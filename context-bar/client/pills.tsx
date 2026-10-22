import type {
  PluginButtonContentProps,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { useSyncExternalStore, type ComponentType } from "react";
import { Text, View } from "react-native";
import { compactPoint, compactSettingsRpc, type CompactPoint, type CompactSettings } from "../shared/compact";

type Tone = "ok" | "warning" | "danger";

interface Reading {
  agentId: string;
  model: string | null;
  used: number;
  max: number;
  point: CompactPoint;
  /** Share of the way to the compaction point, 0-100 and beyond. */
  pct: number;
  tone: Tone;
}

interface AgentLike {
  id: string;
  workspaceId?: string;
  model: string | null;
  status: string;
  archivedAt?: string | null;
  internal?: boolean;
  lastUsage?: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number };
}

const CELLS = 6;
const SETTINGS_REFRESH_MS = 60_000;

function toneOf(pct: number): Tone {
  return pct > 90 ? "danger" : pct >= 70 ? "warning" : "ok";
}

function toneColor(tone: Tone, theme: PluginTheme): string {
  return tone === "danger"
    ? theme.colors.statusDanger
    : tone === "warning"
      ? theme.colors.statusWarning
      : theme.colors.statusSuccess;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 2)}M`;
  return `${Math.round(tokens / 1000)}k`;
}

/**
 * "▰▰▰▱▱▱ 47%": plain text, because a pill's label can only be a string. Paseo caps a
 * composer pill at 160px, which leaves about ten characters beside the icon.
 */
function barLabel(reading: Reading): string {
  const filled = Math.max(0, Math.min(CELLS, Math.round((reading.pct / 100) * CELLS)));
  return `${"▰".repeat(filled)}${"▱".repeat(CELLS - filled)} ${Math.round(reading.pct)}%`;
}

/** The pill's title, shown as its tooltip, carries what the label has no room for. */
function barTitle(reading: Reading): string {
  return `Context: ${formatTokens(reading.used)} of ${formatTokens(reading.point.tokens)} before compaction`;
}

// A pill's icon is the only part a plugin draws itself (16×16), so it carries the colour.
const DOTS: Record<Tone, ComponentType<PluginButtonIconProps>> = {
  ok: (props) => <Dot {...props} tone="ok" />,
  warning: (props) => <Dot {...props} tone="warning" />,
  danger: (props) => <Dot {...props} tone="danger" />,
};

function Dot({ theme, size, tone }: PluginButtonIconProps & { tone: Tone }) {
  const diameter = Math.round(size * 0.6);
  return (
    <View
      style={{ width: diameter, height: diameter, borderRadius: diameter / 2, backgroundColor: toneColor(tone, theme) }}
    />
  );
}

// Readings for the popover, which renders inside the app and reads them on demand.
const readings = new Map<string, Reading>();
const listeners = new Set<() => void>();
let version = 0;
function publish() {
  version += 1;
  for (const listener of listeners) listener();
}
function useReading(agentId: string): Reading | undefined {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  return readings.get(agentId);
}

function Details({ theme, ...context }: PluginButtonContentProps) {
  const reading = useReading(context.context === "agent" ? context.agentId : "");
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  if (!reading) return <Text style={muted}>No context reading yet.</Text>;
  const width = `${Math.max(0, Math.min(100, reading.pct))}%` as const;
  return (
    <View style={{ gap: 8, padding: 12, minWidth: 260 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
        {Math.round(reading.pct)}% of the way to compaction
      </Text>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        <View style={{ width, height: "100%", backgroundColor: toneColor(reading.tone, theme) }} />
      </View>
      <Text style={{ color: theme.colors.foreground }}>
        {reading.used.toLocaleString()} tokens used · compacts at {reading.point.tokens.toLocaleString()}
      </Text>
      <Text style={muted}>Compaction point: {reading.point.source}</Text>
      <Text style={muted}>
        Model window {reading.max.toLocaleString()} tokens{reading.model ? ` · ${reading.model}` : ""}
      </Text>
      <Text style={muted}>
        A per-launch override (CLAUDE_CODE_AUTO_COMPACT_WINDOW or --autocompact) is not visible here.
      </Text>
    </View>
  );
}

/**
 * One composer pill per live agent, kept current from the daemon's agent updates. Paseo
 * refreshes an agent's context count at every model call in a turn, so the pill moves
 * mid-turn, not only when the turn ends.
 */
export function startContextPills(client: PluginClientContext): () => void {
  const agents = new Map<string, AgentLike>();
  const pills = new Map<string, { registration: PluginButtonRegistration; label: string; title: string; tone: Tone }>();
  let settings: CompactSettings | null = null;
  let stopped = false;

  function render(agent: AgentLike) {
    const used = agent.lastUsage?.contextWindowUsedTokens;
    const max = agent.lastUsage?.contextWindowMaxTokens;
    const live = agent.workspaceId && !agent.archivedAt && !agent.internal && agent.status !== "closed";
    if (!live || typeof used !== "number" || typeof max !== "number" || max <= 0) {
      drop(agent.id);
      return;
    }
    const point = compactPoint(agent.model, max, settings);
    const pct = (used / point.tokens) * 100;
    const reading: Reading = { agentId: agent.id, model: agent.model, used, max, point, pct, tone: toneOf(pct) };
    readings.set(agent.id, reading);
    publish();

    const label = barLabel(reading);
    const title = barTitle(reading);
    const existing = pills.get(agent.id);
    if (existing) {
      if (existing.label === label && existing.title === title && existing.tone === reading.tone) return;
      existing.registration.update({ label, title, icon: DOTS[reading.tone] });
      existing.label = label;
      existing.title = title;
      existing.tone = reading.tone;
      return;
    }
    const registration = client.addComposerPill({
      id: `context-${agent.id}`,
      workspaceId: agent.workspaceId!,
      agentId: agent.id,
      button: {
        title,
        icon: DOTS[reading.tone],
        label,
        behavior: { kind: "popover", Content: Details },
      },
    });
    pills.set(agent.id, { registration, label, title, tone: reading.tone });
  }

  function drop(agentId: string) {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
    if (readings.delete(agentId)) publish();
  }

  function upsert(agent: AgentLike) {
    agents.set(agent.id, agent);
    render(agent);
  }

  async function refreshSettings() {
    try {
      const next = await client.rpc(compactSettingsRpc, {});
      if (JSON.stringify(next) === JSON.stringify(settings)) return;
      settings = next;
      for (const agent of agents.values()) render(agent);
    } catch (error) {
      console.warn("[context-bar] could not read Claude Code's compaction settings", error);
    }
  }

  let unsubscribe: (() => void) | undefined;
  let release: (() => Promise<void>) | undefined;
  void (async () => {
    await refreshSettings();
    try {
      // Updates arrive for agents this client is subscribed to; the listing holds that open.
      unsubscribe = client.paseo.agents.subscribe((update) => {
        if (update.kind === "upsert") upsert(update.agent);
        else {
          agents.delete(update.agentId);
          drop(update.agentId);
        }
      });
      const listing = await client.paseo.agents.list({ subscribe: {} });
      release = () => listing.subscription.release();
      if (stopped) {
        void release();
        return;
      }
      for (const entry of listing.entries) upsert(entry.agent);
    } catch (error) {
      console.warn("[context-bar] could not follow agents", error);
    }
  })();
  const timer = setInterval(() => void refreshSettings(), SETTINGS_REFRESH_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe?.();
    void release?.();
    for (const agentId of [...pills.keys()]) drop(agentId);
  };
}
