import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "pino";
import { z } from "zod";
import { O2_ORG_ID, type Config } from "../config/index.js";
import { answerLang } from "../lang.js";
import { Credential, type HistoryTurn, type RunInput, type RunManager } from "../runs/index.js";
import { cap } from "./o2-events.js";
import { O2Turn } from "./o2-stream.js";

// The OpenObserve assistant entry: docs/design/002-o2-gateway-contract.md. O2 forwards each chat turn and pipes the
// SSE answer to the panel byte for byte; everything here is shaped by what the panel and O2's client expect.

export interface O2GatewayOptions {
  cfg: Config["o2Gateway"];
  /** x-o2-agent-key. */
  key: string;
  runs: Pick<RunManager, "submit" | "cancelSession" | "active" | "stats" | "wouldQueue">;
  log: Pick<Logger, "info" | "warn" | "error">;
  pingMs?: number;
}

const QueryRequest = z.object({
  query: z.string(),
  history: z
    .array(z.object({ role: z.string(), content: z.unknown() }).loose())
    .nullish(),
  context: z.record(z.string(), z.unknown()).nullish(),
}).loose();

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;
const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,128}$/;
/**
 * O2's per-turn user token, `o2ut.<claims>.<mac>` (unpadded base64url). Opaque here: only O2 can check it, so this
 * is a shape check, and anything else counts as no token.
 */
const USER_TOKEN = /^o2ut\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const USER_TOKEN_CHARS = 4096;
/** Taken off the token's exp: clock skew between moose and O2, and a call in flight when time runs out. */
const USER_TOKEN_MARGIN_MS = 30_000;
/** One value of the page context larger than this is replaced by a note: the context is a starting point, not data. */
const CONTEXT_VALUE_CHARS = 4000;
/** All of the page context; values past it are dropped, so a page cannot fill the prompt. */
const CONTEXT_CHARS = 32_000;
const FEEDBACK_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

/** Pre-stream failure in o2-ai's shape; O2 passes `code` on to the panel as `error_code`. */
function sendError(res: ServerResponse, e: HttpError): void {
  if (res.headersSent) return void res.end();
  res.writeHead(e.status, {
    "content-type": "application/json",
    ...(e.retryAfterSec !== undefined && { "retry-after": String(Math.max(1, e.retryAfterSec)) }),
  });
  res.end(JSON.stringify({ detail: { code: e.code, message: e.message } }));
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Read to the end even when too large: leaving the loop early destroys the socket, and O2 would get a reset
  // instead of the 400.
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= maxBytes) chunks.push(chunk as Buffer);
  }
  if (size > maxBytes) throw new HttpError(400, "bad_request", `the request body is over ${Math.floor(maxBytes / 1024)} KB`);
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_request", "the request body is not JSON");
  }
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "bad_request", "malformed path");
  }
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant time; hashing first makes the lengths equal. */
function keyMatches(given: string | string[] | undefined, key: string): boolean {
  return typeof given === "string" && timingSafeEqual(digest(given), digest(key));
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};

/** Newest turns that fit `maxChars`, oldest first; text only (the panel replays no tool calls). */
export function boundedHistory(raw: { role: string; content: unknown }[] | null | undefined, maxChars: number): HistoryTurn[] {
  const turns = (raw ?? []).flatMap((t): HistoryTurn[] =>
    (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim() ? [{ role: t.role, content: t.content }] : [],
  );
  const kept: HistoryTurn[] = [];
  let chars = 0;
  for (const t of turns.reverse()) {
    const left = maxChars - chars;
    if (left <= 0) break;
    // A turn too long for what is left keeps its start: the latest answer is what a follow-up refers to.
    const content = t.content.length > left ? `${cap(t.content, left)}\n[cut: ${t.content.length} characters]` : t.content;
    chars += Math.min(t.content.length, left);
    kept.unshift({ role: t.role, content });
  }
  return kept;
}

/** The page context with oversized values (a pasted log, a huge field list) replaced by a note. */
export function boundedContext(ctx: Record<string, unknown> | null | undefined): Record<string, unknown> {
  // Built as entries: assigning a request's "__proto__" key to a plain object would set its prototype instead.
  const out: [string, unknown][] = [];
  let total = 0;
  for (const [k, v] of Object.entries(ctx ?? {})) {
    const size = typeof v === "string" ? v.length : (JSON.stringify(v) ?? "").length;
    const value = size > CONTEXT_VALUE_CHARS ? `[omitted: ${size} characters]` : v;
    total += k.length + (value === v ? size : 32);
    if (total > CONTEXT_CHARS) {
      out.push(["_omitted", "the rest of the page context did not fit"]);
      break;
    }
    out.push([k, value]);
  }
  return Object.fromEntries(out);
}

/** A usable `x-o2-user-token`, or undefined. */
export function userToken(v: string | undefined): string | undefined {
  return v && v.length <= USER_TOKEN_CHARS && USER_TOKEN.test(v) ? v : undefined;
}

/**
 * The token's `exp` (Unix seconds), read from its claims without checking the MAC: only for timing the run. O2
 * still checks the token on every call, so a forged exp buys nothing.
 */
export function userTokenExp(token: string): number | undefined {
  try {
    const exp: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))?.exp;
    return typeof exp === "number" && Number.isSafeInteger(exp) && exp > 0 ? exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the run is told about orgs, in code: the user's org from the URL path (O2 sets `org_id`) and the tools of each
 * configured org. The org id is checked against the identifier format before it goes anywhere near the prompt.
 * `asUser`: the run queries as the user and has only its own org's tools, so other orgs can only be linked to.
 */
export function orgNotes(org: string | undefined, orgs: Record<string, string>, asUser = false): { notes: string[]; server?: string } {
  // Own keys only: an org id such as "constructor" must not find Object.prototype.
  const server = org && Object.hasOwn(orgs, org) ? orgs[org] : undefined;
  const others = Object.entries(orgs).filter(([id]) => id !== org);
  const notes: string[] = [];
  if (org && server) {
    notes.push(
      asUser
        ? `The user is in O2 org ${org}; query it with the ${server}__ tools, which run with the user's own O2 permissions.`
        : `The user is in O2 org ${org}; query it with the ${server}__ tools unless the data is in another org.`,
    );
  } else if (org) notes.push(`The user is in O2 org ${org}, which no data source here queries.`);
  if (others.length) {
    notes.push(
      asUser
        ? `Other O2 orgs: ${others.map(([id]) => id).join(", ")}. This run has no tools for them: for data there, give the user a link and the query instead.`
        : `Other O2 orgs: ${others.map(([id, s]) => `${id} (${s}__ tools)`).join(", ")}.`,
    );
  }
  return { notes, ...(server && { server }) };
}

/**
 * HTTP server of the O2 entry, on its own port (in-cluster only; the Service and NetworkPolicy keep it there):
 * `POST /o2_agent/{agent}/query/stream` (SSE), `POST /o2_agent/sessions/{id}/cancel`, `POST /o2_agent/feedback`.
 */
export function createO2Gateway(o: O2GatewayOptions) {
  const { cfg, log } = o;

  async function query(req: IncomingMessage, res: ServerResponse, agent: string): Promise<void> {
    if (agent !== "o2") throw new HttpError(404, "agent_not_found", `unknown agent ${JSON.stringify(agent.slice(0, 40))}`);
    const session = header(req, "x-o2-assistant-session-id")?.toLowerCase();
    if (!session || !SESSION.test(session)) throw new HttpError(400, "bad_request", "x-o2-assistant-session-id must be a UUID");
    const parsed = QueryRequest.safeParse(await readBody(req, cfg.maxBodyKb * 1024));
    if (!parsed.success) throw new HttpError(400, "bad_request", "the body is not a QueryRequest");
    const body = parsed.data;
    const question = body.query.trim();
    if (!question) throw new HttpError(400, "bad_request", "query is empty");

    const email = header(req, "x-o2-user-email")?.trim().toLowerCase();
    const user = email && EMAIL.test(email) ? email : undefined;
    const traceparent = header(req, "traceparent")?.trim().toLowerCase();
    const trace = traceparent ? TRACEPARENT.exec(traceparent) : null;
    const context = boundedContext(body.context);
    // From the request, not the bounded copy: large page fields before it must not cost the run its org.
    const rawOrg = body.context?.org_id;
    const orgId = typeof rawOrg === "string" && O2_ORG_ID.test(rawOrg) ? rawOrg : undefined;
    const asUser = cfg.auth === "user";
    const { notes, server } = orgNotes(orgId, cfg.orgs, asUser);
    let mcp: RunInput["mcp"];
    let credentialDeadline: RunInput["credentialDeadline"];
    if (asUser) {
      // Never the service account instead: the panel's user would see data their own account cannot.
      const raw = header(req, "x-o2-user-token");
      const token = userToken(raw);
      const exp = token && userTokenExp(token);
      if (!token || !exp) {
        if (raw) log.warn({ session, length: raw.length }, "o2 x-o2-user-token is malformed; turn refused");
        throw new HttpError(503, "user_auth_unavailable", "O2 sent no usable credential for this user; ask again, or ask an admin to check the AI assistant's user tokens");
      }
      if (!server) throw new HttpError(503, "user_auth_unavailable", "the assistant does not serve this O2 org");
      credentialDeadline = { at: exp * 1000 - USER_TOKEN_MARGIN_MS, minMs: cfg.minUserTokenSec * 1000 };
      if (credentialDeadline.at - Date.now() < credentialDeadline.minMs) {
        log.warn({ session, expiresInSec: Math.round(exp - Date.now() / 1000) }, "o2 x-o2-user-token expires too soon; turn refused");
        throw new HttpError(503, "user_auth_unavailable", "the user's O2 sign-in for this question expires too soon; ask again");
      }
      mcp = {
        hide: Object.values(cfg.orgs).filter((s) => s !== server),
        asUser: { server, bearer: new Credential(token) },
      };
    }
    const history = boundedHistory(body.history, cfg.maxHistoryChars);
    const lang = answerLang(question);

    const turn = new O2Turn({
      res,
      question,
      lang,
      // What the panel sent, not what fits: a follow-up whose history was all cut must not rename the chat.
      firstTurn: (body.history ?? []).length === 0,
      ...(orgId && { org: orgId }),
      ...(server && { currentServer: server }),
      fallbackTraceId: trace && !/^0+$/.test(trace[1]!) ? trace[1]! : randomBytes(16).toString("hex"),
      log,
      ...(o.pingMs && { pingMs: o.pingMs }),
    });
    const input: RunInput = {
      source: "o2",
      sessionId: session,
      ...(user && { user }),
      question,
      history,
      context,
      notes,
      tools: [turn.navigationTool(), turn.dashboardTool(), turn.alertsTool()],
      ...(mcp && { mcp }),
      ...(credentialDeadline && { credentialDeadline }),
      ...(trace && { traceparent: traceparent! }),
    };
    // The user may have pressed Stop while the body was still arriving: no run for a turn nobody reads.
    if (res.destroyed || req.socket.destroyed) return;
    // Queueing is fine for a moment; a long queue means minutes of pings, so the panel gets its turn-limit notice.
    if (o.runs.wouldQueue(session) && o.runs.stats().queued >= cfg.maxQueued) throw new HttpError(429, "turn_limit", "too many questions are waiting; ask again shortly", 30);
    const submitted = o.runs.submit(input, turn.observer);
    if (!submitted.ok) {
      if (submitted.code === "rate_limited") throw new HttpError(429, "turn_limit", submitted.message, submitted.retryAfterSec);
      throw new HttpError(503, "unavailable", submitted.message, 5);
    }
    log.info({ runId: submitted.run.id, session, user, org: orgId, auth: cfg.auth, historyTurns: history.length }, "o2 query accepted");
    turn.open(submitted.run);
  }

  async function cancel(req: IncomingMessage, res: ServerResponse, session: string): Promise<void> {
    const id = session.toLowerCase();
    if (!SESSION.test(id)) throw new HttpError(400, "bad_request", "the session id must be a UUID");
    await readBody(req, FEEDBACK_BODY_BYTES);
    const active = o.runs.active(id);
    const cancelled = active && o.runs.cancelSession(id, "cancelled by O2");
    log.info({ session: id, active, cancelled }, "o2 cancel");
    sendJson(res, { active, cancelled });
  }

  async function feedback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req, FEEDBACK_BODY_BYTES);
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const session = header(req, "x-o2-assistant-session-id")?.toLowerCase();
    const email = header(req, "x-o2-user-email")?.trim().toLowerCase();
    const pick = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : undefined);
    // One log event per vote (§15); only known shapes, so a client cannot write arbitrary text into the logs.
    log.info(
      {
        event: "o2_feedback",
        session: pick(session, SESSION),
        user: pick(email, EMAIL),
        feedbackType: pick(b.feedback_type, /^thumbs_(up|down)$/),
        queryIndex: typeof b.query_index === "number" && Number.isInteger(b.query_index) ? b.query_index : undefined,
        traceId: pick(b.trace_id, /^[0-9a-f]{32}$/),
      },
      "o2 feedback",
    );
    sendJson(res, {});
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0]!;
    if (req.method === "GET" && path === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    if (!path.startsWith("/o2_agent/")) throw new HttpError(404, "not_found", "not found");
    if (!keyMatches(req.headers["x-o2-agent-key"], o.key)) throw new HttpError(401, "unauthorized", "missing or wrong x-o2-agent-key");
    // O2 must never forward the user's own credentials; they are not used, and their presence is an O2 bug.
    if (req.headers.authorization || req.headers.cookie) log.warn({ path }, "o2 request carries Authorization or Cookie; ignored");
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");
    const m = /^\/o2_agent\/(?:sessions\/([^/]+)\/cancel|feedback|([^/]+)\/query\/stream)$/.exec(path);
    if (!m) throw new HttpError(404, "not_found", "not found");
    if (m[1] !== undefined) return cancel(req, res, decoded(m[1]));
    if (m[2] !== undefined) return query(req, res, decoded(m[2]));
    return feedback(req, res);
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) return sendError(res, err);
      // The client went away mid-request (an aborted upload): nobody to answer.
      if (res.destroyed || req.destroyed) return;
      log.error({ err }, "o2 gateway request failed");
      sendError(res, new HttpError(500, "internal_error", "internal error"));
    });
  });

  return {
    server,
    listen: (port: number, host?: string) =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          // After startup a server error (EMFILE on accept, ...) is logged; unhandled it would take the process down.
          server.on("error", (err) => log.error({ err }, "o2 gateway server error"));
          resolve();
        });
      }),
    /** Stop accepting connections; open streams go on until their runs finish (the run manager drains them). */
    stopAccepting: () => {
      server.close();
      server.closeIdleConnections();
    },
    /** Close whatever is still open, after up to `graceMs` for responses that just ended to flush their last event. */
    close: async (graceMs = 2000) => {
      const closed = new Promise<void>((r) => server.once("close", () => r()));
      await Promise.race([closed, new Promise((r) => setTimeout(r, graceMs).unref())]);
      server.closeAllConnections();
    },
  };
}

export type O2Gateway = ReturnType<typeof createO2Gateway>;
