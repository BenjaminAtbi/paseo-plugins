// A counter that moves whenever a usage reading lands (a poll, a mod hand-off, a proxied
// response), so the app can wait for the next one instead of polling on a timer.

export class Changes {
  private version = 0;
  private readonly waiters = new Set<() => void>();

  bump(): void {
    this.version += 1;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  /** Resolves with the version once it differs from `since`, or after `timeoutMs` regardless. */
  wait(since: number, timeoutMs: number): Promise<number> {
    if (since !== this.version) return Promise.resolve(this.version);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(this.version);
      };
      const timer = setTimeout(wake, timeoutMs);
      this.waiters.add(wake);
    });
  }

  stop(): void {
    for (const wake of [...this.waiters]) wake();
  }
}
