// Adapted from ZeroSub (https://github.com/kapybara-org/zerosub, MIT, Copyright (c) 2026 Kapybara).
import { z } from "zod";

export const SWITCH_ROW_KIND = "load-balancer-switch";
export const SWITCH_ROW_VERSION = 1;

/** The note an agent's timeline gets when Load Balancer moves it to another account. */
export const switchRowSchema = z.object({
  from: z.string().nullable(),
  to: z.string(),
  reason: z.enum([
    /** `from` hit its usage limit. */
    "limit",
    /** `from` is no longer signed in. */
    "signed_out",
    /** The user picked another account for this agent. */
    "manual",
    /** The default account changed and this agent follows it. */
    "default",
    /** `from` was removed. */
    "removed",
    /** `from` was disabled for a while. */
    "disabled",
    /** `to` was enabled again, and this agent returns to it. */
    "enabled",
    /** Every account is at its limit; nothing to switch to. */
    "exhausted",
  ]),
  /** When the exhausted account frees up again, if known. */
  resetsAt: z.string().nullable(),
  /** A follow-up was sent so the interrupted turn continues. */
  continued: z.boolean(),
  /**
   * `switched`: the agent now runs on `to`. `pending`: it moves when its session next starts.
   * `stayed`: it remains on `from` (see `detail`).
   */
  outcome: z.enum(["switched", "pending", "stayed"]),
  detail: z.string().nullable(),
  at: z.string(),
});
export type SwitchRow = z.infer<typeof switchRowSchema>;
