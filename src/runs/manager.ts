import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { contextPackage, notice, type DegradeReason } from "./degrade.js";
import { RateLimiter, limitKey } from "./limits.js";
import {
  RunAbort,
  RunError,
  type AgentRunner,
  type RunInput,
  type RunObserver,
  type RunOutcome,
  type RunResult,
  type RunSource,
  type RunState,
} from "./types.js";

export interface RunManagerOptions {
  runner: AgentRunner;
  /** Runs at once; the rest wait in submission order. */
  concurrency: number;
  perUserPerHour: number;
  maxSteps: number;
  maxInputTokens: number;
  wallClockSec: Record<RunSource, number>;
  /** Seconds before the wall clock at which the model is told to wrap up. */
  finalReserveSec: number;
  log?: Pick<Logger, "info" | "warn" | "error">;
  now?: () => number;
  newId?: () => string;
  /** The answer when the runner cannot give one; default: the context package. */
  degrade?: (input: RunInput, why: DegradeReason) => string;
}

export type SubmitResult =
  | { ok: true; run: RunHandle }
  | { ok: false; code: "rate_limited"; message: string; retryAfterSec: number }
  | { ok: false; code: "shutting_down"; message: string };

export interface RunHandle {
  readonly id: string;
  readonly sessionId: string;
  readonly state: RunState;
  /** Always resolves, whatever the run's fate. */
  readonly result: Promise<RunResult>;
  /** Stop the run (queued: dropped; running: aborted). False once it has finished. */
  cancel(reason?: string): boolean;
}

interface Run {
  id: string;
  input: RunInput;
  observer: RunObserver;
  state: RunState;
  controller: AbortController;
  enqueuedAt: number;
  startedAt?: number;
  ahead?: number;
  timer?: NodeJS.Timeout;
  resolve: (r: RunResult) => void;
  result: Promise<RunResult>;
}

const ZERO = { steps: 0, toolCalls: 0, usage: { inputTokens: 0, outputTokens: 0 } };

/**
 * Owns every agent run: the state machine (queued → running → done | failed | cancelled | budget_exhausted),
 * a global concurrency limit, one run per session at a time, per-user rate limits, budgets, cancellation and
 * draining on shutdown. State is in process memory (single replica); the interface is what a Redis-backed
 * version would keep.
 */
export class RunManager {
  private queue: Run[] = [];
  private running = new Map<string, Run>();
  private busySessions = new Set<string>();
  private limiter: RateLimiter;
  private draining = false;

  constructor(private o: RunManagerOptions) {
    this.limiter = new RateLimiter({ limit: o.perUserPerHour, windowMs: 3600_000, ...(o.now && { now: o.now }) });
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  stats(): { running: number; queued: number } {
    return { running: this.running.size, queued: this.queue.length };
  }

  submit(input: RunInput, observer: RunObserver = {}): SubmitResult {
    if (this.draining) return { ok: false, code: "shutting_down", message: notice("shutting_down", input.question) };
    const taken = this.limiter.take(limitKey(input));
    if (!taken.ok) {
      const retryAfterSec = Math.ceil(taken.retryAfterMs / 1000);
      return { ok: false, code: "rate_limited", message: `rate limit: ${this.o.perUserPerHour} runs per hour`, retryAfterSec };
    }
    let resolve!: (r: RunResult) => void;
    const result = new Promise<RunResult>((r) => (resolve = r));
    const run: Run = {
      id: this.o.newId?.() ?? randomUUID(),
      input,
      observer: safeObserver(observer, this.o.log),
      state: "queued",
      controller: new AbortController(),
      enqueuedAt: this.now(),
      resolve,
      result,
    };
    this.queue.push(run);
    this.schedule();
    return {
      ok: true,
      run: {
        id: run.id,
        sessionId: input.sessionId,
        get state() {
          return run.state;
        },
        result,
        cancel: (reason?: string) => this.cancel(run, new RunAbort("cancelled", reason ?? "cancelled")),
      },
    };
  }

  /** Cancel every queued and running run of a session (O2's cancel endpoint). True if any was stopped. */
  cancelSession(sessionId: string, reason = "cancelled"): boolean {
    const runs = [...this.queue, ...this.running.values()].filter((r) => r.input.sessionId === sessionId);
    return runs.map((r) => this.cancel(r, new RunAbort("cancelled", reason))).some(Boolean);
  }

  /** Is a run of this session queued or running? */
  active(sessionId: string): boolean {
    return this.busySessions.has(sessionId) || this.queue.some((r) => r.input.sessionId === sessionId);
  }

  /**
   * Stop taking runs, tell queued ones to ask again, and wait up to `timeoutMs` for running ones. Runs still
   * going after that are aborted. Resolves true when every run finished on its own.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    this.draining = true;
    for (const r of [...this.queue]) {
      this.dequeue(r);
      this.finish(r, { state: "cancelled", answer: notice("shutting_down", r.input.question), reason: "shutting down", ...ZERO });
    }
    const pending = () => Promise.all([...this.running.values()].map((r) => r.result));
    if (this.running.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((r) => (timer = setTimeout(() => r(false), timeoutMs)));
    const finished = await Promise.race([pending().then(() => true as const), timedOut]);
    clearTimeout(timer);
    if (finished) return true;
    for (const r of this.running.values()) r.controller.abort(new RunAbort("shutdown", "shutting down"));
    // Runners honour the signal; do not hang shutdown on one that does not.
    await Promise.race([pending(), new Promise((r) => setTimeout(r, 5000).unref())]);
    return false;
  }

  private cancel(run: Run, why: RunAbort): boolean {
    if (run.state === "queued") {
      this.dequeue(run);
      this.finish(run, { state: "cancelled", answer: notice("cancelled", run.input.question), reason: why.message, ...ZERO });
      this.schedule();
      return true;
    }
    if (run.state === "running") {
      if (!run.controller.signal.aborted) run.controller.abort(why);
      return true;
    }
    return false;
  }

  private dequeue(run: Run): void {
    const i = this.queue.indexOf(run);
    if (i >= 0) this.queue.splice(i, 1);
  }

  private schedule(): void {
    for (const run of [...this.queue]) {
      if (this.running.size >= this.o.concurrency) break;
      if (this.busySessions.has(run.input.sessionId)) continue;
      this.dequeue(run);
      this.start(run);
    }
    this.queue.forEach((run, ahead) => {
      if (run.ahead === ahead) return;
      run.ahead = ahead;
      run.observer.queued?.({ runId: run.id, ahead });
    });
  }

  private start(run: Run): void {
    const { input } = run;
    run.state = "running";
    run.startedAt = this.now();
    this.running.set(run.id, run);
    this.busySessions.add(input.sessionId);
    const wallMs = this.o.wallClockSec[input.source] * 1000;
    const reserveMs = Math.min(this.o.finalReserveSec * 1000, wallMs / 2);
    run.timer = setTimeout(() => run.controller.abort(new RunAbort("deadline", "wall clock exceeded")), wallMs);
    run.observer.started?.({ runId: run.id });
    const ctx = {
      runId: run.id,
      signal: run.controller.signal,
      budget: { maxSteps: this.o.maxSteps, softDeadline: run.startedAt + wallMs - reserveMs, maxInputTokens: this.o.maxInputTokens },
      observer: run.observer,
    };
    // Defer so a runner that throws synchronously still goes through the same path.
    void Promise.resolve()
      .then(() => this.o.runner.run(input, ctx))
      .then(
        (outcome) => this.finish(run, this.fromOutcome(run, outcome)),
        (err: unknown) => this.finish(run, this.fromError(run, err)),
      );
  }

  private fromOutcome(run: Run, out: RunOutcome): Omit<RunResult, "id" | "sessionId" | "durationMs"> {
    if (out.state !== "cancelled") return out;
    const why = run.controller.signal.reason;
    const kind = why instanceof RunAbort && why.kind === "shutdown" ? "interrupted" : "cancelled";
    return { ...out, answer: out.answer || notice(kind, run.input.question), reason: out.reason ?? (why instanceof RunAbort ? why.message : "cancelled") };
  }

  private fromError(run: Run, err: unknown): Omit<RunResult, "id" | "sessionId" | "durationMs"> {
    const partial = { ...ZERO, ...(err instanceof RunError ? err.partial : {}) };
    const why = run.controller.signal.reason;
    if (run.controller.signal.aborted && why instanceof RunAbort && why.kind !== "deadline") {
      const kind = why.kind === "shutdown" ? "interrupted" : "cancelled";
      return { ...partial, state: "cancelled", answer: notice(kind, run.input.question), reason: why.message };
    }
    const degradeKind: DegradeReason =
      run.controller.signal.aborted && why instanceof RunAbort ? "deadline" : err instanceof RunError ? err.kind : "error";
    const message = (err as Error)?.message ?? String(err);
    if (degradeKind === "error") this.o.log?.error({ err, runId: run.id }, "agent run crashed");
    const degrade = this.o.degrade ?? contextPackage;
    return { ...partial, state: "failed", answer: degrade(run.input, degradeKind), degraded: true, reason: message };
  }

  private finish(run: Run, r: Omit<RunResult, "id" | "sessionId" | "durationMs">): void {
    if (run.timer) clearTimeout(run.timer);
    const wasRunning = this.running.delete(run.id);
    if (wasRunning) this.busySessions.delete(run.input.sessionId);
    run.state = r.state;
    const result: RunResult = { ...r, id: run.id, sessionId: run.input.sessionId, durationMs: this.now() - (run.startedAt ?? run.enqueuedAt) };
    // One summary line per run (§15): enough to chart volume, cost and outcomes from the logs.
    this.o.log?.info(
      {
        runId: run.id,
        source: run.input.source,
        session: run.input.sessionId,
        user: run.input.user,
        state: result.state,
        degraded: result.degraded ?? false,
        reason: result.reason,
        steps: result.steps,
        toolCalls: result.toolCalls,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        model: result.model,
        effort: result.effort,
        durationMs: result.durationMs,
        queuedMs: (run.startedAt ?? this.now()) - run.enqueuedAt,
      },
      "agent run finished",
    );
    run.observer.done?.(result);
    run.resolve(result);
    if (wasRunning) this.schedule();
  }
}

/** Observer callbacks never fail a run: a client that went away must not take the run down with it. */
function safeObserver(o: RunObserver, log?: Pick<Logger, "warn">): RunObserver {
  const wrap = <K extends keyof RunObserver>(k: K) => {
    const f = o[k] as ((arg: unknown) => void) | undefined;
    return f
      ? (arg: unknown) => {
          try {
            f.call(o, arg);
          } catch (err) {
            log?.warn({ err, callback: k }, "run observer failed");
          }
        }
      : undefined;
  };
  const out: RunObserver = {};
  for (const k of ["queued", "started", "toolStart", "toolEnd", "delta", "done"] as const) {
    const w = wrap(k);
    if (w) (out as Record<string, unknown>)[k] = w;
  }
  return out;
}
