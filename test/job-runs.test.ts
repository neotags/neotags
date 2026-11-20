import { TraceFlags } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGateway } from "../src/agent/models.js";
import { loadConfig } from "../src/config/index.js";
import { createJobRunner, JobRequestError, type JobRunRequest } from "../src/runs/job.js";
import { RunManager } from "../src/runs/manager.js";
import { outputValidator, SUBMIT_TOOL, submitOutputTool } from "../src/runs/output.js";
import { PiAgentRunner } from "../src/runs/pi-runner.js";
import type { AgentRunner, RunContext, RunInput, RunOutcome } from "../src/runs/types.js";
import { startTelemetry } from "../src/telemetry/index.js";
import { SkillPackIndex } from "../src/tools/skillpacks.js";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { callTool, fail, say, scripted, transcriptText, type Reply } from "./fake-stream.js";

const exporter = new InMemorySpanExporter();
const telemetry = startTelemetry({ exporter })!;
const flushed = async (): Promise<ReadableSpan[]> => {
  await telemetry.flush();
  return exporter.getFinishedSpans();
};

const base = { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y", MOOSE_JOB_KEY: "test-job-key" };
const cfgFor = (extra = "") =>
  loadConfig({ ...base, NEOTAGS_CONFIG: "f" }, () => `llm:
  baseUrl: http://gw.test/v1
  models:
    flash: { id: flash-model, reasoning: true, thinkingLevelMap: { max: max } }
    jobm: { id: job-model, reasoning: true }
  chains:
    agent: [{ model: flash, effort: high, finalEffort: max }]
    job: [{ model: jobm, effort: medium }]
    gate: [{ model: flash, effort: none }]
    summary: [{ model: flash, effort: low }]
  failover:
    breaker: { failures: 1, windowSec: 60, cooldownSec: 120 }
skillPacks: { packs: [triage, other] }
jobsApi: { enabled: true, callers: { job: { keyFromEnv: MOOSE_JOB_KEY } } }
mcp:
  servers:
    - { name: o2, url: "http://o2.test/mcp", allowTools: [SearchSQL] }
    - { name: o2prod, url: "http://o2prod.test/mcp", allowTools: [SearchSQL] }
outbox: { slack: { allowedChannels: [C0TEST], testChannel: C0TEST } }
routines:
  daily-triage:
    kind: pipeline
    type: alert-triage
    trigger: { schedule: "0 9 * * *", timeZone: Asia/Shanghai }
    owner: { slack: C0TEST }
    packs: [triage]
    mcp: [o2prod]
    params: { window: 24h }
    delivery: { slack: [{ channel: C0TEST, lang: zh }] }
${extra}`);

const index = new SkillPackIndex(
  new Map([
    ["triage", { name: "triage", description: "Group alerts into problems", body: "Group by cause.", refs: new Map() }],
    ["other", { name: "other", description: "Something else", body: "Other.", refs: new Map([["secret.md", "other's reference"]]) }],
    ["method", { name: "method", description: "", refs: new Map([["problems.md", "how to group"]]) }],
  ]),
);

const schema = {
  type: "object",
  properties: { notify: { type: "boolean" }, summary: { type: "string", minLength: 1 } },
  required: ["notify", "summary"],
  additionalProperties: false,
};

const job = (extra: Partial<RunInput> = {}): RunInput => ({
  source: "job",
  sessionId: "job:daily-triage:2026-11-18T01:00:00Z",
  question: "Group the alerts.",
  jobInput: '{"alerts":3}',
  packs: ["triage"],
  outputSchema: schema,
  ...extra,
});

function ctxFor(o: { maxSteps?: number; signal?: AbortSignal } = {}): RunContext {
  return {
    runId: "r1",
    signal: o.signal ?? new AbortController().signal,
    budget: { maxSteps: o.maxSteps ?? 30, softDeadline: Number.MAX_SAFE_INTEGER, maxInputTokens: 100_000 },
    observer: {},
  };
}

function piRunner(replies: Reply[], cfg = cfgFor()) {
  const stream = scripted(replies);
  const gateway = createGateway(cfg);
  const runner = new PiAgentRunner({
    gateway,
    index,
    botName: "moose",
    entries: {},
    firstTokenTimeoutMs: 1000,
    maxRetries: 0,
    charsPerToken: 4,
    streamFn: stream,
    sleep: async () => {},
  });
  return { runner, stream, gateway };
}

const good = { notify: true, summary: "two problems" };
const toolNames = (c: { messages: Parameters<typeof getCurrentTools>[0] }) => getCurrentTools(c.messages).map((t) => t.name);

describe("submit_output", () => {
  it("rejects schemas a tool cannot take", () => {
    expect(() => outputValidator({ type: "array" })).toThrow(/type "object"/);
    expect(() => outputValidator({ type: "object", properties: { a: { type: "nope" } } })).toThrow();
  });

  it("compiles the same $id again for every request's new schema object", () => {
    const fresh = () => ({ $id: "https://example.com/out.json", type: "object", properties: { a: { type: "string" } } });
    for (let i = 0; i < 3; i++) expect(outputValidator(fresh())({ a: "x" })).toBe(true);
  });

  it("takes draft 2020-12 schemas (zod v4's toJSONSchema) by their $schema", () => {
    const zs = z.toJSONSchema(z.object({ notify: z.boolean(), pair: z.tuple([z.string(), z.number()]) })) as Record<string, unknown>;
    expect(String(zs.$schema)).toContain("2020-12");
    const v = outputValidator(zs);
    expect(v({ notify: true, pair: ["a", 1] })).toBe(true);
    // prefixItems is a 2020-12 keyword; draft-07 would not check the tuple's items.
    expect(v({ notify: true, pair: [1, "a"] })).toBe(false);
  });

  it("reads every schema as 2020-12, like pi's own argument check, whatever $schema says", () => {
    const v = outputValidator({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "string" } }, unevaluatedProperties: false });
    expect(v({ a: "x" })).toBe(true);
    expect(v({ a: "x", b: 1 })).toBe(false);
  });

  it("validates with the schema itself and reports ajv's errors at their paths", async () => {
    const got: unknown[] = [];
    const tool = submitOutputTool({ ...schema, properties: { ...schema.properties, at: { type: "string", format: "date-time" } } }, (v) => got.push(v));
    const bad = await tool.execute("c1", { notify: true, summary: "x", at: "yesterday", extra: 1 } as never);
    expect(bad.isError).toBe(true);
    const text = (bad.content[0] as { text: string }).text;
    expect(text).toContain('/at: must match format "date-time"');
    expect(text).toContain("must NOT have additional properties");
    expect(got).toEqual([]);
    const fine = await tool.execute("c2", { notify: false, summary: "x", at: "2026-11-18T01:00:00Z" } as never);
    expect(fine.isError).toBeUndefined();
    expect(got).toEqual([{ notify: false, summary: "x", at: "2026-11-18T01:00:00Z" }]);
  });

  it("ends the run at the first valid call, with its arguments as the output, on the job chain", async () => {
    const { runner, stream } = piRunner([callTool(SUBMIT_TOOL, good)]);
    const out = await runner.run(job(), ctxFor());
    expect(out).toMatchObject({ state: "done", output: good, model: "job-model", effort: "medium" });
    expect(stream.calls).toHaveLength(1);
    const sent = transcriptText(stream.calls[0]!.context);
    expect(sent).toContain('<job_input>\n{"alerts":3}\n</job_input>');
    expect(sent).toContain("deliver the result only by calling submit_output");
    expect(toolNames(stream.calls[0]!.context)).toContain(SUBMIT_TOOL);
  });

  it("gives the schema errors back once, and takes the fixed call", async () => {
    const { runner, stream } = piRunner([callTool(SUBMIT_TOOL, { notify: true, summary: "" }), callTool(SUBMIT_TOOL, good)]);
    const out = await runner.run(job(), ctxFor());
    expect(out).toMatchObject({ state: "done", output: good });
    const retry = transcriptText(stream.calls[1]!.context);
    expect(retry).toMatch(/summary: expected at least 1 characters/);
  });

  it("fails the run when the second call is invalid too", async () => {
    const { runner, stream } = piRunner([callTool(SUBMIT_TOOL, { notify: "maybe" }), callTool(SUBMIT_TOOL, { summary: "" }), say("never asked")]);
    await expect(runner.run(job(), ctxFor())).rejects.toThrow(/rejected 2 times/);
    expect(stream.calls).toHaveLength(2);
  });

  it("still lets the model submit when the steps run out, with submit_output as the only tool", async () => {
    const { runner, stream } = piRunner([callTool("read_skill", { name: "triage" }), callTool(SUBMIT_TOOL, good)]);
    const out = await runner.run(job(), ctxFor({ maxSteps: 1 }));
    expect(out).toMatchObject({ state: "budget_exhausted", output: good, reason: "budget: steps" });
    expect(toolNames(stream.calls[1]!.context)).toEqual([SUBMIT_TOOL]);
    expect(transcriptText(stream.calls[1]!.context)).toContain("submit_output is the only tool left");
  });

  it("asks once more when the model answers in text, then fails if it still does not submit", async () => {
    const { runner, stream } = piRunner([say("here is my answer in prose"), say("still prose")]);
    await expect(runner.run(job(), ctxFor())).rejects.toThrow(/did not call submit_output/);
    expect(stream.calls).toHaveLength(2);
    expect(transcriptText(stream.calls[1]!.context)).toContain("No submit_output call has been accepted yet");
  });

  it("keeps an accepted output when the run is aborted right after it", async () => {
    const { runner } = piRunner([callTool(SUBMIT_TOOL, good)]);
    const ac = new AbortController();
    const ctx = { ...ctxFor({ signal: ac.signal }), observer: { toolEnd: () => ac.abort(new Error("caller went away")) } };
    await expect(runner.run(job(), ctx)).resolves.toMatchObject({ state: "done", output: good });
  });

  it("takes the output when the model submits after being asked", async () => {
    const { runner } = piRunner([say("prose"), callTool(SUBMIT_TOOL, good)]);
    await expect(runner.run(job(), ctxFor())).resolves.toMatchObject({ state: "done", output: good });
  });

  it("lets a job run read only its own packs and reference-only ones", async () => {
    const { runner, stream } = piRunner([
      callTool("read_skill", { name: "other" }),
      callTool("read_skill_ref", { name: "method", file: "problems.md" }),
      callTool(SUBMIT_TOOL, good),
    ]);
    await expect(runner.run(job(), ctxFor())).resolves.toMatchObject({ output: good });
    const sent = transcriptText(stream.calls[2]!.context);
    expect(sent).toContain('unknown skill pack "other"');
    expect(sent).toContain("how to group");
    expect(sent).toContain("- triage: Group alerts into problems");
    expect(sent).not.toContain("- other:");
  });

  it("leaves runs without an outputSchema unchanged", async () => {
    const { runner, stream } = piRunner([say("plain answer")]);
    const out = await runner.run({ source: "o2", sessionId: "s", question: "q?" }, ctxFor());
    expect(out).toMatchObject({ state: "done", answer: "plain answer", model: "flash-model" });
    expect(out.output).toBeUndefined();
    expect(toolNames(stream.calls[0]!.context)).not.toContain(SUBMIT_TOOL);
  });
});

/** A runner whose runs finish when the test says so. */
function controlled() {
  const pending: { input: RunInput; ctx: RunContext; finish: (o: RunOutcome) => void }[] = [];
  const runner: AgentRunner = {
    run: (input, ctx) =>
      new Promise<RunOutcome>((resolve, reject) => {
        pending.push({ input, ctx, finish: resolve });
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  };
  return { runner, pending };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const submitted: RunOutcome = { state: "done", answer: "{}", output: good, steps: 1, toolCalls: 1, usage: { inputTokens: 1, outputTokens: 1 } };

function jobs(o: { cfg?: ReturnType<typeof cfgFor>; total?: number; available?: () => boolean } = {}) {
  const cfg = o.cfg ?? cfgFor();
  const { runner, pending } = controlled();
  let n = 0;
  const logs: Record<string, unknown>[] = [];
  const runs = new RunManager({
    log: { info: (obj: unknown) => void logs.push(obj as Record<string, unknown>), warn: () => {}, error: () => {} } as never,
    runner,
    concurrency: o.total ?? 4,
    selfLimited: ["job"],
    perUserPerHour: 1,
    maxSteps: cfg.agent.maxSteps,
    maxInputTokens: 100_000,
    wallClockSec: cfg.agent.wallClockSec,
    finalReserveSec: 90,
    newId: () => `run-${++n}`,
  });
  const jr = createJobRunner({ cfg, runs, modelAvailable: o.available ?? (() => true) });
  return { ...jr, runs, pending, cfg, logs };
}

const req = (extra: Partial<JobRunRequest> = {}): JobRunRequest => ({ routine: "daily-triage", period: "2026-11-18T01:00:00Z", input: { alerts: [1, 2] }, outputSchema: schema, ...extra });

describe("runJob", () => {
  it("runs on the routine's packs and session, with the input in its own field", async () => {
    const j = jobs();
    const p = j.runJob(req(), { caller: "job" });
    await tick();
    const { input } = j.pending[0]!;
    expect(input).toMatchObject({
      source: "job",
      sessionId: "job:daily-triage:2026-11-18T01:00:00Z",
      packs: ["triage"],
      jobInput: '{"alerts":[1,2]}',
      outputSchema: schema,
      routine: { name: "daily-triage", period: "2026-11-18T01:00:00Z" },
    });
    j.pending[0]!.finish(submitted);
    await expect(p).resolves.toMatchObject({ runId: "run-1", state: "done", output: good, degraded: false });
  });

  it("keeps the routine's fields in the config", () => {
    expect(cfgFor().routines["daily-triage"]).toMatchObject({ packs: ["triage"], kind: "pipeline", params: { window: "24h" } });
  });

  it("gives the run only the routine's own MCP servers", async () => {
    const j = jobs();
    const p = j.runJob(req(), { caller: "job" });
    await tick();
    expect(j.pending[0]!.input.mcp).toEqual({ hide: ["o2"] });
    j.pending[0]!.finish(submitted);
    await p;
  });

  it("refuses unknown routines and packs the routine does not have", async () => {
    const j = jobs();
    await expect(j.runJob(req({ routine: "nope" }), { caller: "job" })).rejects.toMatchObject({ status: 403 });
    await expect(j.runJob(req({ routine: "constructor" }), { caller: "job" })).rejects.toMatchObject({ status: 403 });
    await expect(j.runJob(req({ packs: ["triage", "other"] }), { caller: "job" })).rejects.toMatchObject({ status: 403, message: /other/ });
    expect(j.pending).toHaveLength(0);
  });

  it("refuses an input over 200k characters with 413", async () => {
    const j = jobs();
    await expect(j.runJob(req({ input: "x".repeat(200_001) }), { caller: "job" })).rejects.toMatchObject({ status: 413 });
    // Counted as serialized: {"a":"..."} is 8 characters more than the string.
    await expect(j.runJob(req({ input: { a: "x".repeat(199_993) } }), { caller: "job" })).rejects.toMatchObject({ status: 413 });
  });

  it("refuses an unusable output schema with 400", async () => {
    const j = jobs();
    await expect(j.runJob(req({ outputSchema: { type: "string" } }), { caller: "job" })).rejects.toBeInstanceOf(JobRequestError);
  });

  it("applies a smaller budget and refuses a larger one", async () => {
    const j = jobs();
    await expect(j.runJob(req({ budget: { wallClockSec: 901 } }), { caller: "job" })).rejects.toMatchObject({ status: 400 });
    await expect(j.runJob(req({ budget: { maxSteps: 31 } }), { caller: "job" })).rejects.toMatchObject({ status: 400 });
    const t0 = Date.now();
    const p = j.runJob(req({ budget: { wallClockSec: 300, maxSteps: 12 } }), { caller: "job" });
    await tick();
    const { ctx } = j.pending[0]!;
    expect(ctx.budget.maxSteps).toBe(12);
    // 300 s less the 90 s final reserve.
    expect(ctx.budget.softDeadline - t0).toBeGreaterThan(209_000);
    expect(ctx.budget.softDeadline - t0).toBeLessThan(211_000);
    j.pending[0]!.finish(submitted);
    await p;
  });

  it("uses the job wall clock (900 s by default) without a budget", async () => {
    const j = jobs();
    const t0 = Date.now();
    const p = j.runJob(req(), { caller: "job" });
    await tick();
    const { ctx } = j.pending[0]!;
    expect(ctx.budget.maxSteps).toBe(30);
    expect(ctx.budget.softDeadline - t0).toBeGreaterThan(809_000);
    j.pending[0]!.finish(submitted);
    await p;
  });

  it("queues beyond jobsApi.concurrency without taking or waiting for an interactive slot", async () => {
    const j = jobs({ total: 1 });
    const first = j.runJob(req(), { caller: "job" });
    const second = j.runJob(req({ period: "2026-11-19T01:00:00Z" }), { caller: "job" });
    await tick();
    expect(j.pending.map((p) => p.input.source)).toEqual(["job"]);
    // The one interactive slot is still free, and the hourly limit does not count routines.
    const o2 = j.runs.submit({ source: "o2", sessionId: "s1", user: "a@example.com", question: "q" });
    expect(o2.ok && o2.run.state).toBe("running");
    expect(j.runs.stats()).toEqual({ running: 1, queued: 0 });
    j.pending[0]!.finish(submitted);
    await first;
    await tick();
    expect(j.pending.map((p) => p.input.sessionId)).toEqual(["job:daily-triage:2026-11-18T01:00:00Z", "s1", "job:daily-triage:2026-11-19T01:00:00Z"]);
    j.pending[2]!.finish(submitted);
    await expect(second).resolves.toMatchObject({ state: "done" });
    j.pending[1]!.finish(submitted);
    await tick();
    // Not rate limited, but not logged as an exempt user either (that flag marks agent.concurrency.exemptUsers).
    expect(j.logs.filter((l) => l.source === "job")).toHaveLength(2);
    expect(j.logs.some((l) => l.rateLimitExempt)).toBe(false);
  });

  it("starts routine runs while the interactive pool is full", async () => {
    const j = jobs({ total: 1 });
    j.runs.submit({ source: "o2", sessionId: "s1", question: "q" });
    const queued = j.runs.submit({ source: "o2", sessionId: "s2", question: "q" });
    expect(queued.ok && queued.run.state).toBe("queued");
    const p = j.runJob(req(), { caller: "job" });
    await tick();
    expect(j.pending.map((x) => x.input.source)).toEqual(["o2", "job"]);
    j.pending[1]!.finish(submitted);
    await expect(p).resolves.toMatchObject({ state: "done" });
  });

  it("answers degraded at once when the model is unavailable, without a run", async () => {
    const j = jobs({ available: () => false });
    await expect(j.runJob(req(), { caller: "job" })).resolves.toEqual({ state: "failed", output: null, degraded: true, reason: "model unavailable" });
    expect(j.pending).toHaveLength(0);
  });

  it("reports a run whose model failed as degraded, and one without output as failed", async () => {
    const j = jobs();
    const p = j.runJob(req(), { caller: "job" });
    await tick();
    j.pending[0]!.finish({ state: "done", answer: "prose", steps: 0, toolCalls: 0, usage: { inputTokens: 0, outputTokens: 0 } });
    await expect(p).resolves.toMatchObject({ state: "failed", output: null, degraded: false });
  });

  it("refuses with 503 while draining", async () => {
    const j = jobs();
    await j.runs.drain(10);
    await expect(j.runJob(req(), { caller: "job" })).rejects.toMatchObject({ status: 503, code: "shutting_down" });
  });

  it("answers 503, not cancelled, for a run a shutdown interrupts", async () => {
    const j = jobs();
    const running = j.runJob(req(), { caller: "job" });
    const queued = j.runJob(req({ period: "2026-11-19T01:00:00Z" }), { caller: "job" });
    await tick();
    await j.runs.drain(10);
    await expect(running).rejects.toMatchObject({ status: 503, code: "shutting_down" });
    await expect(queued).rejects.toMatchObject({ status: 503 });
  });

  it("counts queue positions within each pool", async () => {
    const j = jobs({ total: 1 });
    j.runs.submit({ source: "o2", sessionId: "s1", question: "q" });
    const p = j.runJob(req(), { caller: "job" });
    await tick();
    // A retry of the same period waits behind its own session, ahead of the next O2 question in the queue.
    const retry = j.runs.submit({ source: "job", sessionId: "job:daily-triage:2026-11-18T01:00:00Z", question: "q" });
    expect(retry.ok && retry.run.state).toBe("queued");
    const aheads: number[] = [];
    j.runs.submit({ source: "o2", sessionId: "s2", question: "q" }, { queued: (i) => aheads.push(i.ahead) });
    expect(aheads).toEqual([0]);
    j.pending[1]!.finish(submitted);
    await p;
  });

  it("cancels the run, or the wait for a slot, when its signal aborts", async () => {
    const j = jobs();
    const a = new AbortController();
    const b = new AbortController();
    const first = j.runJob(req(), { caller: "job", signal: a.signal });
    const second = j.runJob(req({ period: "2026-11-19T01:00:00Z" }), { caller: "job", signal: b.signal });
    await tick();
    b.abort();
    await expect(second).resolves.toMatchObject({ state: "cancelled", output: null });
    a.abort();
    await expect(first).resolves.toMatchObject({ state: "cancelled", runId: "run-1" });
    // The slot is free again.
    const third = j.runJob(req(), { caller: "job" });
    await tick();
    j.pending[1]!.finish(submitted);
    await expect(third).resolves.toMatchObject({ state: "done" });
  });

  it("sends a model-unavailable run through the job chain's breaker", async () => {
    const cfg = cfgFor();
    const { runner, gateway } = piRunner([fail("upstream 500")], cfg);
    await expect(runner.run(job(), ctxFor())).rejects.toThrow();
    expect(gateway.policy.steps("job")[0]!.breaker.state).toBe("open");
    expect(gateway.policy.steps("agent")[0]!.breaker.state).toBe("closed");
    await expect(runner.run(job(), ctxFor())).rejects.toMatchObject({ kind: "model_unavailable" });
  });
});

describe("job run spans", () => {
  it("names the agent job, carries the routine and period, and hangs under the caller's traceparent", async () => {
    exporter.reset();
    const cfg = cfgFor();
    const { runner } = piRunner([callTool(SUBMIT_TOOL, good)], cfg);
    const runs = new RunManager({
      runner,
      concurrency: 1,
      selfLimited: ["job"],
      perUserPerHour: 1,
      maxSteps: 30,
      maxInputTokens: 100_000,
      wallClockSec: cfg.agent.wallClockSec,
      finalReserveSec: 90,
    });
    const { runJob } = createJobRunner({ cfg, runs, modelAvailable: () => true });
    const parent = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", traceFlags: TraceFlags.SAMPLED };
    const res = await runJob(req(), { caller: "job", traceparent: `00-${parent.traceId}-${parent.spanId}-01` });
    expect(res).toMatchObject({ state: "done", output: good, traceId: parent.traceId });
    const spans = await flushed();
    const run = spans.find((s) => s.attributes["neotags.run.id"] === res.runId)!;
    expect(run.name).toBe("invoke_agent job");
    expect(run.attributes).toMatchObject({
      "gen_ai.agent.name": "job",
      "neotags.routine.name": "daily-triage",
      "neotags.routine.period": "2026-11-18T01:00:00Z",
      "session.id": "job:daily-triage:2026-11-18T01:00:00Z",
    });
    expect(run.spanContext().traceId).toBe(parent.traceId);
    expect(run.parentSpanContext?.spanId).toBe(parent.spanId);
    const chat = spans.find((s) => s.parentSpanContext?.spanId === run.spanContext().spanId && s.name.startsWith("chat "))!;
    expect(chat.name).toBe("chat job-model");
  });
});
