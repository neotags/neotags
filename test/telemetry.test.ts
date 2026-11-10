import { pino } from "pino";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diag } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { tracedStreamFn } from "../src/agent/index.js";
import { endChatSpan, inSpan, MAX_PROMPT_CHARS, recordedPrompt, startChatSpan } from "../src/telemetry/spans.js";
import { PiLlmClient } from "../src/agent/llm.js";
import { createGateway } from "../src/agent/models.js";
import { loadConfig } from "../src/config/index.js";
import { Router } from "../src/router/index.js";
import type { Skill, SkillContext } from "../src/skills/types.js";
import type { Task } from "../src/task.js";
import { messageText, thinkingChars } from "../src/agent/message.js";
import { ReportingExporter, startTelemetry, telemetryResource, tracingEnabled } from "../src/telemetry/index.js";

// The global tracer provider can be set once per process; vitest runs each test file in its own.
const exporter = new InMemorySpanExporter();
const appLog = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const telemetry = startTelemetry({ exporter, log: appLog as never })!;
const flushed = async (): Promise<ReadableSpan[]> => {
  await telemetry.flush();
  return exporter.getFinishedSpans();
};

const log = pino({ level: "silent" });
const base = { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y" };
// Single-model setup: every chain runs on m1, without effort.
const { policy } = createGateway(loadConfig({ ...base, LLM_MODEL: "m1" }));
/** A span's `gen_ai.input.messages` or `gen_ai.output.messages`, parsed. */
const messages = (s: ReadableSpan, key: "input" | "output") => JSON.parse(String(s.attributes[`gen_ai.${key}.messages`])) as Record<string, unknown>[];

const msg = (over: object = {}) =>
  ({
    role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", model: "m1",
    usage: { input: 30, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 37 }, ...over,
  }) as never;

describe("telemetry config", () => {
  it("is on only when an OTLP endpoint is set and the SDK is not disabled", () => {
    expect(tracingEnabled({})).toBe(false);
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://o2.test/api/default" })).toBe(true);
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://lf.test/api/public/otel/v1/traces" })).toBe(true);
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://o2.test", OTEL_SDK_DISABLED: "true" })).toBe(false);
  });
  it("starts from process.env alone: the exporter and resource read it, so a passed env would only gate tracing", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "");
    try {
      // @ts-expect-error env is not an option
      expect(startTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test" } })).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("captures no content by default; the file or the GenAI env var turns it on", () => {
    expect(loadConfig(base).telemetry.captureContent).toBe(false);
    expect(loadConfig({ ...base, NEOTAGS_CONFIG: "f" }, () => "telemetry:\n  captureContent: true\n").telemetry.captureContent).toBe(true);
    expect(loadConfig({ ...base, OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "TRUE" }).telemetry.captureContent).toBe(true);
    expect(
      loadConfig({ ...base, NEOTAGS_CONFIG: "f", OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false" }, () => "telemetry:\n  captureContent: true\n")
        .telemetry.captureContent,
    ).toBe(false);
  });
});

describe("telemetry resource", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("names the service neotags unless OTEL_SERVICE_NAME is set, and adds OTEL_RESOURCE_ATTRIBUTES", () => {
    vi.stubEnv("OTEL_SERVICE_NAME", "");
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "");
    expect(telemetryResource().attributes["service.name"]).toBe("neotags");
    vi.stubEnv("OTEL_SERVICE_NAME", "neotags-staging");
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment=prod,team=sre");
    expect(telemetryResource().attributes).toMatchObject({
      "service.name": "neotags-staging", "deployment.environment": "prod", team: "sre",
    });
  });
});

describe("message helpers", () => {
  it("counts thinking characters and renders text and tool calls", () => {
    const m = { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "a" }, { type: "toolCall", name: "q", arguments: { x: 1 } }] } as never;
    expect(thinkingChars(m)).toBe(3);
    expect(messageText(m)).toBe('a\nq({"x":1})');
    expect(messageText({ content: "plain" })).toBe("plain");
  });
});

describe("traces", () => {
  beforeEach(() => exporter.reset());

  it("puts the routing call and every skill LLM attempt under one task span, with usage and no content by default", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(msg({ content: [{ type: "text", text: '{"skill":"echo"}' }] }))
      .mockResolvedValueOnce(msg({ stopReason: "error", errorMessage: "503 upstream" }))
      .mockResolvedValueOnce(msg());
    const llm = new PiLlmClient({ complete, timeoutMs: 1000, maxRetries: 1, sleep: async () => {}, policy });
    const skill: Skill = {
      name: "echo",
      description: "echo",
      run: async (_task, ctx) => void (await ctx.llm.chat([{ role: "user", content: "secret thread" }], { purpose: "answer" })),
    };
    const task: Task = {
      id: "T1", source: "slack", actor: { id: "U1" }, text: "hello",
      reply: { kind: "slack", channel: "C1", threadTs: "100" }, thread: { ts: "100" },
    };
    const router = new Router({
      botName: "moose", notifier: { reply: async () => {}, react: async () => {} }, skills: [skill], llm, log,
      context: () => ({ llm }) as unknown as SkillContext,
    });
    await router.handle(task);

    const spans = await flushed();
    const byName = (n: string) => spans.filter((s) => s.name === n);
    const [root] = byName("invoke_agent slack");
    const [skillSpan] = byName("skill echo");
    const [intent] = byName("intent");
    const chats = byName("chat m1");
    expect(root!.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "slack", "gen_ai.agent.id": "slack", "neotags.bot.name": "moose",
      "neotags.task.id": "T1", "neotags.skill": "echo", "user.id": "U1", "gen_ai.conversation.id": "C1:100", "session.id": "C1:100",
    });
    expect(chats).toHaveLength(3); // router + a failed attempt + its retry: each billed call is its own span
    expect(chats.every((s) => s.attributes["gen_ai.conversation.id"] === "C1:100")).toBe(true);
    expect(chats.every((s) => s.attributes["gen_ai.agent.name"] === "slack" && s.attributes["gen_ai.agent.id"] === "slack")).toBe(true);
    const traceId = root!.spanContext().traceId;
    expect(spans.every((s) => s.spanContext().traceId === traceId)).toBe(true);
    expect(skillSpan!.parentSpanContext?.spanId).toBe(root!.spanContext().spanId);

    const [routing, failed, answer] = chats;
    expect(intent!.parentSpanContext?.spanId).toBe(root!.spanContext().spanId);
    expect(intent!.attributes).toMatchObject({ "neotags.intent.skill": "echo", "neotags.intent.matched": true, "neotags.intent.files": 0 });
    expect(routing!.parentSpanContext?.spanId).toBe(intent!.spanContext().spanId);
    expect(routing!.attributes).toMatchObject({ "neotags.llm.purpose": "router", "neotags.llm.chain": "gate", "gen_ai.output.type": "json" });
    expect(failed!.status).toMatchObject({ code: 2, message: "503 upstream" });
    expect(answer!.parentSpanContext?.spanId).toBe(skillSpan!.spanContext().spanId);
    expect(answer!.attributes).toMatchObject({
      "gen_ai.request.model": "m1", "gen_ai.response.model": "m1", "neotags.llm.purpose": "answer", "neotags.llm.chain": "summary", "neotags.llm.attempt": 1,
      "gen_ai.usage.input_tokens": 30, "gen_ai.usage.output_tokens": 7, "llm.usage.total_tokens": 37,
      "gen_ai.response.finish_reasons": ["stop"],
    });
    expect(Object.keys(answer!.attributes).some((k) => /^gen_ai\.(prompt|completion|input\.messages|output\.messages)/.test(k))).toBe(false);
  });
});

describe("intent traces", () => {
  beforeEach(() => exporter.reset());

  it("records an invalid routing reply and an unknown skill on the intent span", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(msg({ content: [{ type: "text", text: "not json" }] }))
      .mockResolvedValueOnce(msg({ content: [{ type: "text", text: '{"skill":"deploy"}' }] }));
    const llm = new PiLlmClient({ complete, timeoutMs: 1000, maxRetries: 0, policy });
    const router = new Router({
      botName: "moose", notifier: { reply: async () => {}, react: async () => {} }, skills: [], llm, log,
      context: () => ({ llm }) as unknown as SkillContext,
    });
    await router.handle({ id: "T2", source: "slack", actor: { id: "U1" }, text: "deploy it", reply: { kind: "slack", channel: "C1" } });
    const spans = await flushed();
    const [intent] = spans.filter((s) => s.name === "intent");
    expect(intent!.attributes).toMatchObject({ "neotags.intent.skill": "deploy", "neotags.intent.matched": false, "neotags.intent.invalid_replies": 1 });
    expect(spans.filter((s) => s.name === "chat m1" && s.parentSpanContext?.spanId === intent!.spanContext().spanId)).toHaveLength(2);
    expect(spans.find((s) => s.name === "invoke_agent slack")!.attributes["neotags.skill"]).toBe("none");
  });
});

describe("traces with content", () => {
  it("records prompts and the reply when captureContent is on", async () => {
    const llm = new PiLlmClient({ complete: vi.fn().mockResolvedValue(msg()), timeoutMs: 1000, maxRetries: 0, policy, captureContent: true });
    exporter.reset();
    await llm.chat([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
    const [span] = (await flushed()).filter((s) => s.name === "chat m1");
    expect(messages(span!, "input")).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
    expect(messages(span!, "output")).toEqual([{ role: "assistant", content: "ok", finish_reason: "stop" }]);
    expect(Object.keys(span!.attributes).some((k) => k.startsWith("gen_ai.prompt.") || k.startsWith("gen_ai.completion."))).toBe(false);
  });

  // A 26-step run with 56 tool calls: two attributes per message ran past the SDK's 128 per span, and the reply and
  // token usage, set when the span ends, were dropped.
  it("keeps a long transcript, the reply and the usage within the attribute limit", async () => {
    const long = Array.from({ length: 120 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` }));
    exporter.reset();
    const span = startChatSpan({ model: "m1", system: "sys", messages: long, captureContent: true });
    endChatSpan(span, { msg: msg(), captureContent: true });
    const [s] = (await flushed()).filter((x) => x.name === "chat m1");
    expect(s!.droppedAttributesCount).toBe(0);
    expect(messages(s!, "input")).toHaveLength(121);
    expect(messages(s!, "input").at(-1)).toEqual({ role: "assistant", content: "turn 119" });
    expect(messages(s!, "output")).toEqual([{ role: "assistant", content: "ok", finish_reason: "stop" }]);
    expect(s!.attributes).toMatchObject({ "gen_ai.usage.input_tokens": 30, "gen_ai.usage.output_tokens": 7, "gen_ai.response.finish_reasons": ["stop"] });
  });

  it("bounds a recorded prompt: keeps the system prompt, the question and the newest turns", () => {
    const big = "x".repeat(30_000);
    const ms = [{ role: "system", content: "sys" }, { role: "user", content: "q" }, ...Array.from({ length: 20 }, (_, i) => ({ role: "tool", content: `${i}${big}` }))];
    const out = recordedPrompt(ms);
    expect(out.slice(0, 2)).toEqual(ms.slice(0, 2));
    expect(out[2]).toEqual({ role: "system", content: "[12 earlier messages omitted from the trace]" });
    expect(out.slice(3)).toEqual(ms.slice(14));
    expect(out.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(recordedPrompt(ms.slice(0, 5))).toEqual(ms.slice(0, 5));
  });
});

describe("export failures", () => {
  const fakeLog = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() });
  const span = {} as ReadableSpan;
  const results: ExportResult[] = [];
  const inner = {
    export: (_s: ReadableSpan[], done: (r: ExportResult) => void) => done(results.shift()!),
    shutdown: async () => {},
  };
  const failed: ExportResult = { code: ExportResultCode.FAILED, error: new Error("503 Service Unavailable") };
  const ok: ExportResult = { code: ExportResultCode.SUCCESS };

  it("logs a failed batch once per interval with running counts, then the recovery, and never fails the processor", () => {
    let t = 0;
    const log = fakeLog();
    const e = new ReportingExporter(inner, log as never, () => t, 60_000);
    const seen: ExportResult[] = [];
    results.push(failed, failed, failed, ok);
    e.export([span, span], (r) => seen.push(r));
    t = 5_000;
    e.export([span], (r) => seen.push(r)); // inside the interval: counted, not logged
    t = 61_000;
    e.export([span], (r) => seen.push(r));
    e.export([span], (r) => seen.push(r));
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({ failedBatches: 1, droppedSpans: 2 });
    expect(log.warn.mock.calls[1]![0]).toMatchObject({ failedBatches: 3, droppedSpans: 4 });
    expect(log.info).toHaveBeenCalledWith({ failedBatches: 3, droppedSpans: 4 }, "trace export recovered");
    expect(seen.every((r) => r.code === ExportResultCode.SUCCESS)).toBe(true);
  });

  it("reports failures still unlogged at shutdown", async () => {
    let t = 0;
    const log = fakeLog();
    const e = new ReportingExporter(inner, log as never, () => t, 60_000);
    results.push(failed, failed);
    e.export([span], () => {});
    t = 5_000;
    e.export([span], () => {}); // inside the interval: counted, not logged
    await e.shutdown();
    expect(log.warn).toHaveBeenLastCalledWith({ failedBatches: 2, droppedSpans: 2 }, "trace export failed; spans dropped");
  });

  it("sends SDK warnings (dropped spans, partial success) to the app log, errors under err", () => {
    diag.warn("Dropped 3 spans because maxQueueSize reached");
    expect(appLog.warn).toHaveBeenCalledWith({}, "Dropped 3 spans because maxQueueSize reached");
    const err = new Error("boom");
    diag.warn("export failed", err, "detail");
    expect(appLog.warn).toHaveBeenCalledWith({ err, otel: ["detail"] }, "export failed");
  });
});

describe("agent traces", () => {
  beforeEach(() => exporter.reset());

  it("records each agent turn as a chat span, tool calls included in the reply", async () => {
    const reply = msg({
      content: [{ type: "toolCall", id: "1", name: "search", arguments: { q: "disk" } }],
      stopReason: "toolUse",
    });
    const inner = vi.fn(async () => ({ result: async () => reply }) as never);
    const stream = tracedStreamFn(inner, { captureContent: true, effort: "high" });
    const s = await stream({ id: "m1" } as never, { messages: [{ role: "user", content: "why is disk full?", timestamp: 0 }] } as never);
    await s.result();
    const [span] = (await flushed()).filter((x) => x.name === "chat m1");
    expect(span!.attributes).toMatchObject({
      "neotags.llm.purpose": "agent", "neotags.llm.chain": "agent", "neotags.llm.effort": "high",
      "gen_ai.response.finish_reasons": ["tool_calls"],
      "gen_ai.usage.input_tokens": 30,
    });
    expect(messages(span!, "input")).toEqual([{ role: "user", content: "why is disk full?" }]);
    expect(messages(span!, "output")).toEqual([{ role: "assistant", content: 'search({"q":"disk"})', finish_reason: "tool_calls" }]);
    expect(span!.attributes["neotags.llm.attempt"]).toBeUndefined();
  });
});

describe("tracing never fails the traced work", () => {
  // Flush first: a test that does not flush leaves its spans in the batch queue for the next one.
  beforeEach(async () => {
    await telemetry.flush();
    exporter.reset();
  });

  it("survives malformed requests and replies, reporting the bug once", async () => {
    appLog.warn.mockClear();
    const span = startChatSpan({ model: "m1", messages: null as never, captureContent: true });
    expect(() => endChatSpan(span, { msg: {} as never, text: "", captureContent: true })).not.toThrow();
    const ok = startChatSpan({ model: "m1", messages: [], captureContent: false });
    expect(() => endChatSpan(ok, { msg: { content: null } as never, text: "", captureContent: false })).not.toThrow();
    // The span whose reply could not be read is still ended, so it is exported rather than leaked.
    expect((await flushed()).filter((s) => s.name === "chat m1")).toHaveLength(1);
    const reports = appLog.warn.mock.calls.filter((c) => /neotags tracing failed/.test(String(c[1])));
    expect(reports).toHaveLength(1);
  });

  it("lets a PiLlmClient call succeed when its reply cannot be traced", async () => {
    // A thinking block without text: only the span reads it (to count thinking characters).
    const odd = msg({ content: [{ type: "text", text: "ok" }, { type: "thinking", thinking: null }] });
    const llm = new PiLlmClient({ complete: vi.fn().mockResolvedValue(odd), timeoutMs: 1000, maxRetries: 0, policy });
    await expect(llm.chat([{ role: "user", content: "hi" }])).resolves.toMatchObject({ text: "ok" });
  });

  it("marks the widened repeat of an attempt", async () => {
    const complete = vi.fn().mockResolvedValueOnce(msg({ content: [] })).mockResolvedValueOnce(msg());
    const llm = new PiLlmClient({ complete, timeoutMs: 1000, maxRetries: 0, maxTokensCap: 4096, policy });
    await llm.chat([{ role: "user", content: "hi" }], { maxTokens: 100 });
    const spans = (await flushed()).filter((s) => s.name === "chat m1");
    expect(spans.map((s) => [s.attributes["neotags.llm.attempt"], s.attributes["neotags.llm.widened"]])).toEqual([[0, undefined], [0, true]]);
  });

  it("retries an error reply without content, closing its span", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(msg({ stopReason: "error", errorMessage: "503 upstream", content: undefined }))
      .mockResolvedValueOnce(msg());
    const llm = new PiLlmClient({ complete, timeoutMs: 1000, maxRetries: 1, sleep: async () => {}, policy });
    await expect(llm.chat([{ role: "user", content: "hi" }])).resolves.toMatchObject({ text: "ok" });
    expect((await flushed()).filter((s) => s.name === "chat m1")).toHaveLength(2);
  });

  it("does not leave an unhandled rejection when an agent reply cannot be traced", async () => {
    const inner = vi.fn(async () => ({ result: async () => ({ content: null }) }) as never);
    const s = await tracedStreamFn(inner, { captureContent: true })({ id: "m1" } as never, { messages: [{ role: "user", content: 1 }] } as never);
    await s.result();
    await new Promise((r) => setTimeout(r, 0)); // vitest fails the run on an unhandled rejection
  });

  it("records what inSpan's work threw, and rethrows it as it was", async () => {
    const thrown = { code: 7 };
    await expect(inSpan("skill a", {}, async () => Promise.reject(thrown))).rejects.toBe(thrown);
    const err = new TypeError("bad input");
    await expect(inSpan("skill b", {}, async () => { throw err; })).rejects.toBe(err);
    const [a, b] = (await flushed()).filter((s) => s.name.startsWith("skill "));
    // A thrown non-Error is not an LLM error.
    expect(a!.attributes["error.type"]).toBe("error");
    expect(a!.status).toMatchObject({ code: 2, message: "[object Object]" });
    expect(b!.attributes["error.type"]).toBe("TypeError");
    expect(b!.status).toMatchObject({ code: 2, message: "bad input" });
  });

  it("returns inSpan's result when the span cannot be ended", async () => {
    const result = inSpan("skill c", {}, async (span) => {
      span.end = () => {
        throw new Error("exporter bug");
      };
      return 42;
    });
    await expect(result).resolves.toBe(42);
  });
});
