import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const toneSchema = z.enum(["default", "ok", "warning", "danger"]);
export type Tone = z.infer<typeof toneSchema>;

export const meterSchema = z.object({
  /** `<row key>/<window id>`: what the display settings pin and hide. */
  key: z.string(),
  label: z.string(),
  shortLabel: z.string(),
  usedPct: z.number().nullable(),
  resetsAt: z.string().nullable(),
  tone: toneSchema,
  /** Paseo's own summary windows (session and weekly) show unless hidden. */
  summary: z.boolean(),
});
export type Meter = z.infer<typeof meterSchema>;

export const rowSchema = z.object({
  key: z.string(),
  /** Source and account, e.g. "Claude (someone@example.com)". */
  title: z.string(),
  /** The account part alone, short enough for the sidebar. */
  name: z.string(),
  planLabel: z.string().nullable(),
  error: z.string().nullable(),
  meters: z.array(meterSchema),
});
export type Row = z.infer<typeof rowSchema>;

export const listUsageRpc = defineRpc({
  name: "usage.list",
  input: z.object({ refresh: z.boolean().optional() }),
  output: z.object({ rows: z.array(rowSchema) }),
});

/** The thresholds Paseo uses when a window arrives without a tone. */
export function toneFor(usedPct: number | null, given?: string | null): Tone {
  const parsed = toneSchema.safeParse(given);
  if (parsed.success) return parsed.data;
  if (usedPct === null) return "default";
  return usedPct > 90 ? "danger" : usedPct >= 70 ? "warning" : "ok";
}

export function isShown(meter: Meter, settings: { hidden: string[]; pinned: string[] }): boolean {
  if (settings.pinned.includes(meter.key)) return true;
  return meter.summary && !settings.hidden.includes(meter.key);
}

export function setShown(
  meter: Meter,
  shown: boolean,
  settings: { hidden: string[]; pinned: string[] },
): { hidden: string[]; pinned: string[] } {
  const hidden = settings.hidden.filter((key) => key !== meter.key);
  const pinned = settings.pinned.filter((key) => key !== meter.key);
  if (shown && !meter.summary) pinned.push(meter.key);
  if (!shown && meter.summary) hidden.push(meter.key);
  return { hidden, pinned };
}
