import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readCompactSettings } from "./server/settings";
import { compactSettingsRpc } from "./shared/compact";

export default function contribute(server: PluginServerContext) {
  server.handle(compactSettingsRpc, () => readCompactSettings());
  return () => {};
}
