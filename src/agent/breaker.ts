export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerOptions {
  /** Failed calls within `windowMs` that open the breaker. */
  failures: number;
  windowMs: number;
  /** How long the breaker stays open before letting one probe through. */
  cooldownMs: number;
  now?: () => number;
  onChange?: (state: BreakerState) => void;
}

/** One call's slot on a breaker. Report exactly one outcome when the call ends. */
export interface Lease {
  /** The model answered. */
  success(): void;
  /** The model failed (gateway error, timeout, unknown model, ...). */
  failure(error?: string): void;
  /** The call says nothing about the model (e.g. the request itself was rejected as too long). */
  release(): void;
}

/**
 * Per-model circuit breaker. While open, calls fail fast instead of waiting for timeouts; after the cooldown
 * one probe call is let through (half-open), and only its outcome closes or reopens the breaker.
 */
export class CircuitBreaker {
  private failureTimes: number[] = [];
  private openedAt = 0;
  private probing = false;
  private current: BreakerState = "closed";
  /** Error of the last failed call, for "model unavailable" messages. */
  lastError: string | undefined;

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

  /** A slot for one call, or undefined while open (or while the half-open probe is out). */
  acquire(): Lease | undefined {
    const s = this.state;
    if (s === "open" || (s === "half-open" && this.probing)) return undefined;
    const probe = s === "half-open";
    if (probe) this.probing = true;
    let done = false;
    const once = (f: () => void) => () => {
      if (done) return;
      done = true;
      f();
    };
    return {
      success: once(() => (probe ? this.close() : undefined)),
      failure: (error?: string) =>
        once(() => {
          if (error !== undefined) this.lastError = error;
          if (probe) this.open();
          else if (this.current === "closed") this.count();
          // A call that started before the breaker opened says nothing new.
        })(),
      release: once(() => {
        if (probe) this.probing = false;
      }),
    };
  }

  private count(): void {
    const now = this.now();
    this.failureTimes = this.failureTimes.filter((t) => now - t < this.o.windowMs);
    this.failureTimes.push(now);
    if (this.failureTimes.length >= this.o.failures) this.open();
  }

  private close(): void {
    this.probing = false;
    this.failureTimes = [];
    this.set("closed");
  }

  private open(): void {
    this.probing = false;
    this.failureTimes = [];
    this.openedAt = this.now();
    this.set("open");
  }
}
