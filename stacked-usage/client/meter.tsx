import type { PluginTheme } from "@getpaseo/plugin";
import { View } from "react-native";
import type { Tone } from "../shared/usage";
import { toneColor } from "./data";

/** A thin bar filled to the used percentage, in the colour of its tone. */
export function MeterBar({
  usedPct,
  tone,
  theme,
  height = 5,
}: {
  usedPct: number | null;
  tone: Tone;
  theme: PluginTheme;
  height?: number;
}) {
  const width = `${Math.max(0, Math.min(100, usedPct ?? 0))}%` as const;
  return (
    <View
      style={{
        flex: 1,
        minWidth: 20,
        height,
        borderRadius: height / 2,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden",
      }}
    >
      <View style={{ width, height: "100%", backgroundColor: toneColor(tone, theme) }} />
    </View>
  );
}
