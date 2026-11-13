import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  accountWindowSchema,
  readingSourceSchema,
  type AccountView,
  type AccountWindow,
  type LoginView,
  type ReadingSource,
} from "../../shared/accounts";
import { dataPath, readData, writeData } from "../data";
import { mergeWindow, type HeaderReadings } from "../readings";
import { ClaudeLogin, hasCredentials, mainIdentity, parseJsonObject, readIdentity, readUsage } from "./claude";
import { prepareClaudeHome, removeHome } from "./homes";
import { homesDir, mainClaudeDir } from "./paths";
import { defaultAccount, limitedUntil, type Binding, type Readings } from "./routing";

// Load Balancer's own Claude accounts: one home per sign-in, the routing state (default, per-agent
// bindings, which account each live session opened on), and one usage poller shared by all
// accounts. The poller only reads an account model-response headers haven't covered lately, and
// spaces its reads to stay under the usage endpoint's limit.

/** Shortest gap between two of our usage reads, whatever account: about the per-machine limit. */
const READ_SPACING_MS = 120_000;
/** An account wants a new reading once its newest one is this old. */
const STALE_MS = 10 * 60_000;
/** Headers carry only session and weekly; per-model windows still get polled this often. */
const FULL_STALE_MS = 60 * 60_000;
const TICK_MS = 15_000;
const LOGIN_KEEP_MS = 10 * 60_000;
/** How often to look at Claude Code's own sign-in again. */
const MAIN_CHECK_MS = 60_000;

export const MAIN_ACCOUNT_ID = "claude-main";

const AccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  identity: z.string(),
  /** Credential home (`CLAUDE_CONFIG_DIR`); `null` for Claude Code's own sign-in. */
  home: z.string().nullable(),
  kind: z.enum(["managed", "main"]).default("managed"),
  addedAt: z.string(),
  signedIn: z.boolean().default(true),
  /** Set aside by the user for a while: stays signed in, but nothing is routed to it. */
  disabled: z.boolean().default(false),
  /** A limit a turn ran into. Limits seen in readings are worked out live instead. */
  limitedUntil: z.string().nullable().default(null),
  limitKind: z.enum(["window", "budget"]).nullable().default(null),
});
export type Account = z.infer<typeof AccountSchema>;

const BindingSchema = z.object({
  accountId: z.string(),
  source: z.enum(["user", "auto", "balance"]),
  at: z.string(),
});
const SessionSchema = z.object({ accountId: z.string(), openedAt: z.string() });
export type Session = z.infer<typeof SessionSchema>;

const StateSchema = z.object({
  accounts: z.array(z.unknown()).default([]),
  defaultAccountId: z.string().nullable().default(null),
  bindings: z.record(z.string(), z.unknown()).default({}),
  /** Which account each agent's live session was opened with. */
  sessions: z.record(z.string(), z.unknown()).default({}),
});

export interface RegistryState {
  accounts: Account[];
  defaultAccountId: string | null;
  bindings: Record<string, Binding>;
  sessions: Record<string, Session>;
}

const PolledSchema = z.object({
  windows: z.array(accountWindowSchema),
  readAt: z.string(),
  source: readingSourceSchema,
});
type Polled = z.infer<typeof PolledSchema>;

interface Reading {
  windows: AccountWindow[];
  readAt: string | null;
  source: ReadingSource | null;
  /** When the last reading with every window (not just header windows) was taken. */
  fullReadAt: string | null;
}

interface LoginEntry {
  view: LoginView;
  login: ClaudeLogin;
  home: string;
  isNewHome: boolean;
  endedAt: number | null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function newId(): string {
  return `claude-${randomBytes(6).toString("hex")}`;
}

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** Each entry that still validates, so one bad record can't wipe the rest. */
function salvage<T>(schema: z.ZodType<T>, entries: Record<string, unknown>): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(entries)) {
    const parsed = schema.safeParse(value);
    if (parsed.success) result[key] = parsed.data;
  }
  return result;
}

export class AccountRegistry {
  private readonly statePath = dataPath("accounts.json");
  private readonly usagePath = dataPath("usage.json");
  private state: RegistryState = { accounts: [], defaultAccountId: null, bindings: {}, sessions: {} };
  private polled = new Map<string, Polled>();
  private errors = new Map<string, string>();
  private logins = new Map<string, LoginEntry>();
  private wanted = new Set<string>();
  private nextReadAt = 0;
  private reading = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private main: { at: number; identity: string | null } = { at: 0, identity: null };

  constructor(private readonly headers: HeaderReadings) {}

  async start(): Promise<void> {
    const saved = StateSchema.safeParse(await readData(this.statePath));
    if (saved.success) {
      this.state = {
        accounts: saved.data.accounts.flatMap((entry) => {
          const parsed = AccountSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        }),
        defaultAccountId: saved.data.defaultAccountId,
        bindings: salvage(BindingSchema, saved.data.bindings),
        sessions: salvage(SessionSchema, saved.data.sessions),
      };
    }
    const usage = z.record(z.string(), z.unknown()).safeParse(await readData(this.usagePath));
    for (const [id, value] of Object.entries(usage.success ? usage.data : {})) {
      const parsed = PolledSchema.safeParse(value);
      if (parsed.success) this.polled.set(id, parsed.data);
    }
    await this.syncMain(true).catch((error: unknown) => console.error("[Load Balancer] could not read Claude Code's sign-in", describe(error)));
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const entry of this.logins.values()) entry.login.cancel();
  }

  /** Every `<orgUuid>|<email>` this registry holds. */
  identities(): string[] {
    return this.state.accounts.map((account) => account.identity);
  }

  /** The routing state as it is now. Treat as read-only; change it through `update`. */
  current(): RegistryState {
    return this.state;
  }

  require(accountId: string): Account {
    const account = this.state.accounts.find((entry) => entry.id === accountId);
    if (!account) throw new Error("That account no longer exists.");
    return account;
  }

  /**
   * The account a session runs on: the one it was routed to, else (opened before routing was on)
   * the account holding Claude Code's own sign-in.
   */
  runningOn(agentId: string): Account | undefined {
    const recorded = this.state.sessions[agentId]?.accountId;
    if (recorded) return this.state.accounts.find((account) => account.id === recorded);
    return (
      this.state.accounts.find((account) => account.kind === "main") ??
      (this.main.identity ? this.state.accounts.find((account) => account.identity === this.main.identity) : undefined)
    );
  }

  /** Usage as routing sees it, at `now`. */
  readings(now = Date.now()): Readings {
    return { now, windowsOf: (accountId) => this.readingOf(accountId).windows };
  }

  async list(agentCounts: ReadonlyMap<string, number> = new Map()): Promise<{
    accounts: AccountView[];
    logins: LoginView[];
    nextReadAt: string | null;
  }> {
    this.syncLogins();
    await this.syncMain().catch(() => undefined);
    const now = Date.now();
    for (const [id, entry] of this.logins) if (entry.endedAt && now - entry.endedAt > LOGIN_KEEP_MS) this.logins.delete(id);
    const readings = this.readings(now);
    const fallback = defaultAccount(this.state)?.id;
    return {
      accounts: this.state.accounts.map((account) => {
        const reading = this.readingFor(account);
        const until = limitedUntil(account, readings);
        return {
          id: account.id,
          label: account.label,
          email: account.email,
          plan: account.plan,
          signedIn: account.signedIn,
          kind: account.kind,
          isCliLogin: account.kind === "main" || account.identity === this.main.identity,
          status: !account.signedIn ? "signed_out" : account.disabled ? "disabled" : until ? "limited" : "ready",
          isDefault: account.id === fallback,
          disabled: account.disabled,
          limitedUntil: until,
          agentCount: agentCounts.get(account.id) ?? 0,
          windows: reading.windows,
          readAt: reading.readAt,
          source: reading.source,
          error: this.errors.get(account.id) ?? null,
        };
      }),
      logins: [...this.logins.values()].map((entry) => entry.view),
      nextReadAt: this.nextReadAt > now ? new Date(this.nextReadAt).toISOString() : null,
    };
  }

  /** Accounts Paseo's built-in source (the CLI's own login) doesn't already report. */
  async reportable(): Promise<AccountView[]> {
    return (await this.list()).accounts.filter((account) => !account.isCliLogin);
  }

  // ------------------------------------------------------------------------- Claude Code's own login

  /**
   * Lists Claude Code's own sign-in as an account, unless a home already holds that subscription
   * (then the home stands for it) or there is none.
   */
  private async syncMain(force = false): Promise<void> {
    if (!force && Date.now() - this.main.at < MAIN_CHECK_MS) return;
    this.main = { at: Date.now(), identity: await mainIdentity() };
    const { identity } = this.main;
    const existing = this.state.accounts.find((account) => account.kind === "main");
    const held = identity !== null && this.state.accounts.some((account) => account.kind === "managed" && account.identity === identity);
    const wanted = identity !== null && !held && (await hasCredentials(mainClaudeDir()));
    if (!wanted) {
      if (!existing) return;
      // A home holding the same subscription takes over the CLI login's place: one account, one set
      // of limits. Match by kind, not reference: `update` works on a copy.
      const twin = held ? this.state.accounts.find((account) => account.kind === "managed" && account.identity === identity) : undefined;
      await this.update((state) => {
        state.accounts = state.accounts.filter((account) => account.kind !== "main");
        if (state.defaultAccountId === existing.id) state.defaultAccountId = twin?.id ?? null;
        for (const [agentId, binding] of Object.entries(state.bindings)) {
          if (binding.accountId !== existing.id) continue;
          if (twin) binding.accountId = twin.id;
          else delete state.bindings[agentId];
        }
        for (const session of Object.values(state.sessions)) if (session.accountId === existing.id && twin) session.accountId = twin.id;
      });
      return;
    }
    if (existing?.identity === identity) return;
    const email = identity.split("|")[1] ?? null;
    const account: Account = {
      id: MAIN_ACCOUNT_ID,
      label: existing?.label ?? email ?? "Claude Code",
      email,
      plan: null,
      identity,
      home: null,
      kind: "main",
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      signedIn: true,
      disabled: existing?.disabled ?? false,
      limitedUntil: null,
      limitKind: null,
    };
    await this.update((state) => {
      state.accounts = [...state.accounts.filter((entry) => entry.kind !== "main"), account];
    });
    this.wanted.add(account.id);
    void readIdentity(null)
      .then((who) => (who.identity === identity && who.plan ? this.patch(account.id, { plan: who.plan }) : undefined))
      .catch(() => undefined);
  }

  // ------------------------------------------------------------------------- readings

  private readingOf(accountId: string): Reading {
    const account = this.state.accounts.find((entry) => entry.id === accountId);
    return account ? this.readingFor(account) : { windows: [], readAt: null, source: null, fullReadAt: null };
  }

  /** Our newest full reading, with fresher header windows merged in. */
  private readingFor(account: Account): Reading {
    const base = this.polled.get(account.id) ?? null;
    const header = account.email ? this.headers.windowsFor(account.email) : undefined;
    let readAt = base?.readAt ?? null;
    let source: ReadingSource | null = base?.source ?? null;
    const windows = (base?.windows ?? []).map((window) => {
      const fromHeader = header?.[window.id];
      const merged = mergeWindow(window, fromHeader);
      if (merged === fromHeader && fromHeader.readAt) {
        readAt = later(readAt, fromHeader.readAt);
        if (readAt === fromHeader.readAt) source = "headers";
      }
      return { ...window, usedPct: merged.usedPct, resetsAt: merged.resetsAt };
    });
    if (!base && header) {
      for (const [id, window] of Object.entries(header)) {
        windows.push({ id, label: id === "five_hour" ? "Session" : "Weekly", usedPct: window.usedPct, resetsAt: window.resetsAt });
        readAt = later(readAt, window.readAt ?? null);
        source = "headers";
      }
    }
    return { windows, readAt, source, fullReadAt: base?.readAt ?? null };
  }

  private needsRead(account: Account, reading: Reading, now: number): boolean {
    if (this.wanted.has(account.id)) return true;
    if (!account.signedIn || account.disabled) return false;
    if (!reading.readAt || !reading.fullReadAt) return true;
    if (now - Date.parse(reading.readAt) > STALE_MS) return true;
    if (now - Date.parse(reading.fullReadAt) > FULL_STALE_MS) return true;
    return reading.windows.some((window) => window.resetsAt !== null && Date.parse(window.resetsAt) <= now);
  }

  private async tick(): Promise<void> {
    if (this.reading || Date.now() < this.nextReadAt || this.state.accounts.length === 0) return;
    this.reading = true;
    try {
      const now = Date.now();
      const due = this.state.accounts
        .map((account) => ({ account, reading: this.readingFor(account) }))
        .filter(({ account, reading }) => this.needsRead(account, reading, now))
        .sort((a, b) => {
          const wantedA = this.wanted.has(a.account.id) ? 0 : 1;
          const wantedB = this.wanted.has(b.account.id) ? 0 : 1;
          return wantedA - wantedB || Date.parse(a.reading.readAt ?? "0") - Date.parse(b.reading.readAt ?? "0");
        })[0];
      if (!due) return;
      await this.read(due.account);
    } catch (error) {
      console.error("[Load Balancer] usage poll failed", describe(error));
    } finally {
      this.reading = false;
    }
  }

  private async read(account: Account): Promise<void> {
    this.wanted.delete(account.id);
    this.nextReadAt = Date.now() + READ_SPACING_MS;
    const result = await readUsage(account.home);
    if (result.kind === "limited") {
      this.nextReadAt = Date.now() + result.retryAfterMs;
      console.log(`[Load Balancer] usage endpoint asked to wait ${Math.round(result.retryAfterMs / 1000)} s`);
      return;
    }
    if (result.kind === "error") {
      this.errors.set(account.id, result.message);
      if (/sign in again/i.test(result.message)) await this.patch(account.id, { signedIn: false });
      return;
    }
    this.errors.delete(account.id);
    this.polled.set(account.id, { windows: result.windows, readAt: result.readAt, source: result.cached ? "cli" : "poll" });
    if (!account.signedIn) await this.patch(account.id, { signedIn: true });
    this.queueWrite(this.usagePath, () => Object.fromEntries(this.polled));
  }

  /** Asks for a reading at the next free slot; never sooner than the spacing allows. */
  refresh(accountId: string): void {
    this.require(accountId);
    this.wanted.add(accountId);
    void this.tick();
  }

  /** Re-checks a sign-in Claude reported as gone; true when it really is signed out. */
  async confirmSignedOut(accountId: string): Promise<boolean> {
    const account = this.require(accountId);
    const who = await readIdentity(account.home).catch(() => null);
    if (!who || who.signedIn) return false;
    await this.patch(accountId, { signedIn: false });
    return true;
  }

  // ------------------------------------------------------------------------- state

  private queueWrite(path: string, value: () => unknown): void {
    this.writes = this.writes
      .then(() => writeData(path, value()))
      .catch((error: unknown) => console.error("[Load Balancer] could not save", path, describe(error)));
  }

  /** Applies `change` to a copy of the state, then saves it. */
  update(change: (draft: RegistryState) => void): Promise<void> {
    const draft = structuredClone(this.state);
    change(draft);
    this.state = draft;
    this.queueWrite(this.statePath, () => this.state);
    return this.writes;
  }

  private patch(accountId: string, patch: Partial<Account>): Promise<void> {
    return this.update((state) => {
      state.accounts = state.accounts.map((account) => (account.id === accountId ? { ...account, ...patch } : account));
    });
  }

  async rename(accountId: string, label: string): Promise<void> {
    const account = this.require(accountId);
    await this.patch(accountId, { label: label.trim() || account.email || account.id });
  }

  markLimited(accountId: string, until: string, kind: "window" | "budget"): Promise<void> {
    return this.patch(accountId, { limitedUntil: until, limitKind: kind });
  }

  setDisabled(accountId: string, disabled: boolean): Promise<void> {
    return this.patch(accountId, { disabled });
  }

  /**
   * Forgets the account and deletes its home, credentials included. It does not sign the account
   * out on Anthropic's side, so its other logins keep working.
   */
  async remove(accountId: string): Promise<void> {
    const account = this.require(accountId);
    if (account.kind === "main") throw new Error("This is Claude Code's own sign-in. Disable it instead.");
    for (const entry of this.logins.values()) if (entry.view.accountId === accountId) entry.login.cancel();
    await this.update((state) => {
      state.accounts = state.accounts.filter((entry) => entry.id !== accountId);
      if (state.defaultAccountId === accountId) state.defaultAccountId = null;
      for (const [agentId, binding] of Object.entries(state.bindings)) if (binding.accountId === accountId) delete state.bindings[agentId];
    });
    this.polled.delete(accountId);
    this.errors.delete(accountId);
    this.wanted.delete(accountId);
    this.queueWrite(this.usagePath, () => Object.fromEntries(this.polled));
    if (account.home) await removeHome(account.home);
    // Claude Code's own sign-in may stand for this subscription again.
    await this.syncMain(true).catch(() => undefined);
  }

  /** Records a signed-in home as an account, or refuses a subscription already listed. */
  private async adopt(home: string, accountId: string | null): Promise<Account> {
    const who = await readIdentity(home);
    if (!who.signedIn || !who.identity) throw new Error("Claude Code doesn't see a sign-in in that home.");
    const duplicate = this.state.accounts.find(
      (entry) => entry.kind === "managed" && entry.identity === who.identity && entry.id !== accountId,
    );
    if (duplicate) throw new Error(`That subscription is already listed as ${duplicate.label}.`);
    if (accountId) {
      await this.patch(accountId, { identity: who.identity, email: who.email, plan: who.plan, signedIn: true });
      this.errors.delete(accountId);
      this.wanted.add(accountId);
      return this.require(accountId);
    }
    const account: Account = {
      id: home.split(/[\\/]/).pop() ?? newId(),
      label: who.email ?? "Claude account",
      email: who.email,
      plan: who.plan,
      identity: who.identity,
      home,
      kind: "managed",
      addedAt: new Date().toISOString(),
      signedIn: true,
      disabled: false,
      limitedUntil: null,
      limitKind: null,
    };
    await this.update((state) => void state.accounts.push(account));
    this.wanted.add(account.id);
    // A home holding Claude Code's own subscription replaces its separate listing.
    await this.syncMain(true).catch(() => undefined);
    return account;
  }

  private async newHome(): Promise<string> {
    const home = join(homesDir(), newId());
    await mkdir(home, { recursive: true });
    await prepareClaudeHome(home, true);
    return home;
  }

  /**
   * Adds an existing sign-in from a Claude config directory. Its credentials and account record
   * are copied into a new home; the source directory is left as it is.
   */
  async importFrom(path: string): Promise<string> {
    const source = resolve(path.trim().replace(/^["']|["']$/g, ""));
    if (!(await stat(source).catch(() => null))?.isDirectory()) throw new Error("That folder doesn't exist.");
    if (!(await hasCredentials(source))) throw new Error("No Claude sign-in (.credentials.json) in that folder.");
    const home = await this.newHome();
    try {
      await copyFile(join(source, ".credentials.json"), join(home, ".credentials.json"));
      const sourceConfig = parseJsonObject(await readFile(join(source, ".claude.json"), "utf8").catch(() => ""));
      if (sourceConfig?.oauthAccount) {
        const target = join(home, ".claude.json");
        const config = parseJsonObject(await readFile(target, "utf8").catch(() => "")) ?? {};
        config.oauthAccount = sourceConfig.oauthAccount;
        await writeFile(`${target}.tmp`, `${JSON.stringify(config, null, 2)}\n`);
        await rename(`${target}.tmp`, target);
      }
      return (await this.adopt(home, null)).id;
    } catch (error) {
      await removeHome(home);
      throw error;
    }
  }

  // ------------------------------------------------------------------------- sign-in

  async startLogin(accountId?: string): Promise<string> {
    const existing = accountId ? this.require(accountId) : null;
    if (existing && !existing.home) throw new Error("This is Claude Code's own sign-in. Run `claude auth login` in a terminal.");
    const home = existing?.home ?? (await this.newHome());
    if (existing) await prepareClaudeHome(home, true);
    const id = randomBytes(8).toString("hex");
    const login = new ClaudeLogin(home);
    const entry: LoginEntry = {
      view: { id, accountId: existing?.id ?? null, step: "starting", codeUrl: null, message: null },
      login,
      home,
      isNewHome: !existing,
      endedAt: null,
    };
    this.logins.set(id, entry);
    void login.finished.then(async (result) => {
      if (!result.ok) return this.endLogin(entry, "failed", result.message);
      entry.view = { ...entry.view, step: "verifying", message: null };
      try {
        const account = await this.adopt(home, entry.view.accountId);
        entry.view = { ...entry.view, accountId: account.id };
        await this.endLogin(entry, "done", null);
      } catch (error) {
        await this.endLogin(entry, "failed", describe(error));
      }
    });
    return id;
  }

  private async endLogin(entry: LoginEntry, step: "done" | "failed" | "canceled", message: string | null): Promise<void> {
    entry.endedAt = Date.now();
    if (step === "failed" && /canceled/i.test(message ?? "")) step = "canceled";
    entry.view = { ...entry.view, step, message };
    if (step !== "done" && entry.isNewHome) await removeHome(entry.home);
  }

  loginView(loginId: string): LoginEntry {
    const entry = this.logins.get(loginId);
    if (!entry) throw new Error("That sign-in has ended. Start again.");
    if (!entry.endedAt && entry.view.step !== "verifying") {
      const progress = entry.login.progress;
      entry.view = { ...entry.view, step: progress.step, codeUrl: progress.codeUrl, message: progress.message };
    }
    return entry;
  }

  /** Refreshes every live login's view from its process before a listing. */
  syncLogins(): void {
    for (const id of this.logins.keys()) this.loginView(id);
  }

  submitCode(loginId: string, code: string): void {
    this.loginView(loginId).login.submitCode(code);
  }

  cancelLogin(loginId: string): void {
    this.logins.get(loginId)?.login.cancel();
  }
}
