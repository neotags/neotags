import { isObj, splitToolName } from "../guardrails/tools.js";
import type { AnswerLang } from "../lang.js";
import { redact } from "../tools/redact.js";

// SSE events of the O2 assistant panel (docs/design/002-o2-gateway-contract.md §4), and the text code writes into them.

export type O2Event =
  | { type: "title"; title: string }
  | { type: "message_delta"; content: string }
  | { type: "tool_call"; tool: string; call_id: string; message: string; context: Record<string, unknown> }
  | {
      type: "tool_result";
      tool: string;
      call_id: string;
      success: boolean;
      message: string;
      summary?: { count?: number; took?: number };
      call_args?: SqlCallArgs;
      error_type?: string;
    }
  | { type: "navigation_action"; resource_type: "logs" | "traces"; action: "load_query"; label: string; target: Record<string, unknown> }
  | { type: "complete"; trace_id: string }
  | { type: "error"; error: string; error_type?: string; suggestion?: string }
  | { type: "cancelled" };

/** One SSE frame: a single `data:` line (JSON.stringify escapes newlines), then a blank line. */
export const frame = (e: O2Event): string => `data: ${JSON.stringify(e)}\n\n`;
export const PING = ": ping\n\n";

export const SEARCH_SQL = "SearchSQL";
const TOOLS_CALL = "tools_call";

/** A call as the panel names it: the O2 inner tool (tools_call unwrapped), without the `<server>__` prefix. */
export interface PanelTool {
  /** MCP server, for MCP tools. */
  server?: string;
  tool: string;
  args: Record<string, unknown>;
}

export function panelTool(name: string, args: unknown): PanelTool {
  const a = isObj(args) ? args : {};
  const id = splitToolName(name);
  if (!id) return { tool: name, args: a };
  if (id.tool === TOOLS_CALL && typeof a.tool === "string") return { server: id.server, tool: a.tool, args: isObj(a.args) ? a.args : {} };
  return { server: id.server, tool: id.tool, args: a };
}

/** SearchSQL's query, in `request_body.query` or (O2 moves it there) at the top level. */
function sqlQuery(args: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isObj(args.request_body) && isObj(args.request_body.query)) return args.request_body.query;
  return isObj(args.query) ? args.query : undefined;
}

// The panel's own rule for the stream of a query (O2AIChat.navigation.ts).
const FROM = /FROM\s+["']?([^"'\s,()]+)["']?/i;
const STREAM_TYPES = new Set(["logs", "traces", "metrics"]);

export interface SqlCallArgs {
  stream_name: string;
  stream_type: string;
  request_body: { query: { sql: string; start_time: number; end_time: number; size?: number } };
}

/** The SearchSQL that ran, in the shape the panel turns into a "View in Logs/Traces" button; undefined if incomplete. */
export function sqlCallArgs(args: Record<string, unknown>): SqlCallArgs | undefined {
  const q = sqlQuery(args);
  if (!q || typeof q.sql !== "string" || typeof q.start_time !== "number" || typeof q.end_time !== "number") return undefined;
  const stream = typeof args.stream_name === "string" && args.stream_name ? args.stream_name : FROM.exec(q.sql)?.[1];
  if (!stream) return undefined;
  const type = typeof args.type === "string" && STREAM_TYPES.has(args.type) ? args.type : "logs";
  return {
    stream_name: stream,
    stream_type: type,
    request_body: { query: { sql: q.sql, start_time: q.start_time, end_time: q.end_time, ...(typeof q.size === "number" && { size: q.size }) } },
  };
}

const CARD_STRING_CHARS = 2000;
const card = (v: string) => {
  const s = redact(v).text;
  return s.length > CARD_STRING_CHARS ? `${s.slice(0, CARD_STRING_CHARS)}…` : s;
};

/** What the tool card shows of the arguments: the query fields the panel knows, redacted and capped. */
export function cardContext(t: PanelTool): Record<string, unknown> {
  const a = t.args;
  const out: Record<string, unknown> = {};
  for (const k of ["stream_name", "type", "query", "name", "file", "start", "end", "step"]) {
    const v = a[k];
    if (typeof v === "string") out[k] = card(v);
    else if (typeof v === "number") out[k] = v;
  }
  if (Array.isArray(a.argv)) out.command = card(a.argv.filter((x) => typeof x === "string").join(" "));
  const q = sqlQuery(a);
  if (q && typeof q.sql === "string") {
    delete out.query;
    const query: Record<string, unknown> = { sql: card(q.sql) };
    for (const k of ["start_time", "end_time", "size"]) if (typeof q[k] === "number") query[k] = q[k];
    out.request_body = { query };
  }
  return out;
}

type Lang<T> = Record<AnswerLang, T>;

/** One line on the tool card while the call runs. `other`: the call queries another org than the user's. */
export function callMessage(t: PanelTool, lang: AnswerLang, other?: string): string {
  const s = (v: unknown) => (typeof v === "string" && v ? card(v).slice(0, 80) : undefined);
  const stream = s(t.args.stream_name) ?? s(FROM.exec(String(sqlQuery(t.args)?.sql ?? ""))?.[1]);
  const m: Lang<string> = (() => {
    switch (t.tool) {
      case SEARCH_SQL:
        return { zh: stream ? `查询 ${stream}` : "运行 SQL 查询", en: stream ? `Querying ${stream}` : "Running a SQL query" };
      case "StreamSchema":
        return { zh: `读取 ${stream ?? "stream"} 的字段`, en: `Reading the schema of ${stream ?? "a stream"}` };
      case "StreamList":
        return { zh: "列出 streams", en: "Listing streams" };
      case "PrometheusRangeQuery":
        return { zh: "运行 PromQL 查询", en: "Running a PromQL query" };
      case "GetLatestTraces":
        return { zh: "查看最近的 trace", en: "Fetching recent traces" };
      case "GetIncident":
        return { zh: "读取 incident", en: "Reading the incident" };
      case "tool_search":
        return { zh: "查找可用的工具", en: "Looking up tools" };
      case "read_skill":
        return { zh: `读取说明 ${s(t.args.name) ?? ""}`.trim(), en: `Reading the ${s(t.args.name) ?? "skill"} instructions` };
      case "read_skill_ref":
        return { zh: `读取参考资料 ${s(t.args.file) ?? ""}`.trim(), en: `Reading ${s(t.args.file) ?? "a reference"}` };
      case "run_skill_command": {
        const cmd = Array.isArray(t.args.argv) ? s(t.args.argv[0]) : undefined;
        return { zh: `在沙箱里运行 ${cmd ?? "命令"}`, en: `Running ${cmd ?? "a command"} in the sandbox` };
      }
      case "search_indexed_documents":
        return { zh: "搜索知识库", en: "Searching the knowledge base" };
      default:
        return { zh: `调用 ${t.tool}`, en: `Calling ${t.tool}` };
    }
  })();
  return other ? `${m[lang]} (${lang === "zh" ? `org ${other}` : `in org ${other}`})` : m[lang];
}

/** Rows and milliseconds of an O2 search result, from what the run saw of it (the output may be cut). */
export function resultSummary(output: string): { count?: number; took?: number } | undefined {
  let count: number | undefined;
  let took: number | undefined;
  try {
    const v: unknown = JSON.parse(output);
    if (isObj(v)) {
      if (Array.isArray(v.hits)) count = v.hits.length;
      else if (typeof v.total === "number") count = v.total;
      if (typeof v.took === "number") took = v.took;
    }
  } catch {
    // Cut or not JSON: the leading fields are still there.
    const t = /"took"\s*:\s*(\d+)/.exec(output);
    const n = /"total"\s*:\s*(\d+)/.exec(output);
    if (t) took = Number(t[1]);
    if (n) count = Number(n[1]);
  }
  if (count === undefined && took === undefined) return undefined;
  return { ...(count !== undefined && { count }), ...(took !== undefined && { took }) };
}

const ERROR_MESSAGE_CHARS = 300;

/** The card line of a finished call. A failure shows the start of the error, redacted. */
export function resultMessage(ok: boolean, output: string, summary: { count?: number } | undefined, lang: AnswerLang): string {
  if (!ok) {
    const first = redact(output.trim()).text.replace(/\s+/g, " ");
    const text = first.length > ERROR_MESSAGE_CHARS ? `${first.slice(0, ERROR_MESSAGE_CHARS)}…` : first;
    return text || (lang === "zh" ? "调用失败" : "The call failed");
  }
  if (summary?.count !== undefined) return lang === "zh" ? `返回 ${summary.count} 行` : `Returned ${summary.count} rows`;
  return lang === "zh" ? "完成" : "Done";
}

/** The guard refused the call (pi reports it as `Not allowed: <reason>`), or the tool failed. */
export const resultErrorType = (output: string) => (output.startsWith("Not allowed:") ? "tool_denied" : "tool_error");

/** `load_query` for the panel: opens the SQL on the Logs or Traces page with its time range. */
export function navigation(args: SqlCallArgs, lang: AnswerLang): Extract<O2Event, { type: "navigation_action" }> | undefined {
  const type = args.stream_type;
  if (type !== "logs" && type !== "traces") return undefined;
  const q = args.request_body.query;
  const label: Lang<Record<"logs" | "traces", string>> = {
    zh: { logs: "在日志页打开查询", traces: "在 Traces 页打开查询" },
    en: { logs: "Open the query in Logs", traces: "Open the query in Traces" },
  };
  return {
    type: "navigation_action",
    resource_type: type,
    action: "load_query",
    label: label[lang][type],
    target: { query: q.sql, sql_mode: true, stream: args.stream_name.split(","), from: q.start_time, to: q.end_time },
  };
}

const TITLE_CHARS = 60;

/** Chat title for the first turn, from the question: written by code, so the first event goes out at once. */
export function title(question: string): string {
  const one = redact(question).text.replace(/\s+/g, " ").trim();
  return one.length > TITLE_CHARS ? `${one.slice(0, TITLE_CHARS - 1)}…` : one;
}

/**
 * The terminal `error` of a run that did not finish normally. Never says unauthorized / forbidden / not authorized /
 * permission denied: the panel would replace it with "you are not authorized".
 */
export function errorEvent(kind: "budget_exhausted" | "failed" | "interrupted", lang: AnswerLang, errorType?: string): Extract<O2Event, { type: "error" }> {
  const text: Lang<Record<typeof kind, { error: string; suggestion: string }>> = {
    zh: {
      budget_exhausted: { error: "排查在得出完整结论前用完了预算（步数、时长或上下文）。", suggestion: "缩小时间范围，或只问一个 namespace 或服务。" },
      failed: { error: "回答没有写完：模型调用中途失败。", suggestion: "请稍后重新提问。" },
      interrupted: { error: "排查被中断：服务正在更新。", suggestion: "请稍后重新提问。" },
    },
    en: {
      budget_exhausted: { error: "The investigation used up its budget (steps, time or context) before finishing.", suggestion: "Narrow the time range, or ask about one namespace or service." },
      failed: { error: "The answer was not finished: the model request failed midway.", suggestion: "Please ask again in a moment." },
      interrupted: { error: "The investigation was interrupted: the service is restarting.", suggestion: "Please ask again in a moment." },
    },
  };
  return { type: "error", ...text[lang][kind], error_type: errorType ?? kind };
}
