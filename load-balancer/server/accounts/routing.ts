// Adapted from ZeroSub (https://github.com/kapybara-org/zerosub, MIT, Copyright (c) 2026 Kapybara).
import type { AccountWindow } from "../../shared/accounts";

// Which account a Claude session opens on. Pure: the registry supplies the state and readings.

/** The windows that cap the whole account; a full per-model window leaves room for other models. */
const ACCOUNT_WINDOWS = new Set(["five_hour", "weekly"]);

export interface RoutedAccount {
  id: string;
  label: string;
  kind: "managed" | "main";
  signedIn: boolean;
  disabled: boolean;
  /** A limit a turn ran into, until it lifts. */
  limitedUntil: string | null;
  /** When the turn ran into it. */
  limitedAt?: string | null;
  addedAt: string;
}

export interface Binding {
  accountId: string;
  /** `user`: chosen in the UI. `auto`: moved after a limit, or kept on its account when the default changed. `balance`: spread at creation. */
  source: "user" | "auto" | "balance";
  at: string;
}

export interface RoutingState<A extends RoutedAccount = RoutedAccount> {
  accounts: readonly A[];
  defaultAccountId: string | null;
  /** Per-agent overrides of the default account. */
  bindings: Readonly<Record<string, Binding>>;
}

export interface Readings {
  now: number;
  windowsOf(accountId: string): readonly AccountWindow[];
  /** When the account's newest reading was taken. */
  readAtOf?(accountId: string): string | null;
}

export function findAccount<A extends RoutedAccount>(accounts: readonly A[], accountId: string | null | undefined): A | undefined {
  return accountId ? accounts.find((account) => account.id === accountId) : undefined;
}

/** The explicit default, else the first of Load Balancer's own sign-ins, else Claude Code's. */
export function defaultAccount<A extends RoutedAccount>(state: RoutingState<A>): A | undefined {
  return (
    findAccount(state.accounts, state.defaultAccountId) ??
    state.accounts.find((account) => account.kind === "managed") ??
    state.accounts[0]
  );
}

/**
 * When a reading shows a whole-account window full: the latest such reset. Model-response headers
 * say so the moment it happens, so new sessions stop going there before a turn runs into it.
 */
export function readingLimit(windows: readonly AccountWindow[], now: number): string | null {
  let until: string | null = null;
  for (const window of windows) {
    if (!ACCOUNT_WINDOWS.has(window.id) || window.usedPct === null || window.usedPct < 100 || !window.resetsAt) continue;
    if (Date.parse(window.resetsAt) <= now) continue;
    if (!until || Date.parse(window.resetsAt) > Date.parse(until)) until = window.resetsAt;
  }
  return until;
}

/**
 * A reading taken after the turn hit its limit that shows every window with room: the limit has
 * lifted, whatever the notice said. Claude Code's notice can name a later reset than the real one.
 */
function liftedSince(account: RoutedAccount, readings: Readings): boolean {
  const readAt = readings.readAtOf?.(account.id);
  if (!account.limitedAt || !readAt || Date.parse(readAt) <= Date.parse(account.limitedAt)) return false;
  const windows = readings.windowsOf(account.id);
  return windows.length > 0 && windows.every((window) => window.usedPct !== null && window.usedPct < 99);
}

/** When the account frees up again, or null when it isn't at a limit. */
export function limitedUntil(account: RoutedAccount, readings: Readings): string | null {
  const turn =
    account.limitedUntil && Date.parse(account.limitedUntil) > readings.now && !liftedSince(account, readings)
      ? account.limitedUntil
      : null;
  const reading = readingLimit(readings.windowsOf(account.id), readings.now);
  if (!turn) return reading;
  if (!reading) return turn;
  return Date.parse(turn) >= Date.parse(reading) ? turn : reading;
}

export function isUsable(account: RoutedAccount, readings: Readings): boolean {
  return account.signedIn && !account.disabled && limitedUntil(account, readings) === null;
}

/** Lower is better. Unknown usage ranks in the middle so a known-quiet account wins over a mystery. */
export function headroomScore(windows: readonly AccountWindow[]): number {
  let peak: number | null = null;
  for (const window of windows) {
    if (ACCOUNT_WINDOWS.has(window.id) && window.usedPct !== null) peak = Math.max(peak ?? 0, window.usedPct);
  }
  return peak ?? 50;
}

/** The usable account with the most room, preferring the default, then Load Balancer's own sign-ins, on ties. */
export function mostAvailable<A extends RoutedAccount>(
  state: RoutingState<A>,
  readings: Readings,
  exclude: ReadonlySet<string> = new Set(),
): A | undefined {
  const preferred = defaultAccount(state)?.id;
  const rank = (account: A) => [
    headroomScore(readings.windowsOf(account.id)),
    account.id === preferred ? 0 : 1,
    account.kind === "main" ? 1 : 0,
    Date.parse(account.addedAt) || 0,
  ];
  return state.accounts
    .filter((account) => !exclude.has(account.id) && isUsable(account, readings))
    .sort((a, b) => {
      const left = rank(a);
      const right = rank(b);
      for (let index = 0; index < left.length; index += 1) {
        const delta = (left[index] ?? 0) - (right[index] ?? 0);
        if (delta !== 0) return delta;
      }
      return 0;
    })[0];
}

export interface RouteInput {
  agentId: string;
  reason: "create" | "resume" | "refresh" | "import";
  autoSwitch: boolean;
  balanceNewAgents: boolean;
}

export interface RouteDecision<A extends RoutedAccount> {
  account: A;
  /** A binding to persist so the agent stays where it was routed. */
  bind: Binding | null;
  /** Why the preferred account was skipped, if it was. */
  skipped: { account: A; why: "limited" | "signed_out" | "disabled" } | null;
}

/**
 * Which account a session opens on: the agent's own binding, else (for balanced new agents) the
 * roomiest account, else the default. An exhausted or signed-out choice is swapped for the roomiest
 * usable account when automatic switching is on. A disabled choice is always swapped, and the agent
 * keeps its own binding so it returns once the account is enabled again.
 */
export function chooseAccount<A extends RoutedAccount>(
  state: RoutingState<A>,
  readings: Readings,
  input: RouteInput,
): RouteDecision<A> | null {
  if (state.accounts.length === 0) return null;
  const at = new Date(readings.now).toISOString();

  let account = findAccount(state.accounts, state.bindings[input.agentId]?.accountId);
  let bind: Binding | null = null;
  if (!account && input.reason === "create" && input.balanceNewAgents && state.accounts.length > 1) {
    account = mostAvailable(state, readings);
    if (account) bind = { accountId: account.id, source: "balance", at };
  }
  account ??= defaultAccount(state);
  if (!account) return null;

  let skipped: RouteDecision<A>["skipped"] = null;
  const why = !account.signedIn
    ? "signed_out"
    : account.disabled
      ? "disabled"
      : limitedUntil(account, readings) !== null
        ? "limited"
        : null;
  if (why && (input.autoSwitch || why !== "limited")) {
    const alternative = mostAvailable(state, readings, new Set([account.id]));
    if (alternative) {
      skipped = { account, why };
      account = alternative;
      // A disabled account keeps its agents' bindings, so they return when it's enabled again.
      bind = why === "disabled" ? null : { accountId: alternative.id, source: "auto", at };
    }
  }
  return { account, bind, skipped };
}

/** The account an agent would open on now, without side effects (for display and reconciling). */
export function targetFor<A extends RoutedAccount>(
  state: RoutingState<A>,
  readings: Readings,
  agentId: string,
  autoSwitch: boolean,
): A | undefined {
  return chooseAccount(state, readings, { agentId, reason: "refresh", autoSwitch, balanceNewAgents: false })?.account;
}
