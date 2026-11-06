export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerOptions {
  /** Failures within `windowMs` that open the breaker. */
  failures: number;
  windowMs: number;
  /** How long the breaker stays open before letting one probe through. */
  cooldownMs: number;
  now?: () => number;
  onChange?: (state: BreakerState) => void;
}

/**
 * Per-model circuit breaker. While open, calls fail fast instead of waiting for timeouts; after the cooldown
 * one probe call is let through (half-open), and its outcome closes or reopens the breaker.
 */
export class CircuitBreaker {
  private failureTimes: number[] = [];
  private openedAt = 0;
  private probing = false;
  private current: BreakerState = "closed";

  constructor(private o: BreakerOptions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private set(state: BreakerState): void {
    if (state === this.current) return;
    this.current = state;
    this.o.onChange?.(state);
  }

  get state(): BreakerState {
    if (this.current === "open" && this.now() - this.openedAt >= this.o.cooldownMs) this.set("half-open");
    return this.current;
  }

  /** May a call go out now? In half-open state only one probe at a time; the caller must then report its outcome. */
  tryAcquire(): boolean {
    const s = this.state;
    if (s === "closed") return true;
    if (s === "open" || this.probing) return false;
    this.probing = true;
    return true;
  }

  success(): void {
    this.probing = false;
    this.failureTimes = [];
    this.set("closed");
  }

  failure(): void {
    const now = this.now();
    if (this.current === "open") return; // a call that started before the breaker opened
    if (this.current === "half-open") return this.open(now);
    this.failureTimes = this.failureTimes.filter((t) => now - t < this.o.windowMs);
    this.failureTimes.push(now);
    if (this.failureTimes.length >= this.o.failures) this.open(now);
  }

  /** The call ended without telling us whether the model works (e.g. it was never sent); free the probe slot. */
  release(): void {
    this.probing = false;
  }

  private open(now: number): void {
    this.probing = false;
    this.failureTimes = [];
    this.openedAt = now;
    this.set("open");
  }
}
