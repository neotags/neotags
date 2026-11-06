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
  /** Retries of a transient failure (429, 5xx, timeout, first-token timeout) before any output. */
  maxRetries: number;
  /** llm.extraBody, then the effort's llm.models.<key>.effortBody, merged into every request body. */
  extraBody?: Record<string, unknown>;
  effortBody?: ChainStep["effortBody"];
  temperature?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** A failed attempt, retried or not. */
  onAttemptError?: (error: string, attempt: number, retrying: boolean) => void;
}

/** pi's thinking level back to the configured effort ("off" is "none"). */
export function effortOf(level: SimpleStreamOptions["reasoning"]): Effort {
  if (!level) return "none";
  return level === "minimal" ? "low" : level === "xhigh" ? "max" : level;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
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
    const body = mergeBody(o.extraBody, o.effortBody?.[effortOf(options?.reasoning)]);
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
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          ac.abort(new Error("first token timeout"));
        }, o.firstTokenMs);
        let start: Extract<AssistantMessageEvent, { type: "start" }> | undefined;
        let forwarded = false;
        let final: AssistantMessage | undefined;
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
            final = { ...final, stopReason: "error", errorMessage: `no first token within ${o.firstTokenMs / 1000}s (timed out)` };
          }
          const error = final.errorMessage ?? `LLM stopped: ${final.stopReason}`;
          const retry =
            !forwarded && !userSignal?.aborted && final.stopReason === "error" && attempt < o.maxRetries && (timedOut || isTransientError(error));
          o.onAttemptError?.(error, attempt, retry);
          if (retry) {
            await sleep(Math.min(500 * 2 ** attempt, 8000), userSignal);
            if (!userSignal?.aborted) continue;
            final = { ...final, stopReason: "aborted", errorMessage: "aborted" };
          }
          out.push({ type: "error", reason: final.stopReason === "aborted" ? "aborted" : "error", error: final });
          return;
        }
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
