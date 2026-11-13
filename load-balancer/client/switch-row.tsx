// Adapted from ZeroSub (https://github.com/kapybara-org/zerosub, MIT, Copyright (c) 2026 Kapybara).
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import type { SwitchRow } from "../shared/timeline";
import { formatReset } from "./data";

function cause(row: SwitchRow): string | null {
  const reset = formatReset(row.resetsAt);
  const from = row.from ?? "The previous account";
  switch (row.reason) {
    case "limit":
      return `${from} hit its usage limit${reset ? ` (${reset})` : ""}.`;
    case "signed_out":
      return `${from} is signed out — sign it in again from Accounts.`;
    case "removed":
      return `${from} was removed.`;
    case "disabled":
      return `${from} was disabled for now.`;
    case "enabled":
      return `${row.to} is enabled again.`;
    case "default":
      return "The default account changed.";
    default:
      return null;
  }
}

export function describeRow(row: SwitchRow): string {
  if (row.reason === "exhausted") {
    const reset = formatReset(row.resetsAt);
    return `Every Claude account is at its limit${reset ? `; ${row.from ?? "this one"} ${reset}` : ""}. Add another account or wait.${
      row.detail ? ` ${row.detail}` : ""
    }`;
  }
  const why = cause(row);
  const lead = why ? `${why} ` : "";
  switch (row.outcome) {
    case "stayed":
      return `${lead}This conversation stays on ${row.from ?? "its account"}.${row.detail ? ` ${row.detail}` : ""}`;
    case "pending":
      return `${lead}Moves to ${row.to} when its session next starts.`;
    default: {
      const from =
        row.from && row.reason !== "limit" && row.reason !== "signed_out" && row.reason !== "disabled" ? `from ${row.from} ` : "";
      return `${lead}Switched ${from}to ${row.to}${row.continued ? " and carried on" : ""}.`;
    }
  }
}

/** Inline note in an agent's timeline when Load Balancer moved it to another account. */
export function SwitchRowView({ item, theme }: PluginTimelineItemProps<SwitchRow>) {
  const row = item.data;
  const warning = row.reason === "limit" || row.reason === "signed_out" || row.reason === "exhausted" || row.outcome === "stayed";
  const icon = row.reason === "exhausted" || row.outcome === "stayed" ? "CircleAlert" : "ArrowRightLeft";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        alignSelf: "flex-start",
        maxWidth: "100%",
      }}
    >
      <Icon name={icon} size={14} color={warning ? theme.colors.statusWarning : theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, flexShrink: 1 }}>{describeRow(row)}</Text>
    </View>
  );
}
