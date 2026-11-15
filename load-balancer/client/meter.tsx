import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
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

const TICK_WIDTH = 2;
const TICK_GAP = 2;

/**
 * A full session window counting down to its reset: the red bar stays, and a row of upright ticks in
 * the accent blue (the Default badge's) fills it from the left as the window's five hours pass.
 */
export function CountdownBar({ progress, theme, height = 5 }: { progress: number; theme: PluginTheme; height?: number }) {
  const [width, setWidth] = useState(0);
  const blue = theme.colors.accent;
  const fraction = Math.max(0, Math.min(1, progress));
  const head = fraction * width;
  const ticks: number[] = [];
  for (let left = 0; left + TICK_WIDTH <= head - TICK_GAP; left += TICK_WIDTH + TICK_GAP) ticks.push(left);
  return (
    <View style={{ flex: 1, minWidth: 20, height }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderRadius: height / 2, backgroundColor: theme.colors.statusDanger }} />
      {ticks.map((left) => (
        <View key={left} style={{ position: "absolute", left, top: 0, bottom: 0, width: TICK_WIDTH, backgroundColor: blue }} />
      ))}
      {width > 0 ? (
        <View style={{ position: "absolute", left: head, top: 0, bottom: 0, width: TICK_WIDTH, marginLeft: -TICK_WIDTH / 2, backgroundColor: blue }} />
      ) : null}
    </View>
  );
}
