/** Why a wait for a slot ended without one. */
export type SlotWaitEnd = "timeout" | "aborted";

/**
 * A FIFO counting semaphore: at most `size` holders at once, the rest wait in arrival order. A waiter that times out
 * or is aborted leaves the queue without taking a slot.
 */
export class Slots {
  private free: number;
  private waiters: { grant: () => void }[] = [];

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error(`slots: size must be a positive integer, got ${size}`);
    this.free = size;
  }

  /** Holders plus waiters, for tests and logs. */
  get pending(): number {
    return this.size - this.free + this.waiters.length;
  }

  /** Resolves once a slot is held; rejects with the {@link SlotWaitEnd} when `timeoutMs` passes or `signal` aborts first. */
  acquire(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject("aborted" satisfies SlotWaitEnd);
    if (this.free > 0 && this.waiters.length === 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const leave = (why: SlotWaitEnd) => {
        const i = this.waiters.indexOf(waiter);
        if (i < 0) return;
        this.waiters.splice(i, 1);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(why);
      };
      const onAbort = () => leave("aborted");
      const waiter = {
        grant: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const timer = setTimeout(() => leave("timeout"), Math.max(0, timeoutMs));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Hands the slot to the longest waiter, or frees it. */
  release(): void {
    const next = this.waiters.shift();
    if (next) next.grant();
    else this.free = Math.min(this.size, this.free + 1);
  }
}
