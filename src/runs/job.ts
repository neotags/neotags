import type { Logger } from "pino";
import type { Config, JobCaller } from "../config/index.js";
import { Slots } from "../sandbox/slots.js";
import type { RunManager } from "./manager.js";
import { outputValidator } from "./output.js";
import type { RunLimits, RunResult } from "./types.js";

/** `input`, serialized, at most this many characters (S-D17). */
export const MAX_JOB_INPUT_CHARS = 200_000;
/** Longest wait for a jobsApi.concurrency slot: a routine's whole period has an hour (S-D24). */
const SLOT_TIMEOUT_MS = 3600_000;
/** What the model is asked when the routine gives no instructions of its own: its packs say how. */
const DEFAULT_QUESTION =
  "Do this routine's task, as its skill packs describe it, on the data in <job_input>, and deliver the result with submit_output.";

/** One run for a routine: `POST /internal/v1/runs`, or the pipeline engine in process. */
export interface JobRunRequest {
  /** A name in `routines`; its `packs` bound what the run may load. */
  routine: string;
  /** The period this run is for (RFC 3339, UTC). With the routine, its session: a retry queues behind the last try. */
  period: string;
  /** A dry run of the period: its own session, so it never queues behind (or ahead of) the formal run. */
  dryRun?: boolean;
  /** A subset of the routine's packs; default: all of them. */
  packs?: string[];
  /** The data to work on: a string as it is, anything else as JSON. Untrusted. */
  input: unknown;
  /** JSON Schema (type object) of the result, which the model delivers through submit_output. */
  outputSchema: Record<string, unknown>;
  /** Only below the defaults (agent.wallClockSec.job, agent.maxSteps). */
  budget?: RunLimits;
  /** From the routine's configuration (agent routines), never from a request: what the model is asked to do. */
  instructions?: string;
}

export interface JobRunOptions {
  /** Whose key the request came with; the run's source. */
  caller: JobCaller;
  /** Aborting it cancels the run, or the wait for a slot. */
  signal?: AbortSignal;
  /** W3C trace context: the run's span is its child (the routine's root span, when sampled). */
  traceparent?: string;
}

export interface JobRunResult {
  /** Absent when no run was started (model unavailable, cancelled while waiting). */
  runId?: string;
  traceId?: string;
  /** done (with output), failed (no valid output), cancelled. */
  state: "done" | "failed" | "cancelled";
  /** The validated submit_output arguments; null unless done. */
  output: unknown;
  /** The model is unavailable (every model of the job chain is failing): retrying now would not help. */
  degraded: boolean;
  reason?: string;
}

/** A request refused before any run: the internal API answers with `status`. */
export class JobRequestError extends Error {
  constructor(
    public readonly status: 400 | 403 | 413 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JobRequestError";
  }
}

export interface JobRunnerOptions {
  cfg: Pick<Config, "routines" | "agent" | "jobsApi">;
  runs: Pick<RunManager, "submit" | "isDraining">;
  /** False while every model of the job chain is failing: answer degraded at once, without a run. */
  modelAvailable: () => boolean;
  log?: Pick<Logger, "info" | "warn">;
  /** jobsApi.concurrency; shared with whatever else of routines must take one (the pipeline engine's sandbox steps). */
  slots?: Slots;
}

/**
 * `runJob`: checks a request against the routine's configuration, waits for a jobsApi.concurrency slot (held only
 * for this run), and runs it with structured output (S-D11, S-D18).
 */
export function createJobRunner(o: JobRunnerOptions) {
  const { cfg } = o;
  const slots = o.slots ?? new Slots(cfg.jobsApi.concurrency);

  /** Everything checkable before a run; throws JobRequestError. */
  function check(req: JobRunRequest): { packs: string[]; input: string; budget?: RunLimits; only: string[] } {
    // Own keys only: a routine named "constructor" must not find Object.prototype.
    const routine = Object.hasOwn(cfg.routines, req.routine) ? cfg.routines[req.routine] : undefined;
    if (!routine) throw new JobRequestError(403, "forbidden", `unknown routine ${JSON.stringify(req.routine.slice(0, 64))}`);
    const packs = req.packs ?? routine.packs;
    const outside = packs.filter((p) => !routine.packs.includes(p));
    if (outside.length) throw new JobRequestError(403, "forbidden", `skill packs not configured for routine ${req.routine}: ${outside.join(", ")}`);
    const input = typeof req.input === "string" ? req.input : (JSON.stringify(req.input) ?? "null");
    if (input.length > MAX_JOB_INPUT_CHARS) throw new JobRequestError(413, "too_large", `input is ${input.length} characters; at most ${MAX_JOB_INPUT_CHARS}`);
    try {
      outputValidator(req.outputSchema);
    } catch (err) {
      throw new JobRequestError(400, "bad_request", `outputSchema: ${(err as Error).message}`);
    }
    const b = req.budget;
    if (b?.wallClockSec !== undefined && b.wallClockSec > cfg.agent.wallClockSec.job) {
      throw new JobRequestError(400, "bad_request", `budget.wallClockSec may not exceed ${cfg.agent.wallClockSec.job}`);
    }
    if (b?.maxSteps !== undefined && b.maxSteps > cfg.agent.maxSteps) throw new JobRequestError(400, "bad_request", `budget.maxSteps may not exceed ${cfg.agent.maxSteps}`);
    // Only the routine's own MCP servers: its input is untrusted and could ask for another org's data, which no
    // prompt can be trusted to refuse.
    // An allowlist, so a server added later stays out of the routine's runs.
    return { packs, input, only: [...routine.mcp], ...(b && { budget: b }) };
  }

  async function runJob(req: JobRunRequest, opts: JobRunOptions): Promise<JobRunResult> {
    const { packs, input, budget, only } = check(req);
    if (o.runs.isDraining) throw new JobRequestError(503, "shutting_down", "shutting down; submit again");
    if (!o.modelAvailable()) {
      o.log?.warn({ routine: req.routine, period: req.period }, "job run not started: model unavailable");
      return { state: "failed", output: null, degraded: true, reason: "model unavailable" };
    }
    if (opts.signal?.aborted) return { state: "cancelled", output: null, degraded: false, reason: "cancelled" };
    try {
      await slots.acquire(SLOT_TIMEOUT_MS, opts.signal);
    } catch (why) {
      if (why === "aborted") return { state: "cancelled", output: null, degraded: false, reason: "cancelled while waiting for a slot" };
      throw new JobRequestError(503, "busy", "no jobsApi.concurrency slot came free in time");
    }
    try {
      const submitted = o.runs.submit({
        source: opts.caller,
        sessionId: `job:${req.routine}:${req.period}${req.dryRun ? ":dryrun" : ""}`,
        question: req.instructions ?? DEFAULT_QUESTION,
        jobInput: input,
        packs,
        mcp: { only },
        outputSchema: req.outputSchema,
        ...(budget && { budget }),
        routine: { name: req.routine, period: req.period },
        ...(opts.traceparent && { traceparent: opts.traceparent }),
      });
      if (!submitted.ok) throw new JobRequestError(503, submitted.code, submitted.message);
      const onAbort = () => submitted.run.cancel("cancelled by the caller");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await submitted.run.result;
        // Stopped by this process shutting down, not by the caller: the caller should submit again (to another Pod).
        if (result.errorType === "interrupted") throw new JobRequestError(503, "shutting_down", "interrupted by shutdown; submit again");
        return toJobResult(result);
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
      }
    } finally {
      slots.release();
    }
  }

  return { runJob, slots };
}

export type JobRunner = ReturnType<typeof createJobRunner>;

function toJobResult(r: RunResult): JobRunResult {
  const base = { runId: r.id, ...(r.traceId && { traceId: r.traceId }) };
  if (r.output !== undefined && (r.state === "done" || r.state === "budget_exhausted")) return { ...base, state: "done", output: r.output, degraded: false };
  return {
    ...base,
    state: r.state === "cancelled" ? "cancelled" : "failed",
    output: null,
    degraded: r.errorType === "model_unavailable",
    ...(r.reason && { reason: r.reason }),
  };
}
