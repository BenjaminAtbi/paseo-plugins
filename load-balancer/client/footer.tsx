import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { FIVE_HOUR_MS, isShown, settledMeter, type Meter } from "../shared/usage";
import { formatPct, toneColor, useDisplaySettings, useUsageRows } from "./data";
import { CountdownBar, MeterBar } from "./meter";

const TICK_MS = 5_000;

/** Time left until a full session window resets, or null when it isn't counting down. */
function countdown(meter: Meter, now: number): number | null {
  if (!meter.key.endsWith("/five_hour") || meter.usedPct === null || Math.round(meter.usedPct) < 100) return null;
  const left = meter.resetsAt ? Date.parse(meter.resetsAt) - now : NaN;
  return left > 0 ? left : null;
}

/** "4:59" down to "0:01": hours and minutes left, rounded up so it reads 0:01 in its last minute. */
function formatLeft(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** One line per account, stacked, each with its shown windows as coloured meters. */
export function UsageFooter({ theme, openScreen }: PluginSidebarItemProps) {
  const usage = useUsageRows();
  const { values } = useDisplaySettings();
  const [now, setNow] = useState(() => Date.now());
  const rows = (usage.data?.rows ?? [])
    .map((row) => ({ ...row, meters: row.meters.filter((meter) => isShown(meter, values)).map((meter) => settledMeter(meter, now)) }))
    .filter((row) => row.meters.length > 0);
  const counting = rows.some((row) => row.meters.some((meter) => countdown(meter, now) !== null));

  // Ticks only while a countdown shows; the reset that ends it also asks for a fresh reading.
  const { refetch } = usage;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      clearInterval(timer);
      void refetch();
    };
  }, [counting, refetch]);

  if (rows.length === 0) return null;
  const muted = theme.colors.foregroundMuted;
  const yellow = theme.colors.statusWarning;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Claude accounts"
      onPress={() => openScreen({ screenId: "accounts" })}
      style={({ pressed }) => ({
        width: "100%",
        gap: 4,
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 8,
        backgroundColor: pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      {rows.map((row) => (
        <View key={row.key} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text numberOfLines={1} style={{ width: 72, fontSize: 11, color: muted }}>
            {row.name}
          </Text>
          {row.meters.map((meter) => {
            const left = countdown(meter, now);
            const color =
              left !== null ? yellow : meter.tone === "warning" || meter.tone === "danger" ? toneColor(meter.tone, theme) : theme.colors.foreground;
            return (
              <View key={meter.key} style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 4 }}>
                {left !== null ? (
                  <CountdownBar progress={1 - left / FIVE_HOUR_MS} theme={theme} />
                ) : (
                  <MeterBar usedPct={meter.usedPct} tone={meter.tone} theme={theme} />
                )}
                <Text numberOfLines={1} style={{ fontSize: 11, fontVariant: ["tabular-nums"], color }}>
                  {left !== null ? formatLeft(left) : formatPct(meter.usedPct)}
                  <Text style={{ color: muted }}>{meter.shortLabel ? ` ${meter.shortLabel}` : ""}</Text>
                </Text>
              </View>
            );
          })}
        </View>
      ))}
    </Pressable>
  );
}
