import { randomUUID } from "node:crypto";
import type { Span } from "@opentelemetry/api";
import type { Logger } from "pino";
import { endRunSpan, spanTraceId, startRunSpan, withSpan } from "../telemetry/spans.js";
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
  /** Emails not counted against perUserPerHour; the concurrency limit still applies. */
  exemptUsers?: readonly string[];
  maxSteps: number;
  maxInputTokens: number;
  wallClockSec: Record<RunSource, number>;
  /** Seconds before the wall clock at which the model is told to wrap up. */
  finalReserveSec: number;
  log?: Pick<Logger, "info" | "warn" | "error">;
  now?: () => number;
  newId?: () => string;
  /** After an abort, how long the runner gets to return before the run is finished without it (default 10s). */
  abortGraceMs?: number;
  /** The answer when the runner cannot give one; default: the context package. */
  degrade?: (input: RunInput, why: DegradeReason) => string;
  /** On the run's trace span (`neotags.bot.name`). */
  botName?: string;
  /** Put the question and the answer on the run's trace span (telemetry.captureContent), redacted. */
  captureContent?: boolean;
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
  rateLimitExempt: boolean;
  startedAt?: number;
  ahead?: number;
  timer?: NodeJS.Timeout;
  /** Finishes a run whose runner ignores the abort, so its slot and session lock are not held forever. */
  backstop?: NodeJS.Timeout;
  /** invoke_agent: from start to finish; the runner's chat and tool spans are its children. */
  span?: Span;
  resolve: (r: RunResult) => void;
  result: Promise<RunResult>;
}

const ZERO = { steps: 0, toolCalls: 0, usage: { inputTokens: 0, outputTokens: 0 } };

/** A run's result before the manager stamps id, trace and timing. */
type Finished = Omit<RunResult, "id" | "sessionId" | "durationMs" | "traceId">;
/** After an abort, how long a runner gets to return before the run is finished without it. */
const ABORT_GRACE_MS = 10_000;

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
  private exempt: Set<string>;
  private draining = false;

  constructor(private o: RunManagerOptions) {
    this.limiter = new RateLimiter({ limit: o.perUserPerHour, windowMs: 3600_000, ...(o.now && { now: o.now }) });
    this.exempt = new Set((o.exemptUsers ?? []).map((user) => limitKey({ user, sessionId: "" })));
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  stats(): { running: number; queued: number } {
    return { running: this.running.size, queued: this.queue.length };
  }

  submit(input: RunInput, observer: RunObserver = {}): SubmitResult {
    if (this.draining) return { ok: false, code: "shutting_down", message: notice("shutting_down", input.question) };
    const key = limitKey(input);
    const exempt = this.exempt.has(key);
    const taken = exempt ? { ok: true as const } : this.limiter.take(key);
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
      rateLimitExempt: exempt,
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

  /** Would a run of this session wait now (no free slot, or its session is busy)? */
  wouldQueue(sessionId: string): boolean {
    return this.running.size >= this.o.concurrency || this.active(sessionId);
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
      this.finish(r, { state: "cancelled", answer: notice("shutting_down", r.input.question), reason: "shutting down", errorType: "interrupted", ...ZERO });
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
      this.finish(run, { state: "cancelled", answer: notice("cancelled", run.input.question), reason: why.message, errorType: "cancelled", ...ZERO });
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
    run.controller.signal.addEventListener(
      "abort",
      () => {
        run.backstop = setTimeout(() => {
          this.o.log?.warn({ runId: run.id }, "agent run ignored its abort; finishing it without the runner");
          this.finish(run, this.fromError(run, new Error("the run did not stop after abort")));
        }, this.o.abortGraceMs ?? ABORT_GRACE_MS);
        run.backstop.unref();
      },
      { once: true },
    );
    run.span = startRunSpan({
      agent: input.source,
      ...(this.o.botName && { botName: this.o.botName }),
      runId: run.id,
      sessionId: input.sessionId,
      ...(input.user && { user: input.user }),
      ...(input.traceparent && { traceparent: input.traceparent }),
      queuedMs: run.startedAt - run.enqueuedAt,
    });
    run.observer.started?.({ runId: run.id });
    const ctx = {
      runId: run.id,
      signal: run.controller.signal,
      budget: { maxSteps: this.o.maxSteps, softDeadline: run.startedAt + wallMs - reserveMs, maxInputTokens: this.o.maxInputTokens },
      observer: run.observer,
    };
    // Defer so a runner that throws synchronously still goes through the same path.
    void Promise.resolve()
      .then(() => withSpan(run.span!, () => this.o.runner.run(input, ctx), { conversation: input.sessionId, agent: input.source }))
      .then(
        (outcome) => this.finish(run, this.fromOutcome(run, outcome)),
        (err: unknown) => this.finish(run, this.fromError(run, err)),
      );
  }

  private fromOutcome(run: Run, out: RunOutcome): Finished {
    if (out.state !== "cancelled") return out;
    const why = run.controller.signal.reason;
    const kind = why instanceof RunAbort && why.kind === "shutdown" ? "interrupted" : "cancelled";
    return {
      ...out,
      answer: out.answer || notice(kind, run.input.question),
      reason: out.reason ?? (why instanceof RunAbort ? why.message : "cancelled"),
      errorType: kind,
    };
  }

  private fromError(run: Run, err: unknown): Finished {
    const partial: typeof ZERO & RunError["partial"] = { ...ZERO, ...(err instanceof RunError ? err.partial : {}) };
    const why = run.controller.signal.reason;
    if (run.controller.signal.aborted && why instanceof RunAbort && why.kind !== "deadline") {
      const kind = why.kind === "shutdown" ? "interrupted" : "cancelled";
      return { ...partial, state: "cancelled", answer: notice(kind, run.input.question), reason: why.message, errorType: kind };
    }
    const degradeKind: DegradeReason =
      run.controller.signal.aborted && why instanceof RunAbort ? "deadline" : err instanceof RunError ? err.kind : "error";
    const message = (err as Error)?.message ?? String(err);
    if (degradeKind === "error") this.o.log?.error({ err, runId: run.id }, "agent run crashed");
    if (partial.answer) return { ...partial, answer: partial.answer, state: "failed", reason: message, errorType: degradeKind };
    const degrade = this.o.degrade ?? contextPackage;
    return { ...partial, state: "failed", answer: degrade(run.input, degradeKind), degraded: true, reason: message, errorType: degradeKind };
  }

  private finish(run: Run, finished: Finished): void {
    // A run the backstop finished may still settle later; only the first outcome counts.
    if (run.state !== "queued" && run.state !== "running") return;
    if (run.timer) clearTimeout(run.timer);
    if (run.backstop) clearTimeout(run.backstop);
    const wasRunning = this.running.delete(run.id);
    if (wasRunning) this.busySessions.delete(run.input.sessionId);
    run.state = finished.state;
    const traceId = run.span && spanTraceId(run.span);
    const result: RunResult = {
      ...finished,
      id: run.id,
      sessionId: run.input.sessionId,
      ...(traceId && { traceId }),
      durationMs: this.now() - (run.startedAt ?? run.enqueuedAt),
    };
    // One summary line per run (§15): enough to chart volume, cost and outcomes from the logs.
    this.o.log?.info(
      {
        runId: run.id,
        source: run.input.source,
        session: run.input.sessionId,
        user: run.input.user,
        ...(run.rateLimitExempt && { rateLimitExempt: true }),
        state: result.state,
        degraded: result.degraded ?? false,
        reason: result.reason,
        errorType: result.errorType,
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
    if (run.span) {
      endRunSpan(run.span, {
        ...result,
        question: run.input.question,
        captureContent: this.o.captureContent ?? false,
      });
    }
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
