import { z } from "zod";
import {
  hashAccountKey,
  toneFromUsedPct,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
  type UsageScope,
} from "@getpaseo/plugin/server/usage";
import { SHORT_LABELS } from "../../shared/usage";
import type { AccountRegistry } from "./registry";

// Reports Load Balancer's own accounts to Paseo's usage system. Globally, every account except
// the subscription Paseo's built-in source already reports (the CLI's own login). Per session,
// only sessions sent through the header proxy: Paseo's source treats any non-Anthropic base URL
// as a foreign API and reports nothing for them.

export const lbInputSchema = z.object({ account: z.string() });

const SUMMARY = new Set(["five_hour", "weekly"]);

function entry(account: { id: string; email: string | null; label: string }): UsageAccount {
  return {
    key: hashAccountKey(account.id),
    // The email matches the label Paseo's built-in source gives an account.
    label: account.email || account.label,
    input: { account: account.id },
  };
}

export async function discoverAccounts(
  registry: AccountRegistry,
  scope: UsageScope,
  isProxied: (baseUrl: string) => boolean,
): Promise<UsageAccount[]> {
  if (scope.kind === "global") return (await registry.reportable()).map(entry);
  const baseUrl = scope.env.ANTHROPIC_BASE_URL;
  if (scope.provider !== "claude" || !baseUrl || !isProxied(baseUrl)) return [];
  const account = registry.forConfigDir(scope.env.CLAUDE_CONFIG_DIR);
  return account ? [entry(account)] : [];
}

export async function fetchAccountUsage(registry: AccountRegistry, raw: unknown): Promise<UsageReport> {
  const { account: id } = lbInputSchema.parse(raw);
  const account = (await registry.list()).accounts.find((entry) => entry.id === id);
  if (!account) return { status: "error", error: "Load Balancer no longer lists this account" };
  if (account.windows.length === 0) return { status: "error", error: account.error ?? "No usage reading yet" };
  return {
    status: "available",
    planLabel: account.plan ? account.plan.charAt(0).toUpperCase() + account.plan.slice(1) : undefined,
    windows: account.windows.map((window) =>
      windowFromUsedPct({
        id: window.id,
        label: window.label,
        shortLabel: SHORT_LABELS[window.id] ?? window.label,
        summary: SUMMARY.has(window.id),
        utilizationPct: window.usedPct,
        resetsAt: window.resetsAt,
        tone: toneFromUsedPct(window.usedPct),
      }),
    ),
    details: account.readAt ? [{ id: "read_at", label: "Reading taken", value: account.readAt }] : [],
  };
}
