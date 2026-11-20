import { EventEmitter } from "node:events";
import { SocketModeReceiver } from "@slack/bolt";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boltLogger, fatalSocketError, superviseSocket } from "../src/gateway/socket.js";

type Line = [string, Record<string, unknown>, string?];
function fakeLog() {
  const lines: Line[] = [];
  const at = (level: string) => (o: Record<string, unknown>, msg?: string) => void lines.push([level, o, msg]);
  const log = { info: at("info"), warn: at("warn"), error: at("error") } as unknown as Parameters<typeof superviseSocket>[0]["log"];
  return { log, lines, states: () => lines.filter((l) => l[2] === "slack socket").map((l) => [l[0], l[1].state]) };
}

const platformError = (error: string) => Object.assign(new Error(error), { code: "slack_webapi_platform_error", data: { ok: false, error } });

/** Stands in for @slack/socket-mode's client: each start() is answered by the next scripted outcome. */
class FakeClient extends EventEmitter {
  outcomes: Array<"ok" | "close" | Error> = [];
  starts = 0;
  disconnects = 0;
  async start() {
    this.starts++;
    const o = this.outcomes.shift() ?? "ok";
    if (o === "ok") {
      this.emit("connected");
      return;
    }
    // Like the real client: the socket closing before Slack's hello rejects start() without a reason.
    this.emit("disconnected");
    if (o === "close") throw undefined;
    throw o;
  }
  async disconnect() {
    this.disconnects++;
    this.emit("disconnected");
  }
}

describe("superviseSocket", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  const setup = (outcomes: FakeClient["outcomes"]) => {
    const client = new FakeClient();
    client.outcomes = outcomes;
    const { log, lines, states } = fakeLog();
    const onFatal = vi.fn();
    const s = superviseSocket({ client, log, first: () => client.start(), onFatal, baseDelayMs: 1_000, maxDelayMs: 4_000 });
    return { client, lines, states, onFatal, s };
  };

  it("retries a failed connect with capped backoff, without waiting on Slack to return", async () => {
    const { client, states, onFatal, s } = setup([new Error("ENOTFOUND"), "close", new Error("503"), new Error("503")]);
    s.start(); // returns at once: startup does not wait for Slack
    await vi.advanceTimersByTimeAsync(0);
    expect(client.starts).toBe(1);
    // Delays are 1s, 2s, 4s, 4s (cap) with jitter in [50%, 100%]; 30s covers them all.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.starts).toBe(5);
    expect(onFatal).not.toHaveBeenCalled();
    expect(states().filter(([, st]) => st === "reconnecting").every(([lvl]) => lvl === "warn")).toBe(true);
    expect(states().at(-1)).toEqual(["info", "connected"]);
  });

  it("caps the delay", async () => {
    const { client, lines, s } = setup(Array.from({ length: 6 }, () => new Error("down")));
    s.start();
    await vi.advanceTimersByTimeAsync(120_000);
    const delays = lines.filter((l) => l[1].state === "reconnecting").map((l) => l[1].inMs as number);
    expect(delays).toHaveLength(6);
    expect(Math.max(...delays)).toBeLessThanOrEqual(4_000);
    expect(client.starts).toBe(7);
  });

  it("stops and reports a refused token instead of retrying it", async () => {
    const { client, onFatal, lines, s } = setup([platformError("invalid_auth")]);
    s.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.starts).toBe(1);
    expect(onFatal).toHaveBeenCalledOnce();
    expect(lines.some((l) => l[0] === "error" && l[1].code === "invalid_auth")).toBe(true);
  });

  it("reconnects when Slack drops the socket, and a refused token then is fatal, not an unhandled rejection", async () => {
    const { client, onFatal, s } = setup(["ok", platformError("token_revoked")]);
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    client.emit("disconnected");
    await vi.advanceTimersByTimeAsync(0);
    expect(client.starts).toBe(2);
    expect(onFatal).toHaveBeenCalledOnce();
  });

  it("logs Slack's routine refresh as info and other disconnects as warnings", async () => {
    const { client, states, s } = setup(["ok", "ok", "ok"]);
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    client.emit("ws_message", JSON.stringify({ type: "disconnect", reason: "refresh_requested" }), false);
    client.emit("disconnected");
    await vi.advanceTimersByTimeAsync(0);
    client.emit("disconnected");
    await vi.advanceTimersByTimeAsync(0);
    expect(states().filter(([, st]) => st === "disconnected")).toEqual([
      ["info", "disconnected"],
      ["warn", "disconnected"],
    ]);
    expect(client.starts).toBe(3);
  });

  it("does not reconnect after stop", async () => {
    const { client, s } = setup([new Error("down")]);
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    s.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.starts).toBe(1);
  });

  it("closes a connection that completes after stop", async () => {
    const client = new FakeClient();
    let finish!: () => void;
    const { log } = fakeLog();
    const s = superviseSocket({
      client,
      log,
      first: () => new Promise<void>((r) => (finish = () => (client.emit("connected"), r()))),
      onFatal: () => {},
    });
    s.start();
    s.stop();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.disconnects).toBe(1);
  });
});

describe("fatalSocketError", () => {
  it("matches only token errors that a retry cannot fix", () => {
    expect(fatalSocketError(platformError("invalid_auth"))).toBe("invalid_auth");
    expect(fatalSocketError(platformError("missing_scope"))).toBe("missing_scope");
    expect(fatalSocketError(platformError("ratelimited"))).toBeUndefined();
    expect(fatalSocketError(new Error("invalid_auth"))).toBeUndefined();
    expect(fatalSocketError(undefined)).toBeUndefined();
  });

  it("recognizes what the real Socket Mode client throws for a refused token", async () => {
    const receiver = new SocketModeReceiver({
      appToken: "xapp-test",
      logger: boltLogger(pino({ level: "silent" })),
      autoReconnectEnabled: false,
      installerOptions: {
        clientOptions: {
          retryConfig: { retries: 0 },
          fetch: async () => Response.json({ ok: false, error: "invalid_auth" }),
        },
      },
    });
    const err = await receiver.client.start().catch((e: unknown) => e);
    expect(fatalSocketError(err)).toBe("invalid_auth");
  });
});

describe("boltLogger", () => {
  it("writes Bolt's lines as pino JSON and drops its debug lines (they carry Slack payloads)", () => {
    const out: Array<Record<string, unknown>> = [];
    const log = pino({ level: "debug" }, { write: (s: string) => void out.push(JSON.parse(s)) });
    const b = boltLogger(log);
    b.debug("Received a message on the WebSocket: {secret}");
    b.warn("http request failed", "ECONNRESET");
    b.error("boom", new Error("x"));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ level: 40, component: "bolt", msg: "http request failed ECONNRESET" });
    expect(out[1]).toMatchObject({ level: 50, msg: "boom", err: { message: "x" } });
  });
});
