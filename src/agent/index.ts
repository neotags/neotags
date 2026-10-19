import { Agent, type AgentTool, type BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { Config } from "../config/index.js";
import type { Decision } from "../guardrails/policy.js";
import { createGateway, type Gateway } from "./models.js";

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

/** A tool-using agent on the configured gateway. Every tool call passes `guard` first. */
export function createAgent(cfg: Config, spec: AgentSpec, gateway: Gateway = createGateway(cfg)): Agent {
  return new Agent({
    initialState: { systemPrompt: spec.systemPrompt, model: gateway.model, tools: spec.tools },
    streamFn: gateway.models.streamSimple.bind(gateway.models),
    beforeToolCall: toBeforeToolCall(spec.guard),
  });
}
