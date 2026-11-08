import type { Config } from "../config/index.js";
import { redact } from "../tools/redact.js";
import type { Decision } from "./policy.js";

export type McpServerPolicy = Pick<Config["mcp"]["servers"][number], "name" | "allowTools" | "innerAllow" | "argAllow">;
export type QueryLimits = Config["agent"]["queryLimits"];

export interface McpGuardOptions {
  servers: McpServerPolicy[];
  /** Arguments of one call, as JSON. */
  maxArgChars: number;
  /** One tool output after redaction. */
  outputChars: number;
  limits: QueryLimits;
  now?: () => number;
}

const SEP = "__";
export const mcpToolName = (server: string, tool: string) => `${server}${SEP}${tool}`;

/** `<server>__<tool>`; server names have no underscores, so the first "__" ends the server name. */
export function splitToolName(name: string): { server: string; tool: string } | undefined {
  const i = name.indexOf(SEP);
  return i > 0 ? { server: name.slice(0, i), tool: name.slice(i + SEP.length) } : undefined;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const deny = (reason: string): Decision => ({ ok: false, reason });
const OK: Decision = { ok: true };

/** O2's tool that runs another tool by name (`{ tool, args, detail }`). */
const TOOLS_CALL = "tools_call";
const SEARCH_SQL = "SearchSQL";
const PROM_RANGE = "PrometheusRangeQuery";

/**
 * Tool Guard for MCP tools, enforced in code before and after every call; the model cannot bypass it.
 *
 * - `prepare` (the tools' `prepareArguments`) fills in what may safely be defaulted: a missing time range becomes the
 *   last `defaultRangeSec`, SQL without a LIMIT gets `sqlDefaultLimit`, a range query without a step gets one.
 * - `check` (the runner's `beforeToolCall`) decides: allowlisted tool, inner tool of tools_call in `innerAllow`,
 *   `argAllow` values, argument size, and the query limits. A refusal goes back to the model with the reason.
 * - `output` redacts a result, then cuts it to `outputChars`.
 */
export class McpGuard {
  private servers: Map<string, McpServerPolicy>;
  private now: () => number;

  constructor(private o: McpGuardOptions) {
    this.servers = new Map(o.servers.map((s) => [s.name, s]));
    this.now = o.now ?? Date.now;
  }

  /** Arguments with the defaults filled in. Never throws and never mutates `args`; `check` judges the result. */
  prepare(name: string, args: unknown): unknown {
    const id = splitToolName(name);
    if (!id || !isObj(args)) return args;
    if (id.tool === TOOLS_CALL) {
      if (typeof args.tool !== "string") return args;
      // Not an object (a model that sends the inner arguments as a JSON string): left as is, so `check` refuses it.
      if (args.args !== undefined && !isObj(args.args)) return args;
      const inner = this.prepareQuery(args.tool, isObj(args.args) ? args.args : {});
      return { ...args, args: inner };
    }
    return this.prepareQuery(id.tool, args);
  }

  /** May this call run? Calls of tools that are not MCP tools (`read_skill`, ...) are left to the runner. */
  check = (call: { name: string; args: unknown }): Decision => {
    const id = splitToolName(call.name);
    if (!id) return OK;
    const server = this.servers.get(id.server);
    if (!server) return deny(`${call.name} is not a configured MCP tool`);
    if (!server.allowTools.includes(id.tool)) return deny(`${call.name} is not allowlisted`);
    const size = JSON.stringify(call.args ?? {}).length;
    if (size > this.o.maxArgChars) return deny(`the arguments are ${size} characters; at most ${this.o.maxArgChars}`);
    if (!isObj(call.args)) return deny("the arguments must be an object");

    const outer = this.allowedValues(server, id.tool, call.args);
    if (!outer.ok) return outer;
    let tool = id.tool;
    let args: Obj = call.args;
    if (tool === TOOLS_CALL) {
      const inner = args.tool;
      const allowed = server.innerAllow ?? [];
      if (typeof inner !== "string" || !allowed.includes(inner)) {
        return deny(`${TOOLS_CALL} may only run ${allowed.join(", ") || "nothing"} on ${server.name}, not ${JSON.stringify(inner ?? null)}`);
      }
      if (args.args !== undefined && !isObj(args.args)) return deny(`${TOOLS_CALL} args must be an object`);
      tool = inner;
      args = isObj(args.args) ? args.args : {};
      const d = this.allowedValues(server, tool, args);
      if (!d.ok) return d;
    }

    if (tool === SEARCH_SQL) return this.checkSql(args);
    if (tool === PROM_RANGE) return this.checkProm(args);
    return OK;
  };

  /** Redacted, then cut to `outputChars` with a note that tells the model how to get the rest. */
  output(text: string): string {
    return boundedOutput(text, this.o.outputChars, "Narrow the query (a shorter time range, more filters, a smaller LIMIT) to see the rest.");
  }

  /** `argAllow` of `tool`: each listed parameter must be one of its values. */
  private allowedValues(server: McpServerPolicy, tool: string, args: Obj): Decision {
    for (const [param, values] of Object.entries(server.argAllow[tool] ?? {})) {
      const v = args[param];
      if (typeof v !== "string" || !values.includes(v)) {
        return deny(`${tool} ${param} must be one of ${values.join(", ")}, not ${JSON.stringify(v ?? null)}`);
      }
    }
    return OK;
  }

  private prepareQuery(tool: string, args: Obj): Obj {
    if (tool === SEARCH_SQL) return this.prepareSql(args);
    if (tool === PROM_RANGE) return this.prepareProm(args);
    return args;
  }

  // SearchSQL: { request_body: { query: { sql, start_time, end_time, size } } }, times in microseconds. O2 also takes
  // `query` at the top level and moves it into request_body; it is moved here first so that the checks see one shape.
  private prepareSql(args: Obj): Obj {
    const found = sqlQuery(args);
    if (!found || typeof found.query.sql !== "string") return args;
    const q: Obj = { ...found.query };
    const nowUs = this.now() * 1000;
    const rangeUs = this.o.limits.defaultRangeSec * 1e6;
    if (missing(q.end_time)) q.end_time = nowUs;
    if (missing(q.start_time) && typeof num(q.end_time) === "number") q.start_time = (num(q.end_time) as number) - rangeUs;

    // What runs carries no comments: they are where this lexer and O2's parser could disagree on the LIMIT.
    q.sql = stripSqlComments(q.sql as string).trim();
    let limit = trailingLimit(q.sql as string);
    if (limit === undefined) {
      limit = this.o.limits.sqlDefaultLimit;
      q.sql = `${(q.sql as string).replace(/[\s;]+$/, "")}\nLIMIT ${limit}`;
    }
    const size = num(q.size);
    if (size === undefined || size < 0 || size > limit) q.size = limit;

    const out: Obj = { ...args };
    if (found.at === "top") delete out.query;
    out.request_body = { ...(isObj(args.request_body) ? args.request_body : {}), query: q };
    return out;
  }

  private checkSql(args: Obj): Decision {
    const found = sqlQuery(args);
    if (!found || typeof found.query.sql !== "string" || !found.query.sql.trim()) return deny("SearchSQL needs request_body.query.sql");
    const q = found.query;
    const start = num(q.start_time);
    const end = num(q.end_time);
    // 16 digits: anything else is seconds, milliseconds or nanoseconds, or 0, which O2 rejects or misreads.
    const us = (v: number | undefined) => v !== undefined && v >= 1e15 && v < 1e17;
    if (!us(start) || !us(end)) return deny("start_time and end_time must be microseconds since the epoch (16 digits)");
    if (end! <= start!) return deny("end_time must be after start_time");
    const range = (end! - start!) / 1e6;
    if (range > this.o.limits.maxRangeSec) return deny(`the time range is ${hours(range)}; one query covers at most ${hours(this.o.limits.maxRangeSec)}: narrow it or split it`);
    const ambiguous = ambiguousSql(q.sql as string);
    if (ambiguous) return deny(`the SQL is refused: ${ambiguous}`);
    const limit = trailingLimit(q.sql as string);
    if (limit === undefined) return deny("the SQL needs a LIMIT at the end");
    if (limit > this.o.limits.sqlMaxLimit) return deny(`LIMIT ${limit} is above ${this.o.limits.sqlMaxLimit}: aggregate, or use a smaller LIMIT`);
    return OK;
  }

  // PrometheusRangeQuery: { query, start, end, step }, times RFC 3339 or Unix seconds, step a duration or seconds.
  private prepareProm(args: Obj): Obj {
    const a: Obj = { ...args };
    const def = this.o.limits.defaultRangeSec;
    if (missing(a.end)) a.end = new Date(this.now()).toISOString();
    const end = promTime(a.end);
    if (missing(a.start) && end !== undefined) a.start = new Date((end - def) * 1000).toISOString();
    const start = promTime(a.start);
    // About 60 points per series, as the skill pack asks for, and never more than promMaxPoints: a step of
    // ceil(range / n) gives at most n + 1 points.
    const n = Math.max(1, Math.min(60, this.o.limits.promMaxPoints - 1));
    if (missing(a.step) && start !== undefined && end !== undefined && end > start) a.step = `${Math.max(1, Math.ceil((end - start) / n))}s`;
    return a;
  }

  private checkProm(args: Obj): Decision {
    if (typeof args.query !== "string" || !args.query.trim()) return deny("PrometheusRangeQuery needs a query");
    const start = promTime(args.start);
    const end = promTime(args.end);
    if (start === undefined || end === undefined) return deny("start and end must be RFC 3339 times or Unix seconds");
    if (end <= start) return deny("end must be after start");
    const range = end - start;
    if (range > this.o.limits.maxRangeSec) return deny(`the time range is ${hours(range)}; one query covers at most ${hours(this.o.limits.maxRangeSec)}: narrow it or split it`);
    const step = duration(args.step);
    if (step === undefined) return deny("step must be a duration such as 60s or 5m");
    // Prometheus returns both ends: floor(range / step) + 1 points.
    const points = Math.floor(range / step) + 1;
    const max = this.o.limits.promMaxPoints;
    if (points > max) return deny(`step ${args.step} gives ${points} points per series; at most ${max}: use a step of at least ${Math.ceil(range / Math.max(1, max - 1))}s`);
    return OK;
  }
}

/** `text` redacted, then cut to `max` characters with a note ending in `hint`. */
export function boundedOutput(text: string, max: number, hint: string): string {
  // Redaction is linear but not cheap, and a result can be megabytes: only a prefix is scanned. The scanned prefix must
  // still be twice the budget after redaction, which can shorten it a lot, so that a secret cut at the end of the
  // prefix (and no longer matching its pattern) lies past what is kept unless it is longer than `max` itself.
  let window = 2 * max;
  let clean = redact(text.slice(0, window)).text;
  while (window < text.length && clean.length < 2 * max) {
    window *= 2;
    clean = redact(text.slice(0, window)).text;
  }
  if (clean.length <= max && window >= text.length) return clean;
  return `${clean.slice(0, max)}\n\n[Output truncated: ${max} of ${text.length} characters shown. ${hint}]`;
}

const missing = (v: unknown) => v === undefined || v === null || v === "";

/** A number, or a string holding one (models often quote them). */
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function sqlQuery(args: Obj): { query: Obj; at: "body" | "top" } | undefined {
  if (isObj(args.request_body) && isObj(args.request_body.query)) return { query: args.request_body.query, at: "body" };
  if (isObj(args.query)) return { query: args.query, at: "top" };
  return undefined;
}

// Literals ('it''s'), quoted identifiers ("col") and comments, matched left to right: whichever starts first wins.
const SQL_TOKENS = /'(?:[^']|'')*'|"(?:[^"]|"")*"|\/\*[\s\S]*?\*\/|--[^\n]*/g;
const isComment = (tok: string) => tok.startsWith("--") || tok.startsWith("/*");

/** The SQL without its comments; literals are kept. */
export function stripSqlComments(sql: string): string {
  return sql.replace(SQL_TOKENS, (tok) => (isComment(tok) ? " " : tok));
}

/**
 * Forms where this lexer and O2's SQL parser could read the text differently (nested comments, backslash escapes,
 * backtick identifiers), so that a LIMIT seen here is not the one O2 runs. `prepare` removes comments; the rest is
 * refused. This keeps the LIMIT check honest for the model's mistakes; the hard bounds are the time range and the
 * output budget, which do not depend on parsing SQL.
 */
function ambiguousSql(sql: string): string | undefined {
  if (sql.replace(SQL_TOKENS, (tok) => (isComment(tok) ? "--" : "''")).match(/--|\/\*|\*\//)) return "remove the SQL comments";
  if (sql.includes("`")) return 'quote identifiers with double quotes ("col"), not backticks';
  if (/\\['"]/.test(sql)) return "escape a quote by doubling it ('it''s'), not with a backslash";
  return undefined;
}

/** Row count of the outer query's LIMIT (`LIMIT n`, `LIMIT n OFFSET m`, `LIMIT m, n`), or undefined without one. */
export function trailingLimit(sql: string): number | undefined {
  const body = sql.replace(SQL_TOKENS, (tok) => (isComment(tok) ? " " : "''"));
  const m = /\blimit\s+(\d+)(?:\s*,\s*(\d+)|\s+offset\s+\d+)?\s*;?\s*$/i.exec(body);
  if (!m) return undefined;
  return Number(m[2] ?? m[1]);
}

/** Prometheus API time in Unix seconds: a number of seconds or an RFC 3339 timestamp. */
function promTime(v: unknown): number | undefined {
  const n = num(v);
  if (n !== undefined) return n;
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms / 1000;
}

const UNIT_SEC: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86_400, w: 604_800, y: 31_536_000 };

/** Prometheus duration (`1m30s`) or float seconds, in seconds; undefined unless positive. */
export function duration(v: unknown): number | undefined {
  const n = num(v);
  if (n !== undefined) return n > 0 ? n : undefined;
  if (typeof v !== "string" || !/^(\d+(ms|s|m|h|d|w|y))+$/.test(v)) return undefined;
  let sec = 0;
  for (const m of v.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)) sec += Number(m[1]) * UNIT_SEC[m[2]!]!;
  return sec > 0 ? sec : undefined;
}

const hours = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600}h` : `${(sec / 3600).toFixed(1)}h`);
