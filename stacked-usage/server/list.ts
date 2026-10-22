import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { toneFor, type Meter, type Row } from "../shared/usage";

/** The account part of "Claude (someone@example.com)", trimmed to its local part. */
function shortName(displayName: string): string {
  const account = /\(([^)]+)\)\s*$/.exec(displayName)?.[1];
  if (!account) return displayName;
  return account.split("@")[0] || account;
}

export async function listUsage(_input: unknown, { paseo }: PluginHandlerContext): Promise<{ rows: Row[] }> {
  const { providers } = await paseo.providers.listUsage();
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    // One subscription can be reported twice, by Paseo's own source and by ZeroSub's, under
    // the same "<Source> (<email>)" name. Keep the first.
    if (seen.has(provider.displayName)) continue;
    seen.add(provider.displayName);
    const key = provider.displayName;
    const meters: Meter[] = provider.windows.map((window) => {
      const usedPct =
        window.usedPct ?? (typeof window.remainingPct === "number" ? 100 - window.remainingPct : null);
      return {
        key: `${key}/${window.id}`,
        label: window.label,
        shortLabel: window.shortLabel ?? window.label,
        usedPct,
        resetsAt: window.resetsAt ?? null,
        tone: toneFor(usedPct, window.tone),
        summary: window.summary === true,
      };
    });
    rows.push({
      key,
      title: provider.displayName,
      name: shortName(provider.displayName),
      planLabel: provider.planLabel,
      error: provider.status === "available" ? null : (provider.error ?? provider.status),
      meters,
    });
  }
  return { rows };
}
