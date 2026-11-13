// Adapted from ZeroSub (https://github.com/kapybara-org/zerosub, MIT, Copyright (c) 2026 Kapybara).
import type { PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { AgentRoute, ReopenSummary } from "../../shared/accounts";
import type { RoutingPreferences } from "../../shared/settings";
import { SWITCH_ROW_KIND, SWITCH_ROW_VERSION, type SwitchRow } from "../../shared/timeline";
import { sessionEnv } from "./claude";
import { prepareClaudeHome } from "./homes";
import { detectClaudeLimit, detectClaudeSignOut, turnRows, type LimitHit, type TurnEvent } from "./limits";
import type { AccountRegistry, Account } from "./registry";
import { Reopener } from "./reopen";
import { chooseAccount, defaultAccount, isUsable, mostAvailable, targetFor } from "./routing";

// Moves Claude agents between accounts: which account a session opens on, failover when a turn
// runs into a usage limit or a lost sign-in, and the moves the Accounts page and pill ask for.

type Paseo = PluginHookContext["paseo"];
type SessionOpen = { agentId: string; provider: string; purpose: string; reason: "create" | "resume" | "refresh" | "import"; env: Record<string, string> };
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

/** A turn limit with no reset time given lasts this long for a window, and longer for a budget. */
const WINDOW_LIMIT_MS = 60 * 60_000;
const BUDGET_LIMIT_MS = 3 * 60 * 60_000;
const TURN_READ_MS = 10_000;
const AGENT_LIST_MS = 3_000;
const PROVIDERS_MS = 30_000;
const MAX_PAGES = 100;

type Problem = { kind: "limit"; hit: LimitHit } | { kind: "signed_out" };
type ReopenOutcome = "reopened" | "deferred" | "closed" | "failed";

interface AgentInfo {
  id: string;
  provider: string;
  status: string;
  archived: boolean;
}

/** Open: idle, busy, starting, or stopped by a failed turn. */
function isLive(status: string): boolean {
  return status === "idle" || status === "error" || status === "running" || status === "initializing";
}

/** Open and between turns. */
function settled(status: string): boolean {
  return status === "idle" || status === "error";
}

/**
 * A backstop against runaway switching, should limit detection ever misfire turn after turn. Only
 * moves that actually happened count, so real limits can move an agent whenever one hits.
 */
export class SwitchGuard {
  private readonly moves = new Map<string, number[]>();

  constructor(
    readonly limit = 4,
    readonly windowMs = 10 * 60_000,
  ) {}

  allows(agentId: string, now: number): boolean {
    return this.recent(agentId, now).length < this.limit;
  }

  note(agentId: string, now: number): void {
    this.moves.set(agentId, [...this.recent(agentId, now), now]);
  }

  forget(agentId: string): void {
    this.moves.delete(agentId);
  }

  private recent(agentId: string, now: number): number[] {
    return (this.moves.get(agentId) ?? []).filter((at) => now - at < this.windowMs);
  }
}

/** One task at a time per key. */
class Locks {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

export class Switcher {
  private readonly reopener = new Reopener();
  private readonly guard = new SwitchGuard();
  private readonly locks = new Locks();
  /** Switches waiting for a busy agent's turn to end, with the note to add once it moves. */
  private readonly deferred = new Map<string, SwitchRow | null>();
  /** Agents being moved right now, so a second trigger doesn't move them twice. */
  private readonly switching = new Set<string>();
  /** When each agent was last told it won't be switched again for now. */
  private readonly noticeAt = new Map<string, number>();
  private agentCache: { at: number; agents: Promise<AgentInfo[]> } | null = null;
  private providers: { at: number; claude: Promise<Set<string>> } | null = null;

  constructor(
    private readonly registry: AccountRegistry,
    private readonly preferences: () => Promise<RoutingPreferences | null>,
  ) {}

  // ------------------------------------------------------------------ providers and agents

  /** Providers that run Claude Code: `claude` and profiles extending it. */
  private claudeProviders(paseo: Paseo): Promise<Set<string>> {
    if (this.providers && Date.now() - this.providers.at < PROVIDERS_MS) return this.providers.claude;
    const claude = paseo.config.get().then(({ config }) => {
      const providers = (config.providers ?? {}) as Record<string, { extends?: unknown } | undefined>;
      const names = new Set(["claude"]);
      for (const [name, entry] of Object.entries(providers)) if (entry?.extends === "claude") names.add(name);
      return names;
    });
    this.providers = { at: Date.now(), claude };
    claude.catch(() => {
      this.providers = null;
    });
    return claude;
  }

  private async isClaude(paseo: Paseo, provider: string): Promise<boolean> {
    return (await this.claudeProviders(paseo)).has(provider);
  }

  private async agentInfo(paseo: Paseo, agentId: string): Promise<AgentInfo | null> {
    try {
      const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
      return agent ? { id: agent.id, provider: agent.provider, status: agent.status, archived: Boolean(agent.archivedAt) } : null;
    } catch {
      return null;
    }
  }

  private listAgents(paseo: Paseo): Promise<AgentInfo[]> {
    if (this.agentCache && Date.now() - this.agentCache.at < AGENT_LIST_MS) return this.agentCache.agents;
    const agents = (async () => {
      const found: AgentInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await paseo.agents.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        for (const { agent } of result.entries) {
          found.push({ id: agent.id, provider: agent.provider, status: agent.status, archived: Boolean(agent.archivedAt) });
        }
        if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
        cursor = result.pageInfo.nextCursor;
      }
      return found;
    })();
    this.agentCache = { at: Date.now(), agents };
    agents.catch(() => {
      this.agentCache = null;
    });
    return agents;
  }

  /** Live Claude agents: the given ones (looked up fresh), or every one. */
  private async liveClaudeAgents(paseo: Paseo, agentIds?: readonly string[]): Promise<AgentInfo[]> {
    const agents = agentIds
      ? (await Promise.all(agentIds.map((id) => this.agentInfo(paseo, id)))).filter((agent): agent is AgentInfo => agent !== null)
      : await this.listAgents(paseo);
    const claude = await this.claudeProviders(paseo);
    return agents.filter((agent) => !agent.archived && isLive(agent.status) && claude.has(agent.provider));
  }

  private async prefs(): Promise<RoutingPreferences | null> {
    const prefs = await this.preferences();
    return prefs?.enabled ? prefs : null;
  }

  private target(agentId: string, autoSwitch: boolean): Account | undefined {
    return targetFor(this.registry.current(), this.registry.readings(), agentId, autoSwitch);
  }

  // ------------------------------------------------------------------ session open

  /** The session's launch env pointed at the account it should use, or undefined to leave it alone. */
  async route<Request extends SessionOpen>(request: Request, paseo: Paseo): Promise<Request | undefined> {
    const prefs = await this.prefs();
    if (!prefs || !(await this.isClaude(paseo, request.provider))) return undefined;
    const now = Date.now();
    const state = this.registry.current();
    const decision = chooseAccount(state, this.registry.readings(now), {
      agentId: request.agentId,
      reason: request.reason,
      autoSwitch: prefs.autoSwitch,
      balanceNewAgents: prefs.balanceNewAgents,
    });
    if (!decision) return undefined;
    const { account } = decision;
    if (account.home) {
      await prepareClaudeHome(account.home).catch((error: unknown) => log(`could not refresh the home of ${account.label}`, error));
    }
    const interactive = request.purpose === "interactive";
    const seenBinding = state.bindings[request.agentId]?.accountId;
    const bindingChanged = decision.bind !== null && seenBinding !== decision.bind.accountId;
    const sessionChanged = interactive && state.sessions[request.agentId]?.accountId !== account.id;
    if (bindingChanged || sessionChanged) {
      await this.registry.update((draft) => {
        // Don't overwrite a choice the user made while this decision was being taken.
        if (decision.bind && bindingChanged && draft.bindings[request.agentId]?.accountId === seenBinding) {
          draft.bindings[request.agentId] = decision.bind;
        }
        if (interactive) draft.sessions[request.agentId] = { accountId: account.id, openedAt: new Date(now).toISOString() };
      });
    }
    // A fresh session already runs on the routed account, so any pending switch is done.
    if (interactive) this.deferred.delete(request.agentId);
    console.log(
      `[Load Balancer] ${request.provider} agent ${request.agentId} → ${account.label} (${request.reason}${
        decision.skipped ? `; skipped ${decision.skipped.account.label}: ${decision.skipped.why}` : ""
      })`,
    );
    const env = { ...request.env };
    for (const [key, value] of Object.entries(sessionEnv(account.home))) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    return { ...request, env };
  }

  // ------------------------------------------------------------------ turn end

  async onTurnEnded(event: TurnEnded, paseo: Paseo): Promise<void> {
    const prefs = await this.prefs();
    if (!prefs || !(await this.isClaude(paseo, event.agent.provider))) return;
    const agentId = event.agent.id;
    if (event.outcome.kind !== "canceled") {
      const turn = await this.turnWithTimeline(paseo, event);
      const hit = detectClaudeLimit(turn);
      if (hit) return this.handleUnavailable(paseo, prefs, agentId, { kind: "limit", hit });
      if (detectClaudeSignOut(turn)) {
        const account = this.registry.runningOn(agentId);
        if (account && (await this.registry.confirmSignedOut(account.id))) {
          return this.handleUnavailable(paseo, prefs, agentId, { kind: "signed_out" });
        }
      }
    }
    if (this.deferred.has(agentId)) await this.finishDeferred(paseo, agentId, prefs);
  }

  /**
   * Paseo 0.13 stopped copying the conversation into turn-ended hooks: `timeline` is always `[]`.
   * Claude reports its limits as an ordinary reply, so the tail of the agent's timeline is paged here
   * and only this turn's rows are read. If the page can't be read in time the event stands.
   */
  private async turnWithTimeline(paseo: Paseo, event: TurnEnded): Promise<TurnEvent> {
    const { turnId } = event;
    if (!turnId || event.timeline.length > 0) return event;
    try {
      const page = await deadline(
        paseo.agents.ref(event.agent.id).timeline.refetch({ direction: "tail", limit: 40 }),
        TURN_READ_MS,
        "Paseo didn't send the agent's timeline in time",
      );
      return { ...event, timeline: turnRows(page.entries, turnId) };
    } catch (error) {
      log(`could not read the last turn of ${event.agent.id}`, error);
      return event;
    }
  }

  onArchived(agentId: string): Promise<void> | undefined {
    this.deferred.delete(agentId);
    this.guard.forget(agentId);
    this.noticeAt.delete(agentId);
    if (!this.registry.current().sessions[agentId]) return undefined;
    return this.registry.update((draft) => {
      delete draft.sessions[agentId];
    });
  }

  /** Carries out a switch that waited for the agent's turn to end, unless it's no longer wanted. */
  private async finishDeferred(paseo: Paseo, agentId: string, prefs: RoutingPreferences): Promise<void> {
    const row = this.deferred.get(agentId) ?? null;
    this.deferred.delete(agentId);
    const current = this.registry.runningOn(agentId);
    if (!current || this.target(agentId, prefs.autoSwitch)?.id === current.id) return; // Switched back meanwhile.
    const outcome = await this.reopenAgent(paseo, agentId, row, true);
    if (outcome === "reopened" && row) await this.appendRow(paseo, agentId, this.landed(row, agentId));
  }

  // ------------------------------------------------------------------ failover

  private async handleUnavailable(paseo: Paseo, prefs: RoutingPreferences, agentId: string, problem: Problem): Promise<void> {
    if (this.switching.has(agentId)) return;
    const account = this.registry.runningOn(agentId);
    if (!account) return;
    this.switching.add(agentId);
    try {
      await this.locks.run(account.id, () => this.failover(paseo, prefs, agentId, account, problem));
    } finally {
      this.switching.delete(agentId);
    }
    if (prefs.autoSwitch) {
      void this.moveIdleAgentsOff(paseo, account.id, agentId, problem.kind).catch((error: unknown) => log("moving idle agents failed", error));
    }
  }

  private async failover(paseo: Paseo, prefs: RoutingPreferences, agentId: string, account: Account, problem: Problem): Promise<void> {
    const now = Date.now();
    let resetsAt: string | null = null;
    if (problem.kind === "limit") {
      const { hit } = problem;
      resetsAt = hit.resetsAt ?? this.fullWindowReset(account.id, now) ?? new Date(now + (hit.kind === "budget" ? BUDGET_LIMIT_MS : WINDOW_LIMIT_MS)).toISOString();
      await this.registry.markLimited(account.id, resetsAt, hit.kind);
      console.log(`[Load Balancer] ${account.label} hit a ${hit.kind} limit (agent ${agentId}): ${hit.message}`);
    } else {
      console.log(`[Load Balancer] ${account.label} is signed out (agent ${agentId})`);
    }

    if (!prefs.autoSwitch) return;
    if (this.registry.runningOn(agentId)?.id !== account.id) return; // Already moved.
    const base = { from: account.label, resetsAt, continued: false, detail: null, at: new Date(now).toISOString() };
    if (!this.guard.allows(agentId, now)) {
      console.warn(`[Load Balancer] not switching ${agentId} again: it changed accounts ${this.guard.limit} times in 10 minutes`);
      if (now - (this.noticeAt.get(agentId) ?? 0) > this.guard.windowMs) {
        this.noticeAt.set(agentId, now);
        await this.appendRow(paseo, agentId, {
          ...base,
          to: account.label,
          reason: problem.kind,
          outcome: "stayed",
          detail: `It changed accounts ${this.guard.limit} times in 10 minutes, so Load Balancer stopped switching it for now. Pick an account from the account button to carry on.`,
        });
      }
      return;
    }
    const next = mostAvailable(this.registry.current(), this.registry.readings(now), new Set([account.id]));
    if (!next) {
      if (problem.kind === "limit") {
        await this.appendRow(paseo, agentId, { ...base, to: account.label, reason: "exhausted", outcome: "stayed" });
      }
      return;
    }
    await this.registry.update((draft) => {
      draft.bindings[agentId] = { accountId: next.id, source: "auto", at: new Date(now).toISOString() };
    });
    this.guard.note(agentId, now);
    const outcome = await this.reopenAgent(paseo, agentId, null, true);
    const continued = outcome === "reopened" && prefs.autoContinue;
    await this.appendRow(
      paseo,
      agentId,
      this.landed({ ...base, to: next.label, reason: problem.kind, continued, outcome: outcome === "reopened" ? "switched" : "pending" }, agentId),
    );
    if (continued) {
      await paseo.agents
        .ref(agentId)
        .send(prefs.continuePrompt)
        .catch((error: unknown) => log(`could not continue ${agentId}`, error));
    }
  }

  /** The reset of a whole-account window a reading shows full, for a notice that named no time. */
  private fullWindowReset(accountId: string, now: number): string | null {
    const full = this.registry
      .readings(now)
      .windowsOf(accountId)
      .filter((window) => (window.id === "five_hour" || window.id === "weekly") && (window.usedPct ?? 0) >= 99 && window.resetsAt);
    full.sort((a, b) => Date.parse(b.resetsAt ?? "") - Date.parse(a.resetsAt ?? ""));
    const reset = full[0]?.resetsAt ?? null;
    return reset && Date.parse(reset) > now ? reset : null;
  }

  /** Did this agent's own last turn end on a limit? Then its own failover (with a follow-up) handles it. */
  private async lastTurnHitLimit(paseo: Paseo, agentId: string): Promise<boolean> {
    try {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 40 });
      return detectClaudeLimit({ outcome: { kind: "completed" }, timeline: page.entries.map((entry) => entry.item) }) !== null;
    } catch {
      return true; // When unsure, leave it alone.
    }
  }

  /** Idle agents still on an exhausted account would fail on their next turn; move them now. */
  private async moveIdleAgentsOff(paseo: Paseo, accountId: string, except: string, reason: "limit" | "signed_out"): Promise<void> {
    const from = this.registry.current().accounts.find((account) => account.id === accountId);
    const candidates = (await this.liveClaudeAgents(paseo))
      .filter((agent) => agent.id !== except && this.registry.runningOn(agent.id)?.id === accountId)
      .map((agent) => agent.id);
    for (const agentId of candidates) {
      if (this.switching.has(agentId) || !this.guard.allows(agentId, Date.now())) continue;
      const info = await this.agentInfo(paseo, agentId);
      if (!info || info.archived || !settled(info.status)) continue;
      if (await this.lastTurnHitLimit(paseo, agentId)) continue;
      this.switching.add(agentId);
      try {
        const now = Date.now();
        if (this.registry.runningOn(agentId)?.id !== accountId) continue;
        const next = mostAvailable(this.registry.current(), this.registry.readings(now), new Set([accountId]));
        if (!next) return;
        await this.registry.update((draft) => {
          draft.bindings[agentId] = { accountId: next.id, source: "auto", at: new Date(now).toISOString() };
        });
        this.guard.note(agentId, now);
        if ((await this.reopenAgent(paseo, agentId)) !== "reopened") continue;
        await this.appendRow(
          paseo,
          agentId,
          this.landed(
            {
              from: from?.label ?? null,
              to: next.label,
              reason,
              resetsAt: from?.limitedUntil ?? null,
              continued: false,
              outcome: "switched",
              detail: null,
              at: new Date(now).toISOString(),
            },
            agentId,
          ),
        );
      } finally {
        this.switching.delete(agentId);
      }
    }
  }

  // ------------------------------------------------------------------ reopening

  /** Names the account the agent actually reopened on in its timeline note. */
  private landed(row: SwitchRow, agentId: string): SwitchRow {
    const label = row.outcome === "switched" ? this.registry.runningOn(agentId)?.label : undefined;
    return label ? { ...row, to: label } : row;
  }

  /**
   * Reopens an idle agent now, or defers a busy one until its turn ends. `settle` waits a moment for
   * an agent whose turn just ended to report idle, since nothing else would reopen it later.
   */
  private async reopenAgent(paseo: Paseo, agentId: string, row: SwitchRow | null = null, settle = false): Promise<ReopenOutcome> {
    let info = await this.agentInfo(paseo, agentId);
    for (let attempt = 0; settle && info && attempt < 20 && (info.status === "running" || info.status === "initializing"); attempt += 1) {
      await delay(300);
      info = await this.agentInfo(paseo, agentId);
    }
    if (!info) return "closed";
    if (info.status === "running" || info.status === "initializing") {
      this.deferred.set(agentId, row);
      return "deferred";
    }
    // Reloading an archived agent would unarchive it; a closed one routes itself when it next opens.
    if (info.archived || info.status === "closed") return "closed";
    const before = this.registry.current().sessions[agentId];
    const result = await this.reopener.reopen(agentId);
    if (!result.ok) {
      console.warn(`[Load Balancer] could not reopen ${agentId}: ${result.error}`);
      // Paseo asks for the new session's environment before it closes the old one, so a failed reload
      // has still recorded a session that never opened. One that ran out of time may yet open.
      if (!result.timedOut) {
        await this.registry.update((draft) => {
          const recorded = draft.sessions[agentId];
          if (!recorded || recorded.openedAt === before?.openedAt) return;
          if (before) draft.sessions[agentId] = before;
          else delete draft.sessions[agentId];
        });
      }
      return "failed";
    }
    return "reopened";
  }

  /**
   * Reopens every live agent whose session runs on a different account than it is routed to now,
   * and notes the switch in its timeline. Busy agents switch (and get their note) after their turn.
   */
  private async reconcile(
    paseo: Paseo,
    reason: SwitchRow["reason"],
    agentIds?: readonly string[],
    fromLabels: ReadonlyMap<string, string> = new Map(),
  ): Promise<ReopenSummary> {
    const summary: ReopenSummary = { reopened: 0, deferred: 0, failed: 0 };
    const prefs = await this.prefs();
    if (!prefs) return summary;
    for (const agent of await this.liveClaudeAgents(paseo, agentIds)) {
      if (this.switching.has(agent.id)) continue;
      const current = this.registry.current().sessions[agent.id]?.accountId ?? this.registry.runningOn(agent.id)?.id;
      const target = this.target(agent.id, prefs.autoSwitch);
      if (!target || target.id === current) continue;
      const row: SwitchRow = {
        from: (current && (this.registry.current().accounts.find((account) => account.id === current)?.label ?? fromLabels.get(current))) ?? null,
        to: target.label,
        reason,
        resetsAt: null,
        continued: false,
        outcome: "switched",
        detail: null,
        at: new Date().toISOString(),
      };
      const outcome = await this.reopenAgent(paseo, agent.id, row);
      if (outcome === "reopened") {
        summary.reopened += 1;
        await this.appendRow(paseo, agent.id, this.landed(row, agent.id));
      } else if (outcome === "deferred") summary.deferred += 1;
      else if (outcome === "failed") summary.failed += 1;
    }
    return summary;
  }

  private async appendRow(paseo: Paseo, agentId: string, row: SwitchRow): Promise<void> {
    try {
      await paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id: `switch-${Date.parse(row.at) || Date.now()}`,
        kind: SWITCH_ROW_KIND,
        version: SWITCH_ROW_VERSION,
        data: row,
      });
    } catch (error) {
      log(`could not add a timeline note to ${agentId}`, error);
    }
  }

  // ------------------------------------------------------------------ view and actions

  /** Where each live Claude agent is routed, and how many agents each account has. */
  async view(paseo: Paseo): Promise<{ agents: AgentRoute[]; counts: Map<string, number>; canReopen: boolean }> {
    const prefs = await this.prefs();
    const counts = new Map<string, number>();
    const agents: AgentRoute[] = [];
    if (!prefs) return { agents, counts, canReopen: (await this.reopener.locate()) !== null };
    const state = this.registry.current();
    for (const agent of await this.liveClaudeAgents(paseo)) {
      const target = this.target(agent.id, prefs.autoSwitch);
      if (!target) continue;
      counts.set(target.id, (counts.get(target.id) ?? 0) + 1);
      const current = this.registry.runningOn(agent.id);
      agents.push({
        agentId: agent.id,
        accountId: target.id,
        pinned: Boolean(state.bindings[agent.id]),
        pendingFrom: current && current.id !== target.id ? current.id : null,
      });
    }
    return { agents, counts, canReopen: (await this.reopener.locate()) !== null };
  }

  async setDefault(paseo: Paseo, accountId: string): Promise<ReopenSummary> {
    const account = this.registry.require(accountId);
    if (!account.signedIn) throw new Error(`${account.label} is signed out. Sign it in first.`);
    if (account.disabled) throw new Error(`${account.label} is disabled. Enable it before making it the default.`);
    const prefs = await this.prefs();
    await this.registry.update((draft) => {
      draft.defaultAccountId = accountId;
    });
    if (!prefs) return { reopened: 0, deferred: 0, failed: 0 };
    if (!prefs.moveAgentsOnDefaultChange) {
      // The new default is for what comes next: open agents stay on the account they run on.
      const moving = await this.keepOpenAgents(paseo, accountId);
      return moving.length > 0 ? this.reconcile(paseo, "default", moving) : { reopened: 0, deferred: 0, failed: 0 };
    }
    return this.reconcile(paseo, "default");
  }

  /**
   * Pins each open agent that follows the default to the account it runs on, so the new default
   * doesn't move it. An account that can't be used right now is no place to keep work, so those
   * agents come back to be moved.
   */
  private async keepOpenAgents(paseo: Paseo, newDefault: string): Promise<string[]> {
    const open = await this.liveClaudeAgents(paseo);
    const readings = this.registry.readings();
    const moving: string[] = [];
    const at = new Date().toISOString();
    await this.registry.update((draft) => {
      for (const agent of open) {
        if (draft.bindings[agent.id]) continue;
        const current = this.registry.runningOn(agent.id);
        if (!current || !isUsable(current, readings)) moving.push(agent.id);
        else if (current.id !== newDefault) draft.bindings[agent.id] = { accountId: current.id, source: "auto", at };
      }
    });
    return moving;
  }

  /**
   * Sets an account aside for a while, or brings it back. Its agents move to the next account now
   * (busy ones after their turn) and return when it's enabled again.
   */
  async setEnabled(paseo: Paseo, accountId: string, enabled: boolean): Promise<ReopenSummary> {
    const account = this.registry.require(accountId);
    if (account.disabled === !enabled) return { reopened: 0, deferred: 0, failed: 0 };
    const others = this.registry.current().accounts.filter((other) => other.id !== accountId && other.signedIn && !other.disabled);
    if (!enabled && others.length === 0) throw new Error(`${account.label} is the only account in use. Add or enable another one first.`);
    await this.registry.setDisabled(accountId, !enabled);
    console.log(`[Load Balancer] ${account.label} is ${enabled ? "enabled" : "disabled"}`);
    return this.reconcile(paseo, enabled ? "enabled" : "disabled");
  }

  async clearLimit(accountId: string): Promise<void> {
    this.registry.require(accountId);
    await this.registry.update((draft) => {
      const account = draft.accounts.find((entry) => entry.id === accountId);
      if (account) account.limitedUntil = account.limitKind = null;
    });
    this.registry.refresh(accountId);
  }

  async setAgentAccount(paseo: Paseo, agentId: string, accountId: string | null): Promise<ReopenSummary> {
    const info = await this.agentInfo(paseo, agentId);
    if (!info) throw new Error("That agent is no longer available.");
    if (!(await this.isClaude(paseo, info.provider))) throw new Error(`${info.provider} agents don't use Claude accounts.`);
    const target = accountId ? this.registry.require(accountId) : defaultAccount(this.registry.current());
    if (!target) throw new Error("There is no account to use.");
    if (!target.signedIn) throw new Error(`${target.label} is signed out. Sign it in first.`);
    if (accountId && target.disabled) throw new Error(`${target.label} is disabled. Enable it in Accounts first.`);
    await this.registry.update((draft) => {
      if (accountId) draft.bindings[agentId] = { accountId, source: "user", at: new Date().toISOString() };
      else delete draft.bindings[agentId];
    });
    return this.reconcile(paseo, "manual", [agentId]);
  }

  /** Removes an account, then moves the agents that were on it. */
  async remove(paseo: Paseo, accountId: string): Promise<void> {
    const label = this.registry.require(accountId).label;
    await this.registry.remove(accountId);
    await this.reconcile(paseo, "removed", undefined, new Map([[accountId, label]])).catch((error: unknown) =>
      log("moving agents off a removed account failed", error),
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `task`, or a rejection with `message` once `ms` pass without it settling. */
function deadline<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([task, expired]).finally(() => clearTimeout(timer));
}

function log(message: string, error: unknown): void {
  console.error(`[Load Balancer] ${message}`, error instanceof Error ? error.message : String(error));
}
