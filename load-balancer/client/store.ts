// Adapted from ZeroSub (https://github.com/kapybara-org/zerosub, MIT, Copyright (c) 2026 Kapybara).
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { input as ZodInput, output as ZodOutput, ZodType } from "zod";
import { listAccountsRpc } from "../shared/accounts";

export type AccountsState = ZodOutput<typeof listAccountsRpc.output>;

const POLL_MS = 20_000;

/**
 * One poller feeds the composer pills and commands. Polling is cheap: the daemon answers from
 * memory and reads usage on its own schedule.
 *
 * A closure, not a class: Hermes in React Native has no class support in eval'd plugin code.
 */
export interface AccountsStore {
  current(): AccountsState | null;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  /** Calls a daemon handler, then refreshes so every view sees the result. */
  rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    input: ZodInput<InputSchema>,
  ): Promise<ZodOutput<OutputSchema>>;
  stop(): void;
}

export function createAccountsStore(client: PluginClientContext): AccountsStore {
  let state: AccountsState | null = null;
  let signature = "";
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const listeners = new Set<() => void>();

  async function load(): Promise<void> {
    try {
      const next = await client.rpc(listAccountsRpc, {});
      const nextSignature = JSON.stringify([next.accounts, next.agents, next.routing]);
      state = next;
      if (nextSignature === signature) return;
      signature = nextSignature;
      for (const listener of listeners) listener();
    } catch (error) {
      if (!stopped) console.warn("[Load Balancer] could not read accounts", error);
    }
  }

  function refresh(): Promise<void> {
    if (inFlight) return inFlight.then(() => refresh());
    const run = load();
    inFlight = run;
    void run.finally(() => {
      if (inFlight === run) inFlight = null;
    });
    return run;
  }

  const timer = setInterval(() => void refresh(), POLL_MS);
  void refresh();

  return {
    current: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    async rpc(contract, input) {
      try {
        return await client.rpc(contract, input);
      } finally {
        void refresh();
      }
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      listeners.clear();
    },
  };
}

/** A short name for a pill: the label, or an email's local part. */
export function shortLabel(account: { label: string }): string {
  const name = account.label.includes("@") ? (account.label.split("@")[0] ?? account.label) : account.label;
  return name.length > 18 ? `${name.slice(0, 17)}…` : name;
}

/** An account by exact name or email, else by a prefix or part only one account matches. */
export function findAccount<A extends { label: string; email: string | null }>(accounts: readonly A[], query: string): A | undefined {
  const needle = query.trim().toLowerCase();
  const exact = accounts.find((account) => account.label.toLowerCase() === needle || account.email?.toLowerCase() === needle);
  if (exact) return exact;
  const prefix = accounts.filter(
    (account) => account.label.toLowerCase().startsWith(needle) || account.email?.toLowerCase().startsWith(needle),
  );
  if (prefix.length === 1) return prefix[0];
  const partial = accounts.filter(
    (account) => account.label.toLowerCase().includes(needle) || account.email?.toLowerCase().includes(needle),
  );
  return partial.length === 1 ? partial[0] : undefined;
}
