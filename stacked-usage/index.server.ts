import type { PluginServerContext } from "@getpaseo/plugin/server";
import { discover, fetchUsage, inputSchema, type Family } from "./server/zerosub";
import { listUsage } from "./server/list";
import { displaySettings } from "./shared/settings";
import { listUsageRpc } from "./shared/usage";

const FAMILIES: { family: Family; label: string }[] = [
  { family: "claude", label: "Claude" },
  { family: "codex", label: "Codex" },
];

export default function contribute(server: PluginServerContext) {
  server.registerSettings(displaySettings);
  server.handle(listUsageRpc, listUsage);
  for (const { family, label } of FAMILIES) {
    server.registerUsageSource({
      id: `zerosub-${family}`,
      // Labelled like Paseo's built-in source so both read "Claude (<email>)" side by side.
      label,
      icon: `assets/${family}.svg`,
      input: inputSchema,
      discover: (scope) => discover(family, scope),
      fetch: fetchUsage,
    });
  }
  return () => {};
}
