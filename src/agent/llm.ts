import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { Config } from "../config/index.js";
import { createGateway, type Gateway } from "./models.js";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Ask the gateway for a JSON object. Not every gateway supports it; callers must still validate. */
  json?: boolean;
}

export interface ChatResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number };
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

type CompleteFn = (context: Context, opts: Record<string, unknown>) => Promise<AssistantMessage>;

export interface LlmDeps {
  complete: CompleteFn;
  timeoutMs: number;
  maxRetries: number;
  sleep?: (ms: number) => Promise<void>;
}

// pi-ai reports failures as stopReason "error" rather than throwing; retry the transient ones.
const TRANSIENT = /\b(408|409|425|429|500|502|503|504)\b|timed? ?out|econn|socket|unavailable|upstream|overloaded|rate limit/i;

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

    let last = "LLM request failed";
    for (let attempt = 0; attempt <= this.d.maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
      let msg: AssistantMessage;
      try {
        msg = await this.d.complete(context, {
          signal: AbortSignal.timeout(this.d.timeoutMs),
          ...(opts.temperature !== undefined && { temperature: opts.temperature }),
          ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
          ...(opts.json && {
            onPayload: (p: unknown) => ({ ...(p as object), response_format: { type: "json_object" } }),
          }),
        });
      } catch (err) {
        last = (err as Error).message;
        if (TRANSIENT.test(last)) continue;
        throw new LlmError(`LLM request failed: ${last}`);
      }
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        last = msg.errorMessage ?? `LLM stopped: ${msg.stopReason}`;
        if (TRANSIENT.test(last)) continue;
        throw new LlmError(`LLM request failed: ${last}`);
      }
      const text = msg.content
        .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (!text) throw new LlmError("LLM returned no text content");
      return { text, usage: { promptTokens: msg.usage.input, completionTokens: msg.usage.output } };
    }
    throw new LlmError(`LLM request failed after ${this.d.maxRetries + 1} attempts: ${last}`);
  }
}

/**
 * Build the configured client. `role: "router"` uses `llm.routerModel` (a smaller, faster model on the same
 * gateway) and falls back to `llm.model`. Fails fast with a clear message when no model is configured.
 */
export function createLlm(
  cfg: Config,
  opts: { role?: "default" | "router"; gateway?: Gateway } = {},
): LlmClient {
  const gateway = opts.gateway ?? createGateway(cfg);
  const model = opts.role === "router" ? gateway.routerModel : gateway.model;
  return new PiLlmClient({
    complete: (context, o) => gateway.models.complete(model, context, o),
    timeoutMs: cfg.llm.timeoutMs,
    maxRetries: cfg.llm.maxRetries,
  });
}
