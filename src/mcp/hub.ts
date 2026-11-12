import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import { EXECUTED_ARGS, RESULT_DATA } from "../agent/executed.js";
import type { Config } from "../config/index.js";
import { mcpToolName, type McpGuard } from "../guardrails/tools.js";
import type { Credential, RunMcpAccess } from "../runs/types.js";
import { redact } from "../tools/redact.js";

export type McpServerConfig = Config["mcp"]["servers"][number];

export interface McpHubOptions {
  servers: McpServerConfig[];
  guard: McpGuard;
  connectTimeoutMs: number;
  callTimeoutMs: number;
  /** Background reconnects back off from `reconnectMinMs` (default 5 s) up to this. */
  reconnectMaxMs: number;
  reconnectMinMs?: number;
  /** Where `headersFromEnv` values are read; default process.env. */
  env?: NodeJS.ProcessEnv;
  log: Pick<Logger, "info" | "warn">;
}

// OpenAI-compatible function names.
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
// Past this many tools the model picks the wrong one more often, and every request carries their schemas.
const MANY_TOOLS = 40;

interface ToolDef {
  tool: Tool;
  /** `<server>__<tool>`. */
  full: string;
}

interface ServerState {
  cfg: McpServerConfig;
  client?: Client;
  /** From the last successful tools/list; kept while the server is down so a run's tool list does not change. */
  defs: ToolDef[];
  /** `defs` as tools on the shared client. */
  tools: AgentTool<any>[];
  /** Why the server is unavailable; unset while connected. */
  down?: string;
  connecting?: Promise<void>;
  /** Successful connects so far: tells a failed call whether someone else already replaced its client. */
  gen: number;
  retryMs: number;
  /** Epoch ms before which a call on a down server fails at once instead of reconnecting (the backoff). */
  retryAt: number;
  timer?: NodeJS.Timeout;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The configured MCP servers over Streamable HTTP, one long-lived client each. A server that cannot be reached
 * does not stop startup: it is retried in the background, and `unavailable()` names it so the agent is told.
 * A call that fails on the connection (a restarted server, an expired session) reconnects once and retries; calls
 * that fail together share that reconnect. While a server is down, calls fail at once with an error the model can act
 * on until the next reconnect is due.
 */
export class McpHub {
  private states: ServerState[];
  private closed = false;
  /** Per run (its access object): whether forRun got it tools for its user server. */
  private userTools = new WeakMap<RunMcpAccess, boolean>();

  constructor(private o: McpHubOptions) {
    this.states = o.servers.map((cfg) => ({ cfg, defs: [], tools: [], down: "not connected yet", retryMs: o.reconnectMinMs ?? 5000, retryAt: 0, gen: 0 }));
  }

  get guard(): McpGuard {
    return this.o.guard;
  }

  /** Connect every server at once. Never throws; failures are logged and retried. */
  async start(): Promise<void> {
    await Promise.all(this.states.map((s) => this.connect(s)));
    const tools = this.tools();
    if (tools.length > MANY_TOOLS) this.o.log.warn({ tools: tools.length }, `mcp: more than ${MANY_TOOLS} tools; trim allowTools`);
    this.o.log.info({ tools: tools.map((t) => t.name), unavailable: this.unavailable() }, "mcp: started");
  }

  /** Tools of every server that has listed them, as pi AgentTools named `<server>__<tool>`. */
  tools(): AgentTool<any>[] {
    return this.states.flatMap((s) => s.tools);
  }

  /**
   * Servers that are down right now, by name. Under a run's `access`: not the hidden ones, and its user server only
   * when the run got no tools for it, since the run's calls to it do not go through the shared client.
   */
  unavailable(access?: RunMcpAccess): string[] {
    const hide = new Set(access?.hide ?? []);
    const userServer = access?.asUser?.server;
    return this.states
      .filter((s) =>
        hide.has(s.cfg.name) ? false : s.cfg.name === userServer ? !(this.userTools.get(access!) ?? s.defs.length > 0) : s.down !== undefined,
      )
      .map((s) => s.cfg.name);
  }

  /**
   * The tools of one run. Without `asUser` they are the shared ones, less the hidden servers'. With it, that server's
   * tools call it on a client of this run alone, carrying the user's bearer token and none of the server's configured
   * headers; `close()` ends it. The schemas are the shared client's, or, when it has listed none (its credential is
   * missing or refused, the server was down at startup), the run client lists them itself. Never throws: a run whose
   * listing fails has no tools for that server, and `unavailable(access)` names it.
   * The credential is passed down explicitly, never through ambient context, so one run can never call with another's.
   */
  async forRun(access?: RunMcpAccess, signal?: AbortSignal): Promise<{ tools: AgentTool<any>[]; close: () => Promise<void> }> {
    const hide = new Set(access?.hide ?? []);
    const states = this.states.filter((s) => !hide.has(s.cfg.name));
    const as = access?.asUser;
    const user = as && states.find((s) => s.cfg.name === as.server);
    if (!as || !user) return { tools: states.flatMap((s) => s.tools), close: async () => {} };
    const rc = new RunClient(user.cfg.url, as.bearer, this.o.connectTimeoutMs);
    let defs = user.defs;
    if (defs.length === 0) {
      try {
        defs = await abortable(
          rc.get().then((client) => listDefs(client, user.cfg, this.o.connectTimeoutMs, this.o.log)),
          signal,
        );
      } catch (err) {
        this.o.log.warn({ server: user.cfg.name, error: describe(classify(err)) }, "mcp: the run could not list the user server's tools");
      }
    }
    this.userTools.set(access!, defs.length > 0);
    const tools = states.flatMap((s) =>
      s === user ? defs.map((d) => this.wrap(d, (args, sig) => this.callAsUser(rc, s, d, args, sig))) : s.tools,
    );
    return { tools, close: () => rc.close() };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      this.states.map(async (s) => {
        clearTimeout(s.timer);
        await s.client?.close().catch(() => undefined);
        s.client = undefined;
      }),
    );
  }

  private connect(s: ServerState): Promise<void> {
    s.connecting ??= this.open(s).finally(() => (s.connecting = undefined));
    return s.connecting;
  }

  private async open(s: ServerState): Promise<void> {
    if (this.closed) return;
    const { cfg } = s;
    let client: Client | undefined;
    try {
      const headers: Record<string, string> = {};
      for (const [header, envName] of Object.entries(cfg.headersFromEnv)) {
        const v = (this.o.env ?? process.env)[envName];
        if (!v) throw new Error(`env var ${envName} (header ${header}) is not set`);
        headers[header] = v;
      }
      client = await connectClient(cfg.url, headers, this.o.connectTimeoutMs);
      const defs = await listDefs(client, cfg, this.o.connectTimeoutMs, this.o.log);
      if (this.closed) throw new Error("closed");
      s.client = client;
      s.gen++;
      s.defs = defs;
      s.tools = defs.map((d) => this.wrap(d, (args, signal) => this.call(s, d.tool.name, d.full, args, signal)));
      s.down = undefined;
      s.retryMs = this.o.reconnectMinMs ?? 5000;
      s.retryAt = 0;
      clearTimeout(s.timer);
      this.o.log.info({ server: cfg.name, tools: defs.length }, "mcp: connected");
    } catch (err) {
      await client?.close().catch(() => undefined);
      this.markDown(s, message(err));
    }
  }

  /** Mark a server down and retry it in the background, backing off. */
  private markDown(s: ServerState, why: string): void {
    const client = s.client;
    s.client = undefined;
    void client?.close().catch(() => undefined);
    s.down = why;
    if (this.closed) return;
    this.o.log.warn({ server: s.cfg.name, error: why, retryInSec: s.retryMs / 1000 }, "mcp: server unavailable");
    clearTimeout(s.timer);
    s.timer = setTimeout(() => void this.connect(s), s.retryMs);
    s.timer.unref();
    s.retryAt = Date.now() + s.retryMs;
    s.retryMs = Math.min(s.retryMs * 2, this.o.reconnectMaxMs);
  }

  private wrap({ tool: t, full }: ToolDef, call: (args: unknown, signal?: AbortSignal) => Promise<AgentToolResult<McpCallDetails>>): AgentTool<any> {
    // pi validates arguments against the tool's JSON Schema, which comes from the server as is.
    const { $schema: _ignored, ...schema } = t.inputSchema as Record<string, unknown>;
    return {
      name: full,
      label: t.title ?? t.annotations?.title ?? t.name,
      description: t.description ?? "",
      parameters: { ...schema, type: "object" },
      executionMode: "parallel",
      prepareArguments: (args: unknown) => this.o.guard.prepare(full, args) as never,
      execute: (_id, params, signal) => call(params, signal),
    };
  }

  /**
   * A call as the run's user, on the run's client. 401 (expired or bad token) and 403 (no access) are the server's
   * answer about the user, not about the connection: they reach the model as such, are not retried, and leave the
   * shared client alone. A connection failure gets one retry on a fresh run client.
   */
  private async callAsUser(rc: RunClient, s: ServerState, d: ToolDef, args: unknown, signal?: AbortSignal): Promise<AgentToolResult<McpCallDetails>> {
    const server = s.cfg.name;
    const res = await this.callWithRetry(server, d.tool.name, args, signal, {
      get: () => rc.get(),
      replace: async (failed) => {
        rc.drop(failed);
        return rc.closed ? undefined : "connect";
      },
      gaveUp: (_failed, why) => why,
      auth: (status) => (status === 401 ? userCredentialRejected(server) : userAccessRefused(server)),
    });
    return this.result(d.full, args, res);
  }

  /** A call on the shared client. 401/403 count as the connection here: the configured credential is the server's. */
  private async call(s: ServerState, tool: string, full: string, args: unknown, signal?: AbortSignal): Promise<AgentToolResult<McpCallDetails>> {
    // Within the backoff a down server fails at once: a run making many calls must not wait on a connect each time.
    if (!s.client && (s.connecting || Date.now() >= s.retryAt)) await abortable(this.connect(s), signal);
    if (!s.client) throw new Error(unavailableMessage(s.cfg.name, s.down));
    const first = s.client;
    let gen = s.gen;
    const res = await this.callWithRetry(s.cfg.name, tool, args, signal, {
      get: async () => first,
      replace: async (failed, sig) => {
        const next = failed && (await this.replacement(s, failed, gen, sig));
        if (!next) return undefined;
        gen = next.gen;
        return next.client;
      },
      gaveUp: (failed, why) => {
        if (failed && s.client === failed) this.markDown(s, why);
        return s.down ?? why;
      },
    });
    return this.result(full, args, res);
  }

  /**
   * One tool call with the retry rule of both clients: a connection failure (network error, connection closed, 404
   * for a session the server no longer knows) is retried once on a replacement client; any other HTTP error (400,
   * 429, 5xx) and every JSON-RPC error is the server's answer, which reaches the model as it is, without a retry.
   */
  private async callWithRetry(server: string, tool: string, args: unknown, signal: AbortSignal | undefined, conn: CallConn): Promise<CallToolResult> {
    let client: Client | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        client ??= await abortable(conn.get(), signal);
        return (await client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> }, undefined, {
          timeout: this.o.callTimeoutMs,
          ...(signal && { signal }),
        })) as CallToolResult;
      } catch (err) {
        if (signal?.aborted) throw err;
        const f = classify(err);
        if (f.kind === "answer") throw new Error(f.text);
        if (f.kind === "http") throw new Error(httpAnswer(server, f.status, f.text));
        if (f.kind === "auth" && conn.auth) throw new Error(conn.auth(f.status));
        // Sent again: the allowlisted tools only read (read-only credentials, argAllow lets through read operations
        // only), so a request that did run before its response was lost costs one more read.
        const next = attempt === 0 ? await conn.replace(client, signal) : undefined;
        if (!next) throw new Error(unavailableMessage(server, conn.gaveUp(client, f.text)));
        client = next === "connect" ? undefined : next;
      }
    }
  }

  private result(full: string, args: unknown, res: CallToolResult): AgentToolResult<McpCallDetails> {
    const { text, data } = this.o.guard.result(full, args, resultText(res), res.isError === true);
    // The arguments that ran, after the guard's defaults, for traces and the entry (evidence links): pi reports the
    // model's own arguments on tool events. `data` is what the entry needs of a result the model sees cut.
    return {
      content: [{ type: "text", text }],
      details: { [EXECUTED_ARGS]: args, ...(data !== undefined && { [RESULT_DATA]: data }) },
      ...(res.isError && { isError: true }),
    };
  }

  /**
   * The client to retry a call on after `failed` (of generation `gen`) failed on the connection: one someone else
   * already reconnected, the reconnect in progress, or a reconnect this call starts. Undefined when the reconnect that
   * replaced `failed` already failed (the server is down) or did not succeed.
   */
  private async replacement(s: ServerState, failed: Client, gen: number, signal?: AbortSignal): Promise<{ client: Client; gen: number } | undefined> {
    if (s.client && s.gen !== gen) return { client: s.client, gen: s.gen };
    if (!s.connecting) {
      if (s.client !== failed) return undefined;
      // Closing fails the other calls on it with "connection closed"; they then wait for this reconnect.
      s.client = undefined;
      void failed.close().catch(() => undefined);
    }
    await abortable(this.connect(s), signal);
    return s.client ? { client: s.client, gen: s.gen } : undefined;
  }
}

export type McpCallDetails = { [EXECUTED_ARGS]: unknown; [RESULT_DATA]?: unknown };

/** `p`, or a rejection as soon as `signal` aborts; `p` itself keeps running (a reconnect others may share). */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const unavailableMessage = (server: string, why: string | undefined) =>
  `Data source ${server} is unavailable (${why ?? "not connected"}). Continue without it and say what you could not check.`;

// Worded without "unauthorized" / "forbidden": the text can reach the panel, which rewrites such messages.
const userCredentialRejected = (server: string) =>
  `Data source ${server} no longer accepts the user's O2 sign-in for this question (it expired or is invalid). Do not retry; ` +
  "tell the user to ask the question again.";
const userAccessRefused = (server: string) =>
  `Data source ${server} refused this call for the user's own O2 account: the user has no access to this data. Do not try ` +
  "another org or guess the result; tell the user their account cannot see it.";

const HTTP_TEXT_CHARS = 300;

/** O2's HTTP error answer for the model: the status and the start of the body, redacted. */
function httpAnswer(server: string, status: number, text: string): string {
  const body = redact(text.replace(/^Streamable HTTP error: (Error POSTing to endpoint: )?/, "").slice(0, HTTP_TEXT_CHARS)).text;
  const what = status > 0 ? `HTTP ${status}` : "an unexpected response";
  const next =
    status === 429
      ? "It is limiting requests: do not retry now; narrow the query, or tell the user to try again in a minute."
      : "Do not send the same call again; change it, or continue without it and say what you could not check.";
  return `Data source ${server} answered ${what}: ${body.trim() || "(no details)"}. ${next}`;
}

/** How one call reaches its server, for callWithRetry. */
interface CallConn {
  get(): Promise<Client>;
  /**
   * After `failed` failed on the connection: the client to retry on, "connect" to get a new one, or undefined when
   * there is none (the server is down, the run ended).
   */
  replace(failed: Client | undefined, signal?: AbortSignal): Promise<Client | "connect" | undefined>;
  /** The call failed for good on the connection: why, for the model. */
  gaveUp(failed: Client | undefined, why: string): string;
  /** 401/403 as the model's answer; unset: they count as the connection. */
  auth?(status: 401 | 403): string;
}

type Failure =
  | { kind: "answer"; text: string }
  | { kind: "connection"; text: string }
  | { kind: "auth"; status: 401 | 403; text: string }
  | { kind: "http"; status: number; text: string };

/**
 * What a failed request means. A JSON-RPC error is the server answering (bad arguments, unknown tool, timeout),
 * unless it is the connection closing. An HTTP status is the server answering too, except 404: in Streamable HTTP it
 * is a session the server no longer knows (it restarted), which a new session fixes. Anything else (refused, reset,
 * DNS) is the network.
 */
function classify(err: unknown): Failure {
  const text = message(err);
  if (err instanceof McpError) return err.code === ErrorCode.ConnectionClosed ? { kind: "connection", text } : { kind: "answer", text };
  if (err instanceof StreamableHTTPError) {
    const status = err.code ?? -1;
    if (status === 404) return { kind: "connection", text };
    if (status === 401 || status === 403) return { kind: "auth", status, text };
    return { kind: "http", status, text };
  }
  return { kind: "connection", text };
}

const describe = (f: Failure) => ("status" in f ? `HTTP ${f.status}: ${f.text}` : f.text);

async function connectClient(url: string, headers: Record<string, string>, timeout: number): Promise<Client> {
  const client = new Client({ name: "neotags", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }), { timeout });
  return client;
}

/** The server's allowlisted tools (every page of tools/list), named `<server>__<tool>`. */
async function listDefs(client: Client, cfg: McpServerConfig, timeout: number, log: Pick<Logger, "warn">): Promise<ToolDef[]> {
  const listed: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { timeout });
    listed.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  const byName = new Map(listed.map((t) => [t.name, t]));
  const notListed = cfg.allowTools.filter((n) => !byName.has(n));
  if (notListed.length) log.warn({ server: cfg.name, notListed }, "mcp: allowlisted tools the server does not list");
  const defs: ToolDef[] = [];
  for (const name of cfg.allowTools) {
    const t = byName.get(name);
    if (!t) continue;
    const full = mcpToolName(cfg.name, name);
    if (!TOOL_NAME.test(full)) {
      log.warn({ server: cfg.name, tool: name }, "mcp: tool name is not a valid function name, skipped");
      continue;
    }
    defs.push({ tool: t, full });
  }
  return defs;
}

const RUN_ENDED = "the run has ended";

/**
 * One run's MCP client of a server, as the run's user: connects on its first use, and is closed with the run. A
 * client that failed on the connection is dropped, and the next call connects again.
 */
class RunClient {
  private current?: Promise<Client>;
  private client?: Client;
  closed = false;

  constructor(
    private url: string,
    private bearer: Credential,
    private timeoutMs: number,
  ) {}

  get(): Promise<Client> {
    if (this.closed) return Promise.reject(new Error(RUN_ENDED));
    if (!this.current) {
      const p = this.open();
      this.current = p;
      p.then(
        (c) => this.current === p && (this.client = c),
        () => this.current === p && (this.current = undefined),
      );
    }
    return this.current;
  }

  /** Stop using `failed` (it failed on the connection); the next call connects again. */
  drop(failed: Client | undefined): void {
    // A failed connect already cleared itself; another call may have reconnected since.
    if (!failed || this.client !== failed) return;
    this.current = undefined;
    this.client = undefined;
    void failed.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    const c = this.current;
    this.current = undefined;
    this.client = undefined;
    await c?.then((client) => client.close()).catch(() => undefined);
  }

  private async open(): Promise<Client> {
    const client = await connectClient(this.url, { Authorization: `Bearer ${this.bearer.reveal()}` }, this.timeoutMs);
    // The run ended while this connected: nobody closes it otherwise.
    if (this.closed) {
      await client.close().catch(() => undefined);
      throw new Error(RUN_ENDED);
    }
    return client;
  }
}

/** An MCP tool result as text: text parts as is, embedded text resources inlined, other parts as `[type]`. */
export function resultText(res: CallToolResult): string {
  const parts = (res.content ?? []).map((c) => {
    if (c.type === "text") return c.text;
    if (c.type === "resource" && "text" in c.resource) return c.resource.text;
    if (c.type === "resource_link") return `[resource_link] ${c.uri}`;
    return `[${c.type}]`;
  });
  if (parts.length === 0 && res.structuredContent !== undefined) return JSON.stringify(res.structuredContent);
  return parts.join("\n");
}
