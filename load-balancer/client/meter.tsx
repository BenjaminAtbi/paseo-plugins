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

/**
 * A full session window counting down to its reset: the red bar stays, a yellow line runs along
 * its middle from the left as the window's five hours pass, with an upright yellow tick at its head.
 */
export function CountdownBar({
  progress,
  theme,
  height = 5,
}: {
  /** Share of the window's five hours gone, 0-1. */
  progress: number;
  theme: PluginTheme;
  height?: number;
}) {
  const yellow = theme.colors.statusWarning;
  const head = `${Math.max(0, Math.min(1, progress)) * 100}%` as const;
  const line = Math.max(1, Math.round(height / 4));
  return (
    <View style={{ flex: 1, minWidth: 20, height, justifyContent: "center" }}>
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          borderRadius: height / 2,
          backgroundColor: theme.colors.statusDanger,
        }}
      />
      <View style={{ position: "absolute", left: 0, width: head, top: (height - line) / 2, height: line, backgroundColor: yellow }} />
      <View style={{ position: "absolute", left: head, top: 0, bottom: 0, width: 2, marginLeft: -1, backgroundColor: yellow }} />
    </View>
  );
}
