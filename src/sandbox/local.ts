import { request } from "node:http";
import { isObj } from "../guardrails/tools.js";
import type { SandboxSpec } from "../tools/skillpacks.js";
import { SandboxError, type ExecEntry, type ExecResult, type Sandbox } from "./types.js";

export interface LocalSandboxOptions {
  /** The executor sidecar's unix socket, shared through an emptyDir in the Pod. */
  socketPath: string;
  /** Wait for the answer this much longer than the command's `timeoutSec`: the executor kills it at `timeoutSec`. */
  graceMs?: number;
  /** Wait when the declaration sets no `timeoutSec`: the executor's highest timeout by default. */
  defaultTimeoutSec?: number;
  /** Largest response body; the executor caps stdout and stderr at 1 MiB each by default. */
  maxResponseBytes?: number;
}

/** Errors that mean nothing is listening (or allowed to connect) on the socket. */
const DOWN = new Set(["ENOENT", "ECONNREFUSED", "EACCES", "ECONNRESET", "EPIPE", "ENOTSOCK"]);

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

  constructor(private o: LocalSandboxOptions) {
    this.graceMs = o.graceMs ?? 15_000;
    this.defaultTimeoutSec = o.defaultTimeoutSec ?? 300;
    this.maxResponseBytes = o.maxResponseBytes ?? 8 * 1024 * 1024;
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
    const res = await this.call("POST", "/v1/exec", body, waitMs, signal);
    if (res.status === 200 && isResult(res.body)) return res.body;
    throw this.failure(res.status, res.body);
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
    if (status === 200) return new SandboxError("refused", "invalid_response", "the executor's answer is not an execution result");
    if (body === undefined) return new SandboxError("refused", code, `the executor answered HTTP ${status} without JSON`);
    return new SandboxError("refused", code, message);
  }

  private call(method: string, path: string, body: unknown, waitMs: number, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const aborted = () => new SandboxError("refused", "aborted", "the execution was cancelled");
      // The first outcome wins; later errors from tearing the request down are ignored.
      let settled = false;
      let deadline: NodeJS.Timeout | undefined;
      const done = (err: SandboxError | undefined, value?: { status: number; body: unknown }) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (err) reject(err);
        else resolve(value!);
      };
      const unavailable = (detail: string) =>
        done(signal?.aborted ? aborted() : new SandboxError("unavailable", "executor_unreachable", `the execution sandbox is unavailable: ${detail}`));
      if (signal?.aborted) return reject(aborted());
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
          res.on("error", (e) => unavailable(e.message));
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
        unavailable(`no answer from the executor within ${Math.round(waitMs / 1000)}s`);
        req.destroy();
      }, waitMs);
      req.on("error", (e: NodeJS.ErrnoException) => unavailable(DOWN.has(e.code ?? "") ? `${e.code} on ${this.o.socketPath}` : e.message));
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

function isResult(v: unknown): v is ExecResult {
  return isObj(v) && typeof v.exitCode === "number" && typeof v.stdout === "string" && typeof v.stderr === "string";
}
