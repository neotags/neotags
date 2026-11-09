import { request } from "node:http";
import { isObj } from "../guardrails/tools.js";
import type { SandboxSpec } from "../tools/skillpacks.js";
import { Slots } from "./slots.js";
import { SandboxError, type ExecEntry, type ExecResult, type Sandbox, type SlotWait } from "./types.js";

export interface LocalSandboxOptions {
  /** The executor sidecar's unix socket, shared through an emptyDir in the Pod. */
  socketPath: string;
  /** Wait for the answer this much longer than the command's `timeoutSec`: the executor kills it at `timeoutSec`. */
  graceMs?: number;
  /** Wait when the declaration sets no `timeoutSec`: the executor's highest timeout by default. */
  defaultTimeoutSec?: number;
  /** Largest response body; the executor caps stdout and stderr at 1 MiB each by default. */
  maxResponseBytes?: number;
  /** Calls in flight at once: the executor's EXECUTOR_MAX_CONCURRENCY. More wait here, in arrival order. */
  maxConcurrency?: number;
  /**
   * Longest wait for a slot, in this queue and retrying the executor's `429 busy`. Counted apart from the command's
   * own deadline, which starts when the request is sent: a long wait must not leave the command less time.
   */
  queueTimeoutMs?: number;
  /** First backoff after `429 busy`; doubles up to {@link BUSY_BACKOFF_MAX_MS}, with jitter. */
  busyBackoffMs?: number;
}

const BUSY_BACKOFF_MAX_MS = 2000;

/** Errors that mean nothing is listening (or allowed to connect) on the socket. */
const DOWN = new Set(["ENOENT", "ECONNREFUSED", "EACCES", "ECONNRESET", "EPIPE", "ENOTSOCK"]);
/** Of those, the ones that mean the connection never opened. */
const DOWN_BEFORE_SEND = new Set(["ENOENT", "ECONNREFUSED", "EACCES", "ENOTSOCK"]);

/**
 * Backend `local`: the executor sidecar in the same Pod, over HTTP on a unix socket (executor/README.md). This
 * process never runs a command itself, so when the executor is down, misconfigured or failed its self-check,
 * the execution fails with `unavailable`; there is no other path that could run it.
 */
export class LocalSandbox implements Sandbox {
  readonly backend = "local";
  private graceMs: number;
  private defaultTimeoutSec: number;
  private maxResponseBytes: number;
  private queueTimeoutMs: number;
  private busyBackoffMs: number;
  private slots: Slots;

  constructor(private o: LocalSandboxOptions) {
    this.graceMs = o.graceMs ?? 15_000;
    this.defaultTimeoutSec = o.defaultTimeoutSec ?? 300;
    this.maxResponseBytes = o.maxResponseBytes ?? 8 * 1024 * 1024;
    this.queueTimeoutMs = o.queueTimeoutMs ?? 30_000;
    this.busyBackoffMs = o.busyBackoffMs ?? 250;
    this.slots = new Slots(o.maxConcurrency ?? 4);
  }

  async exec(entry: ExecEntry & { id: string }, constraints: SandboxSpec, signal?: AbortSignal): Promise<ExecResult> {
    const body = {
      id: entry.id,
      argv: entry.argv,
      ...(entry.env && { env: entry.env }),
      ...(entry.stdin !== undefined && { stdin: entry.stdin }),
      ...(entry.files && { files: entry.files }),
      constraints,
    };
    const waitMs = (constraints.limits?.timeoutSec ?? this.defaultTimeoutSec) * 1000 + this.graceMs;
    const started = Date.now();
    const until = started + this.queueTimeoutMs;
    const wait: SlotWait = { queueMs: 0, busyRetries: 0 };
    // Nothing is sent before a slot is held, so any failure on the way is "did not run", never "unknown".
    const notRun = (code: string, message: string) => {
      wait.queueMs = Date.now() - started;
      return Object.assign(new SandboxError("refused", code, `${message}; the command did not run`), { wait });
    };
    try {
      await this.slots.acquire(this.queueTimeoutMs, signal);
    } catch (why) {
      if (why === "aborted") throw notRun("aborted", "the execution was cancelled while waiting for a free slot");
      throw notRun("busy", `no free execution slot within ${Math.round(this.queueTimeoutMs / 1000)}s`);
    }
    try {
      for (let backoff = this.busyBackoffMs; ; backoff = Math.min(backoff * 2, BUSY_BACKOFF_MAX_MS)) {
        wait.queueMs = Date.now() - started;
        let res: { status: number; body: unknown };
        try {
          res = await this.call("POST", "/v1/exec", body, waitMs, signal);
        } catch (err) {
          if (err instanceof SandboxError) err.wait = wait;
          throw err;
        }
        if (res.status === 200 && isResult(res.body)) return { ...res.body, wait };
        const failure = this.failure(res.status, res.body);
        // The executor refuses before it runs anything when it has no slot (its own limit, resident workers): safe
        // to send again until the wait runs out.
        if (failure.code !== "busy") throw Object.assign(failure, { wait });
        const delay = backoff / 2 + Math.random() * (backoff / 2);
        if (Date.now() + delay > until) throw notRun("busy", `the executor stayed at its concurrency limit for ${Math.round(this.queueTimeoutMs / 1000)}s`);
        if (!(await sleep(delay, signal))) throw notRun("aborted", "the execution was cancelled while waiting for a free slot");
        wait.busyRetries++;
      }
    } finally {
      this.slots.release();
    }
  }

  /** The executor's `/healthz`: whether per-call execution is available, and why not. */
  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const res = await this.call("GET", "/healthz", undefined, 5000, signal);
    if (res.status === 200 && isObj(res.body)) return res.body;
    throw this.failure(res.status, res.body);
  }

  private failure(status: number, body: unknown): SandboxError {
    const err = isObj(body) && isObj(body.error) ? body.error : {};
    const code = typeof err.code === "string" ? err.code : `http_${status}`;
    const message = typeof err.message === "string" ? err.message : `the executor answered HTTP ${status}`;
    // 503 is the self-check refusing every execution (sandbox_unavailable); 502 and 504 cannot have run anything.
    if (status === 502 || status === 503 || status === 504) return new SandboxError("unavailable", code, `the execution sandbox is unavailable: ${message}`);
    // A broken result, or the executor failing on the request, can come after the command ran.
    if (status === 200) return new SandboxError("unknown", "invalid_response", "the executor's answer is not an execution result; the command may have run");
    if (status >= 500) return new SandboxError("unknown", code, `the executor failed (HTTP ${status}); the command may have run`);
    if (body === undefined) return new SandboxError("refused", code, `the executor answered HTTP ${status} without JSON`);
    return new SandboxError("refused", code, message);
  }

  private call(method: string, path: string, body: unknown, waitMs: number, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      // Once the request is out, the executor may be running the command: no answer means the outcome is unknown,
      // not that the sandbox is down, so a caller must not treat it as "did not run".
      const lost = (detail: string) => new SandboxError("unknown", signal?.aborted ? "aborted" : "no_answer", `${detail}; the command may have run`);
      const aborted = () => lost("the execution was cancelled");
      // The first outcome wins; later errors from tearing the request down are ignored.
      let settled = false;
      let sent = false;
      let deadline: NodeJS.Timeout | undefined;
      const done = (err: SandboxError | undefined, value?: { status: number; body: unknown }) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (err) reject(err);
        else resolve(value!);
      };
      const unavailable = (detail: string) => done(new SandboxError("unavailable", "executor_unreachable", `the execution sandbox is unavailable: ${detail}`));
      if (signal?.aborted) return reject(new SandboxError("refused", "aborted", "the execution was cancelled before it was sent"));
      const req = request(
        {
          socketPath: this.o.socketPath,
          method,
          path,
          headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
          signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > this.maxResponseBytes) {
              done(new SandboxError("refused", "response_too_large", `the executor's answer is over ${this.maxResponseBytes} bytes`));
              req.destroy();
              return;
            }
            chunks.push(c);
          });
          res.on("error", (e) => done(signal?.aborted ? aborted() : lost(`the executor's answer broke off (${e.message})`)));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            let parsed: unknown;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              // Not JSON: the status still says what happened (a 503 without a body is still unavailable).
              parsed = undefined;
            }
            done(undefined, { status, body: parsed });
          });
        },
      );
      // A deadline for the whole call: an idle timeout would be reset by every byte of a slow answer.
      deadline = setTimeout(() => {
        done(lost(`no answer from the executor within ${Math.round(waitMs / 1000)}s`));
        req.destroy();
      }, waitMs);
      // A connection that never opened (no socket, refused) cannot have run anything; one that broke after the
      // request was written may have.
      req.on("error", (e: NodeJS.ErrnoException) => {
        if (signal?.aborted) return done(sent ? aborted() : new SandboxError("refused", "aborted", "the execution was cancelled before it was sent"));
        if (sent && !DOWN_BEFORE_SEND.has(e.code ?? "")) return done(lost(`the connection to the executor broke (${e.code ?? e.message})`));
        unavailable(DOWN.has(e.code ?? "") ? `${e.code} on ${this.o.socketPath}` : e.message);
      });
      req.on("finish", () => (sent = true));
      req.end(payload);
    });
  }
}

/** Backend `none`: no executor is deployed, so every execution is refused. */
export class DisabledSandbox implements Sandbox {
  readonly backend = "none";

  async exec(): Promise<ExecResult> {
    throw new SandboxError("denied", "execution_disabled", "command execution is disabled (sandbox.backend is none)");
  }
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isResult(v: unknown): v is ExecResult {
  if (!isObj(v) || typeof v.exitCode !== "number" || typeof v.stdout !== "string" || typeof v.stderr !== "string") return false;
  if (v.egress === undefined) return true;
  return (
    Array.isArray(v.egress) &&
    v.egress.every((e) => isObj(e) && typeof e.host === "string" && (e.injected === undefined || (Array.isArray(e.injected) && e.injected.every((n) => typeof n === "string"))))
  );
}
