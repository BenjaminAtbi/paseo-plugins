import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { dataPath } from "./data";

// Load Balancer's Claude Code mod: a hook inside each Claude session that reads the usage headers
// on every model response and hands them over through a file, so usage is read without a proxy.
// Needs Claude Code 2.1.321 or later; where it can't load (older Claude Code, an organization's
// guard), the beta proxy or polling covers usage.
//
// Paseo's plugin runtime gives the server no path to its own files, so the mod's source lives here
// and is written out to Load Balancer's data folder when the plugin starts.

export const MOD_DIR = dataPath("claude-mod");
export const HANDOFF_DIR = dataPath("handoff");

const PLUGIN_DIRS = "CLAUDE_CODE_PLUGIN_DIRS";

const MANIFEST = {
  name: "load-balancer",
  version: "0.1.0",
  description: "Hands the usage headers on Claude's model responses to Paseo's Load Balancer plugin.",
};

const HOOKS = { modules: ["./register.ts"] };

// The mod's hooks module. Kept free of backticks so it can sit in a template literal.
const REGISTER = String.raw`import type { Register } from 'claude-code'

// Written by Paseo's Load Balancer plugin each time it starts: edits here are overwritten.
//
// After each model response's headers arrive, the usage headers go to
// <LOAD_BALANCER_HANDOFF>/<LOAD_BALANCER_AGENT>.usage.json, which Load Balancer reads. The
// response waits for the write, at most WRITE_WAIT_MS, so the file holds the turn's last
// reading before Paseo hears that the turn ended.

const USAGE_PREFIX = 'anthropic-ratelimit-unified-'
const ORGANIZATION = 'anthropic-organization-id'
const WRITE_WAIT_MS = 250

let target: Promise<string | null> | null = null

export const register: Register = on => {
  on('http.fetch', async ($, e, next) => {
    const result = await next(e)
    if (next.origin.plugin !== 'engine' || result.deny !== undefined) return result
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(result.value.headers)) {
      if (name.startsWith(USAGE_PREFIX) || name === ORGANIZATION) headers[name] = value
    }
    if (!Object.keys(headers).some(name => name.startsWith(USAGE_PREFIX))) return result
    target ??= (async () => {
      const directory = await $.env.get('LOAD_BALANCER_HANDOFF')
      const agent = await $.env.get('LOAD_BALANCER_AGENT')
      return directory && agent ? directory + '/' + agent + '.usage.json' : null
    })()
    const path = await target
    if (!path) return result
    const reading = { version: 1, readAt: new Date().toISOString(), status: result.value.status, headers }
    const written = $.fs.write(path, JSON.stringify(reading)).catch(() => undefined)
    const waited = $.clock.sleep(WRITE_WAIT_MS, { signal: next.signal }).catch(() => undefined)
    await Promise.race([written, waited])
    return result
  }).catch(($, e, next) => next(e)) // A failure here never costs the request: it goes on as it was.
}
`;

const FILES: Record<string, string> = {
  ".claude-plugin/plugin.json": `${JSON.stringify(MANIFEST, null, 2)}\n`,
  "hooks/hooks.json": `${JSON.stringify(HOOKS, null, 2)}\n`,
  "hooks/register.ts": REGISTER,
};

/** Writes the mod out, touching only files whose content changed so a running session isn't reloaded for nothing. */
export async function installMod(): Promise<void> {
  for (const [name, content] of Object.entries(FILES)) {
    const path = join(MOD_DIR, name);
    if ((await readFile(path, "utf8").catch(() => null)) === content) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await mkdir(HANDOFF_DIR, { recursive: true });
}

/** A Claude session's launch env with the mod loaded and told where to hand its readings. */
export function withMod(env: Record<string, string>, agentId: string): Record<string, string> {
  const existing = env[PLUGIN_DIRS] ?? process.env[PLUGIN_DIRS] ?? "";
  const dirs = existing.split(delimiter).filter(Boolean);
  const key = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
  if (!dirs.some((dir) => key(dir) === key(MOD_DIR))) dirs.push(MOD_DIR);
  return {
    ...env,
    [PLUGIN_DIRS]: dirs.join(delimiter),
    LOAD_BALANCER_AGENT: agentId,
    LOAD_BALANCER_HANDOFF: HANDOFF_DIR.replace(/\\/g, "/"),
  };
}

export function usageFile(agentId: string): string {
  return join(HANDOFF_DIR, `${agentId}.usage.json`);
}

export async function forgetAgent(agentId: string): Promise<void> {
  await rm(usageFile(agentId), { force: true });
}
