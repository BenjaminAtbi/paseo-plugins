import type { PluginClientContext } from "@getpaseo/plugin/client";
import { UsageDetails } from "./client/details";
import { UsageFooter } from "./client/footer";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "usage", title: "Usage by account", Component: UsageDetails });
  client.addSettingsScreen({ id: "meters", title: "Sidebar meters", icon: "CircleGauge", Component: UsageDetails });
  client.addSidebarFooterItem({ id: "meters", title: "Usage meters", Component: UsageFooter });
  return () => {};
}
