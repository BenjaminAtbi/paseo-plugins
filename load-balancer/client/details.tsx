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
        label="Read usage through a local proxy"
        hint="For sessions that can't load Load Balancer's Claude Code mod (Claude Code before 2.1.321, or an organization that blocks mods), or other providers. Routes Claude sessions through a local proxy from each session's next open."
        value={beta.headerProxy}
        disabled={beta.settings.status !== "ready" || beta.settings.saving}
        onValueChange={toggleHeaderProxy}
      />
    </SettingsSection>
  );
}
