import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { HeaderProxy } from "./proxy";

type SessionOpen = { provider: string; purpose: string; env: Record<string, string> };
type Env = Record<string, unknown>;

const BASE_URL = "ANTHROPIC_BASE_URL";
const OTHER_BACKENDS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstSet(sources: Env[], key: string): string | undefined {
  for (const source of sources) {
    const value = source[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/**
 * Sends a Claude session through the proxy, in order of what the session would otherwise use:
 * its launch env, its provider's config (a profile inherits from `claude`), then the daemon's
 * env. An existing base URL becomes the proxy's destination for that session.
 */
export async function routeSession<Request extends SessionOpen>(
  request: Request,
  paseo: PluginHookContext["paseo"],
  proxy: HeaderProxy,
): Promise<Request | undefined> {
  if (request.purpose !== "interactive") return undefined;
  const { config } = await paseo.config.get();
  const providers = asRecord(config.providers) ?? {};
  const entry = asRecord(providers[request.provider]);
  if (request.provider !== "claude" && entry?.extends !== "claude") return undefined;

  const sources: Env[] = [
    request.env,
    asRecord(entry?.env) ?? {},
    asRecord(asRecord(providers.claude)?.env) ?? {},
    process.env,
  ];
  if (OTHER_BACKENDS.some((key) => firstSet(sources, key))) return undefined;

  const existing = firstSet(sources, BASE_URL) ?? null;
  if (existing && proxy.owns(existing)) return undefined;
  await proxy.start();
  const baseUrl = await proxy.routeFor(existing);
  if (!baseUrl) return undefined;

  const env: Record<string, string> = { ...request.env, [BASE_URL]: baseUrl };
  if (PROXY_VARS.some((key) => firstSet(sources, key))) {
    const current = firstSet(sources, "NO_PROXY") ?? firstSet(sources, "no_proxy");
    env.NO_PROXY = env.no_proxy = current ? `${current},127.0.0.1` : "127.0.0.1";
  }
  return { ...request, env };
}
