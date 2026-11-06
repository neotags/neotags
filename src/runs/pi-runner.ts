import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { context as otelContext } from "@opentelemetry/api";
import type { Logger } from "pino";
import { agentChatRequest, thinkingLevel, toBeforeToolCall, toolOutput, traceToolCalls, type ToolGuard } from "../agent/index.js";
import { ModelUnavailableError, isRequestError } from "../agent/llm.js";
import type { Gateway } from "../agent/models.js";
import type { Effort } from "../config/index.js";
import { endChatSpan, startChatSpan, ToolSpans } from "../telemetry/spans.js";
import { skillPackTools, type SkillPackIndex } from "../tools/skillpacks.js";
import { compactToBudget } from "./budget.js";
import { prefersChinese } from "./degrade.js";
import { finalPrompt, systemPrompt, userPrompt } from "./prompt.js";
import { resilientStream } from "./stream.js";
import { RunAbort, RunError, type AgentRunner, type RunContext, type RunInput, type RunOutcome, type RunSource } from "./types.js";

export interface PiRunnerOptions {
  gateway: Pick<Gateway, "models" | "policy">;
  index: SkillPackIndex;
  botName: string;
  /** Skill packs in the system prompt per entry (agent.entries). */
  entries: Partial<Record<RunSource, string[]>>;
  /** More tools (MCP, O07) next to read_skill / read_skill_ref. */
  tools?: AgentTool<any>[];
  /** Checked after the built-in rule that only registered tools run. */
  guard?: ToolGuard;
  firstTokenTimeoutMs: number;
  /** A streamed request whose output stalls this long is aborted (llm.timeoutMs). */
  idleTimeoutMs?: number;
  maxRetries: number;
  extraBody?: Record<string, unknown>;
  temperature?: number;
  charsPerToken: number;
  /** Put prompts, replies and tool input/output on trace spans (telemetry.captureContent), redacted. */
  captureContent?: boolean;
  log?: Pick<Logger, "warn">;
  now?: () => number;
  /** Replaces gateway.models.streamSimple (tests). */
  streamFn?: StreamFn;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const OBSERVED_OUTPUT_CHARS = 4000;

const cutNote = (question: string) => (prefersChinese(question) ? "\n\n_（回答被中断，请重新提问）_" : "\n\n_(The answer was cut off; please ask again.)_");

const textOf = (m: AssistantMessage | undefined): string =>
  (m?.content ?? []).filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text").map((c) => c.text).join("").trim();

const lastAssistant = (messages: AgentMessage[]): AssistantMessage | undefined =>
  [...messages].reverse().find((m): m is AssistantMessage => (m as { role?: string }).role === "assistant");

/**
 * AgentRunner on pi-agent-core. One run = one model from the agent chain (one breaker lease): investigation
 * turns at the chain's `effort` with tools, then, when tools were used and `finalEffort` differs, one more turn
 * without tools at `finalEffort` that writes the answer. A budget running out (steps, time, context) ends the
 * investigation the same way, and the run is reported as budget_exhausted.
 */
export class PiAgentRunner implements AgentRunner {
  constructor(private o: PiRunnerOptions) {}

  async run(input: RunInput, ctx: RunContext): Promise<RunOutcome> {
    const { o } = this;
    const now = () => o.now?.() ?? Date.now();
    const picked = o.gateway.policy.pick("agent");
    if (!picked) {
      const last = o.gateway.policy.steps("agent").map((s) => s.breaker.lastError).find(Boolean);
      throw new RunError(new ModelUnavailableError("agent", last).message, "model_unavailable");
    }
    const { step, lease } = picked;
    const stats = { steps: 0, toolCalls: 0, usage: { inputTokens: 0, outputTokens: 0 }, model: step.model.id, ...(step.effort && { effort: step.effort }) };

    const tools = [...skillPackTools(o.index), ...(o.tools ?? [])];
    const names = new Set(tools.map((t) => t.name));
    const guard: ToolGuard = async (call) => {
      if (!names.has(call.name)) return { ok: false, reason: `unknown tool ${call.name}` };
      return o.guard ? o.guard(call) : { ok: true };
    };
    const budget = ctx.budget;
    const fits = (messages: AgentMessage[]) => compactToBudget(messages, { maxTokens: budget.maxInputTokens, charsPerToken: o.charsPerToken }).fits;

    let phase: "investigate" | "final" = "investigate";
    let wrap: "steps" | "time" | "tokens" | undefined;
    let answered = false;
    let streamed = "";
    // Effort of the request being made; the stream wrapper adds that effort's effortBody.
    let effortNow: Effort | undefined = step.effort;

    const captureContent = o.captureContent ?? false;
    // The run's span (the RunManager's invoke_agent) is active here; tool spans hang off it, next to the chat spans.
    const toolSpans = new ToolSpans({ captureContent, parent: otelContext.active() });

    const initialLevel = thinkingLevel(step.effort);
    const agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt({ botName: o.botName, index: o.index, entryPacks: input.packs ?? o.entries[input.source] ?? [] }),
        model: step.model,
        tools,
        ...(initialLevel && { thinkingLevel: initialLevel }),
      },
      streamFn: resilientStream(o.streamFn ?? o.gateway.models.streamSimple.bind(o.gateway.models), {
        firstTokenMs: o.firstTokenTimeoutMs,
        ...(o.idleTimeoutMs && { idleMs: o.idleTimeoutMs }),
        maxRetries: o.maxRetries,
        ...(o.extraBody && { extraBody: o.extraBody }),
        ...(step.effortBody && { effortBody: step.effortBody }),
        effort: () => effortNow,
        ...(o.temperature !== undefined && { temperature: o.temperature }),
        ...(o.sleep && { sleep: o.sleep }),
        onAttemptError: (error, attempt, retrying) => o.log?.warn({ runId: ctx.runId, model: step.model.id, attempt, retrying, error }, "agent llm request failed"),
        // One chat span per gateway request: retries and the tool-less final turn each get their own.
        onAttempt: (attempt, request, options) => {
          const span = startChatSpan(agentChatRequest(step.model, request, options, { captureContent, ...(effortNow && { effort: effortNow }), phase, attempt }));
          return (msg) => endChatSpan(span, { msg, captureContent });
        },
      }),
      sessionId: input.sessionId,
      beforeToolCall: toBeforeToolCall(guard, (id, reason) => toolSpans.denied(id, reason)),
      transformContext: async (messages) =>
        compactToBudget(messages, { maxTokens: budget.maxInputTokens, charsPerToken: o.charsPerToken }).messages,
      finishTurn: (turn) => {
        if (phase === "final") return { action: "end" };
        if (turn.toolResults.length === 0) return undefined;
        stats.steps++;
        if (stats.steps >= budget.maxSteps) wrap = "steps";
        else if (now() >= budget.softDeadline) wrap = "time";
        else if (!fits(turn.context.messages)) wrap = "tokens";
        return wrap ? { action: "end" } : undefined;
      },
    });

    traceToolCalls(agent, toolSpans);
    agent.subscribe((ev) => {
      switch (ev.type) {
        case "tool_execution_start":
          stats.toolCalls++;
          ctx.observer.toolStart?.({ id: ev.toolCallId, name: ev.toolName, args: ev.args });
          break;
        case "tool_execution_end": {
          const output = toolOutput(ev.result);
          ctx.observer.toolEnd?.({
            id: ev.toolCallId,
            name: ev.toolName,
            isError: ev.isError,
            output: output.length > OBSERVED_OUTPUT_CHARS ? `${output.slice(0, OBSERVED_OUTPUT_CHARS)}…` : output,
            ...(ev.durationMs !== undefined && { durationMs: ev.durationMs }),
          });
          break;
        }
        case "message_update":
          // Only the final turn streams: an investigation turn's text is either commentary before tool calls or a
          // draft the final turn rewrites, and which one is only known once the turn ends.
          if (phase === "final" && ev.assistantMessageEvent.type === "text_delta") {
            streamed += ev.assistantMessageEvent.delta;
            ctx.observer.delta?.(ev.assistantMessageEvent.delta);
          }
          break;
        case "message_end": {
          const m = ev.message as AssistantMessage;
          if (m.role !== "assistant") break;
          stats.usage.inputTokens += m.usage?.input ?? 0;
          stats.usage.outputTokens += m.usage?.output ?? 0;
          if (m.stopReason !== "error" && m.stopReason !== "aborted") answered = true;
          break;
        }
      }
    });

    const onAbort = () => agent.abort();
    if (ctx.signal.aborted) onAbort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    let outcome: "success" | "failure" | "neutral" = "neutral";
    let failure: string | undefined;
    try {
      if (ctx.signal.aborted) return this.stopped(ctx, stats, undefined);
      await agent.prompt(userPrompt(input, new Date(now())));
      let last = lastAssistant(agent.state.messages);
      const ended = this.check(last, ctx);
      if (ended.kind === "aborted") return this.stopped(ctx, stats, undefined);
      if (ended.kind === "error") {
        ({ outcome, failure } = ended);
        throw new RunError(ended.message, "model_error", stats);
      }

      // A wrap-up interrupts a turn that was calling tools: its text is commentary, not a draft answer.
      const draft = wrap ? "" : textOf(last);
      const final = wrap ?? (stats.toolCalls > 0 && step.finalEffort && step.finalEffort !== step.effort ? "final" : undefined);
      if (!final) {
        outcome = "success";
        if (!draft) throw new RunError("the model returned no answer", "model_error", stats);
        ctx.observer.delta?.(draft);
        return { state: "done", answer: draft, ...stats };
      }

      phase = "final";
      agent.state.tools = [];
      effortNow = final === "final" ? step.finalEffort : (step.finalEffort ?? step.effort);
      const finalLevel = thinkingLevel(effortNow);
      if (finalLevel) agent.state.thinkingLevel = finalLevel;
      await agent.prompt(finalPrompt(final));
      last = lastAssistant(agent.state.messages);
      const ended2 = this.check(last, ctx);
      if (ended2.kind !== "ok" && streamed) {
        // Part of the answer already reached the asker: finish it with a note rather than replace it, so the
        // deltas still add up to the answer.
        if (ended2.kind === "error") ({ outcome, failure } = ended2);
        const note = cutNote(input.question);
        ctx.observer.delta?.(note);
        throw new RunError(ended2.kind === "error" ? ended2.message : "aborted during the final answer", "model_error", { ...stats, answer: streamed + note });
      }
      if (ended2.kind === "aborted") return this.stopped(ctx, stats, draft);
      const answer = ended2.kind === "ok" ? textOf(last) : "";
      if (answer) {
        outcome = "success";
        return { state: wrap ? "budget_exhausted" : "done", answer, ...(wrap && { reason: `budget: ${wrap}` }), ...stats };
      }
      // The final turn failed or came back empty: the investigation's own answer is still an answer.
      if (draft) {
        if (ended2.kind === "error") ({ outcome, failure } = ended2);
        else outcome = "success";
        ctx.observer.delta?.(draft);
        return { state: "done", answer: draft, ...stats };
      }
      if (ended2.kind === "error") {
        ({ outcome, failure } = ended2);
        throw new RunError(ended2.message, "model_error", stats);
      }
      outcome = "success";
      throw new RunError("the model returned no answer", "model_error", stats);
    } finally {
      toolSpans.closeAll("the run stopped before the tool finished");
      ctx.signal.removeEventListener("abort", onAbort);
      if (outcome === "failure") lease.failure(failure);
      else if (outcome === "success" || answered) lease.success();
      else lease.release();
    }
  }

  /** How the last request ended. Content rejections (context too long, filters) do not count against the model. */
  private check(
    last: AssistantMessage | undefined,
    ctx: RunContext,
  ): { kind: "ok" } | { kind: "aborted" } | { kind: "error"; message: string; outcome: "failure" | "neutral"; failure?: string } {
    if (ctx.signal.aborted || last?.stopReason === "aborted") return { kind: "aborted" };
    if (!last) return { kind: "error", message: "the model returned nothing", outcome: "failure", failure: "no response" };
    if (last.stopReason === "error") {
      const message = last.errorMessage ?? "LLM request failed";
      return isRequestError(message) ? { kind: "error", message, outcome: "neutral" } : { kind: "error", message, outcome: "failure", failure: message };
    }
    return { kind: "ok" };
  }

  /** Cancelled, shut down or out of time. Out of time with a draft still answers; otherwise the manager degrades. */
  private stopped(ctx: RunContext, stats: Omit<RunOutcome, "state" | "answer">, draft: string | undefined): RunOutcome {
    const why = ctx.signal.reason;
    if (why instanceof RunAbort && why.kind === "deadline") {
      if (draft) {
        ctx.observer.delta?.(draft);
        return { state: "budget_exhausted", answer: draft, reason: "budget: wall clock", ...stats };
      }
      throw new RunError(why.message, "error", stats);
    }
    return { state: "cancelled", answer: "", reason: why instanceof RunAbort ? why.message : "aborted", ...stats };
  }
}
