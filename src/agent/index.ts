import { Agent, type AgentTool, type BeforeToolCallResult, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Config, Effort } from "../config/index.js";
import type { Decision } from "../guardrails/policy.js";
import { endChatSpan, guarded, startChatSpan, ToolSpans, type ChatRequest } from "../telemetry/spans.js";
import { promptMessages } from "./message.js";
import { createGateway, type Gateway } from "./models.js";

/** The configured effort as a pi thinking level; unset leaves the gateway's default. */
export const thinkingLevel = (e: Effort | undefined): ThinkingLevel | undefined => (e === undefined ? undefined : e === "none" ? "off" : e);

/** Decides, in code, whether a tool call may run. The model cannot bypass or override it. */
export type ToolGuard = (call: { name: string; args: unknown }) => Decision | Promise<Decision>;

/** Adapt a guardrail decision to pi's `beforeToolCall` hook; a denial is reported back to the model. */
export function toBeforeToolCall(guard: ToolGuard, onDenied?: (toolCallId: string, reason: string) => void) {
  return async ({ toolCall, args }: { toolCall: { id: string; name: string }; args: unknown }): Promise<BeforeToolCallResult | undefined> => {
    const d = await guard({ name: toolCall.name, args });
    if (d.ok) return undefined;
    onDenied?.(toolCall.id, d.reason);
    return { block: true, reason: `Not allowed: ${d.reason}` };
  };
}

/** Text of a tool result as the model sees it; images and other parts as `[type]`. */
export function toolOutput(result: unknown): string {
  const content = ((result as { content?: unknown })?.content ?? []) as { type: string; text?: string }[];
  return content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n");
}

/** The arguments a tool ran with when it reports them (`details.arguments`: MCP tools, after the guard's defaults). */
export function executedArgs(result: unknown): unknown {
  const details = (result as { details?: unknown })?.details;
  return details && typeof details === "object" && "arguments" in details ? (details as { arguments: unknown }).arguments : undefined;
}

/** One `execute_tool` span per tool call of `agent`; denials are reported through the returned spans' `denied`. */
export function traceToolCalls(agent: Pick<Agent, "subscribe">, spans: ToolSpans): void {
  agent.subscribe((ev) => {
    if (ev.type === "tool_execution_start") spans.start({ id: ev.toolCallId, name: ev.toolName, args: ev.args });
    else if (ev.type === "tool_execution_end") {
      const args = executedArgs(ev.result);
      spans.end({ id: ev.toolCallId, isError: ev.isError, output: toolOutput(ev.result), ...(args !== undefined && { args }) });
    }
    else if (ev.type === "agent_end") spans.closeAll("the agent stopped before the tool finished");
  });
}

export interface AgentSpec {
  systemPrompt: string;
  tools: AgentTool<any>[];
  guard: ToolGuard;
}

/** The chat span request of one agent model turn: the createAgent loop and the RunManager's runner build it alike. */
export function agentChatRequest(
  model: { id: string },
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
  o: { captureContent: boolean; effort?: string; phase?: string; attempt?: number },
): ChatRequest {
  return {
    model: model.id,
    chain: "agent",
    ...(o.effort && { effort: o.effort }),
    purpose: "agent",
    ...(o.phase && { phase: o.phase }),
    ...(o.attempt !== undefined && { attempt: o.attempt }),
    ...(options?.maxTokens !== undefined && { maxTokens: options.maxTokens }),
    ...(options?.temperature !== undefined && { temperature: options.temperature }),
    // The system prompt is the transcript's first message. Walked only when recorded: it grows every turn.
    messages: () => promptMessages(context.messages),
    captureContent: o.captureContent,
  };
}

/** Each model turn of an agent loop becomes a chat span, like a PiLlmClient call; tool calls show in its reply. */
export function tracedStreamFn(inner: StreamFn, opts: { captureContent: boolean; effort?: string }): StreamFn {
  return async (model, context, options) => {
    const span = startChatSpan(agentChatRequest(model, context, options, opts));
    let stream: Awaited<ReturnType<StreamFn>>;
    try {
      stream = await inner(model, context, options);
    } catch (err) {
      endChatSpan(span, { error: (err as Error).message });
      throw err;
    }
    // Not awaited: the agent loop consumes the stream. Both handlers are guarded, so neither can reject.
    guarded(
      () =>
        stream.result().then(
          (msg) => endChatSpan(span, { msg, captureContent: opts.captureContent }),
          (err: unknown) => endChatSpan(span, { error: String((err as Error)?.message ?? err) }),
        ),
      undefined,
    );
    return stream;
  };
}

/** A tool-using agent on the configured gateway. Every tool call passes `guard` first. */
export function createAgent(cfg: Config, spec: AgentSpec, gateway: Gateway = createGateway(cfg)): Agent {
  const effort = gateway.policy.steps("agent")[0]?.effort;
  const level = thinkingLevel(effort);
  const tools = new ToolSpans({ captureContent: cfg.telemetry.captureContent });
  const agent = new Agent({
    initialState: {
      systemPrompt: spec.systemPrompt,
      model: gateway.model,
      tools: spec.tools,
      ...(level && { thinkingLevel: level }),
    },
    streamFn: tracedStreamFn(gateway.models.streamSimple.bind(gateway.models), {
      captureContent: cfg.telemetry.captureContent,
      ...(effort && { effort }),
    }),
    beforeToolCall: toBeforeToolCall(spec.guard, (id, reason) => tools.denied(id, reason)),
  });
  traceToolCalls(agent, tools);
  return agent;
}
