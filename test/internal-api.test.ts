import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { createPortServer, type PortServer, type Route } from "../src/gateway/http.js";
import { createInternalApi } from "../src/gateway/internal.js";
import { createO2Gateway } from "../src/gateway/o2.js";
import { createJobRunner } from "../src/runs/job.js";
import { RunManager } from "../src/runs/manager.js";
import type { AgentRunner, RunContext, RunInput, RunOutcome } from "../src/runs/types.js";

const JOB_KEY = "test-job-key";
const O2_KEY = "test-o2-key";
const env = { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y", MOOSE_JOB_KEY: JOB_KEY, O2_AGENT_API_KEY: O2_KEY };
const yaml = (o2: boolean) => `o2Gateway: { enabled: ${o2} }
skillPacks: { packs: [triage, other] }
jobsApi: { enabled: true, callers: { job: { keyFromEnv: MOOSE_JOB_KEY } } }
outbox: { slack: { allowedChannels: [C0TEST], testChannel: C0TEST } }
routines:
  daily-triage:
    kind: agent
    trigger: { schedule: "0 9 * * *", timeZone: UTC }
    owner: { slack: C0TEST }
    packs: [triage]
    instructions: Group the alerts.
    delivery: { slack: [{ channel: C0TEST, lang: en }] }
`;
const cfgFor = (o2 = true) => loadConfig({ ...env, NEOTAGS_CONFIG: "f" }, () => yaml(o2));

const log = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Pick<Logger, "info" | "warn" | "error">;
const schema = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] };
const body = (extra: Record<string, unknown> = {}) => ({ routine: "daily-triage", period: "2026-11-18T01:00:00Z", input: { alerts: 2 }, outputSchema: schema, ...extra });
const ok: RunOutcome = { state: "done", answer: "{}", output: { summary: "fine" }, steps: 1, toolCalls: 1, usage: { inputTokens: 1, outputTokens: 1 } };

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

let servers: PortServer[] = [];
afterEach(async () => {
  for (const s of servers) s.stopAccepting();
  await Promise.all(servers.map((s) => s.close(0)));
  servers = [];
});

async function serve(o: { o2?: boolean; available?: () => boolean } = {}) {
  const cfg = cfgFor(o.o2 ?? true);
  const { runner, pending } = controlled();
  const runs = new RunManager({
    runner,
    concurrency: 4,
    selfLimited: ["job"],
    perUserPerHour: 100,
    maxSteps: cfg.agent.maxSteps,
    maxInputTokens: 100_000,
    wallClockSec: cfg.agent.wallClockSec,
    finalReserveSec: 90,
    abortGraceMs: 200,
  });
  const routes: Record<string, Route> = {};
  if (cfg.o2Gateway.enabled) routes["/o2_agent/"] = createO2Gateway({ cfg: cfg.o2Gateway, key: cfg.secrets.o2AgentKey!, runs, log }).route;
  const jobs = createJobRunner({ cfg, runs, modelAvailable: o.available ?? (() => true) });
  routes["/internal/"] = createInternalApi({ keys: cfg.secrets.jobKeys!, jobs, log }).route;
  const server = createPortServer({ routes, log, name: "test" });
  servers.push(server);
  await server.listen(0, "127.0.0.1");
  const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  return { url, runs, pending };
}

const post = (url: string, payload: unknown, headers: Record<string, string> = { authorization: `Bearer ${JOB_KEY}` }) =>
  fetch(`${url}/internal/v1/runs`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean) {
  for (let i = 0; i < 200 && !f(); i++) await tick(5);
  expect(f()).toBe(true);
}

describe("internal API: /internal/v1/runs", () => {
  it("runs the request and answers with the output", async () => {
    const { url, pending } = await serve();
    const res = post(url, body());
    await until(() => pending.length === 1);
    pending[0]!.finish(ok);
    const r = await res;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ runId: expect.any(String), traceId: null, state: "done", output: { summary: "fine" }, degraded: false });
  });

  it("takes the run's source from the key, never from the body", async () => {
    const { url, pending } = await serve();
    const res = post(url, body({ source: "o2", sessionId: "s-forged", user: "admin@example.com" }));
    await until(() => pending.length === 1);
    expect(pending[0]!.input).toMatchObject({ source: "job", sessionId: "job:daily-triage:2026-11-18T01:00:00Z" });
    expect(pending[0]!.input.user).toBeUndefined();
    pending[0]!.finish(ok);
    await res;
  });

  it("refuses a missing or wrong key, and O2's key, with 401", async () => {
    const { url, pending } = await serve();
    expect((await post(url, body(), {})).status).toBe(401);
    expect((await post(url, body(), { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post(url, body(), { authorization: `Bearer ${O2_KEY}` })).status).toBe(401);
    expect((await post(url, body(), { "x-o2-agent-key": O2_KEY })).status).toBe(401);
    expect((await post(url, body(), { authorization: JOB_KEY })).status).toBe(401);
    expect((await post(url, body(), { authorization: `Basic ${JOB_KEY}` })).status).toBe(401);
    const r = await post(url, body(), { authorization: "Bearer wrong" });
    expect(await r.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    expect(pending).toHaveLength(0);
  });

  it("takes the Bearer scheme in any case", async () => {
    const { url, pending } = await serve();
    const res = post(url, body(), { authorization: `bearer  ${JOB_KEY}` });
    await until(() => pending.length === 1);
    pending[0]!.finish(ok);
    expect((await res).status).toBe(200);
  });

  it("does not let the job key into the O2 gateway", async () => {
    const { url } = await serve();
    const r = await fetch(`${url}/o2_agent/o2/query/stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${JOB_KEY}`, "x-o2-agent-key": JOB_KEY, "content-type": "application/json" },
      body: JSON.stringify({ query: "hi" }),
    });
    expect(r.status).toBe(401);
  });

  it("refuses an input over 200k characters with 413, and a body over the limit too", async () => {
    const { url, pending } = await serve();
    expect((await post(url, body({ input: "x".repeat(200_001) }))).status).toBe(413);
    expect((await post(url, body({ input: "x".repeat(3 * 1024 * 1024) }))).status).toBe(413);
    expect(pending).toHaveLength(0);
  });

  it("refuses unknown routines and packs outside the routine's with 403", async () => {
    const { url, pending } = await serve();
    expect((await post(url, body({ routine: "other-routine" }))).status).toBe(403);
    expect((await post(url, body({ packs: ["other"] }))).status).toBe(403);
    expect(pending).toHaveLength(0);
  });

  it("refuses malformed requests and budgets above the defaults with 400", async () => {
    const { url } = await serve();
    expect((await post(url, body({ period: "2026-11-18" }))).status).toBe(400);
    expect((await post(url, body({ outputSchema: undefined }))).status).toBe(400);
    expect((await post(url, body({ outputSchema: { type: "array" } }))).status).toBe(400);
    expect((await post(url, body({ budget: { wallClockSec: 3600 } }))).status).toBe(400);
    expect((await post(url, body({ budget: { maxSteps: 100 } }))).status).toBe(400);
    expect((await fetch(`${url}/internal/v1/runs`, { headers: { authorization: `Bearer ${JOB_KEY}` } })).status).toBe(405);
    for (const path of ["/internal/v1/nope", "/internal/v2/runs"]) {
      const r = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${JOB_KEY}` } });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: { code: "not_found", message: "not found" } });
    }
  });

  it("answers degraded at once when the model is unavailable", async () => {
    const { url, pending } = await serve({ available: () => false });
    const r = await post(url, body());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ runId: null, traceId: null, state: "failed", output: null, degraded: true, reason: "model unavailable" });
    expect(pending).toHaveLength(0);
  });

  it("refuses with 503 while draining", async () => {
    const { url, runs } = await serve();
    await runs.drain(10);
    const r = await post(url, body());
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("5");
    expect((await r.json()).error.code).toBe("shutting_down");
  });

  it("cancels the run when the caller goes away", async () => {
    const { url, pending } = await serve();
    const req = request(`${url}/internal/v1/runs`, { method: "POST", headers: { authorization: `Bearer ${JOB_KEY}`, "content-type": "application/json" } });
    req.on("error", () => {});
    req.end(JSON.stringify(body()));
    await until(() => pending.length === 1);
    req.destroy();
    await until(() => pending[0]!.ctx.signal.aborted);
  });

  it("serves the internal API with the O2 gateway off, and nothing under /o2_agent/", async () => {
    const { url, pending } = await serve({ o2: false });
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    const o2 = await fetch(`${url}/o2_agent/o2/query/stream`, { method: "POST", headers: { "x-o2-agent-key": O2_KEY }, body: "{}" });
    expect(o2.status).toBe(404);
    const res = post(url, body());
    await until(() => pending.length === 1);
    pending[0]!.finish(ok);
    expect((await res).status).toBe(200);
  });
});

describe("jobsApi config", () => {
  const load = (y: string, e: Record<string, string> = env) => () => loadConfig({ ...e, NEOTAGS_CONFIG: "f" }, () => y);

  it("needs a caller, and each caller's key in the env", () => {
    expect(load("jobsApi: { enabled: true }")).toThrow(/at least one caller/);
    const { MOOSE_JOB_KEY: _k, ...noKey } = env;
    expect(load("jobsApi: { enabled: true, callers: { job: { keyFromEnv: MOOSE_JOB_KEY } } }", noKey)).toThrow(/MOOSE_JOB_KEY/);
    expect(load("jobsApi: { enabled: true, callers: { portal: { keyFromEnv: MOOSE_JOB_KEY } } }")).toThrow();
    expect(load("jobsApi: { enabled: false, callers: { job: { keyFromEnv: MISSING } } }")().secrets.jobKeys).toBeUndefined();
  });

  it("refuses a job key equal to O2's", () => {
    expect(load("o2Gateway: { enabled: true }\njobsApi: { enabled: true, callers: { job: { keyFromEnv: O2_AGENT_API_KEY } } }")).toThrow(/give each its own/);
  });

  it("defaults the job wall clock to 900 s and one routine at a time", () => {
    const c = loadConfig({ ...env, NEOTAGS_CONFIG: "f" }, () => "");
    expect(c.agent.wallClockSec.job).toBe(900);
    expect(c.jobsApi).toEqual({ enabled: false, callers: {}, concurrency: 1 });
    expect(c.routines).toEqual({});
  });
});
