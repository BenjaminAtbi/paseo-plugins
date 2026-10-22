import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The auto-compact windows set in Claude Code's user settings, as Claude Code stores them. */
export const compactSettingsRpc = defineRpc({
  name: "compact.settings",
  input: z.object({}),
  output: z.object({
    /** Top-level `autoCompactWindow`, in tokens. */
    window: z.number().nullable(),
    /** `modelSettings.<model>.autoCompactWindow` per model; "auto" means the model's tuned default. */
    perModel: z.record(z.string(), z.union([z.number(), z.literal("auto")])),
  }),
});
export type CompactSettings = z.infer<(typeof compactSettingsRpc)["output"]>;

/** Claude Code's own default for models with a native 1M window, from its model-config docs. */
const ONE_MILLION_DEFAULT = 967_000;

/** Reduce a model id to the canonical name `modelSettings` is keyed by. */
function canonicalModel(model: string): string {
  return model
    .replace(/\[1m\]$/i, "")
    .replace(/-\d{8}$/, "")
    .toLowerCase();
}

export interface CompactPoint {
  tokens: number;
  source: string;
}

/**
 * Where Claude Code will auto-compact this agent: a per-model window, then the top-level
 * window, then Claude Code's default. Every window is capped at the model's context window.
 */
export function compactPoint(
  model: string | null,
  maxTokens: number,
  settings: CompactSettings | null,
): CompactPoint {
  const fallback: CompactPoint =
    maxTokens >= 1_000_000
      ? { tokens: ONE_MILLION_DEFAULT, source: "Claude Code default for 1M models" }
      : { tokens: maxTokens, source: "Claude Code default (the full window)" };
  if (!settings) return fallback;
  const key = model ? canonicalModel(model) : null;
  const perModel = key
    ? Object.entries(settings.perModel).find(([name]) => {
        const canonical = canonicalModel(name);
        return key === canonical || key.startsWith(`${canonical}-`);
      })?.[1]
    : undefined;
  if (perModel === "auto") return fallback;
  if (typeof perModel === "number")
    return { tokens: Math.min(perModel, maxTokens), source: `modelSettings for ${key}` };
  if (settings.window !== null)
    return { tokens: Math.min(settings.window, maxTokens), source: "autoCompactWindow" };
  return fallback;
}
