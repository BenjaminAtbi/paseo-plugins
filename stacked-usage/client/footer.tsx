import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";
import { isShown } from "../shared/usage";
import { formatPct, toneColor, useDisplaySettings, useUsageRows } from "./data";
import { MeterBar } from "./meter";

/** One line per account, stacked, each with its shown windows as coloured meters. */
export function UsageFooter({ theme, openScreen }: PluginSidebarItemProps) {
  const usage = useUsageRows();
  const { values } = useDisplaySettings();
  const rows = (usage.data?.rows ?? [])
    .map((row) => ({ ...row, meters: row.meters.filter((meter) => isShown(meter, values)) }))
    .filter((row) => row.meters.length > 0);
  if (rows.length === 0) return null;

  const muted = theme.colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Usage by account"
      onPress={() => openScreen({ screenId: "usage" })}
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
          {row.meters.map((meter) => (
            <View key={meter.key} style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 4 }}>
              <MeterBar usedPct={meter.usedPct} tone={meter.tone} theme={theme} />
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 11,
                  fontVariant: ["tabular-nums"],
                  color: meter.tone === "warning" || meter.tone === "danger" ? toneColor(meter.tone, theme) : theme.colors.foreground,
                }}
              >
                {formatPct(meter.usedPct)}
                <Text style={{ color: muted }}>{meter.shortLabel ? ` ${meter.shortLabel}` : ""}</Text>
              </Text>
            </View>
          ))}
        </View>
      ))}
    </Pressable>
  );
}
