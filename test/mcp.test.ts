import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createGateway } from "../src/agent/models.js";
import { loadConfig } from "../src/config/index.js";
import { duration, McpGuard, trailingLimit, type McpServerPolicy } from "../src/guardrails/tools.js";
import { McpHub, startMcp, type McpServerConfig } from "../src/mcp/index.js";
import { PiAgentRunner } from "../src/runs/pi-runner.js";
import type { RunContext } from "../src/runs/types.js";
import { SkillPackIndex } from "../src/tools/skillpacks.js";
import { callTool, say, scripted, transcriptText } from "./fake-stream.js";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const NOW_US = NOW * 1000;
const HOUR_US = 3600 * 1e6;
const limits = { defaultRangeSec: 3600, maxRangeSec: 86_400, sqlDefaultLimit: 100, sqlMaxLimit: 1000, promMaxPoints: 1000 };
const o2Policy: McpServerPolicy = {
  name: "o2",
  allowTools: ["SearchSQL", "PrometheusRangeQuery", "tool_search", "tools_call", "manage_rules", "missing_tool"],
  innerAllow: ["SearchSQL", "StreamList"],
  argAllow: { manage_rules: { operation: ["list", "get"] } },
};
const guardFor = (servers: McpServerPolicy[] = [o2Policy], outputChars = 16_000) =>
  new McpGuard({ servers, maxArgChars: 2000, outputChars, limits, now: () => NOW });

/** A fake O2-like MCP server over Streamable HTTP (stateless): records every call and the request headers. */
class FakeMcp {
  calls: { tool: string; args: Record<string, unknown> }[] = [];
  headers: IncomingHttpHeaders[] = [];
  down = false;
  output = "ok";
  private http?: Server;
  port = 0;

  url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  private build(): McpServer {
    const server = new McpServer({ name: "fake-o2", version: "1" });
    const record = (tool: string) => async (args: Record<string, unknown>) => {
      this.calls.push({ tool, args });
      return { content: [{ type: "text" as const, text: this.output }] };
    };
    const loose = { request_body: z.any().optional(), query: z.any().optional() };
    server.registerTool("SearchSQL", { description: "Search with SQL", inputSchema: loose }, record("SearchSQL"));
    server.registerTool(
      "PrometheusRangeQuery",
      { description: "PromQL range query", inputSchema: { query: z.string(), start: z.string(), end: z.string(), step: z.string().optional() } },
      record("PrometheusRangeQuery"),
    );
    server.registerTool("tools_call", { inputSchema: { tool: z.string(), args: z.any().optional() } }, record("tools_call"));
    server.registerTool("tool_search", { inputSchema: { query: z.string() } }, record("tool_search"));
    server.registerTool("manage_rules", { inputSchema: { operation: z.string() } }, record("manage_rules"));
    server.registerTool("DeleteStream", { inputSchema: { name: z.string() } }, record("DeleteStream"));
    server.registerTool("broken", { inputSchema: {} }, async () => ({ isError: true, content: [{ type: "text" as const, text: "stream not found" }] }));
    return server;
  }

  async listen(port = 0): Promise<this> {
    this.http = createServer(async (req, res) => {
      this.headers.push(req.headers);
      if (this.down) {
        res.writeHead(503).end("down");
        return;
      }
      const server = this.build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((r) => this.http!.listen(port, "127.0.0.1", () => r()));
    this.port = (this.http.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    this.http?.closeAllConnections();
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
  }
}

const log = { info: () => {}, warn: () => {} };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function fake(): Promise<FakeMcp> {
  const f = await new FakeMcp().listen();
  cleanup.push(() => f.stop());
  return f;
}

function hubFor(servers: ({ name: string; url: string } & Partial<McpServerConfig>)[], o: { env?: NodeJS.ProcessEnv; outputChars?: number } = {}) {
  const cfgs = servers.map((s) => ({ ...o2Policy, headersFromEnv: {}, ...s }));
  const hub = new McpHub({
    servers: cfgs,
    guard: guardFor(cfgs, o.outputChars),
    connectTimeoutMs: 2000,
    callTimeoutMs: 2000,
    reconnectMinMs: 20,
    reconnectMaxMs: 40,
    env: o.env ?? {},
    log,
  });
  cleanup.push(() => hub.close());
  return hub;
}

/** Run one model-issued tool call through the pi-agent-core runner, as a real run does; returns what the model saw. */
async function runToolCall(hub: McpHub, name: string, args: Record<string, unknown>) {
  const cfg = loadConfig({ SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y", LLM_MODEL: "m" });
  const stream = scripted([callTool(name, args as never), say("done")]);
  const runner = new PiAgentRunner({
    gateway: createGateway(cfg),
    index: new SkillPackIndex(),
    botName: "moose",
    entries: {},
    tools: () => hub.tools(),
    guard: hub.guard.check,
    unavailable: () => hub.unavailable(),
    firstTokenTimeoutMs: 1000,
    maxRetries: 0,
    charsPerToken: 4,
    streamFn: stream,
    now: () => NOW,
  });
  const ctx: RunContext = {
    runId: "r1",
    signal: new AbortController().signal,
    budget: { maxSteps: 5, softDeadline: Number.MAX_SAFE_INTEGER, maxInputTokens: 100_000 },
    observer: {},
  };
  await runner.run({ source: "o2", sessionId: "s1", question: "q" }, ctx);
  // The system prompt is the transcript's first message.
  return { firstRequest: transcriptText(stream.calls[0]!.context), seen: transcriptText(stream.calls[1]!.context) };
}

describe("MCP client", () => {
  it("offers only allowlisted tools, named <server>__<tool>, and sends the configured headers", async () => {
    const f = await fake();
    const hub = hubFor([{ name: "o2", url: f.url(), headersFromEnv: { Authorization: "O2_AUTH" } }], { env: { O2_AUTH: "Basic abc" } });
    await hub.start();
    expect(hub.tools().map((t) => t.name)).toEqual(["o2__SearchSQL", "o2__PrometheusRangeQuery", "o2__tool_search", "o2__tools_call", "o2__manage_rules"]);
    expect(hub.unavailable()).toEqual([]);
    expect(f.headers.every((h) => h.authorization === "Basic abc")).toBe(true);
  });

  it("runs a call through the runner: the result reaches the model, redacted", async () => {
    const f = await fake();
    f.output = "rows: 3, token=supersecretvalue123";
    const hub = hubFor([{ name: "o2", url: f.url() }]);
    await hub.start();
    const { seen } = await runToolCall(hub, "o2__tool_search", { query: "streams" });
    expect(f.calls).toEqual([{ tool: "tool_search", args: { query: "streams" } }]);
    expect(seen).toContain("rows: 3, token=[REDACTED]");
    expect(seen).not.toContain("supersecretvalue123");
  });

  it("truncates long output and tells the model to narrow the query", async () => {
    const f = await fake();
    f.output = "x".repeat(500);
    const hub = hubFor([{ name: "o2", url: f.url() }], { outputChars: 100 });
    await hub.start();
    const { seen } = await runToolCall(hub, "o2__tool_search", { query: "a" });
    expect(seen).toContain(`${"x".repeat(100)}\n\n[Output truncated: 100 of 500 characters shown. Narrow the query`);
  });

  it("refuses a tools_call whose inner tool is not in innerAllow, without calling the server", async () => {
    const f = await fake();
    const hub = hubFor([{ name: "o2", url: f.url() }]);
    await hub.start();
    const { seen } = await runToolCall(hub, "o2__tools_call", { tool: "DeleteStream", args: { name: "k8s_logs" } });
    expect(f.calls).toEqual([]);
    expect(seen).toContain('Not allowed: tools_call may only run SearchSQL, StreamList on o2, not "DeleteStream"');
  });

  it("fills in the time range and LIMIT of SQL without them, also inside tools_call", async () => {
    const f = await fake();
    const hub = hubFor([{ name: "o2", url: f.url() }]);
    await hub.start();
    await runToolCall(hub, "o2__SearchSQL", { query: { sql: "SELECT count(*) FROM k8s_logs" } });
    await runToolCall(hub, "o2__tools_call", { tool: "SearchSQL", args: { request_body: { query: { sql: "SELECT * FROM t LIMIT 20" } } } });
    expect(f.calls[0]).toEqual({
      tool: "SearchSQL",
      args: { request_body: { query: { sql: "SELECT count(*) FROM k8s_logs\nLIMIT 100", start_time: NOW_US - HOUR_US, end_time: NOW_US, size: 100 } } },
    });
    expect(f.calls[1]?.args).toEqual({
      tool: "SearchSQL",
      args: { request_body: { query: { sql: "SELECT * FROM t LIMIT 20", start_time: NOW_US - HOUR_US, end_time: NOW_US, size: 20 } } },
    });
  });

  it("refuses SQL over more than 24 hours", async () => {
    const f = await fake();
    const hub = hubFor([{ name: "o2", url: f.url() }]);
    await hub.start();
    const { seen } = await runToolCall(hub, "o2__SearchSQL", {
      request_body: { query: { sql: "SELECT 1 LIMIT 1", start_time: NOW_US - 48 * HOUR_US, end_time: NOW_US } },
    });
    expect(f.calls).toEqual([]);
    expect(seen).toContain("Not allowed: the time range is 48h; one query covers at most 24h");
  });

  it("a server that is down at startup does not block it; the agent is told, and it is picked up when it comes back", async () => {
    const f = await fake();
    f.down = true;
    const hub = hubFor([
      { name: "o2", url: f.url() },
      { name: "o2prod", url: "http://127.0.0.1:1/mcp" },
    ]);
    await hub.start();
    expect(hub.tools()).toEqual([]);
    expect(hub.unavailable()).toEqual(["o2", "o2prod"]);
    const { firstRequest } = await runToolCall(hub, "read_skill", { name: "x" });
    expect(firstRequest).toContain("Unavailable data sources right now: o2, o2prod.");

    f.down = false;
    await expect.poll(() => hub.unavailable(), { timeout: 2000 }).toEqual(["o2prod"]);
    expect(hub.tools().map((t) => t.name)).toContain("o2__SearchSQL");
  });

  it("a server that goes away mid-run fails the call with an error the model can act on, then reconnects", async () => {
    const f = await fake();
    const hub = hubFor([{ name: "o2", url: f.url() }]);
    await hub.start();
    f.down = true;
    const { seen } = await runToolCall(hub, "o2__tool_search", { query: "a" });
    expect(seen).toContain("Data source o2 is unavailable");
    expect(seen).toContain("Continue without it and say what you could not check.");
    expect(hub.unavailable()).toEqual(["o2"]);
    // The tools stay listed, so the next run sees the same tool set; its call reconnects first.
    expect(hub.tools().map((t) => t.name)).toContain("o2__tool_search");

    f.down = false;
    const again = await runToolCall(hub, "o2__tool_search", { query: "b" });
    expect(again.seen).toContain("ok");
    expect(hub.unavailable()).toEqual([]);
  });

  it("an error result of the tool reaches the model as an error, and the server stays up", async () => {
    const f = await fake();
    const hub = hubFor([{ name: "o2", url: f.url(), allowTools: ["broken"] }]);
    await hub.start();
    const res = await hub.tools()[0]!.execute("id", {});
    expect(res).toMatchObject({ isError: true, content: [{ type: "text", text: "stream not found" }] });
    expect(hub.unavailable()).toEqual([]);
  });

  it("a missing header env var leaves the server unavailable without naming the value", async () => {
    const f = await fake();
    const hub = hubFor([{ name: "o2", url: f.url(), headersFromEnv: { Authorization: "O2_AUTH" } }]);
    await hub.start();
    expect(hub.unavailable()).toEqual(["o2"]);
    expect(f.headers).toEqual([]);
  });

  it("startMcp builds the hub from config", async () => {
    const f = await fake();
    const cfg = loadConfig(
      { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y", NEOTAGS_CONFIG: "f" },
      () => `mcp:\n  servers:\n    - { name: o2, url: "${f.url()}", allowTools: [SearchSQL, DeleteMissing] }\n`,
    );
    const hub = await startMcp(cfg, log, {});
    cleanup.push(() => hub.close());
    expect(hub.tools().map((t) => t.name)).toEqual(["o2__SearchSQL"]);
  });
});

describe("McpGuard", () => {
  const g = guardFor();
  const sql = (q: Record<string, unknown>) => ({ name: "o2__SearchSQL", args: { request_body: { query: q } } });
  const range = { start_time: NOW_US - HOUR_US, end_time: NOW_US };

  it("leaves tools that are not MCP tools to the runner, and refuses unknown servers and unlisted tools", () => {
    expect(g.check({ name: "read_skill", args: {} })).toEqual({ ok: true });
    expect(g.check({ name: "k8s__pods_list", args: {} })).toEqual({ ok: false, reason: "k8s__pods_list is not a configured MCP tool" });
    expect(g.check({ name: "o2__DeleteStream", args: {} })).toEqual({ ok: false, reason: "o2__DeleteStream is not allowlisted" });
  });

  it("refuses every tools_call on a server without innerAllow", () => {
    const strict = guardFor([{ ...o2Policy, innerAllow: undefined }]);
    expect(strict.check({ name: "o2__tools_call", args: { tool: "SearchSQL", args: {} } })).toMatchObject({ ok: false, reason: expect.stringContaining("may only run nothing") });
  });

  it("allows only argAllow values, also for the inner tool of tools_call", () => {
    expect(g.check({ name: "o2__manage_rules", args: { operation: "list" } })).toEqual({ ok: true });
    expect(g.check({ name: "o2__manage_rules", args: { operation: "delete" } })).toEqual({ ok: false, reason: 'manage_rules operation must be one of list, get, not "delete"' });
    expect(g.check({ name: "o2__manage_rules", args: {} })).toMatchObject({ ok: false });
    const inner = guardFor([{ ...o2Policy, innerAllow: ["manage_rules"] }]);
    expect(inner.check({ name: "o2__tools_call", args: { tool: "manage_rules", args: { operation: "create" } } })).toMatchObject({ ok: false });
  });

  it("caps the argument size", () => {
    expect(g.check({ name: "o2__tool_search", args: { query: "x".repeat(3000) } })).toMatchObject({ ok: false, reason: expect.stringContaining("at most 2000") });
  });

  it("checks SQL time ranges in microseconds and the LIMIT", () => {
    expect(g.check(sql({ sql: "SELECT 1 LIMIT 10", ...range }))).toEqual({ ok: true });
    expect(g.check(sql({ sql: "SELECT 1 LIMIT 10" }))).toMatchObject({ ok: false, reason: expect.stringContaining("microseconds") });
    expect(g.check(sql({ sql: "SELECT 1 LIMIT 10", start_time: NOW - 3600_000, end_time: NOW }))).toMatchObject({ ok: false, reason: expect.stringContaining("16 digits") });
    expect(g.check(sql({ sql: "SELECT 1 LIMIT 10", start_time: NOW_US, end_time: NOW_US - 1 }))).toMatchObject({ ok: false, reason: "end_time must be after start_time" });
    expect(g.check(sql({ sql: "SELECT 1", ...range }))).toEqual({ ok: false, reason: "the SQL needs a LIMIT at the end" });
    expect(g.check(sql({ sql: "SELECT 1 LIMIT 5000", ...range }))).toMatchObject({ ok: false, reason: expect.stringContaining("LIMIT 5000 is above 1000") });
    expect(g.check({ name: "o2__SearchSQL", args: {} })).toEqual({ ok: false, reason: "SearchSQL needs request_body.query.sql" });
  });

  it("prepares SQL: fills the missing end of the range, appends LIMIT after a trailing comment, caps size", () => {
    const out = g.prepare("o2__SearchSQL", { request_body: { query: { sql: "SELECT 1 -- note;", start_time: NOW_US - 2 * HOUR_US, size: 5000 } } });
    expect(out).toEqual({ request_body: { query: { sql: "SELECT 1 -- note\nLIMIT 100", start_time: NOW_US - 2 * HOUR_US, end_time: NOW_US, size: 100 } } });
    expect(g.check({ name: "o2__SearchSQL", args: out })).toEqual({ ok: true });
    // A range that is too long is not shortened silently: the check refuses it.
    const long = g.prepare("o2__SearchSQL", { query: { sql: "SELECT 1 LIMIT 5", start_time: NOW_US - 30 * HOUR_US } });
    expect(g.check({ name: "o2__SearchSQL", args: long })).toMatchObject({ ok: false });
  });

  it("prepares and checks PromQL range queries", () => {
    const out = g.prepare("o2__PrometheusRangeQuery", { query: "up" }) as Record<string, unknown>;
    expect(out).toEqual({ query: "up", start: "2026-11-07T11:00:00.000Z", end: "2026-11-07T12:00:00.000Z", step: "60s" });
    expect(g.check({ name: "o2__PrometheusRangeQuery", args: out })).toEqual({ ok: true });
    const call = (a: Record<string, unknown>) => g.check({ name: "o2__PrometheusRangeQuery", args: { query: "up", ...a } });
    expect(call({ start: "2026-11-05T00:00:00Z", end: "2026-11-07T00:00:00Z", step: "5m" })).toMatchObject({ ok: false, reason: expect.stringContaining("48h") });
    expect(call({ start: "2026-11-06T12:00:00Z", end: "2026-11-07T12:00:00Z", step: "15s" })).toEqual({
      ok: false,
      reason: "step 15s gives 5760 points per series; at most 1000: use a step of at least 87s",
    });
    expect(call({ start: String(NOW / 1000 - 600), end: NOW / 1000, step: 30 })).toEqual({ ok: true });
    expect(call({ start: "yesterday", end: "now", step: "1m" })).toMatchObject({ ok: false, reason: expect.stringContaining("RFC 3339") });
    expect(call({ start: "2026-11-07T11:00:00Z", end: "2026-11-07T12:00:00Z", step: "1 minute" })).toMatchObject({ ok: false, reason: expect.stringContaining("duration") });
  });

  it("parses LIMIT forms and durations", () => {
    expect(trailingLimit("SELECT * FROM t LIMIT 10")).toBe(10);
    expect(trailingLimit("select * from t limit 10 offset 20;")).toBe(10);
    expect(trailingLimit("SELECT * FROM t LIMIT 5, 30")).toBe(30);
    expect(trailingLimit("SELECT * FROM (SELECT * FROM t LIMIT 10) s")).toBeUndefined();
    expect(trailingLimit("SELECT 1 LIMIT 10 /* top */ -- end")).toBe(10);
    expect(duration("1m30s")).toBe(90);
    expect(duration("500ms")).toBe(0.5);
    expect(duration("0s")).toBeUndefined();
  });
});

describe("mcp config", () => {
  const load = (yaml: string) => loadConfig({ SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y", NEOTAGS_CONFIG: "f" }, () => yaml);

  it("has no servers by default and the design's limits", () => {
    const cfg = load("");
    expect(cfg.mcp.servers).toEqual([]);
    expect(cfg.agent.toolOutputChars).toBe(16_000);
    expect(cfg.agent.queryLimits).toEqual(limits);
  });

  it("refuses duplicate names, names with underscores and servers without an allowlist", () => {
    expect(() => load("mcp:\n  servers:\n    - { name: o2, url: http://a.example.com/mcp, allowTools: [x] }\n    - { name: o2, url: http://b.example.com/mcp, allowTools: [x] }\n")).toThrow(/duplicate MCP server/);
    expect(() => load("mcp:\n  servers:\n    - { name: o2_prod, url: http://a.example.com/mcp, allowTools: [x] }\n")).toThrow(/lowercase/);
    expect(() => load("mcp:\n  servers:\n    - { name: o2, url: http://a.example.com/mcp, allowTools: [] }\n")).toThrow();
  });
});
