import { diag, INVALID_SPAN_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { messageText, thinkingChars } from "../agent/message.js";

// A proxy until startTelemetry registers a provider; a no-op when tracing is off.
const tracer = trace.getTracer("neotags");
const NOOP_SPAN = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);

let reported = false;
/**
 * Tracing runs inline with the traced work and must never fail it: a bug here (e.g. a reply shaped unlike pi-ai's
 * types) costs the span, not the LLM call or, in a promise callback, the process. Reported once, as an SDK warning.
 */
export function guarded<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    if (!reported) {
      reported = true;
      diag.warn("neotags tracing failed; spans may be missing or incomplete", err);
    }
    return fallback;
  }
}

/** Run `fn` in an active span (so LLM calls inside it become children); errors mark the span failed and rethrow. */
export async function inSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      fail(span, err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

function fail(span: Span, err: Error | string) {
  const message = typeof err === "string" ? err : err.message;
  if (typeof err !== "string") span.recordException(err);
  span.setAttribute("error.type", typeof err === "string" ? "llm_error" : err.name);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

export interface ChatRequest {
  model: string;
  /** llm.chains entry the model was picked from, and its reasoning effort. */
  chain?: string;
  effort?: string;
  purpose?: string;
  /** Retry number within one LlmClient call; absent for agent turns. */
  attempt?: number;
  /** The repeat of an attempt with a larger output budget (same attempt number). */
  widened?: boolean;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  system?: string;
  messages: { role: string; content: string }[];
  /** Record prompts and replies. Off by default: they carry (redacted) Slack content. */
  captureContent: boolean;
}

// pi-ai stop reasons in the OpenAI vocabulary the GenAI conventions use.
const FINISH: Partial<Record<AssistantMessage["stopReason"], string>> = { toolUse: "tool_calls" };

/**
 * One span per gateway request (retries and budget widening each get their own, so every billed call is counted).
 * Attributes follow the OTel GenAI conventions, with prompts in the indexed `gen_ai.prompt.N.*` form that
 * OpenLLMetry emits; OpenObserve and Langfuse both turn such spans into LLM generations with tokens and latency.
 */
export function startChatSpan(req: ChatRequest): Span {
  return guarded(() => chatSpan(req), NOOP_SPAN);
}

function chatSpan(req: ChatRequest): Span {
  const attributes: Attributes = {
    "gen_ai.operation.name": "chat",
    // The wire API, not the vendor: the gateway is OpenAI-compatible whatever model sits behind it.
    "gen_ai.system": "openai",
    "gen_ai.request.model": req.model,
    ...(req.attempt !== undefined && { "neotags.llm.attempt": req.attempt }),
    ...(req.widened && { "neotags.llm.widened": true }),
    ...(req.purpose && { "neotags.llm.purpose": req.purpose }),
    ...(req.chain && { "neotags.llm.chain": req.chain }),
    ...(req.effort && { "neotags.llm.effort": req.effort }),
    ...(req.maxTokens !== undefined && { "gen_ai.request.max_tokens": req.maxTokens }),
    ...(req.temperature !== undefined && { "gen_ai.request.temperature": req.temperature }),
    ...(req.json && { "gen_ai.output.type": "json" }),
  };
  if (req.captureContent) {
    const prompt = [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages];
    prompt.forEach((m, i) => {
      attributes[`gen_ai.prompt.${i}.role`] = m.role;
      attributes[`gen_ai.prompt.${i}.content`] = m.content;
    });
  }
  return tracer.startSpan(`chat ${req.model}`, { kind: SpanKind.CLIENT, attributes });
}

/** Close a chat span with the gateway's reply, or with the error when the request itself failed. */
export function endChatSpan(span: Span, outcome: ChatOutcome) {
  guarded(() => {
    try {
      closeChatSpan(span, outcome);
    } finally {
      span.end();
    }
  }, undefined);
}

/** `text` defaults to the reply's text parts and tool calls (messageText). */
type ChatOutcome = { msg: AssistantMessage; text?: string; captureContent: boolean } | { error: string };

function closeChatSpan(span: Span, outcome: ChatOutcome) {
  if ("error" in outcome) return fail(span, outcome.error);
  const { msg } = outcome;
  const finish = msg.rawStopReason ?? FINISH[msg.stopReason] ?? msg.stopReason;
  const thinking = thinkingChars(msg);
  span.setAttributes({
    "gen_ai.response.model": msg.responseModel ?? msg.model,
    ...(msg.responseId && { "gen_ai.response.id": msg.responseId }),
    "gen_ai.response.finish_reasons": [finish],
    "gen_ai.usage.input_tokens": msg.usage.input,
    "gen_ai.usage.output_tokens": msg.usage.output,
    "llm.usage.total_tokens": msg.usage.totalTokens || msg.usage.input + msg.usage.output,
    ...(msg.usage.cacheRead > 0 && { "gen_ai.usage.cache_read.input_tokens": msg.usage.cacheRead }),
    ...(thinking > 0 && { "neotags.llm.thinking_chars": thinking }),
  });
  if (outcome.captureContent) {
    span.setAttributes({
      "gen_ai.completion.0.role": "assistant",
      "gen_ai.completion.0.content": outcome.text ?? messageText(msg),
      "gen_ai.completion.0.finish_reason": finish,
    });
  }
  if (msg.stopReason === "error" || msg.stopReason === "aborted") fail(span, msg.errorMessage ?? `LLM stopped: ${msg.stopReason}`);
}
