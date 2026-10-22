import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startContextPills } from "./client/pills";

export default function contribute(client: PluginClientContext) {
  return startContextPills(client);
}
