import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { ScrollView, Text, View } from "react-native";
import { isShown, setShown, type Meter, type Row } from "../shared/usage";
import { formatPct, formatReset, useDisplaySettings, useUsageRows } from "./data";
import { MeterBar } from "./meter";

function MeterLine({ meter, theme }: { meter: Meter; theme: PluginTheme }) {
  const reset = formatReset(meter.resetsAt);
  return (
    <View style={{ gap: 4, minWidth: 160 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <MeterBar usedPct={meter.usedPct} tone={meter.tone} theme={theme} height={6} />
        <Text style={{ color: theme.colors.foreground, fontVariant: ["tabular-nums"] }}>
          {formatPct(meter.usedPct)}
        </Text>
      </View>
      {reset ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{reset}</Text> : null}
    </View>
  );
}

/**
 * Every account and window Paseo knows about, with a switch for whether it shows in the
 * sidebar. Opened from the sidebar widget and from Settings, so the two never disagree.
 */
export function UsageDetails({ theme, layout }: PluginSurfaceProps) {
  const usage = useUsageRows();
  const { settings, values } = useDisplaySettings();
  const ready = settings.status === "ready";

  function toggle(meter: Meter, shown: boolean) {
    if (settings.status !== "ready") return;
    void settings.save(setShown(meter, shown, settings.values), settings.revision);
  }

  const rows: Row[] = usage.data?.rows ?? [];
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}
    >
      {usage.isLoading ? <Text style={{ color: theme.colors.foregroundMuted }}>Loading usage…</Text> : null}
      {usage.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>Could not read usage: {String(usage.error)}</Text>
      ) : null}
      {settings.saveError ? <Text style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text> : null}
      {rows.map((row) => (
        <SettingsSection key={row.key} title={row.planLabel ? `${row.title} · ${row.planLabel}` : row.title}>
          {row.error ? <Text style={{ color: theme.colors.statusWarning }}>{row.error}</Text> : null}
          {row.meters.map((meter) => (
            <SettingsSwitch
              key={meter.key}
              label={meter.label}
              hint={isShown(meter, values) ? "Shown in the sidebar" : "Hidden from the sidebar"}
              value={isShown(meter, values)}
              disabled={!ready || settings.saving}
              onValueChange={(shown) => toggle(meter, shown)}
            >
              <MeterLine meter={meter} theme={theme} />
            </SettingsSwitch>
          ))}
        </SettingsSection>
      ))}
      <SettingsAction
        label="Readings"
        hint="Paseo keeps each reading for five minutes; ZeroSub accounts show ZeroSub's latest reading."
        actionLabel={usage.isFetching ? "Refreshing…" : "Refresh"}
        disabled={usage.isFetching}
        onPress={() => void usage.refetch()}
      />
    </ScrollView>
  );
}
