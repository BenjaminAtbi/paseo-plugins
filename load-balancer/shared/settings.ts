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

/** Opt-in features. `headerProxy` reads Claude usage from model responses through a local proxy. */
export const betaSettings = defineSettings({
  id: "beta",
  scope: "host",
  version: 1,
  schema: z.object({
    headerProxy: z.boolean().default(false),
  }),
});

/** Sent after an automatic switch, so the interrupted turn keeps going. */
export const DEFAULT_CONTINUE_PROMPT =
  "You were interrupted by a usage limit; that has been sorted out. Continue exactly where you left off.";

/** Which account each Claude session opens on, and what happens when one runs out. */
export const routingSettings = defineSettings({
  id: "routing",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Off by default; sessions change account from their next open. */
    enabled: z.boolean().default(false),
    /** Move an agent to another account when its account hits a usage limit or signs out. */
    autoSwitch: z.boolean().default(true),
    /** After an automatic switch, send a follow-up so the interrupted turn keeps going. */
    autoContinue: z.boolean().default(true),
    continuePrompt: z.string().trim().min(1).max(500).default(DEFAULT_CONTINUE_PROMPT),
    /** When the default changes, open agents that follow it move too; off, they stay where they run. */
    moveAgentsOnDefaultChange: z.boolean().default(true),
    /** New agents open on the account with the most room instead of the default. */
    balanceNewAgents: z.boolean().default(false),
    showComposerPill: z.boolean().default(true),
  }),
});
export type RoutingPreferences = z.output<typeof routingSettings.schema>;
