import { pino } from "pino";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { diag } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { tracedStreamFn } from "../src/agent/index.js";
import { PiLlmClient } from "../src/agent/llm.js";
import { createGateway } from "../src/agent/models.js";
import { loadConfig } from "../src/config/index.js";
import { Router } from "../src/router/index.js";
import type { Skill, SkillContext } from "../src/skills/types.js";
import type { Task } from "../src/task.js";
import { ReportingExporter, startTelemetry, tracingEnabled } from "../src/telemetry/index.js";

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
    const [root] = byName("invoke_agent moose");
    const [skillSpan] = byName("skill echo");
    const [intent] = byName("intent");
    const chats = byName("chat m1");
    expect(root!.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent", "neotags.task.id": "T1", "neotags.skill": "echo",
      "user.id": "U1", "session.id": "C1:100",
    });
    expect(chats).toHaveLength(3); // router + a failed attempt + its retry: each billed call is its own span
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
    expect(Object.keys(answer!.attributes).some((k) => k.startsWith("gen_ai.prompt") || k.startsWith("gen_ai.completion"))).toBe(false);
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
    expect(spans.find((s) => s.name === "invoke_agent moose")!.attributes["neotags.skill"]).toBe("none");
  });
});

describe("traces with content", () => {
  it("records prompts and the reply when captureContent is on", async () => {
    const llm = new PiLlmClient({ complete: vi.fn().mockResolvedValue(msg()), timeoutMs: 1000, maxRetries: 0, policy, captureContent: true });
    exporter.reset();
    await llm.chat([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
    const [span] = (await flushed()).filter((s) => s.name === "chat m1");
    expect(span!.attributes).toMatchObject({
      "gen_ai.prompt.0.role": "system", "gen_ai.prompt.0.content": "sys",
      "gen_ai.prompt.1.role": "user", "gen_ai.prompt.1.content": "hi",
      "gen_ai.completion.0.content": "ok",
    });
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

  it("sends SDK warnings (dropped spans, partial success) to the app log", () => {
    diag.warn("Dropped 3 spans because maxQueueSize reached");
    expect(appLog.warn).toHaveBeenCalledWith({ otel: [] }, "Dropped 3 spans because maxQueueSize reached");
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
      "gen_ai.prompt.0.role": "user", "gen_ai.prompt.0.content": "why is disk full?",
      "gen_ai.completion.0.content": 'search({"q":"disk"})', "gen_ai.response.finish_reasons": ["tool_calls"],
      "gen_ai.usage.input_tokens": 30,
    });
    expect(span!.attributes["neotags.llm.attempt"]).toBeUndefined();
  });
});
