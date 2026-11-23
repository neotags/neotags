import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore, PreconditionError } from "../src/artifacts/index.js";
import { loadConfig } from "../src/config/index.js";
import { createInternalApi } from "../src/gateway/internal.js";
import { createPortServer } from "../src/gateway/http.js";
import { classifyInput } from "../src/routines/engine.js";
import { acquireLease, LEASE_TIMING, type LeaseTiming } from "../src/routines/lease.js";
import type { Outbox } from "../src/routines/outbox.js";
import { AGENT_OUTPUT_SCHEMA, createRoutines, FireError } from "../src/routines/period.js";
import type { RunRecord } from "../src/routines/records.js";
import { routineTypes } from "../src/routines/types.js";
import { createJobRunner } from "../src/runs/job.js";
import { RunManager } from "../src/runs/manager.js";
import type { AgentRunner, RunContext, RunInput, RunOutcome } from "../src/runs/types.js";
import { SkillExecutor } from "../src/sandbox/exec.js";
import { Slots } from "../src/sandbox/slots.js";
import type { ExecResult, Sandbox } from "../src/sandbox/types.js";
import { startTelemetry } from "../src/telemetry/index.js";
import { SkillPackIndex, type SkillPack } from "../src/tools/skillpacks.js";

const exporter = new InMemorySpanExporter();
const telemetry = startTelemetry({ exporter })!;
const flushed = async (): Promise<ReadableSpan[]> => {
  await telemetry.flush();
  return exporter.getFinishedSpans();
};

const P = "2026-11-20T09:00:00Z";
const T0 = Date.parse("2026-11-20T09:30:00Z");
const DIR = `jobs/daily/${P}/`;
const AGENT_DIR = `jobs/weekly/${P}/`;

const cfgFor = (extra = "") =>
  loadConfig({ SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y", MOOSE_JOB_KEY: "test-job-key", NEOTAGS_CONFIG: "f" }, () => `skillPacks: { packs: [steps, classify, assistant] }
jobsApi: { enabled: true, callers: { job: { keyFromEnv: MOOSE_JOB_KEY } }, concurrency: 1 }
outbox: { slack: { allowedChannels: [C0TEST, C0TEAM], testChannel: C0TEST } }
artifacts: { s3: { bucket: test-bucket } }
routines:
  daily:
    kind: pipeline
    type: demo
    trigger: { schedule: "0 9 * * *", timeZone: UTC }
    owner: { slack: C0TEST }
    packs: [classify]
    params: { window: 24h, team: vnet }
    delivery: { slack: [{ channel: C0TEAM, lang: zh }, { channel: C0TEST, lang: en }] }
  weekly:
    kind: agent
    trigger: { schedule: "0 9 * * *", timeZone: UTC }
    owner: { slack: C0TEST }
    packs: [assistant]
    instructions: Review the alerts.
    budget: { wallClockSec: 600 }
    delivery: { notify: when_findings, slack: [{ channel: C0TEAM, lang: en }] }
${extra}`);

const problemsSchema = { type: "object", properties: { problems: { type: "array" }, state: { type: "string" } }, required: ["problems"] };

const stepPack = (over: Partial<NonNullable<SkillPack["pipeline"]>> = {}): SkillPack => ({
  name: "steps",
  description: "Demo steps",
  body: "Steps.",
  refs: new Map(),
  sandbox: { net: [], tools: ["python3"], credentials: [], limits: { timeoutSec: 120 } },
  pipeline: {
    type: "demo",
    steps: [
      { name: "pull", argv: ["python3", "/skills/steps/step.py", "pull"] },
      { name: "render", argv: ["python3", "/skills/steps/step.py", "render"] },
    ],
    classify: { after: "pull", outputSchema: "classify/references/problems.schema.json", budget: { wallClockSec: 300 } },
    degrade: "render",
    ...over,
  },
});

const indexOf = (steps: SkillPack = stepPack()) =>
  new SkillPackIndex(
    new Map<string, SkillPack>([
      ["steps", steps],
      ["classify", { name: "classify", description: "Group alerts", body: "Group.", refs: new Map([["problems.schema.json", JSON.stringify(problemsSchema)]]) }],
      ["assistant", { name: "assistant", description: "Assist", body: "Assist.", refs: new Map() }],
    ]),
  );

const bundle = (notify = true) => ({
  notify,
  sections: { all: { zh: { slack: "报告", attachments: { "report.html": "<p>zh</p>" } }, en: { slack: "report" } } },
});

type StepOut = Partial<ExecResult> | Error | ((input: Record<string, any>, signal?: AbortSignal) => Promise<Partial<ExecResult>>);
const ok = (out: unknown): Partial<ExecResult> => ({ stdout: JSON.stringify(out) });

/** A sandbox backend that answers each step (argv's last element) from `steps`, recording every call. */
function fakeSandbox(steps: Record<string, StepOut[] | StepOut>) {
  const calls: { step: string; input: Record<string, any> }[] = [];
  const sandbox: Sandbox = {
    backend: "fake",
    exec: async (entry, _c, signal) => {
      const step = entry.argv.at(-1)!;
      const input = JSON.parse(entry.files!["in.json"]!) as Record<string, any>;
      calls.push({ step, input });
      const list = steps[step];
      let out = Array.isArray(list) ? (list.length > 1 ? list.shift()! : list[0]!) : list!;
      if (typeof out === "function") out = await out(input, signal);
      if (out instanceof Error) throw out;
      return { id: entry.id, exitCode: 0, signal: null, timedOut: false, durationMs: 5, stdout: "", stderr: "", truncated: { stdout: false, stderr: false }, egress: [], ...out };
    },
  };
  return { sandbox, calls };
}

const defaultSteps = (): Record<string, StepOut[] | StepOut> => ({
  pull: ok({ data: { alerts: 3 }, classifyInput: "3 alerts" }),
  render: (input) => Promise.resolve(ok({ bundle: bundle(), state: { anchors: { p1: "#p1" }, saw: input.problems } })),
});

/** A runner whose runs answer from `answer` (default: one problem), or wait for `hold` and the abort. */
function runner(o: { answer?: (input: RunInput) => Partial<RunOutcome>; hold?: boolean } = {}) {
  const inputs: RunInput[] = [];
  const ctxs: RunContext[] = [];
  const r: AgentRunner = {
    run: (input, ctx) =>
      new Promise<RunOutcome>((resolve, reject) => {
        inputs.push(input);
        ctxs.push(ctx);
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        if (o.hold) return;
        const base = input.outputSchema === AGENT_OUTPUT_SCHEMA ? { notify: true, summary: "one finding", report: "*report*", state: "seen p1" } : { problems: [{ id: "p1" }], state: "kept p1" };
        resolve({ state: "done", answer: "", output: base, steps: 1, toolCalls: 1, usage: { inputTokens: 1, outputTokens: 1 }, ...o.answer?.(input) });
      }),
  };
  return { runner: r, inputs, ctxs };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 2));
  }
};

interface HarnessOptions {
  store?: MemoryArtifactStore;
  steps?: Record<string, StepOut[] | StepOut>;
  run?: Parameters<typeof runner>[0];
  index?: SkillPackIndex;
  outbox?: Outbox;
  holder?: string;
  clock?: { t: number };
  timing?: Partial<LeaseTiming & { refreshMs: number; periodMs: number; stepSlotTimeoutMs: number }>;
  cfg?: ReturnType<typeof cfgFor>;
}

/** One bot Pod: real RunManager, job runner and sandbox guard; fake model runner, sandbox and S3. */
function harness(o: HarnessOptions = {}) {
  const cfg = o.cfg ?? cfgFor();
  const store = o.store ?? new MemoryArtifactStore();
  const clock = o.clock ?? { t: T0 };
  const logs: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const log = Object.fromEntries(
    ["info", "warn", "error"].map((level) => [level, (obj: unknown, msg?: string) => void logs.push({ level, obj: (typeof obj === "object" ? obj : {}) as Record<string, unknown>, msg: msg ?? String(obj) })]),
  ) as never;
  const index = o.index ?? indexOf();
  const { sandbox, calls } = fakeSandbox(o.steps ?? defaultSteps());
  const executor = new SkillExecutor({ sandbox, index, log });
  const model = runner(o.run);
  let n = 0;
  const runs = new RunManager({
    log,
    runner: model.runner,
    concurrency: 4,
    selfLimited: ["job"],
    perUserPerHour: 1,
    maxSteps: cfg.agent.maxSteps,
    maxInputTokens: 100_000,
    wallClockSec: cfg.agent.wallClockSec,
    finalReserveSec: 90,
    newId: () => `run-${++n}`,
  });
  const slots = new Slots(cfg.jobsApi.concurrency);
  const jobs = createJobRunner({ cfg, runs, modelAvailable: () => true, slots });
  const routines = createRoutines({
    cfg,
    store,
    jobs,
    executor,
    types: routineTypes(index),
    holder: o.holder ?? "pod-a",
    log,
    isDraining: () => runs.isDraining,
    now: () => clock.t,
    ...(o.outbox && { outbox: o.outbox }),
    ...(o.timing && { timing: o.timing }),
  });
  const json = <T = any>(key: string): T | undefined => {
    const b = store.objects.get(key)?.body;
    return b === undefined ? undefined : (JSON.parse(b) as T);
  };
  return { cfg, store, clock, logs, routines, calls, model, runs, slots, jobs, json };
}

const fire = (h: ReturnType<typeof harness>, extra: { dryRun?: boolean; force?: boolean } = {}, name = "daily") => h.routines.fire(name, { period: P, ...extra }, "job");

/** A lease.json and run.json as another holder left them. */
function leftBy(store: MemoryArtifactStore, dir: string, o: { token: string; leaseExpiresAt?: string; run?: Partial<RunRecord> }) {
  if (o.leaseExpiresAt) store.objects.set(`${dir}lease.json`, { body: JSON.stringify({ holder: "pod-old", token: o.token, expiresAt: o.leaseExpiresAt }), etag: '"old-lease"' });
  if (o.run) {
    const run: RunRecord = {
      kind: "pipeline",
      state: "running",
      token: o.token,
      holder: "pod-old",
      deadlineAt: new Date(T0 + 1800_000).toISOString(),
      startedAt: new Date(T0 - 600_000).toISOString(),
      updatedAt: new Date(T0 - 60_000).toISOString(),
      steps: [],
      runIds: [],
      holders: [{ holder: "pod-old", token: o.token, startedAt: new Date(T0 - 600_000).toISOString() }],
      degraded: false,
      ...o.run,
    };
    store.objects.set(`${dir}run.json`, { body: JSON.stringify(run), etag: '"old-run"' });
  }
}

describe("fire", () => {
  it("writes run.json as running before answering 202, then runs the pipeline in the background to delivered", async () => {
    const h = harness({ run: { hold: true } });
    const answer = await fire(h);
    expect(answer).toEqual({ status: 202, body: { period: P } });
    const run = h.json<RunRecord>(`${DIR}run.json`)!;
    expect(run).toMatchObject({ state: "running", holder: "pod-a", deadlineAt: new Date(T0 + 3600_000).toISOString() });
    expect(run.token).toBe(h.json(`${DIR}lease.json`).token);
    // The classify run is waiting: the period is still running.
    await until(() => h.model.inputs.length === 1);
    expect(h.json<RunRecord>(`${DIR}run.json`)!.step).toBe("classify");
    await h.routines.drain(1000);
  });

  it("runs pull, the classify run and render, writes the records and marks the period delivered", async () => {
    const h = harness();
    await fire(h);
    await h.routines.idle();
    expect(h.calls.map((c) => c.step)).toEqual(["pull", "render"]);
    expect(h.calls[0]!.input).toMatchObject({ task: "daily", period: P, window: { start: "2026-11-19T09:00:00Z", end: P }, params: { window: "24h" }, previous: null });
    expect(h.calls[0]!.input.data).toBeUndefined();
    expect(h.calls[1]!.input).toMatchObject({ data: { alerts: 3 }, problems: [{ id: "p1" }] });
    const run = h.json<RunRecord>(`${DIR}run.json`)!;
    expect(run).toMatchObject({ state: "delivered", degraded: false, runIds: ["run-1"] });
    expect(run.steps.map((s) => [s.name, s.state])).toEqual([
      ["pull", "done"],
      ["classify", "done"],
      ["render", "done"],
      ["deliver", "done"],
    ]);
    expect(h.json(`${DIR}data.json`)).toEqual({ after: "pull", data: { alerts: 3 }, classifyInput: "3 alerts" });
    expect(h.json(`${DIR}input.json`).data).toBeUndefined();
    expect(h.json(`${DIR}output.json`)).toEqual({ problems: [{ id: "p1" }], state: "kept p1" });
    expect(h.json(`${DIR}state.json`)).toMatchObject({ anchors: { p1: "#p1" } });
    expect(h.store.objects.get(`${DIR}bundle/sections/all/zh/slack.md`)!.body).toBe("报告");
    expect(h.store.objects.get(`${DIR}bundle/sections/all/zh/attachments/report.html`)!.body).toBe("<p>zh</p>");
    expect(h.json(`${DIR}bundle/manifest.json`)).toEqual({
      notify: true,
      sections: { all: { zh: { slack: "sections/all/zh/slack.md", attachments: { "report.html": "sections/all/zh/attachments/report.html" } }, en: { slack: "sections/all/en/slack.md", attachments: {} } } },
    });
    expect(h.json(`${DIR}delivery-pending.json`).targets).toEqual(["slack:C0TEAM:all:zh", "slack:C0TEST:all:en"]);
    expect(h.store.objects.has(`${DIR}lease.json`)).toBe(false);
    // The classify run: the routine's packs, the step pack's schema and budget, the routine's session.
    const input = h.model.inputs[0]!;
    expect(input).toMatchObject({ source: "job", sessionId: `job:daily:${P}`, packs: ["classify"], outputSchema: problemsSchema, budget: { wallClockSec: 300 } });
    expect(JSON.parse(input.jobInput!)).toEqual({ summary: "3 alerts", previous: null, team: "vnet" });
  });

  it("answers 200 for a delivered period without running it again", async () => {
    const h = harness();
    await fire(h);
    await h.routines.idle();
    await expect(fire(h)).resolves.toEqual({ status: 200, body: { state: "delivered" } });
    expect(h.calls).toHaveLength(2);
  });

  it("lets only one of two Pods firing the same period at once run it; the other gets 409", async () => {
    const store = new MemoryArtifactStore();
    const a = harness({ store, holder: "pod-a", run: { hold: true } });
    const b = harness({ store, holder: "pod-b", run: { hold: true } });
    const results = await Promise.allSettled([fire(a), fire(b)]);
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : (r.reason as FireError).status)).sort();
    expect(statuses).toEqual([202, 409]);
    await Promise.all([a.routines.drain(1000), b.routines.drain(1000)]);
  });

  it("refuses periods the schedule does not fire at, or older than 8 days, with the reason", async () => {
    const h = harness();
    await expect(h.routines.fire("daily", { period: "2026-11-20T08:00:00Z" }, "job")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not a time "0 9 \* \* \*" fires at/) });
    await expect(h.routines.fire("daily", { period: "2026-11-11T09:00:00Z" }, "job")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/more than 8 days ago/) });
    await expect(h.routines.fire("nope", { period: P }, "job")).rejects.toMatchObject({ status: 404 });
  });

  it("answers 503 while the run manager drains, and while the routines drain", async () => {
    const h = harness();
    void h.runs.drain(10);
    await expect(fire(h)).rejects.toMatchObject({ status: 503, code: "shutting_down" });
    const h2 = harness();
    await h2.routines.drain(10);
    await expect(fire(h2)).rejects.toMatchObject({ status: 503, code: "shutting_down" });
  });

  it("runs a dry run under dryrun/, and the formal period afterwards as usual", async () => {
    const h = harness();
    await fire(h, { dryRun: true });
    await h.routines.idle();
    expect(h.json(`jobs/daily/dryrun/${P}/run.json`).state).toBe("delivered");
    expect(h.store.objects.has(`${DIR}run.json`)).toBe(false);
    await expect(fire(h)).resolves.toMatchObject({ status: 202 });
    await h.routines.idle();
    expect(h.json(`${DIR}run.json`).state).toBe("delivered");
  });

  it("finishes the period after the client that fired it went away", async () => {
    const h = harness();
    const api = createInternalApi({ keys: { job: "test-job-key" }, jobs: h.jobs, routines: h.routines, log: { info: () => {}, warn: () => {}, error: () => {} } });
    const server = createPortServer({ routes: { "/internal/": api.route }, log: { error: () => {} }, name: "test" });
    await server.listen(0, "127.0.0.1");
    const port = (server.server.address() as { port: number }).port;
    const gone = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/internal/v1/routines/daily/fire`, {
      method: "POST",
      headers: { authorization: "Bearer test-job-key", "content-type": "application/json" },
      body: JSON.stringify({ period: P }),
      signal: gone.signal,
    });
    expect(res.status).toBe(202);
    gone.abort();
    await h.routines.idle();
    expect(h.json(`${DIR}run.json`).state).toBe("delivered");
    const status = await fetch(`http://127.0.0.1:${port}/internal/v1/routines/daily/periods/${encodeURIComponent(P)}?dryRun=false`, { headers: { authorization: "Bearer test-job-key" } });
    expect(await status.json()).toMatchObject({ state: "delivered", runIds: ["run-1"] });
    const missing = await fetch(`http://127.0.0.1:${port}/internal/v1/routines/daily/periods/${encodeURIComponent(P)}?dryRun=true`, { headers: { authorization: "Bearer test-job-key" } });
    expect(missing.status).toBe(404);
    const bad = await fetch(`http://127.0.0.1:${port}/internal/v1/routines/daily/fire`, { method: "POST", headers: { authorization: "Bearer test-job-key" }, body: JSON.stringify({ period: "2026-11-20T08:00:00Z" }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toMatch(/not a time/);
    await server.close(0);
  });
});

describe("idempotency", () => {
  it("skips the steps up to data.json, and reruns the classify run and render", async () => {
    const store = new MemoryArtifactStore();
    store.objects.set(`${DIR}data.json`, { body: JSON.stringify({ after: "pull", data: { alerts: 9 }, classifyInput: "9 alerts" }), etag: '"d"' });
    const h = harness({ store });
    await fire(h);
    await h.routines.idle();
    expect(h.calls.map((c) => c.step)).toEqual(["render"]);
    expect(h.calls[0]!.input.data).toEqual({ alerts: 9 });
    expect(JSON.parse(h.model.inputs[0]!.jobInput!).summary).toBe("9 alerts");
    expect(h.json<RunRecord>(`${DIR}run.json`)!.steps.find((s) => s.name === "pull")).toMatchObject({ state: "skipped" });
  });

  it("goes straight to delivery when the bundle is written", async () => {
    const store = new MemoryArtifactStore();
    store.objects.set(`${DIR}bundle/manifest.json`, { body: JSON.stringify({ notify: true, sections: {} }), etag: '"m"' });
    const h = harness({ store });
    await fire(h);
    await h.routines.idle();
    expect(h.calls).toEqual([]);
    expect(h.model.inputs).toEqual([]);
    expect(h.json(`${DIR}run.json`).state).toBe("delivered");
  });

  it("delivers only the targets delivered.json does not have as delivered", async () => {
    const store = new MemoryArtifactStore();
    store.objects.set(`${DIR}bundle/manifest.json`, { body: JSON.stringify({ notify: true, sections: {} }), etag: '"m"' });
    store.objects.set(`${DIR}delivered.json`, { body: JSON.stringify({ token: "old", targets: { "slack:C0TEAM:all:zh": { ok: true, at: "x", link: "https://slack.example.com/1" } } }), etag: '"dl"' });
    const delivered: string[] = [];
    const h = harness({ store, outbox: { deliver: async (t) => (delivered.push(t.key), { link: `https://slack.example.com/${t.key}` }), notifyOwner: async () => {} } });
    await fire(h);
    await h.routines.idle();
    expect(delivered).toEqual(["slack:C0TEST:all:en"]);
    const rec = h.json(`${DIR}delivered.json`);
    expect(rec.token).toBe(h.json<RunRecord>(`${DIR}run.json`)!.token);
    expect(Object.keys(rec.targets)).toEqual(["slack:C0TEAM:all:zh", "slack:C0TEST:all:en"]);
    expect((await h.routines.status("daily", P, false))!.delivered).toEqual(["slack:C0TEAM:all:zh", "slack:C0TEST:all:en"]);
  });

  it("fails the period when a target fails, keeping what was delivered for the next try", async () => {
    let n = 0;
    const h = harness({
      outbox: {
        deliver: async (t) => {
          if (n++ === 1) throw new Error("channel_not_found");
          return { link: t.key };
        },
        notifyOwner: async () => {},
      },
    });
    await fire(h);
    await h.routines.idle();
    expect(h.json(`${DIR}run.json`)).toMatchObject({ state: "failed", reason: expect.stringMatching(/delivery failed: slack:C0TEST:all:en/) });
    expect(h.json(`${DIR}delivered.json`).targets).toMatchObject({ "slack:C0TEAM:all:zh": { ok: true }, "slack:C0TEST:all:en": { ok: false, error: "channel_not_found" } });
  });

  it("runs a failed period again before its deadline, keeping the deadline", async () => {
    const store = new MemoryArtifactStore();
    const deadlineAt = new Date(T0 + 1200_000).toISOString();
    leftBy(store, DIR, { token: "old", run: { state: "failed", reason: "step pull: exit code 1", deadlineAt } });
    const h = harness({ store });
    await expect(fire(h)).resolves.toMatchObject({ status: 202 });
    await h.routines.idle();
    expect(h.json(`${DIR}run.json`)).toMatchObject({ state: "delivered", deadlineAt });
  });

  it("answers 200 failed past the deadline, and runs again with force, which resets the deadline", async () => {
    const store = new MemoryArtifactStore();
    leftBy(store, DIR, { token: "old", run: { state: "failed", reason: "deadline", deadlineAt: new Date(T0 - 1000).toISOString() } });
    const h = harness({ store });
    await expect(fire(h)).resolves.toEqual({ status: 200, body: { state: "failed" } });
    await expect(fire(h, { force: true })).resolves.toMatchObject({ status: 202 });
    expect(h.json(`${DIR}run.json`).deadlineAt).toBe(new Date(T0 + 3600_000).toISOString());
    await h.routines.idle();
    expect(h.json(`${DIR}run.json`).state).toBe("delivered");
  });
});

describe("leases", () => {
  const timing: LeaseTiming = LEASE_TIMING;

  it("renews on the etag it last wrote, and releases only its own lease", async () => {
    const store = new MemoryArtifactStore();
    const clock = { t: T0 };
    const got = await acquireLease(store, "jobs/x/lease.json", "pod-a", { now: () => clock.t, timing });
    if (!got.ok) throw new Error("not acquired");
    expect(JSON.parse(store.objects.get("jobs/x/lease.json")!.body)).toMatchObject({ holder: "pod-a", expiresAt: new Date(T0 + 300_000).toISOString() });
    clock.t += 120_000;
    await got.lease.renew();
    expect(JSON.parse(store.objects.get("jobs/x/lease.json")!.body).expiresAt).toBe(new Date(T0 + 420_000).toISOString());
    // Taken over: release leaves the new holder's lease alone.
    store.objects.set("jobs/x/lease.json", { body: JSON.stringify({ holder: "pod-b", token: "b", expiresAt: "2099-01-01T00:00:00Z" }), etag: '"b"' });
    await got.lease.release();
    expect(JSON.parse(store.objects.get("jobs/x/lease.json")!.body).holder).toBe("pod-b");
  });

  it("loses the lease on 412 and 404, and retries a 409 once while the lease is still its own", async () => {
    const store = new MemoryArtifactStore();
    const lost: string[] = [];
    const got = await acquireLease(store, "jobs/x/lease.json", "pod-a", { now: () => T0, timing, onLost: (w) => lost.push(w) });
    if (!got.ok) throw new Error("not acquired");
    store.failNext("put", "jobs/x/lease.json", () => new PreconditionError(409, "jobs/x/lease.json"));
    await got.lease.renew();
    expect(got.lease.lost).toBe(false);
    store.objects.delete("jobs/x/lease.json");
    await expect(got.lease.renew()).rejects.toThrow(/gone/);
    expect(lost).toHaveLength(1);
    await expect(got.lease.ensure()).rejects.toThrow(/gone/);

    const again = await acquireLease(store, "jobs/y/lease.json", "pod-a", { now: () => T0, timing });
    if (!again.ok) throw new Error("not acquired");
    store.objects.set("jobs/y/lease.json", { body: "{}", etag: '"other"' });
    await expect(again.lease.renew()).rejects.toThrow(/taken over/);
  });

  it("takes over an expired lease, but not a live one; a concurrent delete (409) gets one more try", async () => {
    const store = new MemoryArtifactStore();
    store.objects.set("jobs/x/lease.json", { body: JSON.stringify({ holder: "pod-old", token: "t", expiresAt: new Date(T0 + 1000).toISOString() }), etag: '"e"' });
    expect(await acquireLease(store, "jobs/x/lease.json", "pod-a", { now: () => T0, timing })).toMatchObject({ ok: false, current: { holder: "pod-old" } });
    const taken = await acquireLease(store, "jobs/x/lease.json", "pod-a", { now: () => T0 + 2000, timing });
    expect(taken.ok).toBe(true);
    expect(JSON.parse(store.objects.get("jobs/x/lease.json")!.body).holder).toBe("pod-a");
    store.failNext("put", "jobs/z/lease.json", () => new PreconditionError(409, "jobs/z/lease.json"));
    expect((await acquireLease(store, "jobs/z/lease.json", "pod-a", { now: () => T0, timing })).ok).toBe(true);
  });

  it("stops the period when a renewal finds the lease taken over: the run is cancelled, nothing more is written or delivered", async () => {
    const h = harness({ run: { hold: true }, timing: { renewEveryMs: 10 } });
    await fire(h);
    await until(() => h.model.inputs.length === 1);
    // Another Pod took the period over (as after this one stalled past the expiry).
    h.store.objects.set(`${DIR}lease.json`, { body: JSON.stringify({ holder: "pod-b", token: "b", expiresAt: "2099-01-01T00:00:00Z" }), etag: '"b"' });
    const writes: string[] = [];
    const put = h.store.put.bind(h.store);
    h.store.put = async (key, body, cond) => {
      const r = await put(key, body, cond);
      writes.push(key);
      return r;
    };
    await h.routines.idle();
    expect(h.model.ctxs[0]!.signal.aborted).toBe(true);
    expect(writes).toEqual([]);
    expect(h.calls.map((c) => c.step)).toEqual(["pull"]);
    expect(h.store.objects.has(`${DIR}delivery-pending.json`)).toBe(false);
    expect(JSON.parse(h.store.objects.get(`${DIR}lease.json`)!.body).holder).toBe("pod-b");
    expect(h.logs.some((l) => l.msg === "period stopped: its lease was taken over")).toBe(true);
  });

  it("takes over a period whose holder died: a new trace, the same deadline, and run.json names both holders", async () => {
    const store = new MemoryArtifactStore();
    const deadlineAt = new Date(T0 + 1800_000).toISOString();
    leftBy(store, DIR, { token: "old", leaseExpiresAt: new Date(T0 - 1000).toISOString(), run: { deadlineAt } });
    const h = harness({ store, holder: "pod-b" });
    await expect(fire(h)).resolves.toMatchObject({ status: 202 });
    await h.routines.idle();
    const run = h.json<RunRecord>(`${DIR}run.json`)!;
    expect(run).toMatchObject({ state: "delivered", deadlineAt, holder: "pod-b" });
    expect(run.holders.map((x) => x.holder)).toEqual(["pod-old", "pod-b"]);
    expect(run.holders[1]!.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("answers 409 while another holder's lease is live", async () => {
    const store = new MemoryArtifactStore();
    leftBy(store, DIR, { token: "old", leaseExpiresAt: new Date(T0 + 60_000).toISOString(), run: {} });
    await expect(fire(harness({ store }))).rejects.toMatchObject({ status: 409 });
  });
});

describe("deadlines and shutdown", () => {
  it("marks a period failed (deadline) once its deadline passes, and keeps it failed on the next fire", async () => {
    const store = new MemoryArtifactStore();
    leftBy(store, DIR, { token: "old", leaseExpiresAt: new Date(T0 - 1000).toISOString(), run: { deadlineAt: new Date(T0 - 1).toISOString() } });
    const h = harness({ store });
    await expect(fire(h)).resolves.toMatchObject({ status: 202 });
    await h.routines.idle();
    expect(h.json(`${DIR}run.json`)).toMatchObject({ state: "failed", reason: "deadline", deadlineAt: new Date(T0 - 1).toISOString() });
    expect(h.calls).toEqual([]);
    expect(store.objects.has(`${DIR}lease.json`)).toBe(false);
    await expect(fire(h)).resolves.toEqual({ status: 200, body: { state: "failed" } });
  });

  it("stops a running period at its deadline", async () => {
    const h = harness({ run: { hold: true }, timing: { periodMs: 50 } });
    await fire(h);
    await h.routines.idle();
    expect(h.model.ctxs[0]!.signal.aborted).toBe(true);
    expect(h.json(`${DIR}run.json`)).toMatchObject({ state: "failed", reason: "deadline" });
  });

  it("does not fail a period a shutdown interrupts mid-step: running, reason interrupted, lease released; a new Pod goes on from data.json", async () => {
    const store = new MemoryArtifactStore();
    const steps = defaultSteps();
    // render hangs until the sandbox call is aborted.
    steps.render = (_i, signal) => new Promise((_r, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const a = harness({ store, steps });
    await fire(a);
    await until(() => a.calls.some((c) => c.step === "render"));
    expect(await a.routines.drain(1000)).toBe(true);
    expect(a.json(`${DIR}run.json`)).toMatchObject({ state: "running", reason: "interrupted" });
    expect(store.objects.has(`${DIR}lease.json`)).toBe(false);
    expect((await a.routines.status("daily", P, false))!.state).toBe("orphaned");

    const b = harness({ store, holder: "pod-b" });
    await expect(fire(b)).resolves.toMatchObject({ status: 202 });
    await b.routines.idle();
    expect(b.calls.map((c) => c.step)).toEqual(["render"]);
    expect(b.json(`${DIR}run.json`)).toMatchObject({ state: "delivered", holder: "pod-b" });
  });

  it("treats a classify run the shutdown interrupts as interrupted too", async () => {
    const h = harness({ run: { hold: true } });
    await fire(h);
    await until(() => h.model.inputs.length === 1);
    await Promise.all([h.runs.drain(10), h.routines.drain(1000)]);
    expect(h.json(`${DIR}run.json`)).toMatchObject({ state: "running", reason: "interrupted" });
  });
});

describe("review fixes", () => {
  it("gives a dry run's runs a session of their own", async () => {
    const h = harness();
    await fire(h, { dryRun: true });
    await h.routines.idle();
    expect(h.model.inputs[0]!.sessionId).toBe(`job:daily:${P}:dryrun`);
  });

  it("waits, on drain, for a fire that was taking the lease when the drain began, and interrupts its period", async () => {
    const h = harness({ run: { hold: true } });
    const get = h.store.get.bind(h.store);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = false;
    // Hold the read under the lease, so the drain starts before the period is registered.
    h.store.get = async (key) => {
      if (key === `${DIR}run.json` && h.store.objects.has(`${DIR}lease.json`) && !gated) {
        gated = true;
        await gate;
      }
      return get(key);
    };
    const fired = fire(h);
    await until(() => gated);
    const drained = h.routines.drain(2000);
    release();
    await expect(fired).resolves.toMatchObject({ status: 202 });
    expect(await drained).toBe(true);
    expect(h.json(`${DIR}run.json`)).toMatchObject({ state: "running", reason: "interrupted" });
    expect(h.store.objects.has(`${DIR}lease.json`)).toBe(false);
  });

  it("stops a run when the minute refresh finds run.json written by another holder", async () => {
    const h = harness({ run: { hold: true }, timing: { refreshMs: 10 } });
    await fire(h, {}, "weekly");
    await until(() => h.model.inputs.length === 1);
    h.store.objects.set(`${AGENT_DIR}run.json`, { body: JSON.stringify({ state: "running", token: "other" }), etag: '"other"' });
    await h.routines.idle();
    expect(h.model.ctxs[0]!.signal.aborted).toBe(true);
    expect(h.store.objects.has(`${AGENT_DIR}output.json`)).toBe(false);
  });

  it("refreshes run.json while a step waits for a slot, so a queued step is not stalled", async () => {
    const h = harness({ timing: { refreshMs: 10 } });
    await h.slots.acquire(10);
    await fire(h);
    await until(() => h.json<RunRecord>(`${DIR}run.json`)!.step === "pull");
    const first = h.json<RunRecord>(`${DIR}run.json`)!.updatedAt;
    h.clock.t += 60_000;
    await until(() => h.json<RunRecord>(`${DIR}run.json`)!.updatedAt !== first);
    h.slots.release();
    await h.routines.idle();
    expect(h.json(`${DIR}run.json`).state).toBe("delivered");
  });

  it("writes state.json even when render gives no state, so an earlier attempt's never carries over", async () => {
    const store = new MemoryArtifactStore();
    store.objects.set(`${DIR}state.json`, { body: JSON.stringify({ stale: true }), etag: '"s"' });
    const h = harness({ store, steps: { ...defaultSteps(), render: ok({ bundle: bundle() }) } });
    await fire(h);
    await h.routines.idle();
    expect(h.json(`${DIR}state.json`)).toBeNull();
  });

  it("reads the lease before run.json, so a holder finishing in between is not reported orphaned", async () => {
    const store = new MemoryArtifactStore();
    leftBy(store, DIR, { token: "t", leaseExpiresAt: new Date(T0 + 200_000).toISOString(), run: {} });
    const h = harness({ store });
    const get = store.get.bind(store);
    // The holder writes failed and releases right after the status read the lease.
    store.get = async (key) => {
      const r = await get(key);
      if (key === `${DIR}lease.json`) {
        leftBy(store, DIR, { token: "t", run: { state: "failed", reason: "step pull: exit code 1" } });
        store.objects.delete(`${DIR}lease.json`);
      }
      return r;
    };
    expect((await h.routines.status("daily", P, false))!.state).toBe("failed");
  });
});

describe("period status", () => {
  const status = (store: MemoryArtifactStore, clock = { t: T0 }) => harness({ store, clock }).routines.status("daily", P, false);

  it("reports running for the live holder's own record, stalled past the step budget plus 5 minutes", async () => {
    const store = new MemoryArtifactStore();
    leftBy(store, DIR, { token: "t", leaseExpiresAt: new Date(T0 + 200_000).toISOString(), run: { step: "pull", stepBudgetSec: 120, updatedAt: new Date(T0 - 400_000).toISOString() } });
    expect(await status(store)).toMatchObject({ state: "running", step: "pull", leaseExpiresAt: new Date(T0 + 200_000).toISOString() });
    leftBy(store, DIR, { token: "t", run: { step: "pull", stepBudgetSec: 120, updatedAt: new Date(T0 - 421_000).toISOString() } });
    const h = harness({ store });
    expect(await h.routines.status("daily", P, false)).toMatchObject({ state: "stalled", step: "pull" });
    expect(h.logs.some((l) => l.level === "warn" && l.msg === "period stalled")).toBe(true);
  });

  it("does not call a long agent run stalled while it refreshes updatedAt", async () => {
    const store = new MemoryArtifactStore();
    leftBy(store, AGENT_DIR, { token: "t", leaseExpiresAt: new Date(T0 + 200_000).toISOString(), run: { kind: "agent", step: "run", stepBudgetSec: 600, updatedAt: new Date(T0 - 50_000).toISOString(), startedAt: new Date(T0 - 900_000).toISOString() } });
    expect((await harness({ store }).routines.status("weekly", P, false))!.state).toBe("running");
  });

  it("refreshes updatedAt every minute during a run", async () => {
    const h = harness({ run: { hold: true }, timing: { refreshMs: 10 } });
    await fire(h);
    await until(() => h.model.inputs.length === 1);
    const first = h.json<RunRecord>(`${DIR}run.json`)!.updatedAt;
    h.clock.t += 60_000;
    await until(() => h.json<RunRecord>(`${DIR}run.json`)!.updatedAt !== first);
    expect(h.json<RunRecord>(`${DIR}run.json`)!.step).toBe("classify");
    await h.routines.drain(1000);
  });

  it("reports orphaned when the lease is gone or expired before the period ended", async () => {
    const store = new MemoryArtifactStore();
    leftBy(store, DIR, { token: "t", run: {} });
    expect((await status(store))!.state).toBe("orphaned");
    leftBy(store, DIR, { token: "t", leaseExpiresAt: new Date(T0 - 1).toISOString() });
    expect((await status(store))!.state).toBe("orphaned");
  });

  it("does not take a superseded holder's record: the live holder's lease decides", async () => {
    const store = new MemoryArtifactStore();
    // The old holder wrote failed after pod-b took the period over.
    store.objects.set(`${DIR}lease.json`, { body: JSON.stringify({ holder: "pod-b", token: "new", expiresAt: new Date(T0 + 200_000).toISOString() }), etag: '"l"' });
    leftBy(store, DIR, { token: "old", run: { state: "failed", reason: "step pull: exit code 1", step: "pull" } });
    expect(await status(store)).toMatchObject({ state: "running", step: null, updatedAt: null });
    expect((await status(store))!.reason).toBeUndefined();
  });

  it("reports failed once the holder released the lease, and delivered whatever the lease", async () => {
    const store = new MemoryArtifactStore();
    leftBy(store, DIR, { token: "t", run: { state: "failed", reason: "deadline" } });
    expect(await status(store)).toMatchObject({ state: "failed", reason: "deadline" });
    leftBy(store, DIR, { token: "t", leaseExpiresAt: new Date(T0 + 1000).toISOString(), run: { state: "delivered" } });
    expect((await status(store))!.state).toBe("delivered");
    expect(await harness().routines.status("daily", P, false)).toBeUndefined();
  });
});

describe("pipeline engine", () => {
  it("retries a step whose stdout is not JSON, or truncated, once; then the period fails", async () => {
    const h = harness({ steps: { ...defaultSteps(), pull: [{ stdout: "not json" }, { stdout: '{"data":', truncated: { stdout: true, stderr: false } }] } });
    await fire(h);
    await h.routines.idle();
    expect(h.calls.map((c) => c.step)).toEqual(["pull", "pull"]);
    expect(h.json(`${DIR}run.json`)).toMatchObject({ state: "failed", reason: "step pull: stdout was truncated by the executor" });
    expect(h.json<RunRecord>(`${DIR}run.json`)!.steps[0]).toMatchObject({ name: "pull", state: "failed", attempts: 2 });
  });

  it("passes on a retried step that works the second time", async () => {
    const h = harness({ steps: { ...defaultSteps(), pull: [{ exitCode: 1, stderr: "boom token=abc" }, ok({ data: {}, classifyInput: "none" })] } });
    await fire(h);
    await h.routines.idle();
    expect(h.calls.map((c) => c.step)).toEqual(["pull", "pull", "render"]);
    expect(h.json(`${DIR}run.json`).state).toBe("delivered");
    expect(h.store.objects.get(`${DIR}steps/pull-1.stderr.txt`)!.body).toContain("boom");
  });

  it("does not retry exit code 2", async () => {
    const h = harness({ steps: { ...defaultSteps(), pull: { exitCode: 2, stderr: "bad params" } } });
    await fire(h);
    await h.routines.idle();
    expect(h.calls.map((c) => c.step)).toEqual(["pull"]);
    expect(h.json(`${DIR}run.json`)).toMatchObject({ state: "failed", reason: "step pull: exit code 2 (parameters or configuration)" });
  });

  it("renders with problems: null and marks the period degraded when the classify run fails", async () => {
    const h = harness({ run: { answer: () => ({ output: undefined }) } });
    await fire(h);
    await h.routines.idle();
    expect(h.calls.map((c) => c.step)).toEqual(["pull", "render"]);
    expect(h.calls[1]!.input.problems).toBeNull();
    expect(h.json(`${DIR}run.json`)).toMatchObject({ state: "delivered", degraded: true });
    expect(h.json<RunRecord>(`${DIR}run.json`)!.steps.find((s) => s.name === "classify")).toMatchObject({ state: "failed" });
    expect(h.store.objects.has(`${DIR}output.json`)).toBe(false);
  });

  it("finishes a period with jobsApi.concurrency 1: steps and the classify run take the slot in turn", async () => {
    const h = harness();
    expect(h.cfg.jobsApi.concurrency).toBe(1);
    expect(h.slots).toBe(h.jobs.slots);
    await fire(h);
    await h.routines.idle();
    expect(h.json(`${DIR}run.json`).state).toBe("delivered");
  });

  it("fails a step whose slot does not come free in time", async () => {
    const h = harness({ timing: { stepSlotTimeoutMs: 5 } });
    await h.slots.acquire(10);
    await fire(h);
    await h.routines.idle();
    h.slots.release();
    expect(h.calls).toEqual([]);
    expect(h.json(`${DIR}run.json`)).toMatchObject({ state: "failed", reason: expect.stringMatching(/step pull: no jobsApi.concurrency slot/) });
  });

  it("fails a bundle with unsafe file names", async () => {
    const h = harness({ steps: { ...defaultSteps(), render: ok({ bundle: { notify: true, sections: { all: { zh: { slack: "x", attachments: { "../x": "y" } } } } }, state: {} }) } });
    await fire(h);
    await h.routines.idle();
    expect(h.json(`${DIR}run.json`)).toMatchObject({ state: "failed", reason: expect.stringMatching(/not a plain file name/) });
  });

  it("takes the previous formal delivered period: not a dry run, not a failed one, zero targets count", async () => {
    const store = new MemoryArtifactStore();
    const put = (dir: string, state: string, extra: Record<string, unknown> = {}) => {
      store.objects.set(`${dir}run.json`, { body: JSON.stringify({ state, token: "t" }), etag: '"r"' });
      for (const [f, v] of Object.entries(extra)) store.objects.set(`${dir}${f}`, { body: JSON.stringify(v), etag: '"x"' });
    };
    put("jobs/daily/2026-11-17T09:00:00Z/", "delivered", { "output.json": { problems: [{ id: "old" }], state: "older" } });
    put("jobs/daily/2026-11-18T09:00:00Z/", "delivered", { "output.json": { problems: [{ id: "p7" }], state: "keep p7" }, "state.json": { anchors: { p7: "#p7" } }, "delivery-pending.json": { targets: [] } });
    put("jobs/daily/2026-11-19T09:00:00Z/", "failed", { "output.json": { problems: [{ id: "failed" }] } });
    put(`jobs/daily/dryrun/2026-11-19T09:00:00Z/`, "delivered", { "output.json": { problems: [{ id: "dry" }] } });
    put("jobs/daily/2026-11-21T09:00:00Z/", "delivered", { "output.json": { problems: [{ id: "later" }] } });
    const h = harness({ store });
    await fire(h);
    await h.routines.idle();
    expect(JSON.parse(h.model.inputs[0]!.jobInput!).previous).toEqual({ problems: [{ id: "p7" }], state: "keep p7" });
    expect(h.calls[0]!.input.previous).toEqual({ state: { anchors: { p7: "#p7" } } });
  });

  it("keeps the classify run's input under 200k: the previous memory goes first, then the summary is cut", () => {
    const small = classifyInput("s", { problems: [1], state: "x" }, "vnet");
    expect(small).toEqual({ summary: "s", previous: { problems: [1], state: "x" }, team: "vnet" });
    const big = classifyInput("a".repeat(150_000), { problems: ["p".repeat(80_000)], state: "x" }, null);
    expect(big.previous).toBeNull();
    expect(big.summary).toHaveLength(150_000);
    const huge = classifyInput("b\n".repeat(150_000), null, null);
    expect(JSON.stringify(huge).length).toBeLessThanOrEqual(200_000);
    expect(String(huge.summary)).toMatch(/\[cut: the summary was over the input limit\]$/);
  });
});

describe("agent routines", () => {
  it("runs one run with the routine's instructions and budget, the previous summary and state as memory", async () => {
    const store = new MemoryArtifactStore();
    store.objects.set("jobs/weekly/2026-11-19T09:00:00Z/run.json", { body: JSON.stringify({ state: "delivered" }), etag: '"r"' });
    store.objects.set("jobs/weekly/2026-11-19T09:00:00Z/output.json", { body: JSON.stringify({ notify: false, summary: "quiet", report: "r", state: "s".repeat(9000) }), etag: '"o"' });
    const h = harness({ store });
    await fire(h, {}, "weekly");
    await h.routines.idle();
    const input = h.model.inputs[0]!;
    expect(input).toMatchObject({ question: "Review the alerts.", outputSchema: AGENT_OUTPUT_SCHEMA, budget: { wallClockSec: 600 }, packs: ["assistant"] });
    const job = JSON.parse(input.jobInput!);
    expect(job.previous_period.summary).toBe("quiet");
    expect(job.previous_period.state).toHaveLength(8000);
    expect(h.json(`${AGENT_DIR}output.json`)).toMatchObject({ notify: true, summary: "one finding" });
    expect(h.json(`${AGENT_DIR}run.json`)).toMatchObject({ kind: "agent", state: "delivered" });
    expect(h.json(`${AGENT_DIR}delivery-pending.json`).targets).toEqual(["slack:C0TEAM:all:en"]);
  });

  it("counts a when_findings period with nothing to report as delivered, with no targets", async () => {
    const h = harness({ run: { answer: () => ({ output: { notify: false, summary: "nothing", report: "none" } }) } });
    await fire(h, {}, "weekly");
    await h.routines.idle();
    expect(h.json(`${AGENT_DIR}run.json`).state).toBe("delivered");
    expect(h.json(`${AGENT_DIR}delivery-pending.json`).targets).toEqual([]);
  });

  it("fails the period when the run gives no output", async () => {
    const h = harness({ run: { answer: () => ({ output: undefined }) } });
    await fire(h, {}, "weekly");
    await h.routines.idle();
    expect(h.json(`${AGENT_DIR}run.json`)).toMatchObject({ state: "failed", reason: expect.stringMatching(/^run: /) });
  });
});

describe("routine spans", () => {
  it("opens a root span per period with a child per sandbox step, and hangs the classify run under it", async () => {
    exporter.reset();
    const h = harness();
    await fire(h);
    await h.routines.idle();
    const spans = await flushed();
    const traceId = h.json<RunRecord>(`${DIR}run.json`)!.holders[0]!.traceId;
    const root = spans.find((s) => s.name === "routine daily" && s.spanContext().traceId === traceId)!;
    expect(root.parentSpanContext).toBeUndefined();
    expect(root.attributes).toMatchObject({
      "gen_ai.agent.name": "job",
      "neotags.routine.name": "daily",
      "neotags.routine.period": P,
      "neotags.routine.state": "delivered",
      "neotags.routine.degraded": false,
    });
    const steps = spans.filter((s) => s.name.startsWith("routine.step ") && s.spanContext().traceId === traceId);
    expect(steps.map((s) => s.name).sort()).toEqual(["routine.step pull", "routine.step render"]);
    for (const s of steps) {
      expect(s.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
      expect(s.attributes).toMatchObject({ "neotags.sandbox.exit_code": 0, "neotags.sandbox.truncated": false, "neotags.routine.step.attempts": 1 });
      expect(s.attributes["neotags.sandbox.stdout_bytes"]).toBeGreaterThan(0);
      expect(typeof s.attributes["neotags.routine.step.duration_ms"]).toBe("number");
    }
    const run = spans.find((s) => s.name === "invoke_agent job" && s.spanContext().traceId === traceId)!;
    expect(run.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(run.spanContext().traceId).toBe(root.spanContext().traceId);
    // One log line per step start and end, with the step's numbers.
    const ended = h.logs.filter((l) => l.msg === "routine step finished").map((l) => l.obj);
    expect(ended.find((l) => l.step === "pull")).toMatchObject({ routine: "daily", period: P, outcome: "ok", exitCode: 0, durationMs: expect.any(Number), stdoutBytes: expect.any(Number) });
    expect(h.logs.filter((l) => l.msg === "routine step started").map((l) => l.obj.step)).toEqual(["pull", "classify", "render", "deliver"]);
  });
});

