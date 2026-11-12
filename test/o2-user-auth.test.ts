import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createGateway } from "../src/agent/models.js";
import { loadConfig } from "../src/config/index.js";
import { createO2Gateway } from "../src/gateway/o2.js";
import { startMcp, type McpHub } from "../src/mcp/index.js";
import { createRunManager } from "../src/runs/index.js";
import { PiAgentRunner } from "../src/runs/pi-runner.js";
import { Credential, RunAbort, type RunInput } from "../src/runs/types.js";
import { startTelemetry } from "../src/telemetry/index.js";
import { SkillPackIndex } from "../src/tools/skillpacks.js";
import { callTool, fail, say, scripted, transcriptText, type Reply } from "./fake-stream.js";

// o2Gateway.auth user end to end: O2's per-turn user token from the request header to the O2 MCP calls of the run,
// and nowhere else (docs/design/002-o2-gateway-contract.md §1).

const exporter = new InMemorySpanExporter();
const telemetry = startTelemetry({ exporter })!;

const SERVICE = "Basic c2VydmljZTpzZWNyZXQ=";
/** Shaped like O2's tokens, o2ut.<base64url claims>.<base64url mac>; built here so no token-like literal is in the source. */
const fakeUserToken = (sub: string) =>
  `o2ut.${Buffer.from(JSON.stringify({ v: 1, sub, org: "prod", scope: "read", exp: Math.floor(Date.now() / 1000) + 900 })).toString("base64url")}.${Buffer.from(`mac of ${sub}`).toString("base64url")}`;
const TOKEN_A = fakeUserToken("a@example.com");
const TOKEN_B = fakeUserToken("b@example.com");
const EXPIRED = fakeUserToken("expired@example.com");
const NO_ACCESS = fakeUserToken("no-access@example.com");
const PROD = "prodOrgId123";

interface Seen {
  auth: string | undefined;
  method: string | undefined;
  tool?: string;
}

/**
 * An O2-like MCP endpoint that checks Authorization the way O2 would: the service account's Basic, or a user token.
 * EXPIRED fails every request with 401; NO_ACCESS passes initialize but gets 403 on tools/call (its user may reach
 * /mcp but not the data). Records every request.
 */
class FakeO2 {
  seen: Seen[] = [];
  /** The next `failCalls` tools/call requests answer `failStatus` with `failBody` (O2 rate limiting, a bad request). */
  failCalls = 0;
  failStatus = 429;
  failBody = "rate limit exceeded";
  private http?: Server;
  port = 0;

  url(org: string): string {
    return `http://127.0.0.1:${this.port}/api/${org}/mcp`;
  }

  calls(auth?: string): Seen[] {
    return this.seen.filter((s) => s.method === "tools/call" && (auth === undefined || s.auth === auth));
  }

  private build(): McpServer {
    const server = new McpServer({ name: "fake-o2", version: "1" });
    const loose = { request_body: z.any().optional(), stream_name: z.any().optional() };
    for (const name of ["SearchSQL", "StreamList"]) {
      server.registerTool(name, { description: name, inputSchema: loose }, async () => ({ content: [{ type: "text" as const, text: `{"total":1,"hits":[{"n":1}]}` }] }));
    }
    return server;
  }

  async listen(): Promise<this> {
    this.http = createServer(async (req, res) => {
      const body = await read(req);
      const msg = body ? (JSON.parse(body) as { method?: string; params?: { name?: string } }) : undefined;
      const auth = req.headers.authorization;
      this.seen.push({ auth, method: msg?.method ?? req.method, ...(msg?.params?.name && { tool: msg.params.name }) });
      const user = auth?.startsWith("Bearer o2ut.") ? auth.slice("Bearer ".length) : undefined;
      if (auth !== SERVICE && ![TOKEN_A, TOKEN_B, NO_ACCESS].includes(user ?? "")) return void res.writeHead(401).end("token expired");
      if (user === NO_ACCESS && msg?.method === "tools/call") return void res.writeHead(403).end("no access to stream");
      if (this.failCalls > 0 && msg?.method === "tools/call") {
        this.failCalls--;
        return void res.writeHead(this.failStatus).end(this.failBody);
      }
      const server = this.build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, msg);
    });
    await new Promise<void>((r) => this.http!.listen(0, "127.0.0.1", () => r()));
    this.port = (this.http.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    this.http?.closeAllConnections();
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
  }
}

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  exporter.reset();
});

const KEY = "test-agent-key-0123456789";
const base = { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y", O2_AGENT_API_KEY: KEY };

function configFor(o2: FakeO2, auth: "user" | "service" = "user") {
  return loadConfig({ ...base, NEOTAGS_CONFIG: "f" }, () => `llm:
  baseUrl: http://gw.test/v1
  models:
    flash: { id: flash-model, reasoning: true }
  chains:
    agent: [{ model: flash, effort: high }]
    job: [{ model: flash, effort: high }]
    gate: [{ model: flash, effort: none }]
    summary: [{ model: flash, effort: low }]
mcp:
  servers:
    - { name: o2, url: "${o2.url("default")}", headersFromEnv: { Authorization: O2_AUTH }, allowTools: [SearchSQL, StreamList] }
    - { name: o2prod, url: "${o2.url(PROD)}", headersFromEnv: { Authorization: O2_AUTH }, allowTools: [SearchSQL, StreamList] }
o2Gateway:
  enabled: true
  auth: ${auth}
  orgs: { default: o2, ${PROD}: o2prod }
telemetry: { captureContent: true }
`);
}

async function setup(auth: "user" | "service" = "user", env: NodeJS.ProcessEnv = { O2_AUTH: SERVICE }) {
  const o2 = await new FakeO2().listen();
  cleanup.push(() => o2.stop());
  const cfg = configFor(o2, auth);
  let logged = "";
  const log = pino({ level: "debug" }, { write: (s: string) => void (logged += s) });
  const mcp = await startMcp(cfg, log, env);
  cleanup.push(() => mcp.close());
  return { o2, cfg, log, mcp, logs: () => logged };
}

const END_US = Date.now() * 1000;
const SQL = { request_body: { query: { sql: "SELECT count(*) FROM app_logs", start_time: END_US - 3600e6, end_time: END_US } }, stream_name: "app_logs" };

/** Run one question through the hub as a run of `access` would: the tools the run gets, called by name. */
async function callAs(mcp: McpHub, access: RunInput["mcp"], name: string) {
  const run = await mcp.forRun(access);
  const tool = run.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const call = () => tool.execute("c1", mcp.guard.prepare(name, SQL) as never, undefined, undefined as never);
  return { run, call };
}

describe("McpHub.forRun", () => {
  it("without access: every server's shared tools, as before", async () => {
    const { mcp } = await setup();
    expect((await mcp.forRun(undefined)).tools.map((t) => t.name)).toEqual(mcp.tools().map((t) => t.name));
    expect((await mcp.forRun(undefined)).tools).toHaveLength(4);
  });

  it("as the user: only the page org's tools, on a run client that sends the bearer token and no service header", async () => {
    const { o2, mcp } = await setup();
    const listedBefore = o2.seen.length;
    const access = { hide: ["o2"], asUser: { server: "o2prod", bearer: new Credential(TOKEN_A) } };
    const { run, call } = await callAs(mcp, access, "o2prod__SearchSQL");
    expect(run.tools.map((t) => t.name)).toEqual(["o2prod__SearchSQL", "o2prod__StreamList"]);
    const res = await call();
    expect(res.content).toEqual([{ type: "text", text: expect.stringContaining('"total":1') }]);
    await call();
    const after = o2.seen.slice(listedBefore);
    // initialize (+ initialized), then the calls: all as the user, and the run client never lists tools.
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((s) => s.auth === `Bearer ${TOKEN_A}`)).toBe(true);
    expect(after.map((s) => s.method)).not.toContain("tools/list");
    expect(o2.calls(`Bearer ${TOKEN_A}`)).toHaveLength(2);
    expect(o2.calls(SERVICE)).toHaveLength(0);
    expect(after.filter((s) => s.method === "initialize")).toHaveLength(1);
    await run.close();
  });

  it("keeps two concurrent runs on their own tokens", async () => {
    const { o2, mcp } = await setup();
    const a = await callAs(mcp, { asUser: { server: "o2prod", bearer: new Credential(TOKEN_A) } }, "o2prod__SearchSQL");
    const b = await callAs(mcp, { asUser: { server: "o2prod", bearer: new Credential(TOKEN_B) } }, "o2prod__SearchSQL");
    await Promise.all([a.call(), b.call(), a.call(), b.call()]);
    expect(o2.calls(`Bearer ${TOKEN_A}`)).toHaveLength(2);
    expect(o2.calls(`Bearer ${TOKEN_B}`)).toHaveLength(2);
    expect(o2.calls(SERVICE)).toHaveLength(0);
    // The other servers still go through the shared client.
    const other = a.run.tools.find((t) => t.name === "o2__SearchSQL")!;
    await other.execute("c2", mcp.guard.prepare("o2__SearchSQL", SQL) as never, undefined, undefined as never);
    expect(o2.calls(SERVICE)).toHaveLength(1);
    await Promise.all([a.run.close(), b.run.close()]);
  });

  it("closes the run client with the run: a later call sends nothing", async () => {
    const { o2, mcp } = await setup();
    const { run, call } = await callAs(mcp, { asUser: { server: "o2prod", bearer: new Credential(TOKEN_A) } }, "o2prod__SearchSQL");
    await call();
    await run.close();
    const before = o2.seen.length;
    await expect(call()).rejects.toThrow(/unavailable \(the run has ended\)/);
    expect(o2.seen.length).toBe(before);
  });

  it.each([
    ["401 (expired token, at initialize)", EXPIRED, /no longer accepts the user's O2 sign-in.*ask the question again/],
    ["403 (no access, at tools\/call)", NO_ACCESS, /refused this call for the user's own O2 account.*Do not try another org/],
  ])("turns %s into a tool error without retrying or touching the shared client", async (_name, token, message) => {
    const { o2, mcp } = await setup();
    const shared = o2.seen.length;
    const { run, call } = await callAs(mcp, { asUser: { server: "o2prod", bearer: new Credential(token) } }, "o2prod__SearchSQL");
    const err = await call().then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(message);
    expect(err?.message).not.toMatch(/unauthorized|forbidden|not\s+authorized|permission\s*denied/i);
    const sent = o2.seen.slice(shared);
    // One initialize, and for 403 one tools/call: no second attempt, nothing as the service account.
    expect(sent.filter((s) => s.method === "initialize")).toHaveLength(1);
    expect(sent.filter((s) => s.method === "tools/call").length).toBeLessThanOrEqual(1);
    expect(sent.every((s) => s.auth === `Bearer ${token}`)).toBe(true);
    expect(mcp.unavailable()).toEqual([]);
    await run.close();
  });

  it("does not name a hidden server as down, nor the user server once it has listed its tools", async () => {
    const { o2, mcp } = await setup();
    await o2.stop();
    // The shared client fails, reconnects once, fails again: both servers are down for the shared client.
    for (const name of ["o2__SearchSQL", "o2prod__SearchSQL"]) {
      await mcp.tools().find((t) => t.name === name)!.execute("c", mcp.guard.prepare(name, SQL) as never, undefined, undefined as never).catch(() => undefined);
    }
    expect(mcp.unavailable()).toEqual(["o2", "o2prod"]);
    // A user run calls o2prod on its own client with the tools listed at startup, and has no o2 at all.
    expect(mcp.unavailable({ hide: ["o2"], asUser: { server: "o2prod", bearer: new Credential(TOKEN_A) } })).toEqual([]);
    expect(mcp.unavailable({ hide: ["o2"] })).toEqual(["o2prod"]);
  });

  const userAccess = (token = TOKEN_A) => ({ hide: ["o2"], asUser: { server: "o2prod", bearer: new Credential(token) } });
  const errorOf = (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (e: unknown) => (e as Error).message,
    );

  it.each([
    [429, "rate limit exceeded", /answered HTTP 429: rate limit exceeded\. It is limiting requests: do not retry now/],
    [400, "bad SQL near FROM", /answered HTTP 400: bad SQL near FROM\. Do not send the same call again/],
    [500, "internal error", /answered HTTP 500: internal error\. Do not send the same call again/],
  ])("as the user, passes HTTP %i through to the model as O2's answer, sent once, without reconnecting", async (status, body, want) => {
    const { o2, mcp } = await setup();
    const { run, call } = await callAs(mcp, userAccess(), "o2prod__SearchSQL");
    await call();
    const before = o2.seen.length;
    Object.assign(o2, { failCalls: 1, failStatus: status, failBody: body });
    expect(await errorOf(call())).toMatch(want);
    const sent = o2.seen.slice(before);
    expect(sent.map((s) => s.method)).toEqual(["tools/call"]);
    await run.close();
  });

  it("as the user, a 404 (the server lost the session) reconnects once and retries", async () => {
    const { o2, mcp } = await setup();
    const { run, call } = await callAs(mcp, userAccess(), "o2prod__SearchSQL");
    await call();
    const before = o2.seen.length;
    Object.assign(o2, { failCalls: 1, failStatus: 404, failBody: "session not found" });
    await expect(call()).resolves.toMatchObject({ content: [{ text: expect.stringContaining('"total":1') }] });
    const sent = o2.seen.slice(before).map((s) => s.method);
    expect(sent.filter((m) => m === "initialize")).toHaveLength(1);
    expect(sent.filter((m) => m === "tools/call")).toHaveLength(2);
    await run.close();
  });

  it("on the shared client, a 429 is the server's answer: sent once, and the server stays up", async () => {
    const { o2, mcp } = await setup("service");
    const tool = mcp.tools().find((t) => t.name === "o2prod__SearchSQL")!;
    const before = o2.seen.length;
    Object.assign(o2, { failCalls: 1, failStatus: 429, failBody: "rate limit exceeded" });
    expect(await errorOf(tool.execute("c", mcp.guard.prepare("o2prod__SearchSQL", SQL) as never, undefined, undefined as never))).toMatch(/answered HTTP 429/);
    expect(o2.seen.slice(before).map((s) => s.method)).toEqual(["tools/call"]);
    expect(mcp.unavailable()).toEqual([]);
  });

  it("lists the tools on the run client when the shared client has none (no service credential)", async () => {
    const { o2, mcp } = await setup("user", {});
    expect(mcp.tools()).toEqual([]);
    expect(mcp.unavailable()).toEqual(["o2", "o2prod"]);
    const access = userAccess();
    const { run, call } = await callAs(mcp, access, "o2prod__SearchSQL");
    expect(run.tools.map((t) => t.name)).toEqual(["o2prod__SearchSQL", "o2prod__StreamList"]);
    expect(mcp.unavailable(access)).toEqual([]);
    await call();
    // One connection as the user: initialize, list, call; nothing as the service account.
    expect(o2.seen.filter((s) => s.method === "initialize")).toHaveLength(1);
    expect(o2.seen.filter((s) => s.method === "tools/list").every((s) => s.auth === `Bearer ${TOKEN_A}`)).toBe(true);
    expect(o2.calls(`Bearer ${TOKEN_A}`)).toHaveLength(1);
    await run.close();
  });

  it("a run whose own listing is refused gets no tools for that server, and is told it is unavailable", async () => {
    const { mcp } = await setup("user", {});
    const access = userAccess(EXPIRED);
    const run = await mcp.forRun(access);
    expect(run.tools).toEqual([]);
    expect(mcp.unavailable(access)).toEqual(["o2prod"]);
    await run.close();
  });
});

describe("Credential", () => {
  it("shows a placeholder to JSON, string conversion, util.inspect and pino", () => {
    const c = new Credential(TOKEN_A);
    let out = "";
    pino({}, { write: (s: string) => void (out += s) }).info({ input: { mcp: { asUser: { bearer: c } } } }, "x");
    for (const s of [JSON.stringify({ c }), String(c), `${c}`, inspect({ c }, { depth: 5, showHidden: true }), out]) {
      expect(s).not.toContain(TOKEN_A);
      expect(s).toContain("[REDACTED]");
    }
    expect(c.reveal()).toBe(TOKEN_A);
  });
});

describe("O2 entry as the user, end to end", () => {
  async function serveAll(auth: "user" | "service", replies: Reply[]) {
    const { o2, cfg, log, mcp, logs } = await setup(auth);
    const stream = scripted(replies);
    const gateway = createGateway(cfg);
    Object.assign(gateway.models, { streamSimple: stream });
    const index = new SkillPackIndex();
    const runs = createRunManager(cfg, { gateway, index, log, mcp });
    const g = createO2Gateway({ cfg: cfg.o2Gateway, key: KEY, runs, log });
    await g.listen(0, "127.0.0.1");
    cleanup.push(async () => {
      g.stopAccepting();
      await g.close(0);
    });
    const url = `http://127.0.0.1:${(g.server.address() as AddressInfo).port}/o2_agent/o2/query/stream`;
    const ask = (token: string | undefined, org = PROD) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-o2-agent-key": KEY,
          "x-o2-assistant-session-id": crypto.randomUUID(),
          "x-o2-user-email": "a@example.com",
          ...(token && { "x-o2-user-token": token }),
        },
        body: JSON.stringify({ query: "how many app logs?", history: null, context: { org_id: org } }),
      });
    return { o2, stream, ask, logs, runs };
  }

  it("answers with the user's token on the page org's server only; the token is nowhere else", async () => {
    const { o2, stream, ask, logs } = await serveAll("user", [
      callTool("o2__SearchSQL", SQL as never, "t1"),
      callTool("o2prod__SearchSQL", SQL as never, "t2"),
      say("1 log line."),
    ]);
    const res = await ask(TOKEN_A);
    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(sse).toContain('"type":"complete"');
    // The other org's tool does not exist in this run; the page org's ran as the user.
    expect(o2.calls(`Bearer ${TOKEN_A}`).map((s) => s.tool)).toEqual(["SearchSQL"]);
    expect(o2.calls(SERVICE)).toHaveLength(0);
    const seen = transcriptText(stream.calls[1]!.context);
    expect(seen).toContain("Tool o2__SearchSQL not found");
    await telemetry.flush();
    const spans = exporter.getFinishedSpans();
    const run = spans.find((s) => s.name === "invoke_agent o2");
    expect(run?.attributes["neotags.o2.auth"]).toBe("user");
    // Prompts (system, user, tool results), span attributes with content capture on, logs and the SSE answer.
    const prompts = stream.calls.map((c) => JSON.stringify(c.context)).join("\n");
    const attrs = JSON.stringify(spans.map((s) => s.attributes));
    for (const text of [prompts, attrs, logs(), sse]) {
      expect(text).not.toContain(TOKEN_A);
      expect(text).not.toContain(TOKEN_A.split(".")[1]);
    }
  });

  it("refuses a turn without a token before any model or MCP call", async () => {
    const { o2, stream, ask } = await serveAll("user", [say("never")]);
    const shared = o2.seen.length;
    const res = await ask(undefined);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { detail: { code: string } }).detail.code).toBe("user_auth_unavailable");
    expect(stream.calls).toHaveLength(0);
    expect(o2.seen.length).toBe(shared);
  });

  it("service mode: the shared clients for every org, as before", async () => {
    const { o2, ask } = await serveAll("service", [callTool("o2__SearchSQL", SQL as never, "t1"), say("1 log line.")]);
    const res = await ask(TOKEN_A);
    expect(res.status).toBe(200);
    await res.text();
    expect(o2.calls(SERVICE).map((s) => s.tool)).toEqual(["SearchSQL"]);
    expect(o2.seen.some((s) => s.auth?.includes(TOKEN_A))).toBe(false);
    await telemetry.flush();
    expect(exporter.getFinishedSpans().find((s) => s.name === "invoke_agent o2")?.attributes["neotags.o2.auth"]).toBe("service");
  });
});

describe("run-scoped cleanup", () => {
  it.each([
    ["done", [say("ok")]],
    ["failed", [fail("500 from the gateway")]],
    ["cancelled", ["hang"]],
  ] as [string, Reply[]][])("closes what a run's tools opened when the run ends %s", async (_state, replies) => {
    const cfg = loadConfig({ ...base, LLM_MODEL: "m" });
    const ended: string[] = [];
    const runner = new PiAgentRunner({
      gateway: createGateway(cfg),
      index: new SkillPackIndex(),
      botName: "moose",
      entries: {},
      tools: ({ input, onEnd }) => {
        onEnd(() => ended.push(input.sessionId));
        return [];
      },
      firstTokenTimeoutMs: 1000,
      maxRetries: 0,
      charsPerToken: 4,
      streamFn: scripted(replies),
      sleep: async () => {},
    });
    const controller = new AbortController();
    const run = runner.run(
      { source: "o2", sessionId: "s1", question: "q" },
      { runId: "r1", signal: controller.signal, budget: { maxSteps: 5, softDeadline: Number.MAX_SAFE_INTEGER, maxInputTokens: 100_000 }, observer: {} },
    );
    setTimeout(() => controller.abort(new RunAbort("cancelled", "stop")), 20);
    await run.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(ended).toEqual(["s1"]);
  });
});
