import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { SHORT_LABELS, toneFor, type Meter, type Row } from "../shared/usage";
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

export async function listUsage(
  _input: unknown,
  { paseo }: PluginHandlerContext,
  headers: HeaderReadings | null,
): Promise<{ rows: Row[] }> {
  const { providers } = await paseo.providers.listUsage();
  const rows: Row[] = [];
  const seen = new Map<string, number>();
  for (const provider of providers) {
    // One subscription can be reported twice, by Paseo's own source and by another plugin's, under
    // the same "<Source> (<email>)" name. Keep the first that has a reading.
    const earlier = seen.get(provider.displayName);
    if (earlier !== undefined && (rows[earlier].error === null || provider.status !== "available")) continue;
    const key = provider.displayName;
    const email = claudeEmail(provider.displayName);
    const headerWindows = email ? headers?.windowsFor(email) : undefined;
    const meters: Meter[] = provider.windows.map((window) => {
      const polled = {
        usedPct: window.usedPct ?? (typeof window.remainingPct === "number" ? 100 - window.remainingPct : null),
        resetsAt: window.resetsAt ?? null,
      };
      const merged = mergeWindow(polled, headerWindows?.[window.id]);
      const { usedPct, resetsAt } = merged;
      return {
        key: `${key}/${window.id}`,
        label: window.label,
        shortLabel: SHORT_LABELS[window.id] ?? window.shortLabel ?? window.label,
        usedPct,
        resetsAt,
        tone: toneFor(usedPct, merged === polled ? window.tone : undefined),
        summary: window.summary === true,
      };
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
  return { rows };
}
