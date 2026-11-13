import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const accountWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  usedPct: z.number().nullable(),
  resetsAt: z.string().nullable(),
});
export type AccountWindow = z.infer<typeof accountWindowSchema>;

/** Where an account's numbers came from: model-response headers, our poll, or Claude Code's cache. */
export const readingSourceSchema = z.enum(["headers", "poll", "cli"]);
export type ReadingSource = z.infer<typeof readingSourceSchema>;

export const accountViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  signedIn: z.boolean(),
  /** `main` is Claude Code's own sign-in (`~/.claude`), listed only when no home holds it. */
  kind: z.enum(["managed", "main"]),
  /** The same subscription is also the CLI's own login, which Paseo's built-in source reports. */
  isCliLogin: z.boolean(),
  status: z.enum(["ready", "limited", "signed_out", "disabled"]),
  isDefault: z.boolean(),
  disabled: z.boolean(),
  limitedUntil: z.string().nullable(),
  /** Live agents routed to this account. */
  agentCount: z.number(),
  windows: z.array(accountWindowSchema),
  readAt: z.string().nullable(),
  source: readingSourceSchema.nullable(),
  error: z.string().nullable(),
});
export type AccountView = z.infer<typeof accountViewSchema>;

export const loginStepSchema = z.enum(["starting", "waiting", "verifying", "done", "failed", "canceled"]);
export const loginViewSchema = z.object({
  id: z.string(),
  accountId: z.string().nullable(),
  step: loginStepSchema,
  /** Sign-in page whose code is pasted back here. */
  codeUrl: z.string().nullable(),
  message: z.string().nullable(),
});
export type LoginView = z.infer<typeof loginViewSchema>;

export const agentRouteSchema = z.object({
  agentId: z.string(),
  /** Where the agent is routed now. */
  accountId: z.string(),
  /** Chosen for this agent (by the user or after a limit) rather than following the default. */
  pinned: z.boolean(),
  /** Still running on this account until its session reopens. */
  pendingFrom: z.string().nullable(),
});
export type AgentRoute = z.infer<typeof agentRouteSchema>;

export const listAccountsRpc = defineRpc({
  name: "accounts.list",
  input: z.object({}),
  output: z.object({
    accounts: z.array(accountViewSchema),
    logins: z.array(loginViewSchema),
    /** When the next usage read may go out; reads are spaced to stay under Anthropic's limit. */
    nextReadAt: z.string().nullable(),
    routing: z.object({ enabled: z.boolean(), showComposerPill: z.boolean(), canReopen: z.boolean() }),
    agents: z.array(agentRouteSchema),
  }),
});

const ok = z.object({ ok: z.literal(true) });

export const startLoginRpc = defineRpc({
  name: "accounts.login.start",
  input: z.object({ accountId: z.string().optional() }),
  output: z.object({ id: z.string() }),
});

export const submitLoginCodeRpc = defineRpc({
  name: "accounts.login.code",
  input: z.object({ loginId: z.string(), code: z.string() }),
  output: ok,
});

export const cancelLoginRpc = defineRpc({
  name: "accounts.login.cancel",
  input: z.object({ loginId: z.string() }),
  output: ok,
});

export const renameAccountRpc = defineRpc({
  name: "accounts.rename",
  input: z.object({ accountId: z.string(), label: z.string() }),
  output: ok,
});

export const removeAccountRpc = defineRpc({
  name: "accounts.remove",
  input: z.object({ accountId: z.string() }),
  output: ok,
});

export const refreshAccountRpc = defineRpc({
  name: "accounts.refresh",
  input: z.object({ accountId: z.string() }),
  output: ok,
});

const reopenSummary = z.object({ reopened: z.number(), deferred: z.number(), failed: z.number() });
export type ReopenSummary = z.infer<typeof reopenSummary>;

export const setDefaultAccountRpc = defineRpc({
  name: "accounts.default",
  input: z.object({ accountId: z.string() }),
  output: reopenSummary,
});

export const setAccountEnabledRpc = defineRpc({
  name: "accounts.enabled",
  input: z.object({ accountId: z.string(), enabled: z.boolean() }),
  output: reopenSummary,
});

export const clearLimitRpc = defineRpc({
  name: "accounts.clear-limit",
  input: z.object({ accountId: z.string() }),
  output: ok,
});

/** `accountId: null` makes the agent follow the default again. */
export const setAgentAccountRpc = defineRpc({
  name: "accounts.agent",
  input: z.object({ agentId: z.string(), accountId: z.string().nullable() }),
  output: reopenSummary,
});
