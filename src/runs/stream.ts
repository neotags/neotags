import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { isTransientError, mergeBody } from "../agent/llm.js";
import type { ChainStep } from "../agent/models.js";
import type { Effort } from "../config/index.js";

export interface ResilientStreamOptions {
  /** Abort and retry a request that sent nothing (no text, thinking or tool call) by then. */
  firstTokenMs: number;
  /** Abort a request whose output stalls this long between two events (llm.timeoutMs). */
  idleMs?: number;
  /** Retries of a transient failure (429, 5xx, timeout, first-token timeout) before any output. */
  maxRetries: number;
  /** llm.extraBody, then the effort's llm.models.<key>.effortBody, merged into every request body. */
  extraBody?: Record<string, unknown>;
  effortBody?: ChainStep["effortBody"];
  /** Effort of the current request, for effortBody; undefined adds none. Default: derived from the thinking level. */
  effort?: () => Effort | undefined;
  temperature?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** A failed attempt, retried or not. */
  onAttemptError?: (error: string, attempt: number, retrying: boolean) => void;
  /**
   * Called as each gateway request (attempt) starts; the returned function gets how it ended, timeouts included.
   * For tracing: one chat span per billed request. Must not throw.
   */
  onAttempt?: (attempt: number, context: Parameters<StreamFn>[1], options: SimpleStreamOptions | undefined) => ((final: AssistantMessage) => void) | undefined;
}

/** pi's thinking level back to the configured effort ("off" is "none"). */
export function effortOf(level: SimpleStreamOptions["reasoning"]): Effort {
  if (!level) return "none";
  return level === "minimal" ? "low" : level === "xhigh" ? "max" : level;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Wraps the agent's stream function: retries a request that failed transiently or sent no first token in time
 * (only while nothing has reached the agent yet, so a retry never duplicates output), and adds the request-body
 * fields the one-shot client adds (extraBody, effortBody, temperature).
 */
export function resilientStream(inner: StreamFn, o: ResilientStreamOptions): StreamFn {
  const sleep = o.sleep ?? defaultSleep;
  return (model, context, options) => {
    const out = createAssistantMessageEventStream();
    const userSignal = options?.signal;
    const effort = o.effort ? o.effort() : effortOf(options?.reasoning);
    const body = mergeBody(o.extraBody, effort === undefined ? undefined : o.effortBody?.[effort]);
    const userPayload = options?.onPayload;
    const onPayload =
      Object.keys(body).length > 0 || userPayload
        ? async (p: unknown, m: typeof model) => {
            const changed = (await userPayload?.(p, m)) ?? p;
            return Object.keys(body).length > 0 ? mergeBody(changed as Record<string, unknown>, body) : changed;
          }
        : undefined;

    void (async () => {
      for (let attempt = 0; ; attempt++) {
        const ac = new AbortController();
        const forward = () => ac.abort(userSignal?.reason);
        if (userSignal?.aborted) forward();
        else userSignal?.addEventListener("abort", forward, { once: true });
        let timedOut: "first" | "idle" | undefined;
        let timer = setTimeout(() => {
          timedOut = "first";
          ac.abort(new Error("first token timeout"));
        }, o.firstTokenMs);
        // After the first token, a stall between events aborts the request (no retry: output has gone out).
        const resetIdle = () => {
          if (!o.idleMs) return;
          clearTimeout(timer);
          timer = setTimeout(() => {
            timedOut = "idle";
            ac.abort(new Error("stream stalled"));
          }, o.idleMs);
        };
        let start: Extract<AssistantMessageEvent, { type: "start" }> | undefined;
        let forwarded = false;
        let final: AssistantMessage | undefined;
        const ended = o.onAttempt?.(attempt, context, options);
        try {
          const s = await inner(model, context, {
            ...options,
            signal: ac.signal,
            ...(o.temperature !== undefined && options?.temperature === undefined && { temperature: o.temperature }),
            ...(onPayload && { onPayload }),
          });
          for await (const ev of s) {
            if (ev.type === "start") {
              start = ev;
              continue;
            }
            if (ev.type === "done") final = ev.message;
            else if (ev.type === "error") final = ev.error;
            else {
              // Hold "start" back until real output: a retried attempt must look like one response to the agent.
              if (!forwarded) {
                forwarded = true;
                clearTimeout(timer);
                if (start) out.push(start);
              }
              resetIdle();
              out.push(ev);
              continue;
            }
            break;
          }
          final ??= await s.result();
        } catch (err) {
          // The stream contract forbids throwing; guard anyway so the agent always gets a final message.
          final = { ...(start?.partial ?? emptyMessage(model)), stopReason: "error", errorMessage: (err as Error).message };
        } finally {
          clearTimeout(timer);
          userSignal?.removeEventListener("abort", forward);
        }
        if (!final) final = { ...emptyMessage(model), errorMessage: "the stream ended without a message" };

        if (final.stopReason === "error" || final.stopReason === "aborted") {
          if (timedOut && !userSignal?.aborted) {
            const errorMessage =
              timedOut === "first" ? `no first token within ${o.firstTokenMs / 1000}s (timed out)` : `stream stalled for ${(o.idleMs ?? 0) / 1000}s (timed out)`;
            final = { ...final, stopReason: "error", errorMessage };
          }
          ended?.(final);
          const error = final.errorMessage ?? `LLM stopped: ${final.stopReason}`;
          const retry =
            !forwarded && !userSignal?.aborted && final.stopReason === "error" && attempt < o.maxRetries && (timedOut === "first" || isTransientError(error));
          o.onAttemptError?.(error, attempt, retry);
          if (retry) {
            await sleep(Math.min(500 * 2 ** attempt, 8000), userSignal);
            if (!userSignal?.aborted) continue;
            final = { ...final, stopReason: "aborted", errorMessage: "aborted" };
          }
          out.push({ type: "error", reason: final.stopReason === "aborted" ? "aborted" : "error", error: final });
          return;
        }
        ended?.(final);
        if (!forwarded && start) out.push(start);
        out.push({ type: "done", reason: final.stopReason as Extract<AssistantMessageEvent, { type: "done" }>["reason"], message: final });
        return;
      }
    })();
    return out;
  };
}

function emptyMessage(model: { api: string; provider: string; id: string }): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    timestamp: Date.now(),
  };
}
