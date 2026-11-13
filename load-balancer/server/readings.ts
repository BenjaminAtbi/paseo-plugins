import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import { dataPath, readData, writeData } from "./data";

// Usage readings taken from the headers on model responses, kept per account email.

const PREFIX = "anthropic-ratelimit-unified";
const HEADER_WINDOWS = { "5h": "five_hour", "7d": "weekly" } as const;
const ACCOUNTS_MS = 30_000;
const SAVE_MS = 5_000;
/** Polled and header resets for one window can differ by rounding. */
const SAME_RESET_MS = 60_000;

const WindowSchema = z.object({ usedPct: z.number(), resetsAt: z.string(), readAt: z.string().optional() });
export type HeaderWindow = z.infer<typeof WindowSchema>;
const StoreSchema = z.record(z.string(), z.record(z.string(), WindowSchema));
type Windows = z.infer<typeof StoreSchema>[string];

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseHeaders(headers: IncomingHttpHeaders, now = new Date()): Windows {
  const windows: Windows = {};
  for (const [suffix, id] of Object.entries(HEADER_WINDOWS)) {
    const utilization = Number(single(headers[`${PREFIX}-${suffix}-utilization`]) ?? NaN);
    const reset = Number(single(headers[`${PREFIX}-${suffix}-reset`]) ?? NaN);
    if (!Number.isFinite(utilization) || !Number.isFinite(reset)) continue;
    windows[id] = {
      usedPct: Math.min(100, Math.max(0, utilization * 100)),
      resetsAt: new Date(reset * 1000).toISOString(),
      readAt: now.toISOString(),
    };
  }
  return windows;
}

/** The org's account email, or null when no account or more than one person matches it. */
export function emailForOrg(identities: string[], org: string): string | null {
  const emails = new Set<string>();
  for (const identity of identities) {
    const [identityOrg, email] = identity.split("|");
    if (identityOrg === org && email) emails.add(email.toLowerCase());
  }
  return emails.size === 1 ? [...emails][0] : null;
}

type Polled = { usedPct: number | null; resetsAt: string | null };

/**
 * The better of a polled window and a header reading: a reading past its reset is ignored, a
 * later reset is a newer window, and within one window usage only rises.
 */
export function mergeWindow(polled: Polled, header: HeaderWindow | undefined, now = Date.now()): Polled {
  if (!header) return polled;
  const headerReset = Date.parse(header.resetsAt);
  if (!(headerReset > now)) return polled;
  const polledReset = polled.resetsAt ? Date.parse(polled.resetsAt) : NaN;
  if (polled.usedPct === null || !(polledReset > now)) return header;
  if (Math.abs(headerReset - polledReset) <= SAME_RESET_MS) return header.usedPct >= polled.usedPct ? header : polled;
  return headerReset > polledReset ? header : polled;
}

export class HeaderReadings {
  private readonly path = dataPath("readings.json");
  private byEmail: Record<string, Windows> = {};
  private identities: { at: number; value: string[] } | null = null;

  /** `listIdentities` gives every known `<orgUuid>|<email>`, to tell whose response a header is on. */
  constructor(private readonly listIdentities: () => Promise<string[]>) {}
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  async load(): Promise<void> {
    const saved = StoreSchema.safeParse(await readData(this.path));
    if (saved.success) this.byEmail = { ...saved.data, ...this.byEmail };
  }

  record(headers: IncomingHttpHeaders): void {
    const org = single(headers["anthropic-organization-id"]);
    const windows = parseHeaders(headers);
    if (!org || Object.keys(windows).length === 0) return;
    void this.attribute(org, windows).catch(() => undefined);
  }

  windowsFor(email: string): Windows | undefined {
    return this.byEmail[email.toLowerCase()];
  }

  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void writeData(this.path, this.byEmail).catch(() => undefined);
  }

  private async attribute(org: string, windows: Windows): Promise<void> {
    const email = emailForOrg(await this.knownIdentities(), org);
    if (!email) return;
    this.byEmail[email] = { ...this.byEmail[email], ...windows };
    this.saveTimer ??= setTimeout(() => this.flush(), SAVE_MS);
  }

  private async knownIdentities(): Promise<string[]> {
    if (this.identities && Date.now() - this.identities.at < ACCOUNTS_MS) return this.identities.value;
    const value = await this.listIdentities();
    this.identities = { at: Date.now(), value };
    return value;
  }
}
