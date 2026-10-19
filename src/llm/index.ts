import type { Config } from "../config/index.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
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
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LlmClient {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
}

export interface LlmSettings {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Minimal client for the OpenAI-compatible `POST {baseUrl}/chat/completions` API. */
export class OpenAiCompatClient implements LlmClient {
  private url: string;

  constructor(
    private s: LlmSettings,
    private fetchImpl: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.url = `${s.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const body = JSON.stringify({
      model: this.s.model,
      messages,
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.maxTokens !== undefined && { max_tokens: opts.maxTokens }),
      ...(opts.json && { response_format: { type: "json_object" } }),
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.s.apiKey) headers.authorization = `Bearer ${this.s.apiKey}`;

    let lastErr: LlmError | undefined;
    for (let attempt = 0; attempt <= this.s.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(this.s.timeoutMs),
        });
      } catch (err) {
        lastErr = new LlmError(`LLM request failed: ${(err as Error).message}`);
        continue; // network error / timeout: retry
      }
      if (!res.ok) {
        // Never echo the request (it holds the key); a short slice of the response aids debugging.
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        lastErr = new LlmError(`LLM gateway returned ${res.status}: ${detail}`, res.status);
        if (RETRYABLE.has(res.status)) continue;
        throw lastErr;
      }
      return parseResponse(await res.json().catch(() => undefined));
    }
    throw lastErr ?? new LlmError("LLM request failed");
  }
}

function parseResponse(j: unknown): ChatResult {
  const r = j as {
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = r?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new LlmError("LLM gateway returned no message content");
  return {
    text,
    usage: r.usage && {
      promptTokens: r.usage.prompt_tokens ?? 0,
      completionTokens: r.usage.completion_tokens ?? 0,
    },
  };
}

/** Build the configured client; fails fast with a clear message when no model is configured. */
export function createLlm(cfg: Config, fetchImpl?: typeof fetch): LlmClient {
  if (!cfg.llm.model) {
    throw new Error("llm.model is not set (config file `llm.model` or env LLM_MODEL)");
  }
  return new OpenAiCompatClient(
    {
      baseUrl: cfg.llm.baseUrl,
      model: cfg.llm.model,
      apiKey: cfg.secrets.llmApiKey,
      timeoutMs: cfg.llm.timeoutMs,
      maxRetries: cfg.llm.maxRetries,
    },
    fetchImpl,
  );
}
