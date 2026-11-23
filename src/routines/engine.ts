import type { Span } from "@opentelemetry/api";
import type { Logger } from "pino";
import type { Config, Routine } from "../config/index.js";
import { JobRequestError, MAX_JOB_INPUT_CHARS, type JobRunner } from "../runs/job.js";
import type { SkillExecutor } from "../sandbox/exec.js";
import type { Slots } from "../sandbox/slots.js";
import { SandboxError, type ExecResult } from "../sandbox/types.js";
import { endRoutineStepSpan, startRoutineStepSpan } from "../telemetry/spans.js";
import { redact } from "../tools/redact.js";
import { parseJson } from "./records.js";
import type { RoutineType } from "./types.js";

// The pipeline engine (S-D22): a routine type's steps in the sandbox, one after another, under the step pack's own
// declaration (never through a model or run_skill_command), with the one classify run between them. Each step reads
// /work/in.json and writes one JSON object to stdout (contracts: pipeline-type.md).

/** How a period stops early; the period's AbortSignal carries one as its reason. */
export class Stop extends Error {
  constructor(
    readonly kind: "deadline" | "interrupted" | "superseded",
    message: string,
  ) {
    super(message);
    this.name = "Stop";
  }
}

/** The period failed for real: a step after its retry, the classify run without a degrade step, a delivery. */
export class PeriodFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeriodFailed";
  }
}

/** What the engine needs of the period in progress (period.ts). */
export interface PeriodHandle {
  name: string;
  routine: Extract<Routine, { kind: "pipeline" }>;
  period: string;
  dryRun: boolean;
  signal: AbortSignal;
  span: Span;
  traceparent?: string;
  /** Throws the period's Stop when it has been told to stop. */
  checkpoint(): void;
  /** A file of the period, undefined when absent. */
  read(file: string): Promise<string | undefined>;
  /** Write a file of the period, after confirming the lease. */
  write(file: string, body: string): Promise<void>;
  /** run.json: the step starts (with its budget for `stalled`), or ends. */
  stepStarted(step: string, budgetSec: number, patch?: { attempts?: number }): Promise<void>;
  stepEnded(step: string, patch: { state: "done" | "failed" | "skipped"; attempts?: number; exitCode?: number; runId?: string; reason?: string }): Promise<void>;
  /** Refresh run.json's updatedAt every minute while `work` runs. */
  refreshing<T>(work: Promise<T>): Promise<T>;
  /** Record a run's id in run.json, and whether the period is degraded (when given). */
  noteRun(runId: string | undefined, degraded?: boolean): Promise<void>;
  /** The base of in.json: window, params, delivery, previous state. */
  base: Record<string, unknown>;
  /** The previous completed period's output.json (classify result), or undefined. */
  previousOutput: unknown;
}

export interface EngineDeps {
  cfg: Pick<Config, "agent">;
  executor: Pick<SkillExecutor, "exec">;
  /** jobsApi.concurrency, the job runner's own: taken per step, released before the classify run takes it. */
  slots: Slots;
  runJob: JobRunner["runJob"];
  types: ReadonlyMap<string, RoutineType>;
  log: Pick<Logger, "info" | "warn">;
  /** Longest wait for a slot for one step; then the attempt fails. */
  stepSlotTimeoutMs: number;
}

/** A step's budget when its pack declares no timeout: the executor's default. */
const DEFAULT_STEP_TIMEOUT_SEC = 60;
/** What the classify run's input keeps of a summary that would not fit. */
const SUMMARY_CUT = "\n[cut: the summary was over the input limit]";
/** stderr kept per step attempt in the period's records, for debugging. */
const MAX_STDERR_CHARS = 64_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The classify run's input: `{summary, previous, team}`, at most 200k characters serialized. Over it, the previous
 * period's memory goes first (the summary is what the run classifies), then the summary is cut.
 */
export function classifyInput(summary: unknown, previous: unknown, team: unknown): Record<string, unknown> {
  const text = typeof summary === "string" ? summary : JSON.stringify(summary ?? null);
  const input: Record<string, unknown> = { summary: text, previous: previous ?? null, team: team ?? null };
  const size = () => JSON.stringify(input).length;
  if (size() <= MAX_JOB_INPUT_CHARS) return input;
  input.previous = null;
  input.previousOmitted = "the previous period's problems were left out: over the input limit";
  for (let s = text; size() > MAX_JOB_INPUT_CHARS; ) {
    s = s.slice(0, Math.max(0, s.length - (size() - MAX_JOB_INPUT_CHARS) - SUMMARY_CUT.length - 16));
    input.summary = s + SUMMARY_CUT;
    if (s.length === 0) break;
  }
  return input;
}

/** The bundle's files under bundle/ and its manifest (file names only), or why the bundle is unusable. */
export function bundleFiles(bundle: unknown): { files: Record<string, string>; manifest: Record<string, unknown> } | string {
  if (!isObj(bundle)) return "bundle is not an object";
  if (typeof bundle.notify !== "boolean") return "bundle.notify is not a boolean";
  if (!isObj(bundle.sections)) return "bundle.sections is not an object";
  const files: Record<string, string> = {};
  const attachments = (where: string, v: unknown, dir: string): Record<string, string> | string => {
    if (v === undefined) return {};
    if (!isObj(v)) return `${where}.attachments is not an object`;
    const out: Record<string, string> = {};
    for (const [f, content] of Object.entries(v)) {
      if (!SAFE_NAME.test(f)) return `${where}.attachments: ${JSON.stringify(f.slice(0, 64))} is not a plain file name`;
      if (typeof content !== "string") return `${where}.attachments.${f} is not text`;
      files[`${dir}/attachments/${f}`] = content;
      out[f] = `${dir}/attachments/${f}`;
    }
    return out;
  };
  const sections: Record<string, Record<string, unknown>> = {};
  for (const [section, langs] of Object.entries(bundle.sections)) {
    if (!SAFE_NAME.test(section)) return `bundle.sections: ${JSON.stringify(section.slice(0, 64))} is not a plain name`;
    if (!isObj(langs)) return `bundle.sections.${section} is not an object`;
    sections[section] = {};
    for (const [lang, part] of Object.entries(langs)) {
      if (!SAFE_NAME.test(lang)) return `bundle.sections.${section}: ${JSON.stringify(lang.slice(0, 64))} is not a plain name`;
      const where = `bundle.sections.${section}.${lang}`;
      if (!isObj(part) || typeof part.slack !== "string") return `${where}.slack is not text`;
      const dir = `sections/${section}/${lang}`;
      files[`${dir}/slack.md`] = part.slack;
      const att = attachments(where, part.attachments, dir);
      if (typeof att === "string") return att;
      sections[section]![lang] = { slack: `${dir}/slack.md`, attachments: att };
    }
  }
  const manifest: Record<string, unknown> = { notify: bundle.notify, sections };
  if (bundle.confluence !== undefined) {
    const c = bundle.confluence;
    if (!isObj(c) || typeof c.title !== "string" || typeof c.body !== "string") return "bundle.confluence needs title and body text";
    files["confluence/page.xml"] = c.body;
    const att = attachments("bundle.confluence", c.attachments, "confluence");
    if (typeof att === "string") return att;
    manifest.confluence = { title: c.title, body: "confluence/page.xml", attachments: att };
  }
  return { files, manifest };
}

type StepResult = { ok: true; out: Record<string, unknown>; r: ExecResult } | { ok: false; retry: boolean; reason: string; r?: ExecResult };

function judge(r: ExecResult): StepResult {
  if (r.timedOut) return { ok: false, retry: true, reason: "timed out", r };
  if (r.signal) return { ok: false, retry: true, reason: `killed by ${r.signal}`, r };
  // 2: the step says its parameters or configuration are wrong; running it again cannot help.
  if (r.exitCode === 2) return { ok: false, retry: false, reason: "exit code 2 (parameters or configuration)", r };
  if (r.exitCode !== 0) return { ok: false, retry: true, reason: `exit code ${r.exitCode}`, r };
  if (r.truncated.stdout) return { ok: false, retry: true, reason: "stdout was truncated by the executor", r };
  const out = parseJson<unknown>(r.stdout);
  if (!isObj(out)) return { ok: false, retry: true, reason: "stdout is not one JSON object", r };
  return { ok: true, out, r };
}

/**
 * Run the pipeline from where the records say it got to: a bundle already written means only delivery is left;
 * a data.json checkpoint skips the steps up to it; anything else runs again. Writes data.json, output.json,
 * state.json and bundle/ (manifest last). Returns the bundle's notify and whether the classify run degraded.
 */
export async function runPipeline(h: PeriodHandle, d: EngineDeps): Promise<{ notify: boolean; degraded: boolean }> {
  const t = d.types.get(h.routine.type);
  if (!t) throw new PeriodFailed(`no step pack declares routine type ${h.routine.type}`);
  const { spec, pack } = t;
  const manifest = parseJson<{ notify?: unknown }>(await h.read("bundle/manifest.json"));
  if (manifest) {
    for (const s of spec.steps) await h.stepEnded(s.name, { state: "skipped", reason: "bundle already written" });
    return { notify: manifest.notify !== false, degraded: false };
  }
  const names = spec.steps.map((s) => s.name);
  const after = spec.classify ? names.indexOf(spec.classify.after) : -1;
  // Checkpointed: the steps up to the classify run (all but the last without one). After it, rerun from the data.
  const lastCheckpoint = spec.classify ? after : names.length - 2;
  const checkpoint = parseJson<{ after?: string; data?: unknown; classifyInput?: unknown }>(await h.read("data.json"));
  let start = 0;
  let data: unknown;
  let summary: unknown;
  const resumed = checkpoint?.after !== undefined ? names.indexOf(checkpoint.after) : -1;
  if (resumed >= 0 && resumed <= lastCheckpoint) {
    start = resumed + 1;
    data = checkpoint!.data;
    summary = checkpoint!.classifyInput;
    for (const s of names.slice(0, start)) await h.stepEnded(s, { state: "skipped", reason: "data.json already written" });
  }
  await h.write("input.json", JSON.stringify(h.base));

  let classified = false;
  let problems: unknown = null;
  let degraded = false;
  let final: Record<string, unknown> | undefined;
  for (let i = start; i < spec.steps.length; i++) {
    if (spec.classify && i === after + 1 && !classified) {
      classified = true;
      const c = await classify(h, d, t, summary);
      if (c.ok) problems = c.problems;
      else {
        degraded = true;
        await h.noteRun(undefined, true);
        if (!spec.degrade) throw new PeriodFailed(`classify run: ${c.reason}; routine type ${h.routine.type} has no degrade step`);
        d.log.warn({ routine: h.name, period: h.period, reason: c.reason, degrade: spec.degrade }, "classify run failed; rendering without problems");
        const to = names.indexOf(spec.degrade);
        for (const s of names.slice(i, to)) await h.stepEnded(s, { state: "skipped", reason: "classify run failed" });
        i = to;
      }
    }
    const step = spec.steps[i]!;
    const input = { ...h.base, ...(data !== undefined && { data }), ...(classified && { problems }) };
    const out = await runStep(h, d, pack.name, step, input, pack.sandbox?.limits?.timeoutSec ?? DEFAULT_STEP_TIMEOUT_SEC);
    if (i === after && out.classifyInput === undefined) throw new PeriodFailed(`step ${step.name}: its output has no classifyInput for the classify run`);
    if (i === spec.steps.length - 1) final = out;
    else {
      if (out.data !== undefined) data = out.data;
      if (i === after) summary = out.classifyInput;
      if (i <= lastCheckpoint) await h.write("data.json", JSON.stringify({ after: step.name, data, ...(summary !== undefined && { classifyInput: summary }) }));
    }
  }
  const split = bundleFiles(final?.bundle);
  if (typeof split === "string") throw new PeriodFailed(`step ${names.at(-1)}: ${split}`);
  if (final!.state !== undefined) await h.write("state.json", JSON.stringify(final!.state));
  for (const [f, body] of Object.entries(split.files)) await h.write(`bundle/${f}`, body);
  await h.write("bundle/manifest.json", JSON.stringify(split.manifest));
  return { notify: split.manifest.notify !== false, degraded };
}

async function runStep(
  h: PeriodHandle,
  d: EngineDeps,
  pack: string,
  step: { name: string; argv: string[] },
  input: Record<string, unknown>,
  budgetSec: number,
): Promise<Record<string, unknown>> {
  const fields = { routine: h.name, period: h.period, step: step.name };
  const span = startRoutineStepSpan(h.span, { name: h.name, period: h.period, step: step.name, pack });
  const started = Date.now();
  const inJson = JSON.stringify(input);
  let last: StepResult | undefined;
  let attempts = 0;
  try {
    for (attempts = 1; attempts <= 2; attempts++) {
      h.checkpoint();
      await h.stepStarted(step.name, budgetSec, { attempts });
      d.log.info({ ...fields, attempt: attempts }, "routine step started");
      last = await attempt(h, d, pack, step, inJson, attempts);
      if (last.r?.stderr) await h.write(`steps/${step.name}-${attempts}.stderr.txt`, redact(last.r.stderr.slice(-MAX_STDERR_CHARS)).text);
      if (last.ok || !last.retry) break;
      d.log.warn({ ...fields, attempt: attempts, reason: last.reason, exitCode: last.r?.exitCode }, "routine step failed; retrying once");
    }
  } catch (err) {
    endRoutineStepSpan(span, { ok: false, attempts, durationMs: Date.now() - started, reason: (err as Error).message });
    throw err;
  }
  attempts = Math.min(attempts, 2);
  const r = last!.r;
  const outcome = {
    ok: last!.ok,
    attempts,
    durationMs: Date.now() - started,
    ...(r && { exitCode: r.exitCode, stdoutBytes: Buffer.byteLength(r.stdout), truncated: r.truncated.stdout }),
    ...(!last!.ok && { reason: last!.reason }),
  };
  endRoutineStepSpan(span, outcome);
  const line = { ...fields, durationMs: outcome.durationMs, outcome: last!.ok ? "ok" : "failed", attempts, exitCode: r?.exitCode, stdoutBytes: outcome.stdoutBytes };
  if (last!.ok) {
    d.log.info(line, "routine step finished");
    await h.stepEnded(step.name, { state: "done", attempts, ...(r && { exitCode: r.exitCode }) });
    return last!.out;
  }
  d.log.warn({ ...line, reason: last!.reason }, "routine step finished");
  await h.stepEnded(step.name, { state: "failed", attempts, reason: last!.reason, ...(r && { exitCode: r.exitCode }) });
  throw new PeriodFailed(`step ${step.name}: ${last!.reason}`);
}

/** One try: a slot (never held past the call), then the sandbox. A queue timeout or a busy executor is a failure. */
async function attempt(h: PeriodHandle, d: EngineDeps, pack: string, step: { name: string; argv: string[] }, inJson: string, n: number): Promise<StepResult> {
  try {
    await d.slots.acquire(d.stepSlotTimeoutMs, h.signal);
  } catch (why) {
    h.checkpoint();
    return { ok: false, retry: true, reason: `no jobsApi.concurrency slot within ${Math.round(d.stepSlotTimeoutMs / 1000)} s (${String(why)})` };
  }
  try {
    const r = await d.executor.exec(
      { pack, argv: step.argv, files: { "in.json": inJson }, id: `routine/${h.name}/${h.period}/${step.name}/${n}` },
      { signal: h.signal, packs: [pack], pipelineStep: true },
    );
    return judge(r);
  } catch (err) {
    h.checkpoint();
    if (err instanceof SandboxError) return { ok: false, retry: err.kind !== "denied", reason: `sandbox ${err.kind} (${err.code}): ${err.message}` };
    throw err;
  } finally {
    d.slots.release();
  }
}

/** The classify run, through runJob (which takes its own slot). Not ok: the engine degrades. */
async function classify(h: PeriodHandle, d: EngineDeps, t: RoutineType, summary: unknown): Promise<{ ok: true; problems: unknown } | { ok: false; reason: string }> {
  const c = t.spec.classify!;
  const fields = { routine: h.name, period: h.period, step: "classify" };
  const budgetSec = c.budget?.wallClockSec ?? d.cfg.agent.wallClockSec.job;
  h.checkpoint();
  await h.stepStarted("classify", budgetSec);
  d.log.info(fields, "routine step started");
  const started = Date.now();
  const prev = isObj(h.previousOutput) ? { problems: h.previousOutput.problems ?? null, state: h.previousOutput.state ?? null } : null;
  const team = h.routine.params.team;
  let result: Awaited<ReturnType<JobRunner["runJob"]>> | undefined;
  let reason: string | undefined;
  if (!t.outputSchema) reason = `the output schema ${c.outputSchema} could not be read`;
  else {
    try {
      result = await h.refreshing(
        d.runJob(
          { routine: h.name, period: h.period, packs: h.routine.packs, input: classifyInput(summary, prev, team), outputSchema: t.outputSchema, ...(c.budget && { budget: c.budget }) },
          { caller: "job", signal: h.signal, ...(h.traceparent && { traceparent: h.traceparent }) },
        ),
      );
    } catch (err) {
      if (err instanceof JobRequestError && err.code === "shutting_down") throw new Stop("interrupted", "the classify run was interrupted by a shutdown");
      if (!(err instanceof JobRequestError)) throw err;
      reason = `${err.code}: ${err.message}`;
    }
  }
  h.checkpoint();
  if (result?.state === "done") {
    await h.write("output.json", JSON.stringify(result.output));
    await h.noteRun(result.runId, false);
    await h.stepEnded("classify", { state: "done", ...(result.runId && { runId: result.runId }) });
    d.log.info({ ...fields, durationMs: Date.now() - started, outcome: "ok", runId: result.runId }, "routine step finished");
    return { ok: true, problems: isObj(result.output) && "problems" in result.output ? result.output.problems : result.output };
  }
  reason ??= result?.degraded ? "the model is unavailable" : (result?.reason ?? `run ${result?.state ?? "not started"}`);
  if (result?.runId) await h.noteRun(result.runId);
  await h.stepEnded("classify", { state: "failed", reason, ...(result?.runId && { runId: result.runId }) });
  d.log.warn({ ...fields, durationMs: Date.now() - started, outcome: "failed", runId: result?.runId, reason }, "routine step finished");
  return { ok: false, reason };
}
