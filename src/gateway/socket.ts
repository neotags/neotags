import { format } from "node:util";
import { LogLevel, type AppOptions } from "@slack/bolt";
import type { Logger } from "pino";

type BoltLogger = NonNullable<AppOptions["logger"]>;

/**
 * Bolt and its Slack clients log through this, so their lines are pino JSON next to ours, not console text. Their
 * debug lines carry whole event payloads (Slack content), so they are dropped even at logLevel debug.
 */
export function boltLogger(log: Logger): BoltLogger {
  const write = (level: "info" | "warn" | "error") => (...msg: unknown[]) => {
    const err = msg.find((m) => m instanceof Error);
    const text = format(...msg.filter((m) => m !== err));
    if (err) log[level]({ err, component: "bolt" }, text);
    else log[level]({ component: "bolt" }, text);
  };
  return {
    debug: () => {},
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    setLevel: () => {},
    getLevel: () => (log.isLevelEnabled("info") ? LogLevel.INFO : log.isLevelEnabled("warn") ? LogLevel.WARN : LogLevel.ERROR),
    setName: () => {},
  };
}

// apps.connections.open errors that no retry can fix: the app token is wrong, revoked or lacks connections:write.
const FATAL = new Set([
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "user_removed_from_team",
  "team_disabled",
  "not_allowed_token_type",
  "missing_scope",
]);

/** The Slack error code when `err` says the app token will never work, else undefined. */
export function fatalSocketError(err: unknown): string | undefined {
  const e = err as { code?: string; data?: { error?: string } } | undefined;
  const code = e?.code === "slack_webapi_platform_error" ? e.data?.error : undefined;
  return code && FATAL.has(code) ? code : undefined;
}

/** What the supervisor uses of @slack/socket-mode's client (a fake in tests). */
export interface SocketClient {
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
  on(event: string, fn: (...args: any[]) => void): unknown;
}

export interface SocketSupervisorOptions {
  client: SocketClient;
  log: Logger;
  /** The first attempt: also starts the receiver's /healthz server, which must listen only once. */
  first: () => Promise<unknown>;
  /** The token is refused for good: retrying cannot help, so the caller stops the process. */
  onFatal: (err: unknown) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Keeps the Socket Mode connection up. The client's own reconnect is off: it waits on a reconnect promise nobody
 * handles, so a refused token after startup became an unhandled rejection that ended the process mid-drain. Here
 * every attempt settles in one place: a refused token goes to onFatal, anything else retries with capped backoff.
 * /healthz stays green while this retries (a restart is no better), so these log lines are the signal.
 */
export function superviseSocket(o: SocketSupervisorOptions) {
  const { client, log } = o;
  const baseMs = o.baseDelayMs ?? 1_000;
  const maxMs = o.maxDelayMs ?? 60_000;
  let connected = false;
  let stopped = false;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  // Why Slack last asked us to go: "refresh_requested" every few hours is routine, "link_disabled" means Socket Mode
  // was turned off for the app.
  let reason: string | undefined;

  client.on("connected", () => {
    if (stopped) {
      // An attempt that was already under way when stop() ran.
      void client.disconnect();
      return;
    }
    connected = true;
    failures = 0;
    log.info({ state: "connected" }, "slack socket");
  });
  client.on("ws_message", (data: string | ArrayBuffer, isBinary: boolean) => {
    if (isBinary) return;
    try {
      const m = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as { type?: string; reason?: string };
      if (m.type === "disconnect") reason = m.reason;
    } catch {
      // the client logs unparsable frames itself
    }
  });
  client.on("disconnected", () => {
    // A failed attempt also ends here; its rejected start() schedules the retry.
    if (!connected) return;
    connected = false;
    if (stopped) return;
    const r = reason;
    reason = undefined;
    if (r === "refresh_requested" || r === "warning") log.info({ state: "disconnected", reason: r }, "slack socket");
    else log.warn({ state: "disconnected", reason: r }, "slack socket");
    schedule(0);
  });

  const attempt = (start: () => Promise<unknown>) => {
    timer = undefined;
    if (stopped) return;
    log.info({ state: "connecting", attempt: failures + 1 }, "slack socket");
    start().catch((err: unknown) => {
      if (stopped) return;
      const code = fatalSocketError(err);
      if (code) {
        log.error({ err, code }, "slack refused the app token; stopping");
        o.onFatal(err);
        return;
      }
      failures++;
      // Jitter so replicas (or restarts) do not reconnect in step.
      const delay = Math.round(Math.min(maxMs, baseMs * 2 ** (failures - 1)) * (0.5 + Math.random() / 2));
      // start() rejects without a reason when the socket closes before Slack's hello.
      log.warn({ state: "reconnecting", attempt: failures, inMs: delay, err: err ?? "closed before hello" }, "slack socket");
      schedule(delay);
    });
  };
  const schedule = (ms: number) => {
    if (stopped || timer) return;
    timer = setTimeout(() => attempt(() => client.start()), ms);
  };

  return {
    start() {
      if (!stopped) attempt(o.first);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
