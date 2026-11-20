import { describe, expect, it } from "vitest";
import { EXIT_DELIVERED, EXIT_FAILED, EXIT_USAGE, fireMain, type FireDeps } from "../src/routines/fire.js";

const PERIOD = "2026-11-18T01:00:00Z";
const JOB_NAME = `daily-${Date.parse(PERIOD) / 60_000}`;
const env = { MOOSE_URL: "http://moose.test:3001/", MOOSE_JOB_KEY: "test-job-key", JOB_NAME };
const T0 = Date.parse("2026-11-18T01:00:20Z");
const deadlineAt = new Date(T0 + 3600_000).toISOString();

type Answer = number | { status: number; body?: unknown } | Error;
interface Call {
  at: number;
  method: string;
  url: string;
  body?: Record<string, unknown>;
  auth?: string;
}

/**
 * A fake bot: `post` and `get` answer the calls in turn (the last answer repeats). Time is virtual: sleeping moves the
 * clock, so a test of an hour's wait takes no time.
 */
function bot(o: { post?: Answer[]; get?: Answer[] }) {
  let now = T0;
  const calls: Call[] = [];
  const logs: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const queues = { POST: [...(o.post ?? [202])], GET: [...(o.get ?? [])] };
  const fetch = (async (url: string, init: RequestInit) => {
    const method = init.method as "GET" | "POST";
    calls.push({
      at: now,
      method,
      url,
      ...(init.body !== undefined && { body: JSON.parse(String(init.body)) }),
      auth: (init.headers as Record<string, string>).authorization,
    });
    const q = queues[method];
    const a = q.length > 1 ? q.shift()! : q[0];
    if (a === undefined) throw new Error(`no answer for ${method}`);
    if (a instanceof Error) throw a;
    const { status, body } = typeof a === "number" ? { status: a, body: undefined } : a;
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  const log = (level: string) => (obj: Record<string, unknown>, msg: string) => void logs.push({ level, obj, msg });
  const deps: FireDeps = {
    fetch,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    log: { info: log("info"), warn: log("warn"), error: log("error") } as never,
  };
  return {
    deps,
    calls,
    logs,
    run: (argv: string[] = ["daily"], e: Record<string, string> = env) => fireMain(argv, e, deps),
    posts: () => calls.filter((c) => c.method === "POST"),
    gets: () => calls.filter((c) => c.method === "GET"),
    elapsed: () => now - T0,
  };
}

const status = (state: string, extra: Record<string, unknown> = {}) => ({ status: 200, body: { state, step: "classify", updatedAt: "2026-11-18T01:01:00Z", deadlineAt, ...extra } });
const down = new TypeError("fetch failed");

describe("fire", () => {
  it("submits the period from JOB_NAME and waits for it to be delivered", async () => {
    const b = bot({ post: [202], get: [status("running"), status("running"), status("delivered")] });
    expect(await b.run()).toBe(EXIT_DELIVERED);
    expect(b.posts()).toEqual([{ at: T0, method: "POST", url: "http://moose.test:3001/internal/v1/routines/daily/fire", body: { period: PERIOD, dryRun: false }, auth: "Bearer test-job-key" }]);
    expect(b.gets().map((c) => c.url)).toEqual(Array(3).fill(`http://moose.test:3001/internal/v1/routines/daily/periods/${encodeURIComponent(PERIOD)}?dryRun=false`));
    // The first check at once, then every 30 s.
    expect(b.gets().map((c) => c.at - T0)).toEqual([0, 30_000, 60_000]);
    // One line per check, with the period, its state and step.
    const lines = b.logs.filter((l) => l.msg === "period status");
    expect(lines).toHaveLength(3);
    expect(lines[0]!.obj).toMatchObject({ routine: "daily", period: PERIOD, state: "running", step: "classify" });
  });

  it("waits the same after a 409: another fire holds the period", async () => {
    const b = bot({ post: [{ status: 409, body: { error: { code: "conflict", message: "held" } } }], get: [404, status("running"), status("delivered")] });
    expect(await b.run()).toBe(EXIT_DELIVERED);
    expect(b.posts()).toHaveLength(1);
  });

  it("exits 0 at once for a period already delivered (200)", async () => {
    const b = bot({ post: [{ status: 200, body: { state: "delivered" } }], get: [status("delivered")] });
    expect(await b.run()).toBe(EXIT_DELIVERED);
    expect(b.elapsed()).toBe(0);
  });

  it("exits 1 when the period fails", async () => {
    const b = bot({ get: [status("running"), status("failed", { reason: "deadline" })] });
    expect(await b.run()).toBe(EXIT_FAILED);
    expect(b.logs.find((l) => l.msg === "period failed")?.obj).toMatchObject({ reason: "deadline" });
  });

  it("submits again when the period is orphaned, and a live Pod takes it over", async () => {
    const b = bot({ post: [202, 202], get: [status("running"), status("orphaned"), status("running"), status("delivered")] });
    expect(await b.run()).toBe(EXIT_DELIVERED);
    expect(b.posts().map((c) => c.at - T0)).toEqual([0, 30_000]);
  });

  it("waits through 404s and submits again after 2 minutes of them", async () => {
    const b = bot({ post: [202, 202], get: [404, 404, 404, 404, 404, status("running"), status("delivered")] });
    expect(await b.run()).toBe(EXIT_DELIVERED);
    // 404 at 0, 30, 60, 90 s, then at 120 s: two minutes without a record.
    expect(b.posts().map((c) => c.at - T0)).toEqual([0, 120_000]);
  });

  it("backs off on 503 and connection errors while submitting, then goes on", async () => {
    const b = bot({ post: [{ status: 503, body: { error: { code: "shutting_down", message: "draining" } } }, down, 500, 202], get: [status("delivered")] });
    expect(await b.run()).toBe(EXIT_DELIVERED);
    expect(b.posts().map((c) => c.at - T0)).toEqual([0, 5_000, 15_000, 35_000]);
  });

  it("exits 1 when the bot is unreachable for 5 minutes", async () => {
    const b = bot({ post: [down] });
    expect(await b.run()).toBe(EXIT_FAILED);
    // 5, 10, 20, 30, 30, ... s apart: the first try 5 minutes after the first failure gives up.
    expect(b.elapsed()).toBe(305_000);
    expect(b.logs.at(-1)).toMatchObject({ level: "error", msg: /unreachable for 5 minutes/ });
  });

  it("exits 1 when status checks fail for 5 minutes, and not before", async () => {
    const b = bot({ get: [status("running"), ...Array(11).fill(503), status("delivered")] });
    expect(await b.run()).toBe(EXIT_FAILED);
    // Down from 30 s; at 330 s it has been 5 minutes.
    expect(b.elapsed()).toBe(330_000);
    const ok = bot({ get: [status("running"), ...Array(10).fill(down), status("delivered")] });
    expect(await ok.run()).toBe(EXIT_DELIVERED);
  });

  it("exits 1 when the period has no outcome 5 minutes past its deadline", async () => {
    const b = bot({ get: [status("stalled")] });
    expect(await b.run()).toBe(EXIT_FAILED);
    expect(b.logs.at(-1)!.msg).toMatch(/past the period's deadline/);
    // The deadline is the bot's (an hour from T0), plus 5 minutes; checked every 30 s.
    expect(b.elapsed()).toBeGreaterThan(65 * 60_000);
    expect(b.elapsed()).toBeLessThanOrEqual(65 * 60_000 + 30_000);
  });

  it("exits 2 on a request the bot refuses (400 and the like)", async () => {
    const b = bot({ post: [{ status: 400, body: { error: { code: "bad_request", message: "period is not a time 0 9 * * * fires at" } } }] });
    expect(await b.run()).toBe(EXIT_USAGE);
    expect(b.logs.at(-1)!.msg).toMatch(/bad_request: period is not a time/);
    expect(await bot({ post: [401] }).run()).toBe(EXIT_USAGE);
  });

  it("passes --dry-run to both the submit and the status check", async () => {
    const b = bot({ get: [status("delivered")] });
    expect(await b.run(["daily", "--dry-run"])).toBe(EXIT_DELIVERED);
    expect(b.posts()[0]!.body).toEqual({ period: PERIOD, dryRun: true });
    expect(b.gets()[0]!.url).toMatch(/\?dryRun=true$/);
  });

  it("sends --force only with the first submit", async () => {
    const b = bot({ post: [202, 202], get: [status("orphaned"), status("delivered")] });
    expect(await b.run(["daily", "--force"])).toBe(EXIT_DELIVERED);
    expect(b.posts().map((c) => c.body)).toEqual([
      { period: PERIOD, dryRun: false, force: true },
      { period: PERIOD, dryRun: false },
    ]);
  });

  it("takes --period by hand, and needs it for a Job made by hand", async () => {
    const b = bot({ get: [status("delivered")] });
    expect(await b.run(["daily", "--period", "2026-11-18T09:00:00+08:00"], { ...env, JOB_NAME: "daily-manual" })).toBe(EXIT_DELIVERED);
    expect(b.posts()[0]!.body).toMatchObject({ period: PERIOD });
    const none = bot({});
    expect(await none.run(["daily"], { ...env, JOB_NAME: "daily-manual" })).toBe(EXIT_USAGE);
    expect(none.calls).toEqual([]);
    expect(none.logs[0]!.msg).toMatch(/give --period/);
  });

  it("exits 2 on bad usage without calling the bot", async () => {
    const usage = async (argv: string[], e: Record<string, string> = env) => {
      const b = bot({});
      const code = await b.run(argv, e);
      expect(b.calls).toEqual([]);
      return code;
    };
    expect(await usage([])).toBe(EXIT_USAGE);
    expect(await usage(["daily", "other"])).toBe(EXIT_USAGE);
    expect(await usage(["Daily"])).toBe(EXIT_USAGE);
    expect(await usage(["daily", "--period", "2026-11-18T01:00:30Z"])).toBe(EXIT_USAGE);
    expect(await usage(["daily", "--nope"])).toBe(EXIT_USAGE);
    const { MOOSE_JOB_KEY: _k, ...noKey } = env;
    expect(await usage(["daily"], noKey)).toBe(EXIT_USAGE);
    const { MOOSE_URL: _u, ...noUrl } = env;
    expect(await usage(["daily"], noUrl)).toBe(EXIT_USAGE);
  });

  it("never logs the job key", async () => {
    const b = bot({ post: [down, 202], get: [status("delivered")] });
    await b.run();
    expect(JSON.stringify(b.logs)).not.toContain("test-job-key");
  });
});
