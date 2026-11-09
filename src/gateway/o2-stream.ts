import type { ServerResponse } from "node:http";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { Logger } from "pino";
import { LIST_ALERTS, LIST_DASHBOARDS, type ListedAlert, type ListedData, type ListedDashboard } from "../guardrails/tools.js";
import type { AnswerLang } from "../lang.js";
import type { RunHandle, RunObserver, RunResult } from "../runs/index.js";
import {
  alertsNavigation,
  callMessage,
  cardContext,
  dashboardNavigation,
  errorEvent,
  frame,
  navigation,
  panelTool,
  PING,
  resultErrorType,
  resultMessage,
  resultSummary,
  SEARCH_SQL,
  sqlCallArgs,
  title,
  type AlertsPage,
  type O2Event,
  type SqlCallArgs,
} from "./o2-events.js";

/** Unsent output a stream may hold before the client counts as gone. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** The tool through which the model asks to open a query on the user's page. */
export const NAVIGATE_TOOL = "open_query_in_o2";
/** The tool through which the model asks to open a dashboard it listed. */
export const DASHBOARD_TOOL = "open_dashboard_in_o2";
/** The tool through which the model asks to open an alerts page, or an alert it listed. */
export const ALERTS_TOOL = "open_alerts_in_o2";
const HIDDEN_TOOLS = new Set([NAVIGATE_TOOL, DASHBOARD_TOOL, ALERTS_TOOL]);

type Openable = ListedDashboard & { folder_id: string };
type OpenableAlert = ListedAlert & { folder_id: string };
/** Where the user's page goes when the answer is done: one place per turn, the last asked for. */
type PendingNav = { kind: "query"; sql: SqlCallArgs } | { kind: "dashboard"; dashboard: Openable } | { kind: "alerts"; page: AlertsPage };

export interface O2TurnOptions {
  res: ServerResponse;
  question: string;
  lang: AnswerLang;
  /** No earlier turns: the panel gets a title. */
  firstTurn: boolean;
  /** The user's org (context.org_id) and the MCP server that queries it; only its queries become buttons and navigation. */
  org?: string;
  currentServer?: string;
  /** For `complete` when tracing is off: the caller's trace id, else a random one. */
  fallbackTraceId: string;
  log: Pick<Logger, "warn" | "info">;
  /** Keepalive while nothing else is sent (contract: every 15 s). */
  pingMs?: number;
}

/**
 * One chat turn on the wire: the run's progress as the panel's SSE events. Opens with a title or a ping (first
 * bytes at once), pings while idle, writes exactly one terminal event and closes. A closed connection cancels the run.
 */
export class O2Turn {
  private ended = false;
  private pingTimer: NodeJS.Timeout | undefined;
  private textSent = false;
  private toolSinceText = false;
  /** Panel names of calls in flight, by call id; hidden calls (navigation) are not here. */
  private calls = new Map<string, { tool: string; server?: string; args: unknown }>();
  /** The last SearchSQL that succeeded against the current org: what navigation may open. */
  private lastSql: SqlCallArgs | undefined;
  /** Dashboards a ListDashboards against the current org returned in this turn, by id: what navigation may open. */
  private dashboards = new Map<string, Openable>();
  /** Alerts a ListAlerts against the current org returned in this turn, by id. */
  private alerts = new Map<string, OpenableAlert>();
  private pendingNav: PendingNav | undefined;
  private handle: RunHandle | undefined;

  constructor(private o: O2TurnOptions) {}

  /** Status line and headers, then the first event. Call once the run was accepted. */
  open(handle: RunHandle): void {
    this.handle = handle;
    const { res } = this.o;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    res.on("close", () => {
      if (this.ended) return;
      this.ended = true;
      this.stopPing();
      // The panel's Stop button aborts the request: a closed connection is a cancel.
      if (handle.cancel("client disconnected")) this.o.log.info({ runId: handle.id, session: handle.sessionId }, "o2 client disconnected; run cancelled");
    });
    if (this.o.firstTurn) this.send({ type: "title", title: title(this.o.question) });
    else this.write(PING);
  }

  readonly observer: RunObserver = {
    toolStart: (call) => {
      if (HIDDEN_TOOLS.has(call.name)) return;
      const t = panelTool(call.name, call.args);
      this.calls.set(call.id, { tool: t.tool, ...(t.server && { server: t.server }), args: call.args });
      this.toolSinceText = true;
      this.send({ type: "tool_call", tool: t.tool, call_id: call.id, message: callMessage(t, this.o.lang, this.otherOrg(t.server)), context: cardContext(t) });
    },
    toolEnd: (call) => {
      const started = this.calls.get(call.id);
      if (!started) return;
      this.calls.delete(call.id);
      const ok = !call.isError;
      const listed = ok ? (call.data as ListedData | undefined) : undefined;
      const dashboards = started.tool === LIST_DASHBOARDS && Array.isArray(listed?.dashboards) ? listed.dashboards : undefined;
      const alerts = started.tool === LIST_ALERTS && Array.isArray(listed?.alerts) ? listed.alerts : undefined;
      const count = (dashboards ?? alerts)?.length;
      const summary = count !== undefined ? { count } : ok ? resultSummary(call.output) : undefined;
      // Only the user's org: the panel opens what it navigates to there. Without a folder the page cannot check access.
      if (this.isCurrent(started.server)) {
        for (const d of dashboards ?? []) if (d.folder_id) this.dashboards.set(d.dashboard_id, d as Openable);
        for (const a of alerts ?? []) if (a.folder_id) this.alerts.set(a.alert_id, a as OpenableAlert);
      }
      // What ran (the tool guard's defaults filled in), not what the model asked for: the button must reproduce it.
      const ran = panelTool(call.name, call.args ?? started.args);
      const evidence = ok && started.tool === SEARCH_SQL && this.isCurrent(started.server) ? sqlCallArgs(ran.args) : undefined;
      if (evidence) this.lastSql = evidence;
      this.send({
        type: "tool_result",
        tool: started.tool,
        call_id: call.id,
        success: ok,
        message: resultMessage(ok, call.output, summary, this.o.lang, started.tool),
        ...(summary && { summary }),
        ...(evidence && { call_args: evidence }),
        ...(!ok && { error_type: resultErrorType(call.output) }),
      });
    },
    delta: (text) => this.text(text),
    done: (result) => this.finish(result),
  };

  /** This turn's navigation tool: queues opening the last current-org SearchSQL, sent right before `complete`. */
  navigationTool(): AgentTool<any> {
    const params = obj({});
    return {
      name: NAVIGATE_TOOL,
      label: "Open the query in O2",
      description: [
        "Open the last SearchSQL that succeeded against the user's current org on their Logs or Traces page, when your",
        "answer is done. This switches the user's page: call it only when the user asked to open, show or run a query,",
        "once, after that query's result came back. Not for PromQL or another org's queries: give those as a link. It",
        "replaces a dashboard or alerts page opened before.",
      ].join(" "),
      parameters: params,
      execute: async () => {
        if (!this.o.currentServer) throw new Error(`no data source is configured for the current org${this.o.org ? ` ${this.o.org}` : ""}; give the query as a link instead`);
        const sql = this.lastSql;
        if (!sql) throw new Error(`no SearchSQL has succeeded against the current org (${this.o.currentServer}__ tools) in this answer yet; run it first`);
        if (sql.stream_type !== "logs" && sql.stream_type !== "traces") throw new Error(`a ${sql.stream_type} stream cannot be opened; give the query as a link instead`);
        this.pendingNav = { kind: "query", sql };
        return { content: [{ type: "text", text: `When your answer is done, the user's page opens this query:\n${sql.request_body.query.sql}` }], details: undefined };
      },
    };
  }

  /** This turn's dashboard tool: queues opening a dashboard listed from the current org, sent right before `complete`. */
  dashboardTool(): AgentTool<any> {
    const params = obj({ dashboard_id: str({ description: "dashboard_id of the dashboard, as ListDashboards returned it" }) });
    return {
      name: DASHBOARD_TOOL,
      label: "Open a dashboard in O2",
      description: [
        "Open a dashboard of the user's current org on their page, when your answer is done. Only a dashboard_id that a",
        "ListDashboards against the current org returned in this answer: list first (filter by title). This switches the",
        "user's page: call it only when the user asked to open or go to a dashboard and exactly one dashboard is meant,",
        "once. It replaces a query or alerts page opened before. For another org's dashboard give a link instead.",
      ].join(" "),
      parameters: params,
      execute: async (_id: string, args: { dashboard_id?: unknown }) => {
        if (!this.o.currentServer) throw new Error(`no data source is configured for the current org${this.o.org ? ` ${this.o.org}` : ""}; give the dashboard as a link instead`);
        const id = typeof args?.dashboard_id === "string" ? args.dashboard_id : "";
        const d = this.dashboards.get(id);
        if (!d) {
          throw new Error(
            this.dashboards.size === 0
              ? `no ListDashboards has succeeded against the current org (${this.o.currentServer}__tools_call) in this answer yet; list the dashboards first`
              : `dashboard_id ${JSON.stringify(id)} is not one ListDashboards returned for the current org in this answer`,
          );
        }
        this.pendingNav = { kind: "dashboard", dashboard: d };
        return { content: [{ type: "text", text: `When your answer is done, the user's page opens the dashboard ${JSON.stringify(d.title)} (folder ${d.folder_name ?? d.folder_id}).` }], details: undefined };
      },
    };
  }

  /** This turn's alerts tool: queues opening the alerts list, the alert history, or an alert listed from the current org. */
  alertsTool(): AgentTool<any> {
    const params = obj({
      page: str({ description: 'Which page: "list" (all alerts), "history" (alert firings over time) or "alert" (one alert\'s status page)' }),
      alert_id: opt(str({ description: 'For page "alert": alert_id of the alert, as ListAlerts returned it' })),
    });
    return {
      name: ALERTS_TOOL,
      label: "Open an alerts page in O2",
      description: [
        "Open an alerts page of the user's current org on their page, when your answer is done: the alerts list, the",
        "alert history, or one alert's status page (its state and history; read-only). For one alert only an alert_id",
        "that a ListAlerts against the current org returned in this answer: list first (filter by alert_name_substring).",
        "This switches the user's page: call it only when the user asked to open or go to an alerts page, once. It",
        "replaces a query or dashboard opened before. For another org's alert give a link instead.",
      ].join(" "),
      parameters: params,
      execute: async (_id: string, args: { page?: unknown; alert_id?: unknown }) => {
        if (!this.o.currentServer) throw new Error(`no data source is configured for the current org${this.o.org ? ` ${this.o.org}` : ""}; give the page as a link instead`);
        let page: AlertsPage;
        if (args?.page === "list" || args?.page === "history") page = { page: args.page };
        else if (args?.page === "alert") {
          const id = typeof args.alert_id === "string" ? args.alert_id : "";
          const a = this.alerts.get(id);
          if (!a) {
            throw new Error(
              this.alerts.size === 0
                ? `no ListAlerts has succeeded against the current org (${this.o.currentServer}__tools_call) in this answer yet; list the alerts first`
                : `alert_id ${JSON.stringify(id)} is not one ListAlerts returned for the current org in this answer`,
            );
          }
          page = { page: "alert", alert: a };
        } else throw new Error(`page must be "list", "history" or "alert", not ${JSON.stringify(args?.page ?? null)}`);
        this.pendingNav = { kind: "alerts", page };
        const what = page.page === "alert" ? `the status page of the alert ${JSON.stringify(page.alert.name)}` : page.page === "list" ? "the alerts list" : "the alert history";
        return { content: [{ type: "text", text: `When your answer is done, the user's page opens ${what}.` }], details: undefined };
      },
    };
  }

  private isCurrent(server: string | undefined): boolean {
    return server !== undefined && server === this.o.currentServer;
  }

  /** The org a call queries when it is not the user's, for the card; undefined for the current org and non-O2 tools. */
  private otherOrg(server: string | undefined): string | undefined {
    return server !== undefined && this.o.currentServer !== undefined && server !== this.o.currentServer ? server : undefined;
  }

  private text(text: string): void {
    if (!text) return;
    // A text block after a tool card starts a new paragraph in the joined message the panel replays as history.
    const content = this.textSent && this.toolSinceText ? `\n\n${text}` : text;
    this.textSent = true;
    this.toolSinceText = false;
    this.send({ type: "message_delta", content });
  }

  private finish(r: RunResult): void {
    if (this.ended) return;
    const lang = this.o.lang;
    switch (r.state) {
      case "done":
        if (!this.textSent) this.text(r.answer);
        if (this.pendingNav?.kind === "query") {
          const nav = navigation(this.pendingNav.sql, lang);
          if (nav) this.send(nav);
        } else if (this.pendingNav?.kind === "dashboard") this.send(dashboardNavigation(this.pendingNav.dashboard, lang));
        else if (this.pendingNav?.kind === "alerts") this.send(alertsNavigation(this.pendingNav.page, lang));
        return this.end({ type: "complete", trace_id: r.traceId ?? this.o.fallbackTraceId });
      case "budget_exhausted":
        if (!this.textSent) this.text(r.answer);
        return this.end(errorEvent("budget_exhausted", lang));
      case "failed":
        // The degraded answer is a normal reply (the context package written by code); a half-written one is an
        // error, also when the run was degraded after part of the answer went out (the abort backstop).
        if (r.degraded && !this.textSent) {
          this.text(r.answer);
          return this.end({ type: "complete", trace_id: r.traceId ?? this.o.fallbackTraceId });
        }
        if (!this.textSent) this.text(r.answer);
        return this.end(errorEvent(r.errorType === "deadline" ? "deadline" : "failed", lang, r.errorType));
      case "cancelled":
        if (r.errorType === "interrupted") return this.end(errorEvent("interrupted", lang));
        return this.end({ type: "cancelled" });
    }
  }

  private send(e: O2Event): void {
    this.write(frame(e));
  }

  private write(chunk: string): void {
    const { res } = this.o;
    if (this.ended || res.writableEnded || res.destroyed) return;
    res.write(chunk);
    // A reader that stopped reading would make the buffer grow for the rest of the run: give up on it.
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      this.ended = true;
      this.stopPing();
      this.o.log.warn({ runId: this.handle?.id, buffered: res.writableLength }, "o2 client is not reading; run cancelled");
      this.handle?.cancel("client not reading");
      res.destroy();
      return;
    }
    this.armPing();
  }

  private armPing(): void {
    this.stopPing();
    this.pingTimer = setTimeout(() => this.write(PING), this.o.pingMs ?? 15_000);
    this.pingTimer.unref();
  }

  private stopPing(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = undefined;
  }

  private end(last: O2Event): void {
    this.send(last);
    this.ended = true;
    this.stopPing();
    this.o.res.end();
  }
}

