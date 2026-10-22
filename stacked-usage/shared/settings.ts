import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Which meters the sidebar shows. A meter key is `<provider row key>/<window id>`.
 * Windows Paseo marks as summary windows (session and weekly) show unless hidden;
 * the rest (per-model weekly limits and the like) show only once pinned.
 */
export const displaySettings = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({
    hidden: z.array(z.string()).default([]),
    pinned: z.array(z.string()).default([]),
  }),
});
