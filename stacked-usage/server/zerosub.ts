import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  hashAccountKey,
  toneFromUsedPct,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
  type UsageScope,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

// ZeroSub keeps its accounts and its latest usage readings as JSON under $PASEO_HOME/zerosub.
// This module only reads those files: ZeroSub already polls each provider, so reporting its
// readings costs no extra calls against the providers' rate-limited usage endpoints.

export type Family = "claude" | "codex";

function zerosubDir(): string {
  return join(process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo"), "zerosub");
}

const AccountSchema = z.object({
  id: z.string(),
  family: z.string(),
  kind: z.string().optional(),
  label: z.string().nullish(),
  email: z.string().nullish(),
  plan: z.string().nullish(),
  identity: z.string().nullish(),
  disabled: z.boolean().optional(),
  signedIn: z.boolean().optional(),
});
type Account = z.infer<typeof AccountSchema>;

const StateSchema = z.object({ accounts: z.array(z.unknown()) });

const ReadingSchema = z.object({
  fetchedAt: z.string().nullish(),
  windows: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().nullish(),
        usedPercent: z.number().nullish(),
        resetsAt: z.string().nullish(),
      }),
    )
    .nullish(),
  error: z.unknown().nullish(),
});
type Reading = z.infer<typeof ReadingSchema>;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readAccounts(): Promise<Account[]> {
  const state = StateSchema.parse(await readJson(join(zerosubDir(), "state.json")));
  // Parse entries one at a time so a single account in a newer shape cannot hide the rest.
  return state.accounts.flatMap((entry) => {
    const parsed = AccountSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

async function readReadings(): Promise<Record<string, Reading>> {
  const raw = z.record(z.string(), z.unknown()).parse(await readJson(join(zerosubDir(), "usage.json")));
  const readings: Record<string, Reading> = {};
  for (const [id, value] of Object.entries(raw)) {
    const parsed = ReadingSchema.safeParse(value);
    if (parsed.success) readings[id] = parsed.data;
  }
  return readings;
}

/** Same subscription, whichever login of it ZeroSub holds. */
function subscriptionOf(account: Account): string {
  return account.identity || account.email || account.id;
}

export const inputSchema = z.object({ family: z.enum(["claude", "codex"]), subscription: z.string() });
type Input = z.infer<typeof inputSchema>;

/**
 * One usage account per subscription ZeroSub can switch to. The CLI's own login (ZeroSub's
 * "main" account) is skipped, together with every other login of that subscription, because
 * Paseo's built-in source for the family already reports it.
 */
export async function discover(family: Family, scope: UsageScope): Promise<UsageAccount[]> {
  if (scope.kind !== "global") return [];
  const accounts = (await readAccounts()).filter((a) => a.family === family && !a.disabled);
  const builtIn = new Set(accounts.filter((a) => a.kind === "main").map(subscriptionOf));
  const seen = new Set<string>();
  const result: UsageAccount[] = [];
  for (const account of accounts) {
    const subscription = subscriptionOf(account);
    if (builtIn.has(subscription) || seen.has(subscription)) continue;
    seen.add(subscription);
    const input: Input = { family, subscription: hashAccountKey(subscription) };
    result.push({
      key: input.subscription,
      // The email matches the label Paseo's built-in source gives the same account, so a
      // client can tell the two reports of one subscription apart from two subscriptions.
      label: account.email || account.label || account.id,
      input,
    });
  }
  return result;
}

const WINDOW_NAMES: Record<string, { id: string; label: string; shortLabel: string }> = {
  five_hour: { id: "five_hour", label: "Session", shortLabel: "5h" },
  seven_day: { id: "weekly", label: "Weekly", shortLabel: "wk" },
};

function toWindow(window: NonNullable<Reading["windows"]>[number]): UsageWindow {
  const name = WINDOW_NAMES[window.id] ?? {
    id: window.id,
    label: window.label || window.id,
    shortLabel: window.label || window.id,
  };
  return windowFromUsedPct({
    ...name,
    summary: window.id in WINDOW_NAMES,
    utilizationPct: window.usedPercent ?? null,
    resetsAt: window.resetsAt ?? null,
    tone: toneFromUsedPct(window.usedPercent ?? null),
  });
}

export async function fetchUsage(raw: unknown): Promise<UsageReport> {
  const input = inputSchema.parse(raw);
  const logins = (await readAccounts()).filter(
    (a) => a.family === input.family && hashAccountKey(subscriptionOf(a)) === input.subscription,
  );
  if (logins.length === 0) return { status: "error", error: "ZeroSub no longer lists this account" };

  // Several logins of one subscription share its limits; report the freshest reading.
  const readings = await readReadings();
  const latest = logins
    .map((login) => ({ login, reading: readings[login.id] }))
    .filter((entry): entry is { login: Account; reading: Reading } => !!entry.reading?.windows?.length)
    .sort((a, b) => (b.reading.fetchedAt ?? "").localeCompare(a.reading.fetchedAt ?? ""))[0];
  if (!latest) return { status: "error", error: "ZeroSub has no usage reading for this account yet" };

  const plan = latest.login.plan;
  return {
    status: "available",
    planLabel: plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined,
    windows: (latest.reading.windows ?? []).map(toWindow),
    details: latest.reading.fetchedAt
      ? [{ id: "read_at", label: "Reading taken by ZeroSub", value: latest.reading.fetchedAt }]
      : [],
  };
}
