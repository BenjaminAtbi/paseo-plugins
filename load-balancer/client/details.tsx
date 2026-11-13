import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { useBetaSettings } from "./data";

/** The settings page's beta switch. */
export function BetaSettings({ theme }: { theme: PluginTheme }) {
  const beta = useBetaSettings();

  function toggleHeaderProxy(headerProxy: boolean) {
    if (beta.settings.status !== "ready") return;
    void beta.settings.save({ ...beta.settings.values, headerProxy }, beta.settings.revision);
  }

  return (
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
  );
}
