import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import { EXECUTED_ARGS, RESULT_DATA } from "../agent/executed.js";
import type { Config } from "../config/index.js";
import { mcpToolName, type McpGuard } from "../guardrails/tools.js";

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

interface ServerState {
  cfg: McpServerConfig;
  client?: Client;
  /** From the last successful tools/list; kept while the server is down so a run's tool list does not change. */
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

  constructor(private o: McpHubOptions) {
    this.states = o.servers.map((cfg) => ({ cfg, tools: [], down: "not connected yet", retryMs: o.reconnectMinMs ?? 5000, retryAt: 0, gen: 0 }));
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

  /** Servers that are down right now, by name. */
  unavailable(): string[] {
    return this.states.filter((s) => s.down !== undefined).map((s) => s.cfg.name);
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
      client = new Client({ name: "neotags", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers } });
      const timeout = this.o.connectTimeoutMs;
      await client.connect(transport, { timeout });
      const listed: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout });
        listed.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);

      const byName = new Map(listed.map((t) => [t.name, t]));
      const notListed = cfg.allowTools.filter((n) => !byName.has(n));
      if (notListed.length) this.o.log.warn({ server: cfg.name, notListed }, "mcp: allowlisted tools the server does not list");
      const tools: AgentTool<any>[] = [];
      for (const name of cfg.allowTools) {
        const t = byName.get(name);
        if (!t) continue;
        const full = mcpToolName(cfg.name, name);
        if (!TOOL_NAME.test(full)) {
          this.o.log.warn({ server: cfg.name, tool: name }, "mcp: tool name is not a valid function name, skipped");
          continue;
        }
        tools.push(this.wrap(s, t, full));
      }
      if (this.closed) throw new Error("closed");
      s.client = client;
      s.gen++;
      s.tools = tools;
      s.down = undefined;
      s.retryMs = this.o.reconnectMinMs ?? 5000;
      s.retryAt = 0;
      clearTimeout(s.timer);
      this.o.log.info({ server: cfg.name, tools: tools.length }, "mcp: connected");
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

  private wrap(s: ServerState, t: Tool, full: string): AgentTool<any> {
    // pi validates arguments against the tool's JSON Schema, which comes from the server as is.
    const { $schema: _ignored, ...schema } = t.inputSchema as Record<string, unknown>;
    return {
      name: full,
      label: t.title ?? t.annotations?.title ?? t.name,
      description: t.description ?? "",
      parameters: { ...schema, type: "object" },
      executionMode: "parallel",
      prepareArguments: (args: unknown) => this.o.guard.prepare(full, args) as never,
      execute: (_id, params, signal) => this.call(s, t.name, full, params, signal),
    };
  }

  private async call(s: ServerState, tool: string, full: string, args: unknown, signal?: AbortSignal): Promise<AgentToolResult<McpCallDetails>> {
    // Within the backoff a down server fails at once: a run making many calls must not wait on a connect each time.
    if (!s.client && (s.connecting || Date.now() >= s.retryAt)) await abortable(this.connect(s), signal);
    if (!s.client) throw new Error(unavailableMessage(s.cfg.name, s.down));
    let client: Client = s.client;
    let gen = s.gen;
    let res: CallToolResult | undefined;
    for (let attempt = 0; !res; attempt++) {
      try {
        res = (await client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> }, undefined, {
          timeout: this.o.callTimeoutMs,
          ...(signal && { signal }),
        })) as CallToolResult;
      } catch (err) {
        if (signal?.aborted) throw err;
        // A JSON-RPC error is the server answering (bad arguments, unknown tool, timeout); anything else is the
        // connection: HTTP errors, refused or reset connections, an expired session.
        if (err instanceof McpError && err.code !== ErrorCode.ConnectionClosed) throw new Error(message(err));
        const next: { client: Client; gen: number } | undefined = attempt === 0 ? await this.replacement(s, client, gen, signal) : undefined;
        if (!next) {
          if (attempt > 0 && s.client === client) this.markDown(s, message(err));
          throw new Error(unavailableMessage(s.cfg.name, s.down ?? message(err)));
        }
        // Sent again: the allowlisted tools only read (read-only credentials, argAllow lets through read operations
        // only), so a request that did run before its response was lost costs one more read.
        ({ client, gen } = next);
      }
    }
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
