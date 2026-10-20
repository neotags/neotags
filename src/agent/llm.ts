import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { Config } from "../config/index.js";
import { createGateway, type Gateway } from "./models.js";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/** What a call is for; config (llm.outputTokens) sets the output budget of each. */
export type Purpose = "router" | "notes" | "summary" | "fileSummary" | "answer";

export interface ChatOptions {
  /** Picks the output budget from config. An explicit `maxTokens` wins. */
  purpose?: Purpose;
  /** Overrides llm.temperature for this call. */
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
  /** Upper bound when a call is retried with a larger output budget (llm.maxTokens). */
  maxTokensCap?: number;
  /** Extra fields merged into every request body (llm.extraBody), e.g. to switch off thinking on a gateway. */
  extraBody?: Record<string, unknown>;
  /** Output budget per purpose (llm.outputTokens). */
  outputTokens?: Partial<Record<Purpose, number>>;
  /** Default sampling temperature (llm.temperature); undefined sends none, leaving the gateway's default. */
  temperature?: number;
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

    const extra = this.d.extraBody && Object.keys(this.d.extraBody).length > 0 ? this.d.extraBody : undefined;
    let budget = opts.maxTokens ?? (opts.purpose ? this.d.outputTokens?.[opts.purpose] : undefined);
    const temperature = opts.temperature ?? this.d.temperature;
    let widened = false;
    let last = "LLM request failed";
    for (let attempt = 0; attempt <= this.d.maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
      let msg: AssistantMessage;
      try {
        msg = await this.d.complete(context, {
          signal: AbortSignal.timeout(this.d.timeoutMs),
          ...(temperature !== undefined && { temperature }),
          ...(budget !== undefined && { maxTokens: budget }),
          ...((opts.json || extra) && {
            onPayload: (p: unknown) => ({
              ...(p as object),
              ...(opts.json && { response_format: { type: "json_object" } }),
              ...extra,
            }),
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
    maxTokensCap: cfg.llm.maxTokens,
    extraBody: cfg.llm.extraBody,
    outputTokens: cfg.llm.outputTokens,
    ...(cfg.llm.temperature !== null && { temperature: cfg.llm.temperature }),
  });
}
