import { randomUUID } from "node:crypto";
import { PreconditionError, type ArtifactStore } from "../artifacts/index.js";
import { parseJson, Superseded, type LeaseRecord } from "./records.js";

// One holder per period (S-D24): lease.json under the period's directory, taken with a conditional create, renewed
// with a conditional overwrite, taken over once expired, and released with a conditional delete. Every condition is
// on the etag this holder last wrote, so whoever writes second learns it (412) instead of overwriting.

export interface LeaseTiming {
  /** A lease not renewed for this long is free to take over. */
  ttlMs: number;
  /** How often the holder renews. */
  renewEveryMs: number;
  /** Before a side effect (a delivery, a write of run.json or delivered.json), renew first when less than this is left. */
  marginMs: number;
}

export const LEASE_TIMING: LeaseTiming = { ttlMs: 5 * 60_000, renewEveryMs: 2 * 60_000, marginMs: 60_000 };

export type AcquireResult = { ok: true; lease: Lease } | { ok: false; current?: LeaseRecord };

const conditional = (err: unknown, ...codes: number[]): boolean => err instanceof PreconditionError && codes.includes(err.status);

/**
 * Take the lease at `key` for `holder`: create it; if one exists and has expired, take it over (overwrite on its
 * etag). A lost race (412, 404, or 409 from a concurrent delete) is judged once more from what is there, never in a
 * loop. Not acquired: someone holds a live lease (`current`).
 */
export async function acquireLease(
  store: ArtifactStore,
  key: string,
  holder: string,
  o: { now: () => number; timing?: LeaseTiming; onLost?: (why: string) => void },
): Promise<AcquireResult> {
  const timing = o.timing ?? LEASE_TIMING;
  const token = randomUUID();
  const body = () => {
    const rec: LeaseRecord = { holder, token, expiresAt: new Date(o.now() + timing.ttlMs).toISOString() };
    return { rec, text: JSON.stringify(rec) };
  };
  const won = (etag: string, rec: LeaseRecord): AcquireResult => ({ ok: true, lease: new Lease(store, key, rec, etag, { ...o, timing }) });

  const first = body();
  try {
    return won((await store.put(key, first.text, { ifNoneMatch: "*" })).etag, first.rec);
  } catch (err) {
    if (!conditional(err, 412, 409)) throw err;
  }
  let current: LeaseRecord | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await store.get(key);
    const b = body();
    if (!cur) {
      // Released between our create and this read.
      current = undefined;
      try {
        return won((await store.put(key, b.text, { ifNoneMatch: "*" })).etag, b.rec);
      } catch (err) {
        if (!conditional(err, 412, 409)) throw err;
        continue;
      }
    }
    current = parseJson<LeaseRecord>(cur.body);
    const expires = Date.parse(current?.expiresAt ?? "");
    // An unreadable lease is no one's: take it over like an expired one.
    if (current && !Number.isNaN(expires) && expires > o.now()) return { ok: false, current };
    try {
      return won((await store.put(key, b.text, { ifMatch: cur.etag })).etag, b.rec);
    } catch (err) {
      if (!conditional(err, 412, 404, 409)) throw err;
    }
  }
  return { ok: false, ...(current && { current }) };
}

/** Thrown by `ensure` and `renew` once the lease is no longer this holder's. */
export class LeaseLost extends Superseded {
  constructor(message: string) {
    super(message);
    this.name = "LeaseLost";
  }
}

export class Lease {
  private timer: NodeJS.Timeout | undefined;
  private lostWhy: string | undefined;
  private released = false;
  private renewing: Promise<void> | undefined;

  constructor(
    private store: ArtifactStore,
    readonly key: string,
    private rec: LeaseRecord,
    private etag: string,
    private o: { now: () => number; timing: LeaseTiming; onLost?: (why: string) => void },
  ) {}

  get token(): string {
    return this.rec.token;
  }

  get holder(): string {
    return this.rec.holder;
  }

  get expiresAt(): number {
    return Date.parse(this.rec.expiresAt);
  }

  get lost(): boolean {
    return this.lostWhy !== undefined;
  }

  /** Renew every `renewEveryMs` until released or lost. */
  start(): void {
    if (this.timer || this.lost || this.released) return;
    this.timer = setInterval(() => void this.renew().catch(() => {}), this.o.timing.renewEveryMs);
    this.timer.unref();
  }

  private lose(why: string): never {
    if (!this.lostWhy) {
      this.lostWhy = why;
      this.stop();
      this.o.onLost?.(why);
    }
    throw new LeaseLost(why);
  }

  /** Before a side effect: throws LeaseLost when the lease is gone; renews first when it is about to expire. */
  async ensure(): Promise<void> {
    if (this.lostWhy) throw new LeaseLost(this.lostWhy);
    if (this.released) throw new LeaseLost("the lease was released");
    if (this.expiresAt - this.o.now() < this.o.timing.marginMs) await this.renew();
  }

  /** One renewal at a time; concurrent callers share it. */
  renew(): Promise<void> {
    this.renewing ??= this.doRenew().finally(() => (this.renewing = undefined));
    return this.renewing;
  }

  private async doRenew(retried = false): Promise<void> {
    if (this.lostWhy) throw new LeaseLost(this.lostWhy);
    if (this.released) return;
    const next: LeaseRecord = { ...this.rec, expiresAt: new Date(this.o.now() + this.o.timing.ttlMs).toISOString() };
    try {
      const { etag } = await this.store.put(this.key, JSON.stringify(next), { ifMatch: this.etag });
      this.etag = etag;
      this.rec = next;
    } catch (err) {
      if (err instanceof PreconditionError) {
        if (err.status === 409 && !retried) {
          const cur = await this.store.get(this.key);
          if (cur && parseJson<LeaseRecord>(cur.body)?.token === this.rec.token) {
            this.etag = cur.etag;
            return this.doRenew(true);
          }
        }
        this.lose(err.status === 404 ? "the lease is gone" : "the lease was taken over");
      }
      // S3 unreachable: keep trying on the next tick, but past the expiry someone may have taken it over.
      if (this.expiresAt <= this.o.now()) this.lose(`could not renew the lease before it expired: ${(err as Error).message}`);
      throw err;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Delete the lease if it is still the one this holder last wrote; someone else's is left alone. */
  async release(): Promise<void> {
    this.stop();
    if (this.released || this.lostWhy) return;
    this.released = true;
    await this.renewing?.catch(() => {});
    try {
      await this.store.delete(this.key, { ifMatch: this.etag });
    } catch (err) {
      if (!(err instanceof PreconditionError)) throw err;
    }
  }
}
