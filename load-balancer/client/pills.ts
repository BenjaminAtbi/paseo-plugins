// Adapted from ZeroSub (https://github.com/kapybara-org/zerosub, MIT, Copyright (c) 2026 Kapybara).
import type { PluginButton, PluginButtonMenuEntry, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { setAgentAccountRpc, type AccountView } from "../shared/accounts";
import { shortLabel, type AccountsState, type AccountsStore } from "./store";

/** The most agents Paseo returns per page. */
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

interface TrackedAgent {
  id: string;
  workspaceId: string;
}

/**
 * One composer pill per Claude agent showing the account it runs on. Tapping it opens a menu of
 * the accounts. Pills only appear while routing is on and there is more than one account.
 */
export function contributePills(client: PluginClientContext, store: AccountsStore): () => void {
  const agents = new Map<string, TrackedAgent>();
  const pills = new Map<string, { registration: PluginButtonRegistration; key: string }>();
  const lifetime = new AbortController();
  let stopped = false;

  function sync(): void {
    if (stopped) return;
    const state = store.current();
    for (const [agentId, pill] of pills) {
      if (!agents.has(agentId)) {
        pill.registration.remove();
        pills.delete(agentId);
      }
    }
    for (const agent of agents.values()) {
      const button = state ? buttonFor(client, store, state, agent) : null;
      const existing = pills.get(agent.id);
      if (!button) {
        existing?.registration.remove();
        pills.delete(agent.id);
        continue;
      }
      const key = JSON.stringify([button.label, button.title, button.icon, menuKey(button)]);
      if (existing) {
        if (existing.key !== key) {
          existing.registration.update(button);
          existing.key = key;
        }
        continue;
      }
      try {
        const registration = client.addComposerPill({ id: "account", workspaceId: agent.workspaceId, agentId: agent.id, button });
        pills.set(agent.id, { registration, key });
      } catch (error) {
        console.warn("[Load Balancer] could not add account pill", error);
      }
    }
  }

  const unsubscribeStore = store.subscribe(sync);

  const track = (agent: { id: string; workspaceId?: string | null }) => {
    if (agent.workspaceId) agents.set(agent.id, { id: agent.id, workspaceId: agent.workspaceId });
  };

  // The subscription covers the newest page and every later change. Older agents come from the
  // remaining pages, so an agent that has been idle for a while still gets its pill.
  const newestFirst = () => [{ key: "updated_at" as const, direction: "desc" as const }];
  let snapshots = 0;
  async function loadOlder(cursor: string | null, generation: number): Promise<void> {
    for (let page = 1; cursor && page < MAX_PAGES; page += 1) {
      const result = await client.paseo.agents.list({ signal: lifetime.signal, sort: newestFirst(), page: { limit: PAGE_SIZE, cursor } });
      if (stopped || generation !== snapshots) return;
      for (const { agent } of result.entries) track(agent);
      sync();
      cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? null) : null;
    }
  }

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal, sort: newestFirst(), page: { limit: PAGE_SIZE } })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries, pageInfo }) => {
          const generation = ++snapshots;
          agents.clear();
          for (const { agent } of entries) track(agent);
          sync();
          const next = pageInfo.hasMore ? (pageInfo.nextCursor ?? null) : null;
          void loadOlder(next, generation).catch((error: unknown) => {
            if (!stopped) console.warn("[Load Balancer] could not list older agents", error);
          });
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") agents.delete(update.agentId);
          else {
            const known = agents.has(update.agent.id);
            track(update.agent);
            // A new agent may have been routed by the daemon a moment ago; fetch its account.
            if (!known) void store.refresh();
          }
          sync();
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("[Load Balancer] agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    unsubscribeStore();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}

function buttonFor(client: PluginClientContext, store: AccountsStore, state: AccountsState, agent: TrackedAgent): PluginButton | null {
  if (!state.routing.enabled || !state.routing.showComposerPill || state.accounts.length < 2) return null;
  // Only Claude agents are routed, so only they appear in `agents`.
  const route = state.agents.find((entry) => entry.agentId === agent.id);
  if (!route) return null;
  const current = state.accounts.find((account) => account.id === route.accountId);
  if (!current) return null;

  const choose = (accountId: string | null) => async () => {
    await store.rpc(setAgentAccountRpc, { agentId: agent.id, accountId });
  };
  const items: PluginButtonMenuEntry[] = state.accounts.map((account, index) => ({
    kind: "item",
    id: `account-${index}`,
    title: menuTitle(account),
    icon: account.id === current.id ? "CircleCheck" : "Circle",
    disabled: account.status === "signed_out" || account.status === "disabled" || account.id === current.id,
    behavior: { kind: "action", onPress: choose(account.id) },
  }));
  items.push({ kind: "separator", id: "manage-divider" });
  if (route.pinned) {
    const fallback = state.accounts.find((account) => account.isDefault);
    items.push({
      kind: "item",
      id: "follow-default",
      title: fallback ? `Follow default (${fallback.label})` : "Follow default",
      icon: "Undo2",
      behavior: { kind: "action", onPress: choose(null) },
    });
  }
  items.push({
    kind: "item",
    id: "manage",
    title: "Manage accounts…",
    icon: "Users",
    behavior: { kind: "action", onPress: () => client.openScreen({ screenId: "accounts" }) },
  });

  const pending = route.pendingFrom ? " (after this turn)" : "";
  return {
    title: `Account: ${current.label}${current.email && current.email !== current.label ? ` (${current.email})` : ""}`,
    icon: current.status === "limited" ? "CircleAlert" : "CircleUserRound",
    label: `${shortLabel(current)}${pending}`,
    behavior: { kind: "menu", items },
  };
}

function menuTitle(account: AccountView): string {
  if (account.status === "signed_out") return `${account.label} — signed out`;
  if (account.status === "disabled") return `${account.label} — disabled`;
  if (account.status === "limited") return `${account.label} — limit reached`;
  let peak: number | null = null;
  for (const window of account.windows) {
    if ((window.id === "five_hour" || window.id === "weekly") && window.usedPct !== null) peak = Math.max(peak ?? 0, window.usedPct);
  }
  return peak === null ? account.label : `${account.label} — ${Math.round(peak)}% used`;
}

function menuKey(button: PluginButton): string {
  return button.behavior.kind === "menu"
    ? button.behavior.items
        .map((item) => (item.kind === "item" ? `${item.id}:${item.title}:${String(item.icon)}:${item.disabled}` : item.id))
        .join("|")
    : "";
}
