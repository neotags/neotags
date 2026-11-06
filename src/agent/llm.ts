import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ChainName, Config, Effort } from "../config/index.js";
import { endChatSpan, startChatSpan } from "../telemetry/spans.js";
import { createGateway, type ChainStep, type Gateway, type ModelPolicy } from "./models.js";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/** What a call is for; config (llm.outputTokens) sets the output budget of each. */
export type Purpose = "router" | "notes" | "summary" | "fileSummary" | "answer";

/** Model chain (llm.chains) each purpose runs on. */
export const PURPOSE_CHAIN: Record<Purpose, ChainName> = {
  router: "gate",
  notes: "summary",
  summary: "summary",
  fileSummary: "summary",
  answer: "summary",
};

export interface ChatOptions {
  /** Picks the output budget from config. An explicit `maxTokens` wins. */
  purpose?: Purpose;
  /** Overrides llm.temperature for this call. */
  temperature?: number;
  maxTokens?: number;
  /** Ask the gateway for a JSON object. Not every gateway supports it; callers must still validate. */
  json?: boolean;
  /** Model chain to run on; default: the client's chain, else the purpose's (PURPOSE_CHAIN), else "summary". */
  chain?: ChainName;
}

export interface ChatResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number };
  /** Gateway model id and reasoning effort that produced the answer (absent for a client without a model policy). */
  model?: string;
  effort?: Effort;
}

/** One-shot, tool-less completion (summaries, intent routing). Tool use goes through the Agent instead. */
export interface LlmClient {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

/** Every model of the chain has its breaker open: fail fast so the caller can degrade instead of waiting on timeouts. */
export class ModelUnavailableError extends LlmError {
  constructor(public readonly chain: ChainName, lastError?: string) {
    super(`model unavailable: every model of chain "${chain}" is failing (circuit breaker open)${lastError ? `; last error: ${lastError}` : ""}`);
    this.name = "ModelUnavailableError";
  }
}

type CompleteFn = (context: Context, opts: Record<string, unknown>, step?: ChainStep) => Promise<AssistantMessage>;

export interface LlmDeps {
  complete: CompleteFn;
  timeoutMs: number;
  maxRetries: number;
  sleep?: (ms: number) => Promise<void>;
  /** Upper bound when a call is retried with a larger output budget (llm.maxTokens). */
  maxTokensCap?: number;
  /** Extra fields merged into every request body (llm.extraBody), e.g. to switch off thinking on a gateway. */
  extraBody?: Record<string, unknown>;
  /** Output budget per purpose (llm.outputTokens). */
  outputTokens?: Partial<Record<Purpose, number>>;
  /** Default sampling temperature (llm.temperature); undefined sends none, leaving the gateway's default. */
  temperature?: number;
  /** Picks the model and effort per call and tracks failures; without it every call goes to `complete` as is. */
  policy?: Pick<ModelPolicy, "pick"> & Partial<Pick<ModelPolicy, "steps">>;
  /** Chain for every call of this client unless the call names one (e.g. "gate" for the router). */
  chain?: ChainName;
  /** Put prompts and replies on trace spans (telemetry.captureContent). */
  captureContent?: boolean;
}

/** Request settings for one effort: pi-ai's reasoningEffort (it maps that per compat.thinkingFormat) and extra body fields. */
export function effortRequest(step: Pick<ChainStep, "effort" | "effortBody"> | undefined): {
  reasoningEffort?: Exclude<Effort, "none">;
  body?: Record<string, unknown>;
} {
  const effort = step?.effort;
  if (!effort) return {};
  const body = step.effortBody?.[effort];
  return { ...(effort !== "none" && { reasoningEffort: effort }), ...(body && { body }) };
}

// pi-ai reports failures as stopReason "error" rather than throwing; retry the transient ones.
const TRANSIENT = /\b(408|409|425|429|500|502|503|504)\b|timed? ?out|econn|socket|unavailable|upstream|overloaded|rate limit/i;
// Rejections of this request's content, not of the model: they must not open the breaker for everyone else.
// Every other error counts, 400 included, since some gateways answer an unknown model name with a 400.
const REQUEST_ERROR = /context[ _-]?(length|window)|maximum context|too long|too many tokens|content[ _-]?(filter|policy|management)|response_format/i;

/** A gateway error worth retrying (rate limit, 5xx, timeout, ...). */
export const isTransientError = (message: string): boolean => TRANSIENT.test(message);
/** The gateway rejected this request's content, which says nothing about the model's health. */
export const isRequestError = (message: string): boolean => REQUEST_ERROR.test(message);

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Merge request-body fields: nested objects (e.g. chat_template_kwargs) are merged, everything else replaced. */
export function mergeBody(...parts: (Record<string, unknown> | undefined)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const part of parts) {
    for (const [k, v] of Object.entries(part ?? {})) {
      const prev = out[k];
      out[k] = isPlainObject(prev) && isPlainObject(v) ? mergeBody(prev, v) : v;
    }
  }
  return out;
}

export class PiLlmClient implements LlmClient {
  constructor(private d: LlmDeps) {}

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const context: Context = {
      ...(system && { systemPrompt: system }),
      messages: messages
        .filter((m) => m.role === "user")
        .map((m) => ({ role: "user" as const, content: m.content, timestamp: Date.now() })),
    };
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    const chain = opts.chain ?? this.d.chain ?? (opts.purpose ? PURPOSE_CHAIN[opts.purpose] : "summary");
    let budget = opts.maxTokens ?? (opts.purpose ? this.d.outputTokens?.[opts.purpose] : undefined);
    const temperature = opts.temperature ?? this.d.temperature;
    // One model per call, so the breaker counts failed calls, not retries; a later call moves on to the next
    // model of the chain once this one's breaker opens.
    const picked = this.d.policy?.pick(chain);
    if (this.d.policy && !picked) {
      const lastError = this.d.policy.steps?.(chain).map((s) => s.breaker.lastError).find(Boolean);
      throw new ModelUnavailableError(chain, lastError);
    }
    const step = picked?.step;
    const { reasoningEffort, body } = effortRequest(step);
    const extra = mergeBody(this.d.extraBody, body);
    const hasExtra = Object.keys(extra).length > 0;
    let outcome: "success" | "failure" | "neutral" = "failure";
    let widened = false;
    let last = "LLM request failed";
    try {
      for (let attempt = 0; attempt <= this.d.maxRetries; attempt++) {
        if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
        const span = startChatSpan({
          model: step?.model.id ?? "unknown",
          chain,
          ...(step?.effort && { effort: step.effort }),
          ...(opts.purpose && { purpose: opts.purpose }),
          attempt,
          ...(budget !== undefined && { maxTokens: budget }),
          ...(temperature !== undefined && { temperature }),
          ...(opts.json && { json: true }),
          system,
          messages: messages.filter((m) => m.role === "user"),
          captureContent: this.d.captureContent ?? false,
        });
        let msg: AssistantMessage;
        try {
          msg = await this.d.complete(context, {
            signal: AbortSignal.timeout(this.d.timeoutMs),
            ...(temperature !== undefined && { temperature }),
            ...(budget !== undefined && { maxTokens: budget }),
            ...(reasoningEffort && { reasoningEffort }),
            ...((opts.json || hasExtra) && {
              onPayload: (p: unknown) =>
                mergeBody(p as Record<string, unknown>, opts.json ? { response_format: { type: "json_object" } } : undefined, extra),
            }),
          }, step);
        } catch (err) {
          last = (err as Error).message;
          endChatSpan(span, { error: last });
          outcome = REQUEST_ERROR.test(last) ? "neutral" : "failure";
          if (TRANSIENT.test(last)) continue;
          throw new LlmError(`LLM request failed: ${last}`);
        }
        const text = msg.content
          .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
          .map((c) => c.text)
          .join("");
        endChatSpan(span, { msg, text, captureContent: this.d.captureContent ?? false });
        if (msg.stopReason === "error" || msg.stopReason === "aborted") {
          last = msg.errorMessage ?? `LLM stopped: ${msg.stopReason}`;
          outcome = REQUEST_ERROR.test(last) ? "neutral" : "failure";
          if (TRANSIENT.test(last)) continue;
          throw new LlmError(`LLM request failed: ${last}`);
        }
        outcome = "success"; // the model answered, even if the answer turns out unusable below
        // A reasoning model spends the output budget thinking: the reply has no answer, or one cut off by the
        // limit. Retry once with more room (not counted against the transient-error retries).
        const cap = this.d.maxTokensCap;
        if ((!text || msg.stopReason === "length") && !widened && budget !== undefined && cap !== undefined && budget < cap) {
          widened = true;
          budget = Math.min(Math.max(budget * 4, 1024), cap);
          attempt--;
          last = "output budget too small";
          continue;
        }
        if (!text) {
          const thinking = msg.content.reduce((n, c) => n + (c.type === "thinking" ? c.thinking.length : 0), 0);
          throw new LlmError(
            `LLM returned no text content (stopReason=${msg.stopReason}, output tokens=${msg.usage.output}, thinking chars=${thinking}, maxTokens=${budget ?? "default"})`,
          );
        }
        return {
          text,
          usage: { promptTokens: msg.usage.input, completionTokens: msg.usage.output },
          ...(step && { model: step.model.id }),
          ...(step?.effort && { effort: step.effort }),
        };
      }
      throw new LlmError(`LLM request failed after ${this.d.maxRetries + 1} attempts: ${last}`);
    } finally {
      if (outcome === "success") picked?.lease.success();
      else if (outcome === "failure") picked?.lease.failure(last);
      else picked?.lease.release();
    }
  }
}

/**
 * Build the configured client. `role: "router"` runs every call on the gate chain (`llm.routerModel` in the
 * single-model setup, falling back to `llm.model`). Fails fast with a clear message when no model is configured.
 */
export function createLlm(
  cfg: Config,
  opts: { role?: "default" | "router"; gateway?: Gateway } = {},
): LlmClient {
  const gateway = opts.gateway ?? createGateway(cfg);
  return new PiLlmClient({
    complete: (context, o, step) => gateway.models.complete(step!.model, context, o),
    policy: gateway.policy,
    captureContent: cfg.telemetry.captureContent,
    ...(opts.role === "router" && { chain: "gate" as const }),
    timeoutMs: cfg.llm.timeoutMs,
    maxRetries: cfg.llm.maxRetries,
    maxTokensCap: cfg.llm.maxTokens,
    extraBody: cfg.llm.extraBody,
    outputTokens: cfg.llm.outputTokens,
    ...(cfg.llm.temperature !== null && { temperature: cfg.llm.temperature }),
  });
}
