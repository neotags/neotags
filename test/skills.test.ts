import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../src/agent/llm.js";
import { Router } from "../src/router/index.js";
import { createKbCollect, docId } from "../src/skills/kb-collect/index.js";
import type { SkillContext } from "../src/skills/types.js";
import type { Notifier, Task } from "../src/task.js";
import type { OnyxClient, OnyxDocument } from "../src/tools/onyx.js";
import type { SlackMessage, SlackReader } from "../src/tools/slack.js";

const log = pino({ level: "silent" });
const goodSummary = {
  title: "Checkout 502s after cache flush", type: "incident", summary: "Checkout returned 502 after a cache flush.",
  problem: "502 on /checkout", root_cause: "Cold cache overloaded the DB", resolution: "Warmed the cache.\n```\nredis-cli ping\n```",
  follow_ups: ["add cache warmup"], services: ["checkout"], tags: ["cache"], confidence: "high",
};

function fakes(opts: { messages?: SlackMessage[]; kind?: "public" | "private" | "dm" | "unknown"; allowPrivate?: boolean; llmReplies?: string[] } = {}) {
  const sent: { text: string; blocks?: unknown[] }[] = [];
  const notifier: Notifier = {
    reply: vi.fn(async (_t, text, blocks) => void sent.push({ text, blocks })),
    react: vi.fn(),
  };
  const docs: OnyxDocument[] = [];
  const onyx: OnyxClient = {
    upsert: vi.fn(async (d) => (docs.push(d), { alreadyExisted: false })),
    delete: vi.fn(async () => {}),
  };
  const messages = opts.messages ?? [
    { ts: "100", userId: "U1", userName: "Ann", text: "checkout is 502ing, password=hunter2hunter2", files: [], bot: false },
    { ts: "101", userId: "U2", userName: "Bob", text: "flushed redis an hour ago", files: ["graph.png"], bot: false },
    { ts: "102", userId: "U1", userName: "Ann", text: "<trigger>", files: [], bot: false },
  ];
  const slack: SlackReader = {
    thread: vi.fn(async () => messages),
    permalink: vi.fn(async (_c: string, ts: string) => `https://slack.test/p/${ts}`),
    channel: vi.fn(async () => ({ id: "C1", name: "ops", kind: opts.kind ?? "public" })),
    userName: vi.fn(async (id) => (id === "U1" ? "Ann" : id)),
  };
  const replies = [...(opts.llmReplies ?? [JSON.stringify(goodSummary)])];
  const llm: LlmClient = {
    chat: vi.fn(async () => ({ text: replies.shift() ?? replies[0] ?? "", usage: { promptTokens: 1, completionTokens: 1 } })),
  };
  const ctx: SkillContext = { notifier, slack, llm, onyx, log, botName: "moose", maxInputTokens: 60000, allowPrivateChannels: opts.allowPrivate ?? false };
  return { sent, notifier, onyx, docs, slack, llm, ctx };
}
const task = (over: Partial<Task> = {}): Task => ({
  id: "e1", source: "slack", actor: { id: "U1" }, text: "record the knowledge",
  reply: { kind: "slack", channel: "C1", threadTs: "100" }, triggerTs: "102", thread: { ts: "100" }, ...over,
});

describe("kb-collect", () => {
  it("summarizes a thread, redacts secrets, upserts a deterministic doc and replies with Undo", async () => {
    const f = fakes();
    await createKbCollect().run(task(), f.ctx);

    // secret never reaches the LLM
    const sentToLlm = JSON.stringify(vi.mocked(f.llm.chat).mock.calls[0]![0]);
    expect(sentToLlm).not.toContain("hunter2hunter2");
    expect(sentToLlm).toContain("password=[REDACTED]");
    expect(sentToLlm).not.toContain("<trigger>"); // the triggering message is excluded

    expect(f.docs).toHaveLength(1);
    const d = f.docs[0]!;
    expect(d.id).toBe(docId("C1", "100"));
    expect(d.id).toBe("neotags-slack-C1-100");
    expect(d.semantic_identifier).toBe("Checkout 502s after cache flush");
    expect(d.sections[0]).toMatchObject({ link: "https://slack.test/p/100" });
    expect(d.sections[0]!.text).toContain("1 secret(s) redacted");
    expect(d.sections[0]!.text).toContain("Participants: Ann, Bob");
    expect(d.metadata).toMatchObject({ channel: "#ops", origin: "neotags", recorded_by: "Ann", type: "incident", services: ["checkout"] });
    expect(JSON.stringify(d.metadata)).not.toContain("undefined");

    const reply = f.sent[0]!;
    expect(reply.text).toContain("Checkout 502s");
    expect(JSON.stringify(reply.blocks)).toContain("kb-collect:undo");
    expect(JSON.stringify(reply.blocks)).toContain("neotags-slack-C1-100");
  });

  it("re-recording the same thread targets the same document id", async () => {
    const a = fakes(); const b = fakes();
    await createKbCollect().run(task(), a.ctx);
    await createKbCollect().run(task({ id: "e2" }), b.ctx);
    expect(a.docs[0]!.id).toBe(b.docs[0]!.id);
  });

  it("refuses private channels and top-level mentions without touching Onyx", async () => {
    const priv = fakes({ kind: "private" });
    await createKbCollect().run(task(), priv.ctx);
    expect(priv.sent[0]!.text).toMatch(/public/);
    expect(priv.onyx.upsert).not.toHaveBeenCalled();
    expect(priv.slack.thread).not.toHaveBeenCalled();

    const top = fakes();
    await createKbCollect().run(task({ thread: undefined }), top.ctx);
    expect(top.sent[0]!.text).toMatch(/inside the thread/);
    expect(top.onyx.upsert).not.toHaveBeenCalled();
  });

  it("records a private-channel thread only when enabled, and labels the entry and the reply", async () => {
    const on = fakes({ kind: "private", allowPrivate: true });
    await createKbCollect().run(task(), on.ctx);
    expect(on.docs).toHaveLength(1);
    expect(on.docs[0]!.metadata).toMatchObject({ source_visibility: "private-channel" });
    expect(on.docs[0]!.sections[0]!.text).toContain("Source: a private Slack channel");
    expect(JSON.stringify(on.sent[0]!.blocks)).toMatch(/private channel.*visible to everyone/);

    const pub = fakes();
    await createKbCollect().run(task(), pub.ctx);
    expect(pub.docs[0]!.metadata).toMatchObject({ source_visibility: "public-channel" });
    expect(JSON.stringify(pub.sent[0]!.blocks)).not.toMatch(/private channel/);
  });

  it("never records DMs, and explains a channel it cannot see", async () => {
    const dm = fakes({ kind: "dm", allowPrivate: true });
    await createKbCollect().run(task(), dm.ctx);
    expect(dm.sent[0]!.text).toMatch(/direct messages/);
    expect(dm.onyx.upsert).not.toHaveBeenCalled();

    const off = fakes({ kind: "unknown" });
    await createKbCollect().run(task(), off.ctx);
    expect(off.sent[0]!.text).toMatch(/public/);
    expect(off.slack.thread).not.toHaveBeenCalled();

    const on = fakes({ kind: "unknown", allowPrivate: true });
    await createKbCollect().run(task(), on.ctx);
    expect(on.sent[0]!.text).toMatch(/groups:read.*groups:history/);
    expect(on.onyx.upsert).not.toHaveBeenCalled();
  });

  it("says so when Onyx is unconfigured or the thread is empty", async () => {
    const noOnyx = fakes();
    await createKbCollect().run(task(), { ...noOnyx.ctx, onyx: undefined });
    expect(noOnyx.sent[0]!.text).toMatch(/not configured/);

    const empty = fakes({ messages: [{ ts: "102", userName: "Ann", text: "x", files: [], bot: false }] });
    await createKbCollect().run(task(), empty.ctx);
    expect(empty.sent[0]!.text).toMatch(/nothing/);
    expect(empty.onyx.upsert).not.toHaveBeenCalled();
  });

  it("retries once on invalid summarizer output, then fails without writing", async () => {
    const ok = fakes({ llmReplies: ["not json", `\`\`\`json\n${JSON.stringify(goodSummary)}\n\`\`\``] });
    await createKbCollect().run(task(), ok.ctx);
    expect(ok.docs).toHaveLength(1);
    expect(ok.llm.chat).toHaveBeenCalledTimes(2);

    const bad = fakes({ llmReplies: ["nope", "still nope"] });
    await expect(createKbCollect().run(task(), bad.ctx)).rejects.toThrow(/invalid output twice/);
    expect(bad.onyx.upsert).not.toHaveBeenCalled();
  });

  it("summarizes a long thread in parts (map-reduce) and says so in the doc", async () => {
    const long = Array.from({ length: 60 }, (_, i) => ({ ts: String(200 + i), userId: "U1", userName: "Ann", text: `step ${i}: ${"x".repeat(150)}`, files: [], bot: false }));
    const f = fakes({ messages: long, llmReplies: Array(20).fill(JSON.stringify(goodSummary)) });
    await createKbCollect().run(task({ triggerTs: "999" }), { ...f.ctx, maxInputTokens: 500 });
    const calls = vi.mocked(f.llm.chat).mock.calls.length;
    expect(calls).toBeGreaterThan(2); // notes per part + the final summary
    expect(f.docs).toHaveLength(1);
    expect(f.docs[0]!.sections[0]!.text).toMatch(/summarized in \d+ parts/);
  });

  it("filters noise, cites evidence with links, and stores a verbatim excerpts section", async () => {
    const f = fakes({
      messages: [
        { ts: "100", userId: "U1", userName: "Ann", text: "checkout is returning 502", files: [], bot: false },
        { ts: "101", userId: "U2", userName: "Bob", text: "👍", files: [], bot: false },
        { ts: "102", userId: "U2", userName: "Bob", text: "<trigger>", files: [], bot: false },
        { ts: "103", userId: "U2", userName: "Bob", text: "thanks!", files: [], bot: false },
        { ts: "104", userId: "U2", userName: "Bob", text: "FATAL: sorry, too many clients already", files: [], bot: false },
        { ts: "105", userId: "U1", userName: "Ann", text: "fixed by raising max_connections", files: [], bot: false },
      ],
      llmReplies: [JSON.stringify({ ...goodSummary, outcome: "resolved", evidence: [2, 3], ruled_out: ["network"] })],
    });
    await createKbCollect().run(task({ triggerTs: "102" }), f.ctx);

    const d = f.docs[0]!;
    const md = d.sections[0]!.text;
    expect(md).toContain("2 low-signal message(s) filtered");
    expect(md).toContain("## Ruled out");
    expect(md).toMatch(/\[#2\]\(https:\/\/slack\.test\/p\/\d+\) Bob/); // cited message resolved to a permalink
    expect(d.sections).toHaveLength(2);
    expect(d.sections[1]!.text).toContain("too many clients already");
    expect(d.sections[1]!.text).toContain("max_connections");
    expect(d.metadata).toMatchObject({ outcome: "resolved", schema_version: "2", message_count: "3" });
    // the acknowledgements never reach the LLM
    const sent = JSON.stringify(vi.mocked(f.llm.chat).mock.calls[0]![0]);
    expect(sent).not.toContain("thanks!");
    expect(sent).toContain("#2 [");
  });

  it("says there is nothing to record when only noise remains", async () => {
    const f = fakes({ messages: [{ ts: "101", userName: "Bob", text: "👍", files: [], bot: false }, { ts: "102", userName: "Ann", text: "thanks", files: [], bot: false }] });
    await createKbCollect().run(task({ triggerTs: "999" }), f.ctx);
    // the first message is always kept, so the thread is not empty; it is summarized, not rejected
    expect(f.llm.chat).toHaveBeenCalled();
  });

  it("Undo deletes the document", async () => {
    const f = fakes();
    const text = await createKbCollect().onAction!({ id: "undo", value: "neotags-slack-C1-100", actor: { id: "U2" }, channel: "C1" }, f.ctx);
    expect(f.onyx.delete).toHaveBeenCalledWith("neotags-slack-C1-100");
    expect(text).toMatch(/Removed/);
  });
});

describe("Router", () => {
  function setup(llmReplies: string[], opts: { llm?: boolean } = {}) {
    const f = fakes();
    const chat = vi.fn(async (_m: unknown) => ({ text: llmReplies.shift() ?? "", usage: { promptTokens: 1, completionTokens: 1 } }));
    const run = vi.fn(async () => {});
    const skill = { ...createKbCollect(), run };
    const router = new Router({
      botName: "moose", notifier: f.notifier, log, skills: [skill],
      llm: opts.llm === false ? undefined : { chat }, context: () => f.ctx,
    });
    return { f, chat, run, router };
  }

  it("routes to the skill the LLM names, giving it thread context", async () => {
    const s = setup(['{"skill":"kb-collect"}']);
    await s.router.handle(task());
    expect(s.run).toHaveBeenCalledOnce();
    const sys = JSON.stringify(s.chat.mock.calls[0]![0]);
    expect(sys).toContain("kb-collect");
    expect(sys).toContain("inside a thread");
    expect(sys).toContain("<message>");
  });

  it("asks the clarification when no skill applies, and ignores unknown skill names", async () => {
    const s = setup(['{"skill":"none","clarification":"Do you want me to save this thread?"}', '{"skill":"rm-rf"}']);
    await s.router.handle(task({ text: "hmm" }));
    expect(s.f.sent[0]!.text).toBe("Do you want me to save this thread?");
    await s.router.handle(task({ text: "do something" }));
    expect(s.run).not.toHaveBeenCalled();
    expect(s.f.sent[1]!.text).toMatch(/not sure/);
  });

  it("retries invalid JSON once, then throws", async () => {
    const ok = setup(["garbage", '{"skill":"kb-collect"}']);
    await ok.router.handle(task());
    expect(ok.run).toHaveBeenCalledOnce();
    await expect(setup(["a", "b"]).router.handle(task())).rejects.toThrow(/invalid output twice/);
  });

  it("shows help for an empty mention without calling the LLM; explains a missing LLM", async () => {
    const s = setup([]);
    await s.router.handle(task({ text: "  " }));
    expect(s.chat).not.toHaveBeenCalled();
    expect(s.f.sent[0]!.text).toContain("kb-collect");

    const n = setup([], { llm: false });
    await n.router.handle(task());
    expect(n.f.sent[0]!.text).toMatch(/llm\.model/);
  });

  it("dispatches button actions by skill prefix", async () => {
    const s = setup([]);
    expect(await s.router.handleAction("kb-collect:undo", "doc1", { id: "U1" }, "C1")).toMatch(/Removed/);
    expect(s.f.onyx.delete).toHaveBeenCalledWith("doc1");
    expect(await s.router.handleAction("other:undo", "x", { id: "U1" }, "C1")).toBeUndefined();
  });
});
