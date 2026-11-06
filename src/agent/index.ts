import { Agent, type AgentTool, type BeforeToolCallResult, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Config, Effort } from "../config/index.js";
import type { Decision } from "../guardrails/policy.js";
import { endChatSpan, messageText, startChatSpan } from "../telemetry/spans.js";
import { createGateway, type Gateway } from "./models.js";

/** The configured effort as a pi thinking level; unset leaves the gateway's default. */
export const thinkingLevel = (e: Effort | undefined): ThinkingLevel | undefined => (e === undefined ? undefined : e === "none" ? "off" : e);

/** Decides, in code, whether a tool call may run. The model cannot bypass or override it. */
export type ToolGuard = (call: { name: string; args: unknown }) => Decision | Promise<Decision>;

/** Adapt a guardrail decision to pi's `beforeToolCall` hook; a denial is reported back to the model. */
export function toBeforeToolCall(guard: ToolGuard) {
  return async ({ toolCall, args }: { toolCall: { name: string }; args: unknown }): Promise<BeforeToolCallResult | undefined> => {
    const d = await guard({ name: toolCall.name, args });
    return d.ok ? undefined : { block: true, reason: `Not allowed: ${d.reason}` };
  };
}

export interface AgentSpec {
  systemPrompt: string;
  tools: AgentTool<any>[];
  guard: ToolGuard;
}

/** Each model turn of an agent loop becomes a chat span, like a PiLlmClient call; tool calls show in its reply. */
export function tracedStreamFn(inner: StreamFn, opts: { captureContent: boolean; effort?: string }): StreamFn {
  return async (model, context, options) => {
    const span = startChatSpan({
      model: model.id,
      chain: "agent",
      ...(opts.effort && { effort: opts.effort }),
      purpose: "agent",
      ...(options?.maxTokens !== undefined && { maxTokens: options.maxTokens }),
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
      messages: context.messages.map((m) => ({ role: m.role === "toolResult" ? "tool" : m.role, content: messageText(m) })),
      captureContent: opts.captureContent,
    });
    let stream: Awaited<ReturnType<StreamFn>>;
    try {
      stream = await inner(model, context, options);
    } catch (err) {
      endChatSpan(span, { error: (err as Error).message });
      throw err;
    }
    stream.result().then(
      (msg) => endChatSpan(span, { msg, text: messageText(msg), captureContent: opts.captureContent }),
      (err: unknown) => endChatSpan(span, { error: (err as Error).message }),
    );
    return stream;
  };
}

/** A tool-using agent on the configured gateway. Every tool call passes `guard` first. */
export function createAgent(cfg: Config, spec: AgentSpec, gateway: Gateway = createGateway(cfg)): Agent {
  const effort = gateway.policy.steps("agent")[0]?.effort;
  const level = thinkingLevel(effort);
  return new Agent({
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
    beforeToolCall: toBeforeToolCall(spec.guard),
  });
}
