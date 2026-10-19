/** Bounded TTL set used to drop Slack event retries (per pod). */
export class Dedupe {
  private seen = new Map<string, number>();
  constructor(
    private ttlMs = 10 * 60_000,
    private max = 10_000,
    private now: () => number = Date.now,
  ) {}

  /** Returns true if `key` was already seen (and records it otherwise). */
  isDuplicate(key: string): boolean {
    const t = this.now();
    const prev = this.seen.get(key);
    if (prev !== undefined && t - prev < this.ttlMs) return true;
    this.seen.delete(key);
    this.seen.set(key, t);
    if (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }
}
