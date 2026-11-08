import {
  context,
  createContextKey,
  diag,
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { messageText, thinkingChars } from "../agent/message.js";
import { redact } from "../tools/redact.js";

// A proxy until startTelemetry registers a provider; a no-op when tracing is off.
const tracer = trace.getTracer("neotags");
const NOOP_SPAN = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);

/**
 * The conversation of the task or run in progress. OpenObserve's session list sums tokens over the spans that carry
 * `gen_ai.conversation.id`, so every chat and tool span repeats it, not only the root.
 */
const CONVERSATION = createContextKey("neotags.conversation");
const conversationOf = (ctx: Context = context.active()) => ctx.getValue(CONVERSATION) as string | undefined;
const conversationAttrs = (ctx?: Context): Attributes => {
  const id = conversationOf(ctx);
  return id ? { "gen_ai.conversation.id": id } : {};
};

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

/**
 * Run `fn` in an active span (so LLM calls inside it become children); errors mark the span failed and rethrow.
 * `conversation` (the root's `gen_ai.conversation.id`) is passed on to the spans inside.
 */
export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  conversation?: string,
): Promise<T> {
  const ctx = conversation ? context.active().setValue(CONVERSATION, conversation) : context.active();
  return tracer.startActiveSpan(name, { attributes }, ctx, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      guarded(() => fail(span, err instanceof Error ? err : String(err)), undefined);
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Error text is redacted like content: gateway and tool errors can echo a token or a credentialed URL. */
function fail(span: Span, err: Error | string, type?: string) {
  const message = recorded(typeof err === "string" ? err : err.message);
  if (typeof err !== "string") span.recordException({ name: err.name, message, ...(err.stack && { stack: recorded(err.stack) }) });
  span.setAttribute("error.type", type ?? (typeof err === "string" ? "llm_error" : err.name));
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/** Longest recorded content value; an agent turn's prompt repeats every tool output so far. */
export const MAX_CONTENT_CHARS = 32_000;

/**
 * Every recorded prompt, reply, tool argument and tool result goes through here. Slack content is redacted
 * upstream, but an O2 question, its page context and tool output are not, and traces are read by more people.
 */
export function recorded(text: string): string {
  const { text: clean } = redact(text);
  return clean.length > MAX_CONTENT_CHARS ? `${clean.slice(0, MAX_CONTENT_CHARS)}… [truncated ${clean.length - MAX_CONTENT_CHARS} chars]` : clean;
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
  /** Agent run turn: "investigate" (with tools) or "final" (the answer, without tools). */
  phase?: string;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  system?: string;
  /** A function is only called when content is recorded, inside the tracing guard (an agent transcript is walked). */
  messages: { role: string; content: string }[] | (() => { role: string; content: string }[]);
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
    ...(req.phase && { "neotags.llm.phase": req.phase }),
    ...(req.purpose && { "neotags.llm.purpose": req.purpose }),
    ...(req.chain && { "neotags.llm.chain": req.chain }),
    ...(req.effort && { "neotags.llm.effort": req.effort }),
    ...(req.maxTokens !== undefined && { "gen_ai.request.max_tokens": req.maxTokens }),
    ...(req.temperature !== undefined && { "gen_ai.request.temperature": req.temperature }),
    ...(req.json && { "gen_ai.output.type": "json" }),
    ...conversationAttrs(),
  };
  if (req.captureContent) {
    const messages = typeof req.messages === "function" ? req.messages() : req.messages;
    const prompt = [...(req.system ? [{ role: "system", content: req.system }] : []), ...messages];
    prompt.forEach((m, i) => {
      attributes[`gen_ai.prompt.${i}.role`] = m.role;
      attributes[`gen_ai.prompt.${i}.content`] = recorded(m.content);
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
      "gen_ai.completion.0.content": recorded(outcome.text ?? messageText(msg)),
      "gen_ai.completion.0.finish_reason": finish,
    });
  }
  if (msg.stopReason === "error" || msg.stopReason === "aborted") fail(span, msg.errorMessage ?? `LLM stopped: ${msg.stopReason}`);
}

/** Run `fn` with `span` as the active span, so the spans started inside it are its children (and share its conversation). */
export function withSpan<T>(span: Span, fn: () => T, conversation?: string): T {
  const ctx = trace.setSpan(context.active(), span);
  return context.with(conversation ? ctx.setValue(CONVERSATION, conversation) : ctx, fn);
}

export interface AgentRunSpan {
  /** Entry the run came from (o2, slack, job): `gen_ai.agent.name`, so entries can be told apart. */
  agent: string;
  botName?: string;
  runId: string;
  /** The conversation (O2 assistant session, Slack channel:thread). */
  sessionId: string;
  user?: string;
  queuedMs?: number;
}

/**
 * One `invoke_agent` span per agent run, the root of its `chat` and `execute_tool` spans. Totals use
 * `neotags.run.*`, not `gen_ai.usage.*`: backends sum tokens over a trace's spans, so the chat spans already count them.
 */
export function startRunSpan(run: AgentRunSpan): Span {
  return guarded(
    () =>
      tracer.startSpan(
        `invoke_agent ${run.agent}`,
        {
          attributes: {
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.agent.name": run.agent,
            ...(run.botName && { "neotags.bot.name": run.botName }),
            "neotags.run.id": run.runId,
            "gen_ai.conversation.id": run.sessionId,
            // Langfuse groups sessions by session.id; OpenObserve reads either.
            "session.id": run.sessionId,
            ...(run.user && { "user.id": run.user }),
            ...(run.queuedMs !== undefined && { "neotags.run.queued_ms": run.queuedMs }),
          },
        },
        // Always a root: a queued run is started from whatever finished before it, in that work's context.
        ROOT_CONTEXT,
      ),
    NOOP_SPAN,
  );
}

export interface RunSpanOutcome {
  state: string;
  answer: string;
  question: string;
  degraded?: boolean;
  reason?: string;
  /** Why the run failed or stopped (model_unavailable, model_error, deadline, error, cancelled, interrupted). */
  errorType?: string;
  steps: number;
  toolCalls: number;
  usage: { inputTokens: number; outputTokens: number };
  model?: string;
  effort?: string;
  captureContent: boolean;
}

/** Close a run span. Only a failed run is an error; cancelled ones carry `error.type` for filtering but stay OK. */
export function endRunSpan(span: Span, o: RunSpanOutcome) {
  guarded(() => {
    try {
      span.setAttributes({
        "neotags.run.state": o.state,
        "neotags.run.degraded": o.degraded ?? false,
        ...(o.reason && { "neotags.run.reason": recorded(o.reason) }),
        "neotags.run.steps": o.steps,
        "neotags.run.tool_calls": o.toolCalls,
        "neotags.run.input_tokens": o.usage.inputTokens,
        "neotags.run.output_tokens": o.usage.outputTokens,
        ...(o.model && { "neotags.llm.model": o.model }),
        ...(o.effort && { "neotags.llm.effort": o.effort }),
      });
      if (o.captureContent) {
        span.setAttributes({
          "gen_ai.prompt.0.role": "user",
          "gen_ai.prompt.0.content": recorded(o.question),
          "gen_ai.completion.0.role": "assistant",
          "gen_ai.completion.0.content": recorded(o.answer),
        });
      }
      if (o.state === "failed") fail(span, o.reason ?? "run failed", o.errorType ?? "error");
      else if (o.errorType) span.setAttribute("error.type", o.errorType);
    } finally {
      span.end();
    }
  }, undefined);
}

/**
 * `execute_tool` spans of one agent: started when the loop announces a call, failed when the tool guard denies it
 * or the tool errors. Parented to `parent` (the run) when given, else to the active span at the call.
 */
export class ToolSpans {
  private open = new Map<string, { span: Span; denied?: string }>();

  constructor(private o: { captureContent: boolean; parent?: Context }) {}

  start(call: { id: string; name: string; args: unknown }): void {
    guarded(() => {
      const attributes: Attributes = {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": call.name,
        "gen_ai.tool.call.id": call.id,
        "gen_ai.tool.type": "function",
        ...conversationAttrs(this.o.parent),
      };
      if (this.o.captureContent) attributes["gen_ai.tool.call.arguments"] = recorded(JSON.stringify(call.args ?? null));
      const span = tracer.startSpan(`execute_tool ${call.name}`, { kind: SpanKind.INTERNAL, attributes }, this.o.parent ?? context.active());
      this.open.set(call.id, { span });
    }, undefined);
  }

  /** The tool guard refused the call; its end event follows. */
  denied(id: string, reason: string): void {
    const t = this.open.get(id);
    if (t) t.denied = reason;
  }

  /** `args`: the arguments that ran, when the tool changed the model's (the MCP tool guard's defaults). */
  end(call: { id: string; isError: boolean; output: string; args?: unknown }): void {
    const t = this.open.get(call.id);
    if (!t) return;
    this.open.delete(call.id);
    guarded(() => {
      try {
        if (this.o.captureContent) {
          if (call.args !== undefined) t.span.setAttribute("gen_ai.tool.call.arguments", recorded(JSON.stringify(call.args)));
          t.span.setAttribute("gen_ai.tool.call.result", recorded(call.output));
        }
        if (t.denied !== undefined) fail(t.span, t.denied, "tool_denied");
        // The error text is tool output: content, recorded only when content is.
        // Redacted before it is cut: a cut through a secret (a PEM block) would no longer match its pattern.
        else if (call.isError) fail(t.span, (this.o.captureContent && recorded(call.output).slice(0, 500)) || "tool failed", "tool_error");
      } finally {
        t.span.end();
      }
    }, undefined);
  }

  /** Close calls that never ended (the run was aborted mid-call), so they are exported rather than leaked. */
  closeAll(reason: string): void {
    for (const [id, t] of this.open) {
      this.open.delete(id);
      guarded(() => {
        fail(t.span, reason, "aborted");
        t.span.end();
      }, undefined);
    }
  }
}
