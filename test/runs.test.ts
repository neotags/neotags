import { describe, expect, it, vi } from "vitest";
import { compactToBudget, STUB } from "../src/runs/budget.js";
import { contextPackage } from "../src/runs/degrade.js";
import { RateLimiter, limitKey } from "../src/runs/limits.js";
import { RunManager, type RunManagerOptions } from "../src/runs/manager.js";
import { RunError, type AgentRunner, type RunContext, type RunInput, type RunOutcome } from "../src/runs/types.js";

const ok = (answer = "ok"): RunOutcome => ({ state: "done", answer, steps: 1, toolCalls: 2, usage: { inputTokens: 10, outputTokens: 5 } });

/** A runner whose runs finish when the test says so. */
function controlled() {
  const pending: { input: RunInput; ctx: RunContext; finish: (o: RunOutcome) => void; fail: (e: unknown) => void }[] = [];
  const runner: AgentRunner = {
    run: (input, ctx) =>
      new Promise<RunOutcome>((resolve, reject) => {
        pending.push({ input, ctx, finish: resolve, fail: reject });
        // Like the real runner: an abort ends the run.
        if (ctx.signal.aborted) reject(new Error("aborted"));
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  };
  return { runner, pending };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
let seq = 0;
const manager = (runner: AgentRunner, o: Partial<RunManagerOptions> = {}) =>
  new RunManager({
    runner,
    concurrency: 4,
    perUserPerHour: 100,
    maxSteps: 30,
    maxInputTokens: 100_000,
    wallClockSec: { o2: 600, slack: 360, job: 600 },
    finalReserveSec: 90,
    newId: () => `run-${++seq}`,
    ...o,
  });
const q = (sessionId: string, extra: Partial<RunInput> = {}): RunInput => ({ source: "o2", sessionId, question: "why?", ...extra });

function submitted(m: RunManager, input: RunInput, observer = {}) {
  const r = m.submit(input, observer);
  if (!r.ok) throw new Error(`rejected: ${r.code}`);
  return r.run;
}

describe("RunManager", () => {
  it("moves a run through queued → running → done and reports it", async () => {
    const { runner, pending } = controlled();
    const m = manager(runner);
    const seen: string[] = [];
    const run = submitted(m, q("s1"), { started: () => seen.push("started"), done: (r: { state: string }) => seen.push(`done:${r.state}`) });
    expect(run.state).toBe("running");
    await tick();
    expect(pending[0]!.ctx.budget).toMatchObject({ maxSteps: 30, maxInputTokens: 100_000 });
    pending[0]!.finish(ok("the answer"));
    const res = await run.result;
    expect(res).toMatchObject({ state: "done", answer: "the answer", steps: 1, toolCalls: 2, sessionId: "s1" });
    expect(run.state).toBe("done");
    expect(seen).toEqual(["started", "done:done"]);
  });

  it("queues beyond the global limit in FIFO order and tells each run how many are ahead", async () => {
    const { runner, pending } = controlled();
    const m = manager(runner, { concurrency: 1 });
    const aheads: number[][] = [[], []];
    const a = submitted(m, q("s1"));
    const b = submitted(m, q("s2"), { queued: (i: { ahead: number }) => aheads[0]!.push(i.ahead) });
    const c = submitted(m, q("s3"), { queued: (i: { ahead: number }) => aheads[1]!.push(i.ahead) });
    expect([a.state, b.state, c.state]).toEqual(["running", "queued", "queued"]);
    expect(m.stats()).toEqual({ running: 1, queued: 2 });
    await tick();
    pending[0]!.finish(ok());
    await a.result;
    expect([b.state, c.state]).toEqual(["running", "queued"]);
    expect(aheads).toEqual([[0], [1, 0]]);
  });

  it("runs one run per session at a time, letting other sessions pass", async () => {
    const { runner, pending } = controlled();
    const m = manager(runner, { concurrency: 2 });
    const a1 = submitted(m, q("s1"));
    const a2 = submitted(m, q("s1"));
    const b = submitted(m, q("s2"));
    expect([a1.state, a2.state, b.state]).toEqual(["running", "queued", "running"]);
    expect(m.active("s1")).toBe(true);
    await tick();
    pending[0]!.finish(ok());
    await a1.result;
    expect(a2.state).toBe("running");
  });

  it("cancels a queued run without starting it and a running one through its signal", async () => {
    const { runner, pending } = controlled();
    const m = manager(runner, { concurrency: 1 });
    const a = submitted(m, q("s1"));
    const b = submitted(m, q("s2"));
    expect(b.cancel("user stopped")).toBe(true);
    expect(await b.result).toMatchObject({ state: "cancelled", reason: "user stopped" });
    await tick();
    expect(a.cancel("client disconnected")).toBe(true);
    expect(pending[0]!.ctx.signal.aborted).toBe(true);
    expect(await a.result).toMatchObject({ state: "cancelled", reason: "client disconnected" });
    expect(a.cancel()).toBe(false);
    expect(pending).toHaveLength(1); // b never ran
  });

  it("cancels every run of a session", async () => {
    const { runner } = controlled();
    const m = manager(runner);
    const a = submitted(m, q("s1"));
    const b = submitted(m, q("s1"));
    const other = submitted(m, q("s2"));
    expect(m.cancelSession("s1")).toBe(true);
    expect((await a.result).state).toBe("cancelled");
    expect((await b.result).state).toBe("cancelled");
    expect(other.state).toBe("running");
    expect(m.cancelSession("nope")).toBe(false);
  });

  it("passes budget_exhausted through with its answer", async () => {
    const m = manager({ run: async () => ({ ...ok("partial"), state: "budget_exhausted", reason: "budget: steps" }) });
    expect(await submitted(m, q("s1")).result).toMatchObject({ state: "budget_exhausted", answer: "partial", reason: "budget: steps" });
  });

  it("aborts at the wall clock and answers with the context package", async () => {
    const { runner } = controlled();
    const m = manager(runner, { wallClockSec: { o2: 0.02, slack: 1, job: 1 }, finalReserveSec: 0 });
    const res = await submitted(m, q("s1", { context: { stream: "k8s_logs" } })).result;
    expect(res).toMatchObject({ state: "failed", degraded: true });
    expect(res.answer).toContain("time limit");
    expect(res.answer).toContain("k8s_logs");
  });

  it("keeps the final reserve out of the soft deadline", async () => {
    const { runner, pending } = controlled();
    const m = manager(runner, { now: () => 1_000_000 });
    submitted(m, q("s1"));
    await tick();
    expect(pending[0]!.ctx.budget.softDeadline).toBe(1_000_000 + 600_000 - 90_000);
  });

  it("degrades to the context package when the model is unavailable, in the asker's language", async () => {
    const m = manager({
      run: async () => {
        throw new RunError("model unavailable: breaker open; last error: 503 from gw.internal", "model_unavailable", { steps: 0 });
      },
    });
    const res = await submitted(m, q("s1", { question: "这个错误为什么多了", context: { sql: "SELECT count(*) FROM k8s_logs", org_id: "default" }, links: [{ title: "Logs", url: "https://o2.example.com/web/logs" }] })).result;
    expect(res).toMatchObject({ state: "failed", degraded: true });
    expect(res.answer).toContain("AI 暂时不可用");
    expect(res.answer).toContain("SELECT count(*) FROM k8s_logs");
    expect(res.answer).toContain("[Logs](https://o2.example.com/web/logs)");
    expect(res.answer).not.toContain("gw.internal"); // the raw error stays in the result's reason / logs
    expect(res.reason).toContain("gw.internal");
  });

  it("degrades on a runner crash too, and logs it", async () => {
    const errors: unknown[] = [];
    const m = manager({ run: async () => { throw new TypeError("boom"); } }, { log: { info: () => {}, warn: () => {}, error: (o: unknown) => errors.push(o) } as never });
    const res = await submitted(m, q("s1")).result;
    expect(res).toMatchObject({ state: "failed", degraded: true, reason: "boom" });
    expect(errors).toHaveLength(1);
  });

  it("drains: queued runs are told to ask again, running ones finish, new ones are refused", async () => {
    const { runner, pending } = controlled();
    const m = manager(runner, { concurrency: 1 });
    const a = submitted(m, q("s1"));
    const b = submitted(m, q("s2"));
    await tick();
    const drained = m.drain(1000);
    expect(await b.result).toMatchObject({ state: "cancelled", reason: "shutting down" });
    expect(m.submit(q("s3"))).toMatchObject({ ok: false, code: "shutting_down" });
    pending[0]!.finish(ok());
    expect(await drained).toBe(true);
    expect((await a.result).state).toBe("done");
  });

  it("aborts runs still going when the drain times out", async () => {
    const { runner } = controlled();
    const m = manager(runner);
    const a = submitted(m, q("s1", { question: "why?" }));
    await tick();
    expect(await m.drain(10)).toBe(false);
    expect(await a.result).toMatchObject({ state: "cancelled", reason: "shutting down" });
    expect((await a.result).answer).toMatch(/interrupted/);
  });

  it("limits runs per user per hour, by session when the user is unknown", async () => {
    let now = 0;
    const m = manager({ run: async () => ok() }, { perUserPerHour: 2, now: () => now });
    expect(m.submit(q("s1", { user: "A@example.com" })).ok).toBe(true);
    expect(m.submit(q("s2", { user: "a@example.com" })).ok).toBe(true);
    const third = m.submit(q("s3", { user: "a@example.com" }));
    expect(third).toMatchObject({ ok: false, code: "rate_limited", retryAfterSec: 3600 });
    expect(m.submit(q("s3", { user: "b@example.com" })).ok).toBe(true);
    expect(m.submit(q("anon")).ok).toBe(true);
    expect(m.submit(q("anon")).ok).toBe(true);
    expect(m.submit(q("anon")).ok).toBe(false);
    now = 3600_000;
    expect(m.submit(q("s4", { user: "a@example.com" })).ok).toBe(true);
  });

  it("cuts a run's wall clock to its credential, and does not start one left with too little after the queue", async () => {
    let now = 1_000_000;
    const { runner, pending } = controlled();
    // Wall clock 600 s, final reserve 90 s.
    const m = manager(runner, { concurrency: 1, now: () => now });
    const first = submitted(m, q("s1"));
    const late = submitted(m, q("s2", { credentialDeadline: { at: now + 200_000, minMs: 120_000 } }));
    const fits = submitted(m, q("s3", { credentialDeadline: { at: now + 400_000, minMs: 120_000 } }));
    await tick();
    expect(late.state).toBe("queued");
    // 100 s in the queue: s2 has 100 s of its credential left, under minMs; s3 has 300 s.
    now += 100_000;
    pending[0]!.finish(ok());
    await first.result;
    expect(await late.result).toMatchObject({ state: "failed", errorType: "sign_in_expiring", steps: 0 });
    expect((await late.result).answer).toMatch(/sign-in for this question was about to expire/);
    await tick();
    expect(pending.map((p) => p.input.sessionId)).toEqual(["s1", "s3"]);
    // Tool calls end by the credential deadline; the final answer may take the reserve after it.
    expect(pending[1]!.ctx.budget.softDeadline).toBe(now + 300_000);
    pending[1]!.finish(ok());
    await fits.result;
  });

  it("aborts a run at its credential deadline plus the final reserve, not at the full wall clock", async () => {
    vi.useFakeTimers();
    try {
      const { runner, pending } = controlled();
      const m = manager(runner, { wallClockSec: { o2: 600, slack: 360, job: 600 }, finalReserveSec: 90 });
      const run = submitted(m, q("s1", { credentialDeadline: { at: Date.now() + 200_000, minMs: 120_000 } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(pending).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(289_000);
      expect(run.state).toBe("running");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await run.result).toMatchObject({ state: "failed", errorType: "deadline" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not count exempt users against the hourly limit, and logs it", async () => {
    const lines: Record<string, unknown>[] = [];
    const log = { info: (o: object) => void lines.push(o as Record<string, unknown>), warn: () => {}, error: () => {} };
    const m = manager({ run: async () => ok() }, { perUserPerHour: 2, exemptUsers: ["eval@example.com"], log });
    const runs = Array.from({ length: 5 }, (_, i) => submitted(m, q(`x${i}`, { user: i % 2 ? " Eval@Example.com" : "eval@example.com" })));
    expect(m.submit(q("a1", { user: "a@example.com" })).ok).toBe(true);
    expect(m.submit(q("a2", { user: "a@example.com" })).ok).toBe(true);
    expect(m.submit(q("a3", { user: "a@example.com" }))).toMatchObject({ ok: false, code: "rate_limited" });
    // A session id never matches an exempt email.
    expect(m.submit(q("eval@example.com")).ok).toBe(true);
    expect(m.submit(q("eval@example.com")).ok).toBe(true);
    expect(m.submit(q("eval@example.com")).ok).toBe(false);
    await Promise.all(runs.map((r) => r.result));
    const finished = lines.filter((l) => /^x\d$/.test(String(l.session)) && l.runId);
    expect(finished).toHaveLength(5);
    expect(finished.every((l) => l.rateLimitExempt === true)).toBe(true);
    expect(lines.filter((l) => l.session === "a1" && l.runId).every((l) => !("rateLimitExempt" in l))).toBe(true);
  });

  it("finishes a run whose runner ignores the abort, freeing its slot and session", async () => {
    let calls = 0;
    const m = manager({ run: () => (calls++ === 0 ? new Promise<RunOutcome>(() => {}) : Promise.resolve(ok())) }, {
      concurrency: 1,
      wallClockSec: { o2: 0.02, slack: 1, job: 1 },
      finalReserveSec: 0,
      abortGraceMs: 10,
    });
    const stuck = submitted(m, q("s1"));
    const next = submitted(m, q("s1"));
    expect(await stuck.result).toMatchObject({ state: "failed", degraded: true });
    expect((await next.result).state).toBe("done");
  });

  it("keeps an answer already streamed instead of replacing it with the context package", async () => {
    const m = manager({
      run: async () => {
        throw new RunError("stream stalled", "model_error", { answer: "half an answer\n\n_(cut off)_" });
      },
    });
    expect(await submitted(m, q("s1")).result).toMatchObject({ state: "failed", answer: "half an answer\n\n_(cut off)_", reason: "stream stalled" });
  });

  it("survives an observer that throws", async () => {
    const m = manager({ run: async (_i, ctx) => (ctx.observer.delta?.("x"), ok()) });
    const bad = { started: () => { throw new Error("socket closed"); }, delta: () => { throw new Error("socket closed"); } };
    expect((await submitted(m, q("s1"), bad).result).state).toBe("done");
  });
});

describe("rate limiter", () => {
  it("frees a slot when the oldest hit leaves the window", () => {
    let now = 0;
    const l = new RateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    expect(l.take("k").ok).toBe(true);
    now = 400;
    expect(l.take("k")).toEqual({ ok: false, retryAfterMs: 600 });
    now = 1000;
    expect(l.take("k").ok).toBe(true);
  });
  it("keys by user, else by session", () => {
    expect(limitKey({ user: " A@Example.com ", sessionId: "s" })).toBe("user:a@example.com");
    expect(limitKey({ sessionId: "s" })).toBe("session:s");
  });
});

describe("input budget", () => {
  const tool = (text: string) => ({ role: "toolResult" as const, toolCallId: "t", toolName: "x", content: [{ type: "text" as const, text }], isError: false, timestamp: 0 });
  const user = { role: "user" as const, content: "q", timestamp: 0 };

  const turn = { role: "assistant", content: [], api: "x", provider: "x", model: "x", usage: {}, stopReason: "toolUse", timestamp: 0 } as never;
  const textAt = (ms: unknown[], i: number) => ((ms[i] as { content: { text: string }[] }).content[0]!.text);

  it("stubs the oldest tool outputs first and keeps every result of the latest turn", () => {
    // turn 1: a, b; turn 2: c; turn 3 (parallel calls): d, e
    const msgs = [user, turn, tool("a".repeat(400)), tool("b".repeat(400)), turn, tool("c".repeat(400)), turn, tool("d".repeat(400)), tool("e".repeat(400))];
    const r = compactToBudget(msgs, { maxTokens: 300, charsPerToken: 4 });
    expect(r.fits).toBe(true);
    expect(r.stubbed).toBe(3);
    expect([2, 3, 5].map((i) => textAt(r.messages, i))).toEqual([STUB, STUB, STUB]);
    expect([7, 8].map((i) => textAt(r.messages, i))).toEqual(["d".repeat(400), "e".repeat(400)]);
    expect(textAt(msgs, 2)).toBe("a".repeat(400)); // transcript untouched
  });

  it("leaves a transcript under budget alone and reports one that cannot fit", () => {
    const msgs = [user, tool("x".repeat(100))];
    expect(compactToBudget(msgs, { maxTokens: 1000, charsPerToken: 4 })).toMatchObject({ messages: msgs, stubbed: 0, fits: true });
    expect(compactToBudget([user, turn, tool("x".repeat(4000))], { maxTokens: 100, charsPerToken: 4 }).fits).toBe(false);
  });
});

describe("context package", () => {
  it("redacts secrets and skips empty fields", () => {
    const text = contextPackage({ source: "o2", sessionId: "s", question: "why?", context: { sql: "password=hunter2hunter2", stream: null, empty: "" } }, "model_error");
    expect(text).toContain("AI is temporarily unavailable");
    expect(text).toContain("password=[REDACTED]");
    expect(text).not.toContain("empty");
    expect(text).not.toContain("stream");
  });
});
