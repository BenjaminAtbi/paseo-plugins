import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Which Claude Code to run: the `claude` provider's command from Paseo's config, so this plugin runs
// the same binary Paseo's own agents do, including one installed off the daemon's PATH. Read from
// the config file rather than through Paseo because usage polling runs outside any hook or request.

export interface ClaudeCommand {
  command: string;
  /** Arguments the command needs before Claude Code's own, e.g. a script for `node`. */
  args: string[];
}

const DEFAULT: ClaudeCommand = { command: "claude", args: [] };
const CACHE_MS = 30_000;

let cached: { at: number; value: Promise<ClaudeCommand> } | null = null;

function configPath(): string {
  return join(process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo"), "config.json");
}

/**
 * `agents.providers.claude.command` as Paseo accepts it: an argv array, or `{ mode: "replace", argv }`.
 * `{ mode: "append" }` adds session flags to the default binary, which the commands this plugin runs
 * (`auth status`, `auth login`, `-p /usage`) must not get, so it and anything else use `claude`.
 */
export function parseClaudeCommand(config: unknown): ClaudeCommand {
  const command = record(record(record(record(config)?.agents)?.providers)?.claude)?.command;
  const argv = strings(command) ?? (record(command)?.mode === "replace" ? strings(record(command)?.argv) : null);
  return argv ? { command: argv[0], args: argv.slice(1) } : DEFAULT;
}

/** The configured Claude Code command, re-read at most every 30 seconds. Never rejects. */
export function claudeCommand(): Promise<ClaudeCommand> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = readFile(configPath(), "utf8")
    .then((text) => parseClaudeCommand(JSON.parse(text) as unknown))
    .catch(() => DEFAULT);
  cached = { at: Date.now(), value };
  return value;
}

/** How to name the command in an error. */
export function describeCommand(claude: ClaudeCommand): string {
  return [claude.command, ...claude.args].join(" ");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A non-empty array of non-empty strings, else null. */
function strings(value: unknown): [string, ...string[]] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((item) => typeof item === "string" && item.trim() !== "") ? (value as [string, ...string[]]) : null;
}
