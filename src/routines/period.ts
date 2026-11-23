import type { Span } from "@opentelemetry/api";
import type { Logger } from "pino";
import type { ArtifactStore } from "../artifacts/index.js";
import type { Config, JobCaller, Routine } from "../config/index.js";
import { JobRequestError, type JobRunner } from "../runs/job.js";
import type { SkillExecutor } from "../sandbox/exec.js";
import { endRoutineSpan, spanTraceId, startRoutineSpan, traceparentOf } from "../telemetry/spans.js";
import { PeriodFailed, runPipeline, Stop, type PeriodHandle } from "./engine.js";
import { acquireLease, LEASE_TIMING, type Lease, type LeaseTiming } from "./lease.js";
import { deliveryTargets, type Outbox } from "./outbox.js";
import { OwnedRecord, parseJson, periodDir, PREFIX, Superseded, type DeliveredRecord, type LeaseRecord, type RunRecord, type StepRecord } from "./records.js";
import { PERIOD, periodError, previousFiring } from "./schedule.js";
import type { RoutineType } from "./types.js";

// A routine's periods (S-D24): `fire` takes the period's lease, writes run.json, answers 202 and runs the period in
// the background, apart from the request; `status` tells the fire command how it is going. Contracts:
// periods-lease.md and internal-api.md of the routines design; docs/design/003-internal-run-api.md §7.

/** A period's whole time, from its first start; takeovers and retries keep it, only force resets it. */
const PERIOD_MS = 3600_000;
/** `stalled`: no run.json write for the step's budget plus this. */
const STALL_GRACE_MS = 5 * 60_000;
/** Long steps (runs) refresh run.json's updatedAt this often. */
const REFRESH_MS = 60_000;
/** Longest wait for a jobsApi.concurrency slot for one sandbox step. */
const STEP_SLOT_TIMEOUT_MS = 15 * 60_000;
/** Budget of the delivery step, for `stalled`. */
const DELIVERY_BUDGET_SEC = 600;
/** An agent routine's memory: the previous period's summary and state, at most this long. */
const MAX_SUMMARY_CHARS = 4000;
const MAX_STATE_CHARS = 8000;
/** Periods looked at, newest first, for the previous completed one. */
const MAX_PREVIOUS_SCAN = 60;
const PREVIOUS_BATCH = 6;

/** The output of an agent routine's run (S-D17): fixed, not configurable. */
export const AGENT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    notify: { type: "boolean", description: "Whether there is anything worth posting (delivery.notify when_findings posts only then)" },
    summary: { type: "string", minLength: 1, maxLength: MAX_SUMMARY_CHARS, description: "A short summary; the next period reads it as its memory" },
    report: { type: "string", minLength: 1, description: "The full report, in Slack mrkdwn" },
    state: { type: "string", maxLength: MAX_STATE_CHARS, description: "Optional notes for the next period (ids to keep, open items)" },
  },
  required: ["notify", "summary", "report"],
  additionalProperties: false,
};

export class FireError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FireError";
  }
}

export type FireAnswer = { status: 200; body: { state: "delivered" | "failed" } } | { status: 202; body: { period: string } };

export interface PeriodStatus {
  state: "running" | "stalled" | "delivered" | "failed" | "orphaned";
  step: string | null;
  updatedAt: string | null;
  leaseExpiresAt: string | null;
  deadlineAt: string | null;
  runIds: string[];
  delivered: string[];
  reason?: string;
}

export interface RoutinesOptions {
  cfg: Pick<Config, "routines" | "agent">;
  store: ArtifactStore;
  /** runJob and its jobsApi.concurrency slots, which the engine's steps share (never another set). */
  jobs: Pick<JobRunner, "runJob" | "slots">;
  /** Runs the pipeline steps; absent: pipeline periods fail. */
  executor?: Pick<SkillExecutor, "exec">;
  types: ReadonlyMap<string, RoutineType>;
  /** Absent until the Outbox (S03): a period ends with delivery-pending.json and counts as delivered. */
  outbox?: Outbox;
  /** This Pod, in lease.json and run.json. */
  holder: string;
  log: Pick<Logger, "info" | "warn" | "error">;
  /** The run manager draining: fire answers 503. */
  isDraining?: () => boolean;
  now?: () => number;
  /** Tests shorten these. */
  timing?: Partial<LeaseTiming & { refreshMs: number; periodMs: number; stepSlotTimeoutMs: number }>;
}

const terminal = (r: RunRecord | undefined, now: number): "delivered" | "failed" | undefined =>
  r?.state === "delivered" ? "delivered" : r?.state === "failed" && Date.parse(r.deadlineAt) <= now ? "failed" : undefined;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createRoutines(o: RoutinesOptions) {
  const now = o.now ?? Date.now;
  const leaseTiming: LeaseTiming = { ...LEASE_TIMING, ...o.timing };
  const refreshMs = o.timing?.refreshMs ?? REFRESH_MS;
  const periodMs = o.timing?.periodMs ?? PERIOD_MS;
  const { store, log } = o;
  const iso = (ms = now()) => new Date(ms).toISOString();
  /** Periods running in the background here, by directory. */
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let draining = false;

  const routineOf = (name: string): Routine => {
    const r = Object.hasOwn(o.cfg.routines, name) ? o.cfg.routines[name] : undefined;
    if (!r) throw new FireError(404, "not_found", `unknown routine ${JSON.stringify(name.slice(0, 64))}`);
    return r;
  };

  async function readJson<T>(key: string): Promise<{ value: T; etag: string } | undefined> {
    const obj = await store.get(key);
    const value = parseJson<T>(obj?.body);
    return obj && value !== undefined ? { value, etag: obj.etag } : undefined;
  }

  /** The latest formal period before `period` that was delivered (zero targets count): its directory. */
  async function previousPeriod(name: string, period: string): Promise<string | undefined> {
    const base = `${PREFIX}${name}/`;
    const { prefixes } = await store.list(base, { delimiter: "/" });
    // dryrun/ is not a period name, so dry runs are never anyone's previous period.
    const periods = prefixes.map((p) => p.slice(base.length, -1)).filter((p) => PERIOD.test(p) && p < period).sort().reverse();
    const scan = periods.slice(0, MAX_PREVIOUS_SCAN);
    // In small batches, newest first: usually the first one is it, and a run of failed periods is not read one by one.
    for (let i = 0; i < scan.length; i += PREVIOUS_BATCH) {
      const batch = scan.slice(i, i + PREVIOUS_BATCH);
      const runs = await Promise.all(batch.map((p) => readJson<RunRecord>(`${base}${p}/run.json`)));
      const hit = runs.findIndex((r) => r?.value.state === "delivered");
      if (hit >= 0) return `${base}${batch[hit]}/`;
    }
    return undefined;
  }

  /** fire() calls past the draining check that have not registered their period yet: drain waits for them too. */
  const starting = new Set<Promise<unknown>>();

  async function fire(name: string, req: { period: string; dryRun?: boolean; force?: boolean }, caller: JobCaller): Promise<FireAnswer> {
    const routine = routineOf(name);
    if (draining || o.isDraining?.()) throw new FireError(503, "shutting_down", "shutting down; submit again");
    const p = start(name, routine, req, caller);
    starting.add(p);
    try {
      return await p;
    } finally {
      starting.delete(p);
    }
  }

  async function start(name: string, routine: Routine, req: { period: string; dryRun?: boolean; force?: boolean }, caller: JobCaller): Promise<FireAnswer> {
    const why = periodError(routine.trigger, req.period, now());
    if (why) throw new FireError(400, "bad_request", `period ${req.period}: ${why}`);
    const dryRun = req.dryRun === true;
    const force = req.force === true;
    const dir = periodDir(name, req.period, dryRun);
    const before = terminal((await readJson<RunRecord>(`${dir}run.json`))?.value, now());
    if (before && !force) return { status: 200, body: { state: before } };

    const controller = new AbortController();
    const got = await acquireLease(store, `${dir}lease.json`, o.holder, {
      now,
      timing: leaseTiming,
      onLost: (w) => controller.abort(new Stop("superseded", w)),
    });
    if (!got.ok) throw new FireError(409, "conflict", `period ${req.period} is held by ${got.current?.holder ?? "another holder"} until ${got.current?.expiresAt ?? "it expires"}`);
    const lease = got.lease;
    let span: Span | undefined;
    let run: OwnedRecord<RunRecord>;
    try {
      // Again under the lease: the last holder may have finished between the first read and the lease.
      const current = await readJson<RunRecord>(`${dir}run.json`);
      const done = terminal(current?.value, now());
      if (done && !force) {
        await lease.release();
        return { status: 200, body: { state: done } };
      }
      span = startRoutineSpan({ name, period: req.period, kind: routine.kind, dryRun, holder: o.holder });
      run = new OwnedRecord<RunRecord>(store, `${dir}run.json`, lease.token, () => lease.ensure());
      run.init(current);
      const prev = current?.value;
      const deadlineAt = force || !prev?.deadlineAt ? iso(now() + periodMs) : prev.deadlineAt;
      const traceId = spanTraceId(span);
      // Written before the 202: whoever polls next finds the period running, never missing.
      await run.write({
        kind: routine.kind,
        state: "running",
        token: lease.token,
        holder: o.holder,
        deadlineAt,
        startedAt: prev?.startedAt ?? iso(),
        updatedAt: iso(),
        steps: prev?.steps ?? [],
        runIds: prev?.runIds ?? [],
        holders: [...(prev?.holders ?? []), { holder: o.holder, token: lease.token, startedAt: iso(), ...(traceId && { traceId }) }],
        // A bundle rendered without problems stays degraded when another holder only delivers it.
        degraded: prev?.degraded ?? false,
      });
    } catch (err) {
      if (span) endRoutineSpan(span, { state: "failed", degraded: false, reason: errText(err) });
      await lease.release().catch(() => {});
      throw err;
    }
    lease.start();
    const p = new PeriodRun({ name, routine, period: req.period, dryRun, dir, lease, run, span, controller, caller });
    const entry = { controller, done: Promise.resolve() };
    // Only its own entry: a superseded run still unwinding must not drop a newer run of the same period on this Pod.
    entry.done = background(p).finally(() => {
      if (active.get(dir) === entry) active.delete(dir);
    });
    active.set(dir, entry);
    // A shutdown that began while this request was taking the lease.
    if (draining) controller.abort(new Stop("interrupted", "shutting down"));
    log.info({ routine: name, period: req.period, dryRun, holder: o.holder, deadlineAt: run.value?.deadlineAt, ...(force && { force }) }, "period started");
    return { status: 202, body: { period: req.period } };
  }

  interface PeriodInit {
    name: string;
    routine: Routine;
    period: string;
    dryRun: boolean;
    dir: string;
    lease: Lease;
    run: OwnedRecord<RunRecord>;
    span: Span;
    controller: AbortController;
    caller: JobCaller;
  }

  /** One period in the background: the handle the engine works through. */
  class PeriodRun {
    readonly traceparent: string | undefined;
    base: Record<string, unknown> = {};
    previousOutput: unknown;
    degraded = false;

    constructor(readonly i: PeriodInit) {
      this.traceparent = traceparentOf(i.span);
      this.degraded = i.run.value?.degraded ?? false;
    }

    get name() {
      return this.i.name;
    }
    get period() {
      return this.i.period;
    }
    get dryRun() {
      return this.i.dryRun;
    }
    get span() {
      return this.i.span;
    }
    get routine() {
      return this.i.routine as Extract<Routine, { kind: "pipeline" }>;
    }

    get signal() {
      return this.i.controller.signal;
    }

    checkpoint(): void {
      if (this.signal.aborted) throw this.signal.reason;
    }

    async read(file: string): Promise<string | undefined> {
      return (await store.get(this.i.dir + file))?.body;
    }

    async write(file: string, body: string): Promise<void> {
      this.checkpoint();
      await this.i.lease.ensure();
      await store.put(this.i.dir + file, body);
    }

    /** run.json with `patch` applied to what this holder last wrote. */
    async update(patch: (r: RunRecord) => Partial<RunRecord>): Promise<void> {
      await this.i.run.update((cur) => ({ ...cur!, ...patch(cur!), updatedAt: iso() }));
    }

    private step(r: RunRecord, name: string, s: Partial<StepRecord>): StepRecord[] {
      const steps = r.steps.filter((x) => x.name !== name);
      const prev = r.steps.find((x) => x.name === name);
      return [...steps, { ...prev, name, ...s } as StepRecord];
    }

    async stepStarted(name: string, budgetSec: number, patch: { attempts?: number } = {}): Promise<void> {
      this.checkpoint();
      await this.update((r) => ({ step: name, stepBudgetSec: budgetSec, steps: this.step(r, name, { state: "running", startedAt: iso(), ...patch, endedAt: undefined, reason: undefined }) }));
    }

    async stepEnded(name: string, patch: Omit<StepRecord, "name">): Promise<void> {
      this.checkpoint();
      await this.update((r) => ({ steps: this.step(r, name, { ...patch, endedAt: iso() }) }));
    }

    async refreshing<T>(work: Promise<T>): Promise<T> {
      const timer = setInterval(() => {
        if (this.signal.aborted) return;
        void this.update(() => ({})).catch((err: unknown) => {
          // Someone else holds the period now: stop the run at once instead of paying for it to the end.
          if (err instanceof Superseded) this.i.controller.abort(new Stop("superseded", err.message));
          else log.warn({ routine: this.i.name, period: this.i.period, err: errText(err) }, "could not refresh run.json");
        });
      }, refreshMs);
      timer.unref();
      try {
        return await work;
      } finally {
        clearInterval(timer);
      }
    }

    async noteRun(runId: string | undefined, degraded?: boolean): Promise<void> {
      if (degraded !== undefined) this.degraded = degraded;
      await this.update((r) => ({ ...(runId && { runIds: [...r.runIds, runId] }), ...(degraded !== undefined && { degraded }) }));
    }
  }

  async function background(p: PeriodRun): Promise<void> {
    const { name, routine, period, dryRun, lease, span, controller } = p.i;
    const fields = { routine: name, period, dryRun };
    const deadline = Date.parse(p.i.run.value!.deadlineAt);
    const timer = setTimeout(() => controller.abort(new Stop("deadline", "the period's deadline passed")), Math.max(0, deadline - now()));
    timer.unref();
    let state: "delivered" | "failed" | "interrupted" | "superseded" = "failed";
    let reason: string | undefined;
    try {
      p.checkpoint();
      if (deadline <= now()) throw new Stop("deadline", "the period's deadline passed");
      // A dry run reads the formal periods' memory too: it is meant to behave like the real one.
      const prevDir = await previousPeriod(name, period);
      const window = { start: previousFiring(routine.trigger, period) ?? null, end: period };
      let notify: boolean;
      if (routine.kind === "pipeline") {
        const prevState = prevDir ? parseJson<unknown>((await store.get(`${prevDir}state.json`))?.body) : undefined;
        p.previousOutput = prevDir ? parseJson<unknown>((await store.get(`${prevDir}output.json`))?.body) : undefined;
        p.base = { task: name, period, window, params: routine.params, delivery: routine.delivery, dryRun, previous: prevState !== undefined ? { state: prevState } : null };
        if (!o.executor) throw new PeriodFailed("no sandbox executor: pipeline steps cannot run");
        const r = await runPipeline(p satisfies PeriodHandle, {
          cfg: o.cfg,
          executor: o.executor,
          slots: o.jobs.slots,
          runJob: o.jobs.runJob,
          types: o.types,
          log,
          stepSlotTimeoutMs: o.timing?.stepSlotTimeoutMs ?? STEP_SLOT_TIMEOUT_MS,
        });
        notify = r.notify;
      } else notify = await agentPeriod(p, routine, prevDir, window);
      await deliver(p, routine, notify);
      p.checkpoint();
      await p.update(() => ({ state: "delivered", step: undefined, stepBudgetSec: undefined, reason: undefined, degraded: p.degraded }));
      state = "delivered";
      log.info({ ...fields, degraded: p.degraded }, "period delivered");
    } catch (err) {
      const stop = controller.signal.aborted && controller.signal.reason instanceof Stop ? controller.signal.reason : err instanceof Stop ? err : undefined;
      if (stop?.kind === "superseded" || (!stop && err instanceof Superseded)) {
        // Someone else holds the period now: write nothing more, deliver nothing more, leave their lease alone.
        state = "superseded";
        reason = stop?.message ?? errText(err);
        lease.stop();
        log.warn({ ...fields, reason }, "period stopped: its lease was taken over");
      } else if (stop?.kind === "interrupted") {
        // Not a failure: the fire command finds the lease gone (orphaned) and submits again, to a live Pod.
        state = "interrupted";
        reason = "interrupted";
        await p.update(() => ({ state: "running", reason: "interrupted" })).catch((e: unknown) => log.warn({ ...fields, err: errText(e) }, "could not record the interruption"));
        log.warn(fields, "period interrupted; another Pod takes it over");
      } else {
        reason = stop?.kind === "deadline" ? "deadline" : errText(err);
        await p
          .update(() => ({ state: "failed", reason, degraded: p.degraded }))
          .catch((e: unknown) => log.error({ ...fields, err: errText(e) }, "could not record the period's failure"));
        if (!(err instanceof PeriodFailed) && !stop) log.error({ ...fields, err }, "period failed");
        else log.warn({ ...fields, reason }, "period failed");
      }
    } finally {
      clearTimeout(timer);
      if (state !== "superseded") await lease.release().catch((err: unknown) => log.warn({ ...fields, err: errText(err) }, "could not release the lease"));
      endRoutineSpan(span, { state, degraded: p.degraded, ...(reason && { reason }) });
    }
  }

  /** An agent routine: one run with the routine's instructions, the previous period's summary and state as memory. */
  async function agentPeriod(p: PeriodRun, routine: Extract<Routine, { kind: "agent" }>, prevDir: string | undefined, window: unknown): Promise<boolean> {
    const done = parseJson<{ notify?: unknown }>(await p.read("output.json"));
    if (done) {
      await p.stepEnded("run", { state: "skipped", reason: "output.json already written" });
      return done.notify !== false;
    }
    const prev = prevDir ? parseJson<{ summary?: unknown; state?: unknown }>((await store.get(`${prevDir}output.json`))?.body) : undefined;
    const cut = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);
    const input = {
      routine: p.i.name,
      period: p.i.period,
      window,
      context: routine.context ?? {},
      // Untrusted like the rest of <job_input>: the model wrote it last time.
      previous_period: prev ? { summary: cut(prev.summary, MAX_SUMMARY_CHARS), state: cut(prev.state, MAX_STATE_CHARS) } : null,
    };
    const budgetSec = routine.budget?.wallClockSec ?? o.cfg.agent.wallClockSec.job;
    await p.stepStarted("run", budgetSec);
    const fields = { routine: p.i.name, period: p.i.period, step: "run" };
    log.info(fields, "routine step started");
    const started = now();
    let r;
    try {
      r = await p.refreshing(
        o.jobs.runJob(
          { routine: p.i.name, period: p.i.period, dryRun: p.i.dryRun, input, outputSchema: AGENT_OUTPUT_SCHEMA, instructions: routine.instructions, ...(routine.budget && { budget: routine.budget }) },
          { caller: p.i.caller, signal: p.signal, ...(p.traceparent && { traceparent: p.traceparent }) },
        ),
      );
    } catch (err) {
      if (err instanceof JobRequestError && err.code === "shutting_down") throw new Stop("interrupted", "the run was interrupted by a shutdown");
      if (err instanceof JobRequestError) throw new PeriodFailed(`run: ${err.code}: ${err.message}`);
      throw err;
    }
    p.checkpoint();
    if (r.runId || r.degraded) await p.noteRun(r.runId, r.degraded);
    if (r.state !== "done") {
      const why = r.degraded ? "the model is unavailable" : (r.reason ?? r.state);
      await p.stepEnded("run", { state: "failed", reason: why, ...(r.runId && { runId: r.runId }) });
      log.warn({ ...fields, durationMs: now() - started, outcome: "failed", runId: r.runId, reason: why }, "routine step finished");
      throw new PeriodFailed(`run: ${why}`);
    }
    await p.write("output.json", JSON.stringify(r.output));
    await p.stepEnded("run", { state: "done", ...(r.runId && { runId: r.runId }) });
    log.info({ ...fields, durationMs: now() - started, outcome: "ok", runId: r.runId }, "routine step finished");
    return (r.output as { notify?: unknown }).notify !== false;
  }

  /**
   * Each due target not yet in delivered.json, one at a time, the lease confirmed before each; every outcome is
   * recorded as it comes. Without an Outbox: delivery-pending.json.
   */
  async function deliver(p: PeriodRun, routine: Routine, notify: boolean): Promise<void> {
    const targets = deliveryTargets(routine.delivery, notify);
    await p.stepStarted("deliver", DELIVERY_BUDGET_SEC);
    const fields = { routine: p.i.name, period: p.i.period, step: "deliver" };
    log.info({ ...fields, targets: targets.length }, "routine step started");
    const started = now();
    if (!o.outbox) {
      await p.write("delivery-pending.json", JSON.stringify({ token: p.i.lease.token, at: iso(), targets: targets.map((t) => t.key) }));
      await p.stepEnded("deliver", { state: "done", reason: "no outbox yet: delivery-pending.json" });
      log.info({ ...fields, durationMs: now() - started, outcome: "ok", targets: targets.length, pending: true }, "routine step finished");
      return;
    }
    const record = new OwnedRecord<DeliveredRecord>(store, `${p.i.dir}delivered.json`, p.i.lease.token, () => p.i.lease.ensure());
    const prior = await record.load();
    let doc: DeliveredRecord = { token: p.i.lease.token, targets: { ...prior?.targets } };
    const failed: string[] = [];
    for (const t of targets) {
      if (doc.targets[t.key]?.ok) continue;
      p.checkpoint();
      await p.i.lease.ensure();
      let entry: DeliveredRecord["targets"][string];
      try {
        const r = await o.outbox.deliver(t, { routine: p.i.name, period: p.i.period, kind: routine.kind, dryRun: p.i.dryRun, dir: p.i.dir, store, signal: p.signal });
        entry = { ok: true, at: iso(), ...(r.link && { link: r.link }), ...(r.detail !== undefined && { detail: r.detail }) };
      } catch (err) {
        p.checkpoint();
        entry = { ok: false, at: iso(), error: errText(err).slice(0, 500) };
        failed.push(t.key);
      }
      doc = { ...doc, targets: { ...doc.targets, [t.key]: entry } };
      await record.write(doc);
    }
    if (failed.length) {
      await p.stepEnded("deliver", { state: "failed", reason: `not delivered: ${failed.join(", ")}` });
      throw new PeriodFailed(`delivery failed: ${failed.join(", ")}`);
    }
    await p.stepEnded("deliver", { state: "done" });
    log.info({ ...fields, durationMs: now() - started, outcome: "ok", targets: targets.length }, "routine step finished");
  }

  /** GET .../periods/{period}: undefined when there is no run.json. */
  async function status(name: string, period: string, dryRun: boolean): Promise<PeriodStatus | undefined> {
    routineOf(name);
    if (!PERIOD.test(period)) throw new FireError(400, "bad_request", "not a period: RFC 3339 in UTC to the minute");
    const dir = periodDir(name, period, dryRun);
    // The lease before run.json: a holder writes its final state, then releases. Read the other way round, a poll
    // between the two would pair the old `running` with no lease and call the period orphaned.
    const leaseObj = await readJson<LeaseRecord>(`${dir}lease.json`);
    const [runObj, deliveredObj] = await Promise.all([readJson<RunRecord>(`${dir}run.json`), readJson<DeliveredRecord>(`${dir}delivered.json`)]);
    if (!runObj) return undefined;
    const run = runObj.value;
    const lease = leaseObj?.value;
    const t = now();
    const live = lease !== undefined && Date.parse(lease.expiresAt) > t;
    const mine = live && lease.token === run.token;
    let state: PeriodStatus["state"];
    if (run.state === "delivered") state = "delivered";
    else if (run.state === "failed" && (!live || mine)) state = "failed";
    // A live lease whose holder has not written yet (or a superseded holder's record): the live holder is on it.
    else if (live) state = "running";
    else state = "orphaned";
    // Only the live holder's own record says how far it got.
    const trusted = state !== "running" || mine;
    if (state === "running" && mine && run.state === "running") {
      const budgetMs = (run.stepBudgetSec ?? 0) * 1000;
      const since = t - Date.parse(run.updatedAt);
      if (since > budgetMs + STALL_GRACE_MS) {
        state = "stalled";
        log.warn({ routine: name, period, dryRun, step: run.step, updatedAt: run.updatedAt, stepBudgetSec: run.stepBudgetSec }, "period stalled");
      }
    }
    return {
      state,
      step: trusted ? (run.step ?? null) : null,
      updatedAt: trusted ? run.updatedAt : null,
      leaseExpiresAt: live ? lease.expiresAt : null,
      deadlineAt: run.deadlineAt ?? null,
      runIds: run.runIds ?? [],
      delivered: Object.entries(deliveredObj?.value.targets ?? {})
        .filter(([, v]) => v.ok)
        .map(([k]) => k),
      ...(trusted && run.reason && { reason: run.reason }),
    };
  }

  /** Shutdown: stop taking periods, interrupt those running (not failed: another Pod goes on), and wait for them. */
  async function drain(timeoutMs: number): Promise<boolean> {
    draining = true;
    // A fire() in progress registers its period after this point, and aborts it itself (draining): wait for it too.
    const settle = async () => {
      while (active.size || starting.size) {
        for (const a of active.values()) a.controller.abort(new Stop("interrupted", "shutting down"));
        await Promise.allSettled([...starting, ...[...active.values()].map((a) => a.done)]);
      }
      return true as const;
    };
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((r) => (timer = setTimeout(() => r(false), timeoutMs)));
    const ok = await Promise.race([settle(), timedOut]);
    clearTimeout(timer);
    return ok;
  }

  /** Resolves when no period runs here (tests). */
  async function idle(): Promise<void> {
    while (active.size) await Promise.all([...active.values()].map((a) => a.done));
  }

  return { fire, status, drain, idle, get draining() { return draining; } };
}

export type Routines = ReturnType<typeof createRoutines>;
