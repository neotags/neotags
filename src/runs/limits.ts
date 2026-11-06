/** Sliding-window limit per key (runs per user per hour). In process memory, like the rest of the run state. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private o: { limit: number; windowMs: number; now?: () => number },
  ) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Take one slot for `key`; when none is left, how long until the oldest frees up. */
  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.o.windowMs);
    if (recent.length >= this.o.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: recent[0]! + this.o.windowMs - now };
    }
    recent.push(now);
    this.hits.set(key, recent);
    // Keep the map from growing with one-off keys.
    if (this.hits.size > 10_000) {
      for (const [k, ts] of this.hits) if (ts.every((t) => now - t >= this.o.windowMs)) this.hits.delete(k);
    }
    return { ok: true };
  }
}

/** Limit key: the asker's email when the entry knows it, else the session (O2 without a resolvable user). */
export function limitKey(input: { user?: string; sessionId: string }): string {
  const user = input.user?.trim().toLowerCase();
  return user ? `user:${user}` : `session:${input.sessionId}`;
}
