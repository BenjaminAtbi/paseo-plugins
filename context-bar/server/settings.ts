import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { CompactSettings } from "../shared/compact";

// Paseo's agents may run under other config directories (ZeroSub gives each account its own),
// but their settings.json files are symlinks to this one, so the user file is the one to read.
// CLAUDE_CODE_AUTO_COMPACT_WINDOW and --autocompact are per-launch overrides this cannot see.
function settingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "settings.json");
}

const WindowSchema = z.union([z.number().int().positive(), z.literal("auto")]);

const SettingsSchema = z.object({
  autoCompactWindow: z.number().int().positive().optional().catch(undefined),
  modelSettings: z
    .record(z.string(), z.object({ autoCompactWindow: WindowSchema.optional().catch(undefined) }).passthrough())
    .optional()
    .catch(undefined),
});

export async function readCompactSettings(): Promise<CompactSettings> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(settingsPath(), "utf8"));
  } catch {
    return { window: null, perModel: {} };
  }
  const parsed = SettingsSchema.safeParse(raw);
  if (!parsed.success) return { window: null, perModel: {} };
  const perModel: CompactSettings["perModel"] = {};
  for (const [model, entry] of Object.entries(parsed.data.modelSettings ?? {})) {
    if (entry.autoCompactWindow !== undefined) perModel[model] = entry.autoCompactWindow;
  }
  return { window: parsed.data.autoCompactWindow ?? null, perModel };
}
