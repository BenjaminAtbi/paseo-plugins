import { useRpc, useSettings } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { betaSettings, displaySettings } from "../shared/settings";
import { listUsageRpc, waitForReadingRpc, type Tone } from "../shared/usage";

// Load Balancer's own accounts read from its live readings; other sources from Paseo's report,
// which the daemon keeps for five minutes.
const REFRESH_MS = 15_000;

/**
 * Refreshes every Load Balancer query as soon as a usage reading lands: a long-held call the
 * server answers on the next reading, then asked again. The timed refreshes stay as the fallback.
 */
export function useLiveReadings(): void {
  const wait = useRpc(waitForReadingRpc);
  const client = useQueryClient();
  useEffect(() => {
    let stopped = false;
    void (async () => {
      let since = -1;
      while (!stopped) {
        try {
          const { version } = await wait({ since });
          if (stopped) return;
          if (since !== -1 && version !== since) void client.invalidateQueries({ queryKey: ["load-balancer"] });
          since = version;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [wait, client]);
}

export function useUsageRows() {
  useLiveReadings();
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
