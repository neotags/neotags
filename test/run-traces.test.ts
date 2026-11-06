import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { beforeEach, describe, expect, it } from "vitest";
import { traceToolCalls } from "../src/agent/index.js";
import { createGateway } from "../src/agent/models.js";
import { loadConfig } from "../src/config/index.js";
import { RunManager } from "../src/runs/manager.js";
import { PiAgentRunner, type PiRunnerOptions } from "../src/runs/pi-runner.js";
import type { RunInput } from "../src/runs/types.js";
import { startTelemetry } from "../src/telemetry/index.js";
import { endChatSpan, inSpan, MAX_CONTENT_CHARS, recorded, startChatSpan, ToolSpans } from "../src/telemetry/spans.js";
import { SkillPackIndex } from "../src/tools/skillpacks.js";
import { callTool, fail, say, scripted, type Reply } from "./fake-stream.js";

// The global tracer provider can be set once per process; vitest runs each test file in its own.
const exporter = new InMemorySpanExporter();
const telemetry = startTelemetry({ exporter })!;
const flushed = async (): Promise<ReadableSpan[]> => {
  await telemetry.flush();
  return exporter.getFinishedSpans();
};

const base = { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y" };
const cfg = loadConfig({ ...base, NEOTAGS_CONFIG: "f" }, () => `llm:
  baseUrl: http://gw.test/v1
  models:
    flash: { id: flash-model, reasoning: true, thinkingLevelMap: { max: max } }
  chains:
    agent: [{ model: flash, effort: high, finalEffort: max }]
    job: [{ model: flash, effort: high }]
    gate: [{ model: flash, effort: none }]
    summary: [{ model: flash, effort: low }]
`);

const index = new SkillPackIndex(
  new Map([["o2-query-assistant", { name: "o2-query-assistant", description: "Write and run O2 SQL", body: "Check the schema first.", refs: new Map() }]]),
);

// Shapes redact() catches; none of them may reach a span.
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"; // AWS documentation example key
const PASSWORD = "hunter2-very-secret";
const BEARER = "Bearer abcdefghijklmnopqrstuvwxyz012345";

const search: AgentTool<any> = {
  name: "o2__SearchSQL",
  label: "search",
  description: "run SQL",
  parameters: Type.Object({ sql: Type.String() }),
  execute: async () => ({ content: [{ type: "text", text: `rows: 3; header ${BEARER}` }], details: undefined }),
};

function setup(replies: Reply[], o: { captureContent?: boolean; runner?: Partial<PiRunnerOptions> } = {}) {
  const stream = scripted(replies);
  const runner = new PiAgentRunner({
    gateway: createGateway(cfg),
    index,
    botName: "moose",
    entries: { o2: ["o2-query-assistant"] },
    tools: [search],
    firstTokenTimeoutMs: 1000,
    maxRetries: 1,
    charsPerToken: 4,
    streamFn: stream,
    sleep: async () => {},
    captureContent: o.captureContent ?? false,
    ...o.runner,
  });
  const manager = new RunManager({
    runner,
    concurrency: 4,
    perUserPerHour: 100,
    maxSteps: 30,
    maxInputTokens: 100_000,
    wallClockSec: { o2: 600, slack: 360, job: 600 },
    finalReserveSec: 90,
    newId: () => "run-1",
    botName: "moose",
    captureContent: o.captureContent ?? false,
  });
  return { manager, stream };
}

const input: RunInput = { source: "o2", sessionId: "sess-1", user: "alice@example.com", question: "why more errors?" };

async function run(replies: Reply[], o: Parameters<typeof setup>[1] & { input?: RunInput } = {}) {
  const { manager } = setup(replies, o);
  const submitted = manager.submit(o.input ?? input);
  if (!submitted.ok) throw new Error(submitted.code);
  const result = await submitted.run.result;
  const spans = await flushed();
  const root = spans.find((s) => s.name.startsWith("invoke_agent"))!;
  const children = spans.filter((s) => s.parentSpanContext?.spanId === root.spanContext().spanId);
  return { result, spans, root, children, chats: children.filter((s) => s.name.startsWith("chat")), tools: children.filter((s) => s.name.startsWith("execute_tool")) };
}

const contentKeys = (s: ReadableSpan) =>
  Object.keys(s.attributes).filter((k) => /^gen_ai\.(prompt|completion)\.|^gen_ai\.tool\.call\.(arguments|result)$/.test(k));

describe("agent run traces", () => {
  beforeEach(async () => {
    await telemetry.flush();
    exporter.reset();
  });

  it("makes one invoke_agent per run with a chat span per request and an execute_tool span per call", async () => {
    const { result, spans, root, chats, tools } = await run([callTool("o2__SearchSQL", { sql: "SELECT 1" }, "call-1"), say("draft"), say("final answer")]);
    expect(result).toMatchObject({ state: "done", answer: "final answer" });

    expect(root.name).toBe("invoke_agent o2");
    expect(root.parentSpanContext).toBeUndefined();
    expect(root.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "o2",
      "neotags.bot.name": "moose",
      "gen_ai.conversation.id": "sess-1",
      "session.id": "sess-1",
      "neotags.run.id": "run-1",
      "user.id": "alice@example.com",
      "neotags.run.state": "done",
      "neotags.run.degraded": false,
      "neotags.run.steps": 1,
      "neotags.run.tool_calls": 1,
      "neotags.run.input_tokens": 300,
      "neotags.run.output_tokens": 30,
      "neotags.llm.model": "flash-model",
    });
    // Tokens are summed over a trace's spans; the run must not count them a second time.
    expect(Object.keys(root.attributes).some((k) => k.startsWith("gen_ai.usage."))).toBe(false);
    expect(root.status.code).not.toBe(SpanStatusCode.ERROR);

    // Investigation turns at the chain's effort, then the tool-less answer at finalEffort.
    expect(chats.map((s) => [s.attributes["neotags.llm.phase"], s.attributes["neotags.llm.effort"]])).toEqual([
      ["investigate", "high"],
      ["investigate", "high"],
      ["final", "max"],
    ]);
    expect(chats[0]!.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "flash-model",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 10,
      "neotags.llm.chain": "agent",
      "neotags.llm.attempt": 0,
      "gen_ai.response.finish_reasons": ["tool_calls"],
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("execute_tool o2__SearchSQL");
    expect(tools[0]!.attributes).toMatchObject({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "o2__SearchSQL", "gen_ai.tool.call.id": "call-1" });
    expect(tools[0]!.status.code).not.toBe(SpanStatusCode.ERROR);

    // Every span is in the run's trace and carries an operation name (O2's LLM views filter on it).
    expect(spans.every((s) => s.spanContext().traceId === root.spanContext().traceId)).toBe(true);
    expect(spans.every((s) => typeof s.attributes["gen_ai.operation.name"] === "string")).toBe(true);
    // OpenObserve's session list sums tokens over the spans carrying the conversation, so all of them do.
    expect(spans.every((s) => s.attributes["gen_ai.conversation.id"] === "sess-1")).toBe(true);
    expect(spans.flatMap(contentKeys)).toEqual([]);
  });

  it("gives a retried request its own failed chat span", async () => {
    const { chats } = await run([fail("503 Service Unavailable"), say("ok")]);
    expect(chats.map((s) => [s.attributes["neotags.llm.attempt"], s.status.code])).toEqual([
      [0, SpanStatusCode.ERROR],
      [1, SpanStatusCode.UNSET],
    ]);
    expect(chats[0]!.status.message).toBe("503 Service Unavailable");
  });

  it("marks a call the tool guard denied as tool_denied, and an unknown tool (pi rejects it first) as tool_error", async () => {
    const { tools } = await run(
      [callTool("o2__SearchSQL", { sql: "DROP TABLE x" }, "c1"), callTool("k8s__exec", { cmd: "ls" }, "c2"), say("could not")],
      { runner: { guard: async ({ args }) => (JSON.stringify(args).includes("DROP") ? { ok: false, reason: "write SQL" } : { ok: true }) } },
    );
    const byId = Object.fromEntries(tools.map((s) => [s.attributes["gen_ai.tool.call.id"], s]));
    expect(byId.c1!.status).toMatchObject({ code: SpanStatusCode.ERROR, message: "write SQL" });
    expect(byId.c1!.attributes["error.type"]).toBe("tool_denied");
    // Without captureContent the tool's error text (tool output) stays off the span.
    expect(byId.c2!.status).toMatchObject({ code: SpanStatusCode.ERROR, message: "tool failed" });
    expect(byId.c2!.attributes["error.type"]).toBe("tool_error");
  });

  it("records redacted prompts, replies and tool input/output when captureContent is on", async () => {
    const question = `why more errors? key ${AWS_KEY}`;
    const { spans, root, chats, tools } = await run(
      [callTool("o2__SearchSQL", { sql: `SELECT * WHERE password='${PASSWORD}'` }, "c1"), say(`found it, password=${PASSWORD}`), say("final")],
      { captureContent: true, input: { ...input, question, context: { sql: `password=${PASSWORD}` } } },
    );
    const all = spans.flatMap((s) => Object.values(s.attributes).map(String)).join("\n");
    for (const secret of [AWS_KEY, PASSWORD, BEARER]) expect(all).not.toContain(secret);

    expect(root.attributes["gen_ai.prompt.0.content"]).toBe("why more errors? key [REDACTED]");
    expect(root.attributes["gen_ai.completion.0.content"]).toBe("final");
    // The first request's transcript: the system prompt, then the user message with the page context.
    expect(chats[0]!.attributes["gen_ai.prompt.0.role"]).toBe("system");
    expect(chats[0]!.attributes["gen_ai.prompt.1.content"]).toContain("[REDACTED]");
    expect(chats[1]!.attributes["gen_ai.completion.0.content"]).toBe("found it, password=[REDACTED]");
    expect(tools[0]!.attributes["gen_ai.tool.call.arguments"]).toContain("[REDACTED]");
    expect(tools[0]!.attributes["gen_ai.tool.call.result"]).toBe("rows: 3; header Bearer [REDACTED]");
  });

  it("records a degraded run as failed with the reason as error.type", async () => {
    const { result, root, chats } = await run([fail("401 invalid api key")]);
    expect(result).toMatchObject({ state: "failed", degraded: true });
    expect(root.attributes).toMatchObject({ "neotags.run.state": "failed", "neotags.run.degraded": true, "error.type": "model_error" });
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(chats).toHaveLength(1);
  });

  it("tags a cancelled run without marking it an error", async () => {
    const { manager } = setup(["hang"]);
    const submitted = manager.submit(input);
    if (!submitted.ok) throw new Error(submitted.code);
    await new Promise((r) => setTimeout(r, 10));
    submitted.run.cancel("user cancelled");
    await submitted.run.result;
    const spans = await flushed();
    const root = spans.find((s) => s.name === "invoke_agent o2")!;
    expect(root.attributes).toMatchObject({ "neotags.run.state": "cancelled", "error.type": "cancelled", "neotags.run.reason": "user cancelled" });
    expect(root.status.code).not.toBe(SpanStatusCode.ERROR);
    // The aborted request is closed too, not left open.
    expect(spans.filter((s) => s.name.startsWith("chat"))).toHaveLength(1);
  });
});

describe("trace hygiene", () => {
  beforeEach(async () => {
    await telemetry.flush();
    exporter.reset();
  });

  it("starts every run as a root, even when submitted or scheduled inside another span", async () => {
    const { manager } = setup([say("a"), say("b")], { runner: {} });
    const [a, b] = await inSpan("http request", {}, async () => [manager.submit({ ...input, sessionId: "s-a" }), manager.submit({ ...input, sessionId: "s-a" })]);
    if (!a!.ok || !b!.ok) throw new Error("not submitted");
    await Promise.all([a!.run.result, b!.run.result]);
    const roots = (await flushed()).filter((s) => s.name === "invoke_agent o2");
    expect(roots).toHaveLength(2);
    expect(roots.every((s) => s.parentSpanContext === undefined)).toBe(true);
  });

  it("redacts error text on span status and exception events", async () => {
    const span = startChatSpan({ model: "m1", messages: [], captureContent: false });
    endChatSpan(span, { error: "connect failed: https://svc:hunter2-very-secret@gw.example.com/v1" });
    await inSpan("skill x", {}, async () => {
      throw new Error(`boom ${BEARER}`);
    }).catch(() => {});
    const out = await flushed();
    const text = JSON.stringify(out.map((s) => [s.status, s.events]));
    expect(text).not.toContain("hunter2-very-secret");
    expect(text).not.toContain(BEARER);
    expect(text).toContain("[REDACTED]");
  });

  it("does not let an unreadable transcript escape the tracing guard", async () => {
    const span = startChatSpan({ model: "m1", messages: () => { throw new Error("bad message"); }, captureContent: true });
    expect(() => endChatSpan(span, { error: "x" })).not.toThrow();
  });

  it("redacts a tool error before cutting it, so a secret across the cut is still caught", async () => {
    const spans = new ToolSpans({ captureContent: true });
    spans.start({ id: "t", name: "x", args: {} });
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${"A".repeat(600)}\n-----END RSA PRIVATE KEY-----`;
    spans.end({ id: "t", isError: true, output: `${"e".repeat(400)} ${pem}` });
    const [span] = await flushed();
    expect(span!.status.message).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(span!.status.message).toContain("[REDACTED]");
  });
});

describe("tool spans of createAgent agents", () => {
  beforeEach(async () => {
    await telemetry.flush();
    exporter.reset();
  });

  it("traces each tool call from the agent's events and closes calls cut off by the end of the run", async () => {
    const listeners: ((ev: any) => void)[] = [];
    const agent = { subscribe: (f: (ev: any) => void) => (listeners.push(f), () => {}) };
    const spans = new ToolSpans({ captureContent: false });
    traceToolCalls(agent as never, spans);
    const emit = (ev: object) => listeners.forEach((f) => f(ev));
    emit({ type: "tool_execution_start", toolCallId: "a", toolName: "kb__search", args: { q: "x" } });
    emit({ type: "tool_execution_end", toolCallId: "a", toolName: "kb__search", isError: true, result: { content: [{ type: "text", text: "boom" }] } });
    emit({ type: "tool_execution_start", toolCallId: "b", toolName: "kb__search", args: {} });
    emit({ type: "agent_end", messages: [] });
    const out = await flushed();
    expect(out.map((s) => [s.attributes["gen_ai.tool.call.id"], s.attributes["error.type"]])).toEqual([
      ["a", "tool_error"],
      ["b", "aborted"],
    ]);
    expect(out.flatMap(contentKeys)).toEqual([]);
  });
});

describe("recorded content", () => {
  it("is redacted and capped", () => {
    expect(recorded(`token: ${PASSWORD}`)).toBe("token: [REDACTED]");
    const long = recorded("x ".repeat(MAX_CONTENT_CHARS));
    expect(long.length).toBeLessThan(MAX_CONTENT_CHARS + 50);
    expect(long).toMatch(/\[truncated \d+ chars\]$/);
  });
});
