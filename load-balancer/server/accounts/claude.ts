// Adapted from ZeroSub (https://github.com/kapybara-org/zerosub, MIT, Copyright (c) 2026 Kapybara).
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountWindow } from "../../shared/accounts";
import { mainClaudeDir, mainClaudeGlobalConfig } from "./paths";
import { firstUrl, run, stripAnsi } from "./process";

// Talks to Claude Code and Anthropic for one account home. Tokens are read only to ask for usage,
// and are never logged or stored.

const API = "https://api.anthropic.com";
/** Variables that would make a process use something other than the home's own login. */
const OVERRIDING_AUTH = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

export interface Identity {
  signedIn: boolean;
  email: string | null;
  plan: string | null;
  /** `<orgUuid>|<email>`, the same subscription whichever login of it. */
  identity: string | null;
}

export type UsageRead =
  | { kind: "ok"; windows: AccountWindow[]; readAt: string; cached: boolean }
  | { kind: "limited"; retryAfterMs: number }
  | { kind: "error"; message: string };

/**
 * Launch-environment changes that make a Claude session use `home`'s login (`null`: Claude Code's
 * own). A `null` value removes the variable. Both point at the home so the keychain entry and
 * refresh locks follow it even when the daemon itself runs with CLAUDE_SECURESTORAGE_CONFIG_DIR set.
 */
export function sessionEnv(home: string | null): Record<string, string | null> {
  const patch: Record<string, string | null> = home
    ? { CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home }
    : { CLAUDE_CONFIG_DIR: null, CLAUDE_SECURESTORAGE_CONFIG_DIR: null };
  for (const key of OVERRIDING_AUTH) if (process.env[key]) patch[key] = "";
  return patch;
}

/** The environment for a Claude process run against `home` (`null`: Claude Code's own login). */
export function claudeEnv(home: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (home) env.CLAUDE_CONFIG_DIR = env.CLAUDE_SECURESTORAGE_CONFIG_DIR = home;
  for (const key of OVERRIDING_AUTH) delete env[key];
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK_VERSION"]) delete env[key];
  return env;
}

export function identityOf(orgId: string | null, email: string): string {
  return `${orgId ?? "personal"}|${email.toLowerCase()}`;
}

export async function readIdentity(home: string | null): Promise<Identity> {
  const result = await run("claude", ["auth", "status", "--json"], { env: claudeEnv(home), timeoutMs: 30_000 });
  const status = parseJsonObject(result.stdout);
  if (!status) throw new Error(result.stderr.trim() || "Could not read Claude sign-in status");
  const email = str(status.email);
  return {
    signedIn: status.loggedIn === true,
    email,
    plan: str(status.subscriptionType),
    identity: email ? identityOf(str(status.orgId), email) : null,
  };
}

/** The CLI's own login, from its global config; null when it has none. */
export async function mainIdentity(): Promise<string | null> {
  const config = parseJsonObject(await readFile(mainClaudeGlobalConfig(), "utf8").catch(() => ""));
  const account = config?.oauthAccount as { organizationUuid?: unknown; emailAddress?: unknown } | undefined;
  const email = str(account?.emailAddress);
  return email ? identityOf(str(account?.organizationUuid), email) : null;
}

interface Credentials {
  accessToken: string | null;
  expiresAt: number | null;
}

function parseCredentials(raw: string): Credentials | null {
  const oauth = parseJsonObject(raw)?.claudeAiOauth as Record<string, unknown> | undefined;
  if (!oauth) return null;
  return {
    accessToken: str(oauth.accessToken),
    expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
  };
}

export async function hasCredentials(directory: string): Promise<boolean> {
  const credentials = parseCredentials(await readFile(join(directory, ".credentials.json"), "utf8").catch(() => ""));
  return Boolean(credentials?.accessToken);
}

function isFresh(credentials: Credentials | null): credentials is Credentials {
  return Boolean(credentials?.accessToken) && (!credentials?.expiresAt || credentials.expiresAt > Date.now() + 60_000);
}

async function readCredentials(home: string | null): Promise<Credentials | null> {
  return parseCredentials(await readFile(join(home ?? mainClaudeDir(), ".credentials.json"), "utf8").catch(() => ""));
}

/** How long to wait after a 429: what it asks, but at least a minute and at most half an hour. */
export function retryDelayMs(retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (!retryAfter || !Number.isFinite(seconds)) return 2 * 60_000;
  return Math.min(30 * 60_000, Math.max(60_000, seconds * 1_000));
}

/**
 * One usage read. An expired sign-in is renewed by Claude Code itself (`claude -p /usage` runs
 * locally, makes no model call, refreshes the token with its own locking and caches the usage it
 * reads), so this plugin never refreshes a token and that run's reading is used instead of a second
 * call.
 */
export async function readUsage(home: string | null): Promise<UsageRead> {
  const credentials = await readCredentials(home);
  if (!isFresh(credentials)) {
    await run("claude", ["-p", "/usage", "--no-session-persistence", "--output-format", "json"], {
      env: claudeEnv(home),
      cwd: tmpdir(),
      timeoutMs: 90_000,
    });
    const cached = await cachedUsage(home);
    if (cached && Date.now() - Date.parse(cached.readAt) < 5 * 60_000) return cached;
    if (!isFresh(await readCredentials(home))) return { kind: "error", message: "This account's sign-in has expired. Sign in again." };
    return { kind: "error", message: "Claude Code renewed the sign-in but read no usage; trying again later." };
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  try {
    const response = await fetch(`${API}/api/oauth/usage`, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
      signal: abort.signal,
    });
    if (response.ok) return { kind: "ok", windows: parseUsage(await response.json()), readAt: new Date().toISOString(), cached: false };
    if (response.status === 429) return { kind: "limited", retryAfterMs: retryDelayMs(response.headers.get("retry-after")) };
    if (response.status === 401 || response.status === 403) return { kind: "error", message: "Claude rejected this sign-in. Sign in again." };
    return { kind: "error", message: `Usage request failed (HTTP ${response.status})` };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** The last usage Claude Code itself cached for the home. */
export async function cachedUsage(home: string | null): Promise<Extract<UsageRead, { kind: "ok" }> | null> {
  const path = home ? join(home, ".claude.json") : mainClaudeGlobalConfig();
  const config = parseJsonObject(await readFile(path, "utf8").catch(() => ""));
  const cache = config?.cachedUsageUtilization as { fetchedAtMs?: unknown; utilization?: unknown } | undefined;
  if (!cache || typeof cache.fetchedAtMs !== "number") return null;
  const windows = parseUsage(cache.utilization);
  if (windows.length === 0) return null;
  return { kind: "ok", windows, readAt: new Date(cache.fetchedAtMs).toISOString(), cached: true };
}

// Window ids match Paseo's own Claude source, so a meter keeps its sidebar setting whichever
// source reported it.
const WINDOW_LABELS: Array<[key: string, id: string, label: string]> = [
  ["five_hour", "five_hour", "Session"],
  ["seven_day", "weekly", "Weekly"],
  ["seven_day_opus", "weekly_model_opus", "Weekly · Opus"],
  ["seven_day_sonnet", "weekly_model_sonnet", "Weekly · Sonnet"],
];

type ScopedLimit = {
  kind?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  scope?: { model?: { id?: unknown; display_name?: unknown } | null } | null;
};

export function parseUsage(body: unknown): AccountWindow[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const windows: AccountWindow[] = [];
  for (const [key, id, label] of WINDOW_LABELS) {
    const entry = record[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (entry && typeof entry.utilization === "number") {
      windows.push({ id, label, usedPct: entry.utilization, resetsAt: isoDate(entry.resets_at) });
    }
  }
  // Per-model weekly limits (Fable, for one) arrive only in `limits[]`.
  for (const limit of Array.isArray(record.limits) ? (record.limits as ScopedLimit[]) : []) {
    if (limit?.kind !== "weekly_scoped") continue;
    const modelId = str(limit.scope?.model?.id)?.trim() || null;
    const name = str(limit.scope?.model?.display_name)?.trim() || modelId;
    if (!name) continue;
    const id = `weekly_model_${modelId ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
    const usedPct = typeof limit.percent === "number" ? limit.percent : null;
    const existing = windows.find((window) => window.id === id);
    if (existing) existing.usedPct ??= usedPct;
    else windows.push({ id, label: `Weekly · ${name}`, usedPct, resetsAt: isoDate(limit.resets_at) });
  }
  return windows;
}

// --------------------------------------------------------------------------- sign-in

export interface LoginProgress {
  step: "starting" | "waiting" | "verifying";
  codeUrl: string | null;
  message: string | null;
}

/**
 * `claude auth login --claudeai` against a home. It opens the browser on this computer itself and
 * also prints a sign-in link whose page shows a code to paste back, which works from any device.
 */
export class ClaudeLogin {
  progress: LoginProgress = { step: "starting", codeUrl: null, message: null };
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private readonly child;
  private stdout = "";
  private stderr = "";
  private canceled = false;
  private exited = false;

  constructor(home: string) {
    this.child = spawn("claude", ["auth", "login", "--claudeai"], { env: claudeEnv(home), stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => undefined);
    this.finished = new Promise((resolve) => {
      this.child.on("error", (error) => resolve({ ok: false, message: `Could not start Claude Code: ${error.message}` }));
      this.child.on("close", (code) => {
        this.exited = true;
        if (this.canceled) return resolve({ ok: false, message: "Sign-in was canceled." });
        if (code === 0) return resolve({ ok: true, message: null });
        const failure = this.stderr
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .reverse()
          .find((line) => /login failed|error/i.test(line));
        resolve({ ok: false, message: friendlyFailure(failure ?? this.stderr.trim()) });
      });
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.stdout = (this.stdout + stripAnsi(chunk)).slice(-16_384);
      const url = firstUrl(this.stdout, /\/oauth\/authorize/);
      if (url && url !== this.progress.codeUrl) this.progress = { ...this.progress, codeUrl: url, step: "waiting" };
    });
    this.child.stderr.on("data", (chunk: string) => {
      const text = stripAnsi(chunk);
      this.stderr = (this.stderr + text).slice(-16_384);
      if (/invalid code/i.test(text)) {
        this.progress = { ...this.progress, message: "That code didn't work. Copy the whole code from the page and paste it again." };
      }
    });
  }

  submitCode(code: string): void {
    let value = code.trim().replace(/\s+/g, "");
    if (!value) throw new Error("Paste the code from the sign-in page.");
    // The CLI only checks that a `#state` suffix is present; the exchange uses the flow's own state.
    if (!value.includes("#")) value = `${value}#load-balancer`;
    if (this.exited) throw new Error("This sign-in has ended. Start again.");
    this.progress = { ...this.progress, message: "Checking the code…" };
    this.child.stdin.write(`${value}\n`);
  }

  cancel(): void {
    if (this.exited || this.canceled) return;
    this.canceled = true;
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (!this.exited) this.child.kill("SIGKILL");
    }, 3_000).unref();
  }
}

function friendlyFailure(message: string): string {
  if (!message) return "Sign-in did not finish.";
  if (/status code 400/i.test(message)) return "That code was rejected. Start again and paste the newest code.";
  return message.replace(/^Login failed:\s*/i, "Sign-in failed: ");
}

// --------------------------------------------------------------------------- helpers

export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const value = JSON.parse(text.slice(start)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isoDate(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
