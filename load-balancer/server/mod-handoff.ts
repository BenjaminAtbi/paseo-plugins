import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { HANDOFF_DIR, usageFile } from "./claude-mod";
import type { HeaderReadings } from "./readings";

// Reads what the Claude Code mod hands over: one file per agent, rewritten after each model
// response. The folder watch keeps usage current during long turns; a turn's end reads its agent's
// file directly, since watch events can arrive late or bunched.

const FileSchema = z.object({
  version: z.literal(1),
  readAt: z.string(),
  headers: z.record(z.string(), z.string()),
});

const SETTLE_MS = 100;
const SUFFIX = ".usage.json";

export class ModHandoff {
  private watcher: FSWatcher | null = null;
  private readonly seen = new Map<string, string>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  /** `emailOf` names the account an agent's session runs on, when known. */
  constructor(
    private readonly readings: HeaderReadings,
    private readonly emailOf: (agentId: string) => string | null,
  ) {}

  start(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(HANDOFF_DIR, (_event, name) => {
        const file = name?.toString();
        if (!file?.endsWith(SUFFIX)) return;
        const agentId = file.slice(0, -SUFFIX.length);
        // One write can raise several events; read once it has settled.
        clearTimeout(this.pending.get(agentId));
        this.pending.set(
          agentId,
          setTimeout(() => {
            this.pending.delete(agentId);
            void this.ingest(agentId);
          }, SETTLE_MS),
        );
      });
      this.watcher.on("error", (error) => console.warn("[Load Balancer] watching the mod's hand-off folder stopped", error.message));
    } catch (error) {
      console.warn("[Load Balancer] could not watch the mod's hand-off folder", error instanceof Error ? error.message : error);
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  /** Takes the agent's latest hand-off, if there is a new one. A file caught mid-write is skipped. */
  async ingest(agentId: string): Promise<void> {
    const raw = await readFile(usageFile(agentId), "utf8").catch(() => null);
    if (!raw) return;
    let parsed: z.infer<typeof FileSchema>;
    try {
      parsed = FileSchema.parse(JSON.parse(raw));
    } catch {
      return;
    }
    if (this.seen.get(agentId) === parsed.readAt) return;
    this.seen.set(agentId, parsed.readAt);
    const now = new Date(parsed.readAt);
    this.readings.record(parsed.headers, { now: Number.isNaN(now.getTime()) ? undefined : now, email: this.emailOf(agentId) });
  }

  forget(agentId: string): void {
    this.seen.delete(agentId);
  }
}
