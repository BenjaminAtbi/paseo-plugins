import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AccountView } from "../shared/accounts";
import { SHORT_LABELS, settledMeter, toneFor, type Meter, type Row } from "../shared/usage";
import { mergeWindow, type HeaderReadings } from "./readings";

/** The account part of "Claude (someone@example.com)", trimmed to its local part. */
function shortName(displayName: string): string {
  const account = /\(([^)]+)\)\s*$/.exec(displayName)?.[1];
  if (!account) return displayName;
  return account.split("@")[0] || account;
}

/** The email in a "Claude (someone@example.com)" row, the only rows headers can speak for. */
function claudeEmail(displayName: string): string | null {
  return /^Claude \(([^)]+@[^)]+)\)\s*$/.exec(displayName)?.[1] ?? null;
}

/** The windows Paseo's own source and other plugins don't report per account, summarised in the sidebar by default. */
const SUMMARY = new Set(["five_hour", "weekly"]);

/** A Claude account's meters from Load Balancer's own reading, current to the last poll or hand-off. */
function ownMeters(key: string, account: AccountView): Meter[] {
  return account.windows.map((window) =>
    settledMeter({
      key: `${key}/${window.id}`,
      label: window.label,
      shortLabel: SHORT_LABELS[window.id] ?? window.label,
      usedPct: window.usedPct,
      resetsAt: window.resetsAt,
      tone: toneFor(window.usedPct),
      summary: SUMMARY.has(window.id),
    }),
  );
}

/**
 * The sidebar's rows. Paseo's usage list keeps each report for minutes, so a Claude account Load
 * Balancer reads itself takes its meters from that reading instead, the one the account cards show.
 */
export async function listUsage(
  _input: unknown,
  { paseo }: PluginHandlerContext,
  headers: HeaderReadings | null,
  ownAccounts: readonly AccountView[] = [],
): Promise<{ rows: Row[] }> {
  const { providers } = await paseo.providers.listUsage();
  const own = new Map(
    ownAccounts.filter((account) => account.email && account.windows.length > 0).map((account) => [account.email!.toLowerCase(), account]),
  );
  const shown = new Set<string>();
  const rows: Row[] = [];
  const seen = new Map<string, number>();
  for (const provider of providers) {
    // One subscription can be reported twice, by Paseo's own source and by another plugin's, under
    // the same "<Source> (<email>)" name. Keep the first that has a reading.
    const earlier = seen.get(provider.displayName);
    if (earlier !== undefined && (rows[earlier].error === null || provider.status !== "available")) continue;
    const key = provider.displayName;
    const email = claudeEmail(provider.displayName);
    const account = email ? own.get(email.toLowerCase()) : undefined;
    if (account) {
      if (earlier !== undefined && rows[earlier].error === null) continue;
      shown.add(account.email!.toLowerCase());
      const row: Row = { key, title: key, name: shortName(key), planLabel: provider.planLabel ?? null, error: null, meters: ownMeters(key, account) };
      if (earlier !== undefined) rows[earlier] = row;
      else seen.set(key, rows.push(row) - 1);
      continue;
    }
    const headerWindows = email ? headers?.windowsFor(email) : undefined;
    const meters: Meter[] = provider.windows.map((window) => {
      const polled = {
        usedPct: window.usedPct ?? (typeof window.remainingPct === "number" ? 100 - window.remainingPct : null),
        resetsAt: window.resetsAt ?? null,
      };
      const merged = mergeWindow(polled, headerWindows?.[window.id]);
      const { usedPct, resetsAt } = merged;
      return settledMeter({
        key: `${key}/${window.id}`,
        label: window.label,
        shortLabel: SHORT_LABELS[window.id] ?? window.shortLabel ?? window.label,
        usedPct,
        resetsAt,
        tone: toneFor(usedPct, merged === polled ? window.tone : undefined),
        summary: window.summary === true,
      });
    });
    const row: Row = {
      key,
      title: provider.displayName,
      name: shortName(provider.displayName),
      planLabel: provider.planLabel,
      error: provider.status === "available" ? null : (provider.error ?? provider.status),
      meters,
    };
    if (earlier !== undefined) rows[earlier] = row;
    else seen.set(provider.displayName, rows.push(row) - 1);
  }
  // An account Paseo's list doesn't carry yet (just added, or its report failed) still shows.
  for (const [email, account] of own) {
    if (shown.has(email)) continue;
    const key = `Claude (${account.email})`;
    const plan = account.plan ? account.plan.charAt(0).toUpperCase() + account.plan.slice(1) : null;
    rows.push({ key, title: key, name: shortName(key), planLabel: plan, error: null, meters: ownMeters(key, account) });
  }
  return { rows };
}
