import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, LlmClient } from "../src/agent/llm.js";
import { chunk, excerpts, fitToBudget, line, prepare, transcriptOf } from "../src/skills/kb-collect/prepare.js";
import { renderMarkdown, summarizeThread } from "../src/skills/kb-collect/summary.js";
import type { SlackMessage } from "../src/tools/slack.js";

const m = (ts: number, userName: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage => ({
  ts: String(1_700_000_000 + ts), userName, text, files: [], bot: false, ...extra,
});

describe("prepare", () => {
  it("drops acknowledgements and empties but keeps confirmations like 'done'", () => {
    const p = prepare([
      m(1, "Ann", "checkout is down"), m(2, "Bob", "👍"), m(3, "Bob", "thanks!"), m(4, "Ann", "ok"),
      m(5, "Bob", ""), m(6, "Bob", "done"), m(7, "Ann", ":+1:"),
    ]);
    expect(p.msgs.map((x) => x.text)).toEqual(["checkout is down", "done"]);
    expect(p.filtered).toBe(5);
    expect(p.msgs.map((x) => x.n)).toEqual([1, 2]); // renumbered after filtering
  });

  it("keeps a short message that carries content, and the opening message even if it is terse", () => {
    const p = prepare([m(1, "Ann", "ok"), m(2, "Bob", "`kubectl get pods`"), m(3, "Bob", "502"), m(4, "Ann", "lol")]);
    expect(p.msgs.map((x) => x.text)).toEqual(["ok", "`kubectl get pods`", "502"]);
  });

  it("collapses repeated bot noise into one message with a count", () => {
    const bot = (t: number, text: string) => m(t, "alertbot", text, { bot: true });
    const p = prepare([
      m(1, "Ann", "seeing alerts"), bot(2, "FIRING cpu 91% on pod-1"), bot(3, "FIRING cpu 93% on pod-1"),
      bot(4, "FIRING cpu 95% on pod-1"), bot(5, "RESOLVED cpu on pod-1"),
    ]);
    expect(p.msgs).toHaveLength(3);
    expect(p.msgs[1]).toMatchObject({ bot: true, repeats: 3 });
    expect(line(p.msgs[1]!)).toContain("(repeated ×3)");
    expect(p.filtered).toBe(2);
  });

  it("redacts secrets per message and counts them", () => {
    const p = prepare([m(1, "Ann", "use password=hunter2hunter2 for the db"), m(2, "Bob", "and password=hunter3hunter3 too")]);
    expect(p.redactions).toBe(2);
    expect(transcriptOf(p.msgs)).not.toMatch(/hunter2hunter2|hunter3hunter3/);
  });

  it("flags technical and salient messages", () => {
    const p = prepare([
      m(1, "Ann", "hello team"), m(2, "Bob", "got FATAL: too many clients already"),
      m(3, "Bob", "see https://example.com/runbook"), m(4, "Ann", "root cause was the cache flush"),
      m(5, "Bob", "x".repeat(200)),
    ]);
    expect(p.msgs.map((x) => x.technical)).toEqual([false, true, true, true, false]);
    expect(p.msgs[4]!.salient).toBe(true); // long, but not technical
  });
});

describe("fitToBudget / chunk / excerpts", () => {
  const long = (n: number) =>
    prepare(Array.from({ length: n }, (_, i) => m(i + 1, i % 2 ? "Ann" : "Bob", i === 20 ? "error: disk full on node-7" : `status update ${i} ${"y".repeat(30)}`)));

  it("is a no-op when the thread fits", () => {
    const p = long(10);
    expect(fitToBudget(p, 100_000)).toBe(p);
  });

  it("drops chatter from the middle first and keeps head, tail and technical lines", () => {
    const p = long(40);
    const size = transcriptOf(p.msgs).length;
    const fit = fitToBudget(p, Math.floor(size * 0.6));
    expect(transcriptOf(fit.msgs).length).toBeLessThanOrEqual(Math.floor(size * 0.6));
    expect(fit.budgetDropped).toBeGreaterThan(0);
    const texts = fit.msgs.map((x) => x.text);
    expect(texts[0]).toContain("status update 0");
    expect(texts.at(-1)).toContain("status update 39");
    expect(texts).toContain("error: disk full on node-7");
  });

  it("bounds the size even when every message is salient", () => {
    const p = prepare(Array.from({ length: 60 }, (_, i) => m(i + 1, "Ann", `${i} ${"z".repeat(300)}`)));
    const fit = fitToBudget(p, 6000);
    expect(transcriptOf(fit.msgs).length).toBeLessThanOrEqual(6000 + 400); // head+tail are always kept
    expect(fit.msgs[0]!.text.startsWith("0 ")).toBe(true);
  });

  it("chunks consecutively under the size limit", () => {
    const p = long(30);
    const parts = chunk(p.msgs, 600);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.flat().map((x) => x.n)).toEqual(p.msgs.map((x) => x.n));
    for (const part of parts) expect(transcriptOf(part).length).toBeLessThanOrEqual(600 + 200);
  });

  it("builds a verbatim excerpts section from technical lines only, within the cap", () => {
    const p = prepare([m(1, "Ann", "hi"), m(2, "Bob", "error: disk full"), m(3, "Ann", "ran `df -h`"), m(4, "Bob", "thanks a lot for the help")]);
    expect(excerpts(p.msgs)).toBe("#2 Bob: error: disk full\n#3 Ann: ran `df -h`");
    expect(excerpts(p.msgs, 30)).toBe("#2 Bob: error: disk full");
  });
});

const good = {
  title: "Disk full on node-7", type: "incident", summary: "node-7 ran out of disk.", problem: "pods evicted",
  root_cause: "log volume grew", resolution: "rotated logs", ruled_out: ["network"], outcome: "resolved",
  follow_ups: [], services: ["node-7"], tags: [], confidence: "high", evidence: [2, "#3", 99],
};
const notes = { symptoms: ["evictions"], tried: ["restart"], findings: ["disk full"], actions: [], outcome: "", key: [2] };

function fakeLlm() {
  const calls: { system: string; user: string }[] = [];
  const llm: LlmClient = {
    chat: vi.fn(async (msgs: ChatMessage[]) => {
      const system = msgs.find((x) => x.role === "system")!.content;
      calls.push({ system, user: msgs.filter((x) => x.role === "user").map((x) => x.content).join("\n") });
      return { text: JSON.stringify(system.includes("ONE PART") ? notes : good), usage: { promptTokens: 1, completionTokens: 1 } };
    }),
  };
  return { llm, calls };
}

describe("summarizeThread", () => {
  it("uses one pass when the thread fits, numbering messages and validating evidence", async () => {
    const f = fakeLlm();
    const p = prepare([m(1, "Ann", "pods evicted"), m(2, "Bob", "error: disk full"), m(3, "Ann", "rotated logs, fixed")]);
    const r = await summarizeThread(f.llm, p, "focus on cause", 100_000);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.user).toContain("#2 [");
    expect(f.calls[0]!.user).toContain("focus on cause");
    expect(r.parts).toBe(1);
    expect(r.summary.evidence).toEqual([2, 3]); // "#3" coerced, hallucinated 99 dropped
    expect(r.summary.ruled_out).toEqual(["network"]);
  });

  it("runs the notes extraction with bounded concurrency and keeps notes in thread order", async () => {
    let inFlight = 0;
    let peak = 0;
    const order: string[] = [];
    const llm: LlmClient = {
      chat: vi.fn(async (msgs: ChatMessage[]) => {
        const system = msgs.find((x) => x.role === "system")!.content;
        const user = msgs.filter((x) => x.role === "user").map((x) => x.content).join("\n");
        if (!system.includes("ONE PART")) return { text: JSON.stringify(good), usage: { promptTokens: 1, completionTokens: 1 } };
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        const first = /#(\d+) \[/.exec(user)![1]!;
        order.push(first);
        return { text: JSON.stringify({ ...notes, outcome: `starts at #${first}` }), usage: { promptTokens: 1, completionTokens: 1 } };
      }),
    };
    const p = prepare(Array.from({ length: 40 }, (_, i) => m(i + 1, "Ann", `step ${i} ${"w".repeat(60)}`)));
    const calls = vi.mocked(llm.chat);
    await summarizeThread(llm, p, "", 800);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    const final = calls.mock.calls.at(-1)![0].filter((x) => x.role === "user").map((x) => x.content).join("\n");
    const starts = [...final.matchAll(/starts at #(\d+)/g)].map((x) => Number(x[1]));
    expect(starts).toEqual([...starts].sort((a, b) => a - b)); // notes passed to the reduce step in thread order
    expect(starts.length).toBeGreaterThan(2);
  });

  it("map-reduces a long thread: notes per part, then one final summary with the edges", async () => {
    const f = fakeLlm();
    const p = prepare(Array.from({ length: 30 }, (_, i) => m(i + 1, "Ann", `step ${i} ${"w".repeat(60)}`)));
    const r = await summarizeThread(f.llm, p, "", 1000);
    const notesCalls = f.calls.filter((c) => c.system.includes("ONE PART"));
    const final = f.calls.at(-1)!;
    expect(r.parts).toBe(notesCalls.length);
    expect(r.parts).toBeGreaterThan(1);
    expect(f.calls).toHaveLength(r.parts + 1);
    expect(final.system).toContain("working notes");
    expect(final.user).toContain("Part 1 of");
    expect(final.user).toContain("<opening>");
    expect(final.user).toContain("step 29"); // closing messages are passed through verbatim
  });
});

describe("renderMarkdown", () => {
  it("includes ruled-out, key message links and provenance notes", () => {
    const md = renderMarkdown({ ...good, evidence: [2] } as never, {
      participants: ["Ann"], permalink: "https://slack.test/p", redactions: 1, filtered: 4, budgetDropped: 0, parts: 3,
      evidence: [{ n: 2, who: "Bob", when: "2026-10-18 09:05", snippet: "error: disk full", url: "https://slack.test/m2" }],
    });
    expect(md).toContain("## Ruled out\n- network");
    expect(md).toContain("## Key messages\n- [#2](https://slack.test/m2) Bob (2026-10-18 09:05): error: disk full");
    expect(md).toContain("Outcome: resolved · Confidence: high");
    expect(md).toContain("4 low-signal message(s) filtered");
    expect(md).toContain("summarized in 3 parts");
  });
});
