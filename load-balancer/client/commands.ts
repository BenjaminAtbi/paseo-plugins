// Adapted from ZeroSub (https://github.com/kapybara-org/zerosub, MIT, Copyright (c) 2026 Kapybara).
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { setAgentAccountRpc, setDefaultAccountRpc } from "../shared/accounts";
import { findAccount, type AccountsState, type AccountsStore } from "./store";

/** Command Center entries and the `/account` slash command. */
export function contributeCommands(client: PluginClientContext, store: AccountsStore): () => void {
  const removers: Array<() => void> = [];

  removers.push(
    client.addCommandCenterItem({
      id: "open-accounts",
      title: "Manage Claude accounts (Load Balancer)",
      icon: "Users",
      keywords: ["load balancer", "claude", "account", "subscription", "login", "switch"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "accounts" });
      },
    }),
  );

  removers.push(
    client.addSlashCommand({
      name: "account",
      description: "Switch the Claude account this agent uses",
      argumentHint: "[name | default]",
      context: "agent",
      async onSubmit({ args, agent, openScreen }) {
        const query = args.trim();
        if (!query) {
          openScreen({ screenId: "accounts" });
          return;
        }
        const state = await currentState(store);
        if (!state.routing.enabled) throw new Error("Account routing is off. Turn it on in Accounts first.");
        if (/^default$/i.test(query)) {
          await store.rpc(setAgentAccountRpc, { agentId: agent.id, accountId: null });
          return;
        }
        const match = findAccount(state.accounts, query);
        if (!match) {
          const names = state.accounts.map((account) => account.label).join(", ");
          throw new Error(`No Claude account matches "${query}". Accounts: ${names || "none"}.`);
        }
        if (match.status === "signed_out") throw new Error(`${match.label} is signed out. Sign it in from Accounts first.`);
        if (match.status === "disabled") throw new Error(`${match.label} is disabled. Enable it in Accounts first.`);
        await store.rpc(setAgentAccountRpc, { agentId: agent.id, accountId: match.id });
      },
    }),
  );

  // One "Make … the default" entry per account, kept in step with the account list.
  let dynamic: Array<() => void> = [];
  let signature = "";
  const syncDynamic = () => {
    const state = store.current();
    const next = state ? JSON.stringify(state.accounts.map((a) => [a.id, a.label, a.isDefault, a.status])) : "";
    if (next === signature) return;
    signature = next;
    for (const remove of dynamic) remove();
    dynamic = [];
    if (!state) return;
    state.accounts.forEach((account, index) => {
      if (account.isDefault || account.status === "signed_out" || account.status === "disabled") return;
      dynamic.push(
        client.addCommandCenterItem({
          id: `default-${index}`,
          title: `Make ${account.label} the default Claude account`,
          icon: "Star",
          keywords: ["account", "default", "switch", account.email ?? ""],
          context: "global",
          async onSelect() {
            await store.rpc(setDefaultAccountRpc, { accountId: account.id });
          },
        }),
      );
    });
  };
  const unsubscribe = store.subscribe(syncDynamic);
  syncDynamic();

  return () => {
    unsubscribe();
    for (const remove of dynamic) remove();
    for (const remove of removers) remove();
  };
}

async function currentState(store: AccountsStore): Promise<AccountsState> {
  if (!store.current()) await store.refresh();
  const state = store.current();
  if (!state) throw new Error("Accounts are not available yet.");
  return state;
}
