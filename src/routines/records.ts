import { PreconditionError, type ArtifactStore } from "../artifacts/index.js";

// A period's records in the artifact store (S-D24): everything under jobs/<routine>/<period>/ (a dry run's under
// jobs/<routine>/dryrun/<period>/), written by the bot only:
//   lease.json          who runs the period now (lease.ts)
//   run.json            its state, steps, runs and traces; every write carries the writer's lease token
//   input.json          the steps' in.json without data
//   data.json           the last checkpointed step's output (data, classifyInput): a retry skips that far
//   output.json         the classify run's result, or an agent routine's output: the next period's memory
//   state.json          the render step's state: the next period's previous.state
//   bundle/             the delivery bundle, split into files; manifest.json last, so its presence means complete
//   delivered.json      per delivery target, its outcome; a target recorded as delivered is never delivered again
//   delivery-pending.json  until the Outbox exists: what would have been delivered

/** Every key routines use starts with this; the IAM policy allows nothing else. */
export const PREFIX = "jobs/";

export function periodDir(routine: string, period: string, dryRun: boolean): string {
  return `${PREFIX}${routine}/${dryRun ? "dryrun/" : ""}${period}/`;
}

export interface LeaseRecord {
  /** The Pod. */
  holder: string;
  /** Random per acquisition: run.json and delivered.json carry it, so a superseded holder's writes are told apart. */
  token: string;
  expiresAt: string;
}

export type RunState = "running" | "delivered" | "failed";

export interface StepRecord {
  name: string;
  state: "running" | "done" | "failed" | "skipped";
  startedAt?: string;
  endedAt?: string;
  attempts?: number;
  exitCode?: number;
  runId?: string;
  reason?: string;
}

export interface RunRecord {
  kind: "agent" | "pipeline";
  state: RunState;
  /** Lease token of the holder that wrote this. */
  token: string;
  holder: string;
  /** The period's absolute deadline: set when it first starts; takeovers and retries keep it, only force resets it. */
  deadlineAt: string;
  startedAt: string;
  /** Every write sets it; long steps (runs) refresh it every minute. */
  updatedAt: string;
  /** The step in progress, and its budget: `stalled` is updatedAt older than the budget plus 5 minutes. */
  step?: string;
  stepBudgetSec?: number;
  steps: StepRecord[];
  runIds: string[];
  /** Each holder of the period in turn, with its trace (a takeover is a new trace). */
  holders: { holder: string; token: string; startedAt: string; traceId?: string }[];
  degraded: boolean;
  reason?: string;
}

export interface DeliveredTarget {
  ok: boolean;
  at: string;
  link?: string;
  error?: string;
  /** What the Outbox reports per step of the target (message, attachments, page). */
  detail?: unknown;
}

export interface DeliveredRecord {
  token: string;
  targets: Record<string, DeliveredTarget>;
}

export function parseJson<T>(body: string | undefined): T | undefined {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}

/** The holder's own lease is gone or someone else wrote the record: stop, write nothing more. */
export class Superseded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Superseded";
  }
}

/**
 * A JSON record only the lease holder writes (run.json, delivered.json): each write checks the lease first
 * (`ensure`), is conditional on the etag this holder last saw, and carries its token. Writes are serialized, so the
 * minute refresh and a step's own write never race each other's etag.
 * S3's answers: 412 (someone else wrote it) and 404 (it is gone) supersede this holder; 409 (a concurrent request)
 * reads it again and retries once if the record is still this holder's.
 */
export class OwnedRecord<T extends { token: string }> {
  private etag: string | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  value: T | undefined;

  constructor(
    private store: ArtifactStore,
    readonly key: string,
    private token: string,
    private ensure: () => Promise<void>,
  ) {}

  /** Start from what is stored (read before the lease was taken, or just now). */
  init(current: { value: T; etag: string } | undefined): void {
    this.value = current?.value;
    this.etag = current?.etag;
  }

  /** Reads the stored record into this one. */
  async load(): Promise<T | undefined> {
    const o = await this.store.get(this.key);
    this.etag = o?.etag;
    this.value = parseJson<T>(o?.body);
    return this.value;
  }

  write(next: T): Promise<void> {
    return this.update(() => next);
  }

  /** `next` gets the record as this holder last wrote it, after every write queued before. */
  update(next: (current: T | undefined) => T): Promise<void> {
    const run = this.chain.then(() => this.put(next(this.value)));
    this.chain = run.catch(() => {});
    return run;
  }

  private async put(next: T, retried = false): Promise<void> {
    await this.ensure();
    const body = JSON.stringify({ ...next, token: this.token });
    try {
      const { etag } = await this.store.put(this.key, body, this.etag === undefined ? { ifNoneMatch: "*" } : { ifMatch: this.etag });
      this.etag = etag;
      this.value = { ...next, token: this.token };
    } catch (err) {
      if (!(err instanceof PreconditionError)) throw err;
      if (err.status === 409 && !retried) {
        const cur = await this.store.get(this.key);
        const v = parseJson<T>(cur?.body);
        // Absent, or written by this holder: the conflict was our own earlier request; go on from what is there.
        if (!cur || v?.token === this.token) {
          this.etag = cur?.etag;
          return this.put(next, true);
        }
      }
      throw new Superseded(`${this.key}: written by another holder (HTTP ${err.status})`);
    }
  }
}
