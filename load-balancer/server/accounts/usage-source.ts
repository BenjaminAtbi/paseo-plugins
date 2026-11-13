import { z } from "zod";
import {
  hashAccountKey,
  toneFromUsedPct,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
  type UsageScope,
} from "@getpaseo/plugin/server/usage";
import type { AccountRegistry } from "./registry";

// Reports Load Balancer's own accounts to Paseo's usage system, except the subscription Paseo's
// built-in source already reports (the CLI's own login).

export const lbInputSchema = z.object({ account: z.string() });

const SHORT: Record<string, string> = { five_hour: "5h", weekly: "wk" };

export async function discoverAccounts(registry: AccountRegistry, scope: UsageScope): Promise<UsageAccount[]> {
  if (scope.kind !== "global") return [];
  return (await registry.reportable()).map((account) => ({
    key: hashAccountKey(account.id),
      // The email matches the label Paseo's built-in source gives an account.
    label: account.email || account.label,
    input: { account: account.id },
  }));
}

export async function fetchAccountUsage(registry: AccountRegistry, raw: unknown): Promise<UsageReport> {
  const { account: id } = lbInputSchema.parse(raw);
  const account = (await registry.reportable()).find((entry) => entry.id === id);
  if (!account) return { status: "error", error: "Load Balancer no longer lists this account" };
  if (account.windows.length === 0) return { status: "error", error: account.error ?? "No usage reading yet" };
  return {
    status: "available",
    planLabel: account.plan ? account.plan.charAt(0).toUpperCase() + account.plan.slice(1) : undefined,
    windows: account.windows.map((window) =>
      windowFromUsedPct({
        id: window.id,
        label: window.label,
        shortLabel: SHORT[window.id] ?? window.label,
        summary: window.id in SHORT,
        utilizationPct: window.usedPct,
        resetsAt: window.resetsAt,
        tone: toneFromUsedPct(window.usedPct),
      }),
    ),
    details: account.readAt ? [{ id: "read_at", label: "Reading taken", value: account.readAt }] : [],
  };
}
