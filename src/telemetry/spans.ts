import {
  context,
  createContextKey,
  diag,
  defaultTextMapGetter,
  INVALID_SPAN_CONTEXT,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Attributes,
  type Context,
  type Span,
  type SpanContext,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { messageText, thinkingChars } from "../agent/message.js";
import { redact } from "../tools/redact.js";
import { PACKAGE_VERSION } from "../version.js";

// A proxy until startTelemetry registers a provider; a no-op when tracing is off.
const tracer = trace.getTracer("neotags");
const NOOP_SPAN = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);

/** What every span of a task or run repeats from its root: the conversation and the agent (entry). */
export interface TraceScope {
  conversation?: string;
  /** The entry (o2, slack, job). */
  agent?: string;
}

/**
 * The scope of the task or run in progress. OpenObserve reads each span on its own: its session list sums tokens over
 * the spans that carry `gen_ai.conversation.id`, and its agent registry and agent graph take the agent from the span
 * itself (a tool or model span without one is an orphan). So every chat and tool span repeats both, not only the root.
 */
const SCOPE = createContextKey("neotags.scope");
const scopeAttrs = (ctx: Context = context.active()): Attributes => {
  const s = ctx.getValue(SCOPE) as TraceScope | undefined;
  return {
    ...(s?.conversation && { "gen_ai.conversation.id": s.conversation }),
    ...(s?.agent && agentAttrs(s.agent)),
  };
};
/** Fields `scope` leaves out (or undefined) are inherited from the enclosing scope. */
const withScope = (ctx: Context, scope: TraceScope | undefined): Context => {
  if (!scope) return ctx;
  const outer = ctx.getValue(SCOPE) as TraceScope | undefined;
  return ctx.setValue(SCOPE, { conversation: scope.conversation ?? outer?.conversation, agent: scope.agent ?? outer?.agent });
};

const agentVersions = new Map<string, string>();

/**
 * The version of each entry's agent (its skill packs, `packsVersion`), set once at startup. An entry not listed is
 * neotags' own version. Without one OpenObserve takes the image tag (`service.version`), and every deploy would show
 * up as a new agent version even when nothing the agent does changed.
 */
export function setAgentVersions(versions: Partial<Record<string, string>>): void {
  agentVersions.clear();
  for (const [entry, v] of Object.entries(versions)) if (v) agentVersions.set(entry, v);
}

/**
 * Agent identity. The id is the entry, like the name, never the bot name: that is a display name (configuration),
 * and renaming the bot would split one agent's history in two.
 */
export const agentAttrs = (entry: string): Attributes => ({
  "gen_ai.agent.name": entry,
  "gen_ai.agent.id": entry,
  "gen_ai.agent.version": agentVersions.get(entry) ?? PACKAGE_VERSION,
});

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
 * `scope` (the root's conversation and agent) is passed on to the spans inside.
 */
export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  scope?: TraceScope,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, withScope(context.active(), scope), async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      // A thrown non-Error is not an LLM error, which is what fail() assumes of a bare string.
      guarded(() => (err instanceof Error ? fail(span, err) : fail(span, String(err), "error")), undefined);
      throw err;
    } finally {
      // Never in place of fn's result or error.
      guarded(() => span.end(), undefined);
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

/**
 * Most characters of recorded message content on one span. Every agent turn re-records the transcript so far, so a
 * long run's prompt grows without bound; the largest seen so far was about 145k.
 */
export const MAX_PROMPT_CHARS = 256_000;

type Message = { role: string; content: string };

/**
 * The prompt as recorded: each message redacted and capped, and, over MAX_PROMPT_CHARS, the oldest messages after the
 * head (any system prompt, then the first other message: the question) replaced by one note, so the newest turns are
 * what is kept. An agent turn's transcript has no system message; a one-shot call's starts with one.
 */
export function recordedPrompt(messages: Message[]): Message[] {
  const all = messages.map((m) => ({ role: m.role, content: recorded(m.content) }));
  const size = (ms: Message[]) => ms.reduce((n, m) => n + m.content.length, 0);
  if (size(all) <= MAX_PROMPT_CHARS) return all;
  const systems = all.findIndex((m) => m.role !== "system");
  // A system prompt and a question, each capped, are far below the limit, so the head always fits.
  const head = all.slice(0, systems < 0 ? all.length : systems + 1);
  let budget = MAX_PROMPT_CHARS - size(head);
  const tail: Message[] = [];
  for (let i = all.length - 1; i >= head.length; i--) {
    const m = all[i]!;
    if (m.content.length > budget) break;
    budget -= m.content.length;
    tail.unshift(m);
  }
  const omitted = all.length - head.length - tail.length;
  return [...head, { role: "system", content: `[${omitted} earlier messages omitted from the trace]` }, ...tail];
}

/**
 * One JSON attribute per direction, in the OTel GenAI shape (`gen_ai.input.messages`, `gen_ai.output.messages`), not
 * the indexed `gen_ai.prompt.N.*`: two attributes per message ran a long run's chat spans past the SDK's 128 attributes
 * per span, and the attributes set last (the reply, the token usage) were dropped. Both directions use this form:
 * OpenObserve reads the indexed one first and would then ignore `gen_ai.input.messages`.
 */
const messagesAttr = (ms: (Message & { finish_reason?: string })[]) => JSON.stringify(ms);

/** A prompt's `gen_ai.input.messages`, redacted on first use and then reused. */
export type RecordedInput = () => string;

export function recordedInput(req: Pick<ChatRequest, "system" | "messages">): RecordedInput {
  let value: string | undefined;
  return () => {
    if (value === undefined) {
      const messages = typeof req.messages === "function" ? req.messages() : req.messages;
      value = messagesAttr(recordedPrompt([...(req.system ? [{ role: "system", content: req.system }] : []), ...messages]));
    }
    return value;
  };
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
  messages: Message[] | (() => Message[]);
  /** `system` and `messages` as recorded, shared by the attempts of one call so each is redacted once. */
  input?: RecordedInput;
  /** Record prompts and replies. Off by default: they carry (redacted) Slack content. */
  captureContent: boolean;
}

// pi-ai stop reasons in the OpenAI vocabulary the GenAI conventions use.
const FINISH: Partial<Record<AssistantMessage["stopReason"], string>> = { toolUse: "tool_calls" };

/**
 * One span per gateway request (retries and budget widening each get their own, so every billed call is counted).
 * Attributes follow the OTel GenAI conventions; OpenObserve turns such spans into LLM generations with tokens and
 * latency.
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
    ...scopeAttrs(),
  };
  if (req.captureContent) attributes["gen_ai.input.messages"] = (req.input ?? recordedInput(req))();
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
    span.setAttribute(
      "gen_ai.output.messages",
      messagesAttr([{ role: "assistant", content: recorded(outcome.text ?? messageText(msg)), finish_reason: finish }]),
    );
  }
  if (msg.stopReason === "error" || msg.stopReason === "aborted") fail(span, msg.errorMessage ?? `LLM stopped: ${msg.stopReason}`);
}

/**
 * Run `fn` with `span` as the active span, so the spans started inside it are its children (and share its scope).
 * `scope` replaces the active one rather than adding to it: a queued run starts in the context of the work that
 * finished before it, and must not pick up that work's conversation or agent.
 */
export function withSpan<T>(span: Span, fn: () => T, scope?: TraceScope): T {
  const ctx = trace.setSpan(context.active(), span);
  return context.with(scope ? ctx.setValue(SCOPE, scope) : ctx, fn);
}

export interface AgentRunSpan {
  /** Entry the run came from (o2, slack, job): `gen_ai.agent.name` and `.id`, so entries can be told apart. */
  agent: string;
  botName?: string;
  runId: string;
  /** The conversation (O2 assistant session, Slack channel:thread). */
  sessionId: string;
  user?: string;
  queuedMs?: number;
  /** W3C `traceparent` of the caller (O2). */
  traceparent?: string;
}

const propagator = new W3CTraceContextPropagator();

/**
 * The caller's trace context, when it is valid and sampled. An unsampled parent would make the default
 * (parent-based) sampler drop the run's spans, and every run must reach the LLM traces; it becomes a link instead.
 */
function callerContext(traceparent: string | undefined): { parent?: Context; link?: SpanContext } {
  if (!traceparent) return {};
  const sc = trace.getSpanContext(propagator.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter));
  if (!sc || !isSpanContextValid(sc)) return {};
  return (sc.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED ? { parent: trace.setSpanContext(ROOT_CONTEXT, sc) } : { link: sc };
}

/** Trace id of a span that is exported; undefined when tracing is off or the sampler dropped it. */
export function spanTraceId(span: Span): string | undefined {
  const sc = span.spanContext();
  return span.isRecording() && isSpanContextValid(sc) ? sc.traceId : undefined;
}

/**
 * One `invoke_agent` span per agent run, the root of its `chat` and `execute_tool` spans. Totals use
 * `neotags.run.*`, not `gen_ai.usage.*`: backends sum tokens over a trace's spans, so the chat spans already count them.
 */
export function startRunSpan(run: AgentRunSpan): Span {
  return guarded(() => {
    const caller = callerContext(run.traceparent);
    return tracer.startSpan(
      `invoke_agent ${run.agent}`,
      {
        ...(caller.link && { links: [{ context: caller.link }] }),
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          ...agentAttrs(run.agent),
          ...(run.botName && { "neotags.bot.name": run.botName }),
          "neotags.run.id": run.runId,
          "gen_ai.conversation.id": run.sessionId,
          // Langfuse groups sessions by session.id; OpenObserve reads either.
          "session.id": run.sessionId,
          ...(run.user && { "user.id": run.user }),
          ...(run.queuedMs !== undefined && { "neotags.run.queued_ms": run.queuedMs }),
        },
      },
      // The caller's trace or a root, never the active context: a queued run is started from whatever finished
      // before it, in that work's context.
      caller.parent ?? ROOT_CONTEXT,
    );
  }, NOOP_SPAN);
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
          "gen_ai.input.messages": messagesAttr([{ role: "user", content: recorded(o.question) }]),
          "gen_ai.output.messages": messagesAttr([{ role: "assistant", content: recorded(o.answer) }]),
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
        ...scopeAttrs(this.o.parent),
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

  /**
   * `args`: the arguments that ran, when the tool changed the model's (the MCP tool guard's defaults).
   * `attributes`: metadata the tool reported (no content), e.g. `neotags.sandbox.queue_ms`.
   */
  end(call: { id: string; isError: boolean; output: string; args?: unknown; attributes?: Attributes }): void {
    const t = this.open.get(call.id);
    if (!t) return;
    this.open.delete(call.id);
    guarded(() => {
      try {
        if (call.attributes) t.span.setAttributes(call.attributes);
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
