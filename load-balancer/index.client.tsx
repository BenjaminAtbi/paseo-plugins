import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { switchRowSchema, SWITCH_ROW_KIND, SWITCH_ROW_VERSION } from "./shared/timeline";
import { AccountsScreen } from "./client/accounts";
import { contributeCommands } from "./client/commands";
import { contributePills } from "./client/pills";
import { createAccountsStore } from "./client/store";
import { SwitchRowView } from "./client/switch-row";
import { UsageDetails } from "./client/details";
import { UsageFooter } from "./client/footer";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "usage", title: "Usage by account", Component: UsageDetails });
  client.addScreen({ id: "accounts", title: "Accounts", Component: AccountsScreen });
  client.addSettingsScreen({ id: "accounts", title: "Accounts", icon: "Users", Component: AccountsScreen });
  client.addSidebarHeaderItem({
    id: "accounts",
    title: "Accounts (Load Balancer)",
    Component: ({ currentScreen, openScreen }) => (
      <SidebarRow
        icon="Users"
        active={currentScreen?.screenId === "accounts"}
        onPress={() => openScreen({ screenId: "accounts" })}
      />
    ),
  });
  client.addSettingsScreen({ id: "meters", title: "Sidebar meters", icon: "CircleGauge", Component: UsageDetails });
  client.addSidebarFooterItem({ id: "meters", title: "Usage meters", Component: UsageFooter });
  client.addTimelineRenderer({ kind: SWITCH_ROW_KIND, version: SWITCH_ROW_VERSION, schema: switchRowSchema, Component: SwitchRowView });
  const store = createAccountsStore(client);
  const stopPills = contributePills(client, store);
  const stopCommands = contributeCommands(client, store);
  return () => {
    stopPills();
    stopCommands();
    store.stop();
  };
}
