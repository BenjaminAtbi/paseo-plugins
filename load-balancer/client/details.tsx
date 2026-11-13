import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsAction, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { useBetaSettings, useDisplaySettings, useUsageRows } from "./data";

/** The settings page's usage part: refreshing Paseo's readings, and the beta switch. */
export function UsageSettings({ theme }: { theme: PluginTheme }) {
  const usage = useUsageRows();
  const { settings } = useDisplaySettings();
  const beta = useBetaSettings();

  function toggleHeaderProxy(headerProxy: boolean) {
    if (beta.settings.status !== "ready") return;
    void beta.settings.save({ ...beta.settings.values, headerProxy }, beta.settings.revision);
  }

  return (
    <>
      {usage.isLoading ? <Text style={{ color: theme.colors.foregroundMuted }}>Loading usage…</Text> : null}
      {usage.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>Could not read usage: {String(usage.error)}</Text>
      ) : null}
      {settings.saveError ? <Text style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text> : null}
      <SettingsSection title="Sidebar meters">
        <SettingsAction
          label="Readings"
          hint="The switches on each account card choose which meters show. Paseo keeps each reading for five minutes."
          actionLabel={usage.isFetching ? "Refreshing…" : "Refresh"}
          disabled={usage.isFetching}
          onPress={() => void usage.refetch()}
        />
      </SettingsSection>
      <SettingsSection title="Beta">
        {beta.settings.saveError ? (
          <Text style={{ color: theme.colors.statusDanger }}>{beta.settings.saveError}</Text>
        ) : null}
        <SettingsSwitch
          label="Read Claude usage from model responses"
          hint="Routes Claude sessions through a local proxy, from each session's next open. Polling stays as the fallback."
          value={beta.headerProxy}
          disabled={beta.settings.status !== "ready" || beta.settings.saving}
          onValueChange={toggleHeaderProxy}
        />
      </SettingsSection>
    </>
  );
}
