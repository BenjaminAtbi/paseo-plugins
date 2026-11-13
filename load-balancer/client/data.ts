import { useRpc, useSettings } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { betaSettings, displaySettings } from "../shared/settings";
import { listUsageRpc, type Tone } from "../shared/usage";

// The daemon caches each report for five minutes, so polling faster only re-reads its cache.
const REFRESH_MS = 60_000;

export function useUsageRows() {
  const listUsage = useRpc(listUsageRpc);
  return useQuery({
    queryKey: ["load-balancer", "rows"],
    queryFn: () => listUsage({}),
    refetchInterval: REFRESH_MS,
  });
}

const EMPTY = { hidden: [] as string[], pinned: [] as string[] };

export function useDisplaySettings() {
  const settings = useSettings(displaySettings);
  return { settings, values: settings.status === "ready" ? settings.values : EMPTY };
}

export function useBetaSettings() {
  const settings = useSettings(betaSettings);
  return { settings, headerProxy: settings.status === "ready" && settings.values.headerProxy };
}

export function toneColor(tone: Tone, theme: PluginTheme): string {
  switch (tone) {
    case "ok":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}

export function formatPct(usedPct: number | null): string {
  return usedPct === null ? "–" : `${Math.round(usedPct)}%`;
}

export function formatReset(resetsAt: string | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt) - now;
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "resetting";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}
