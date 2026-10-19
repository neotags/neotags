import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { LlmError, OpenAiCompatClient, createLlm } from "../src/llm/index.js";

const settings = { baseUrl: "https://gw.test/v1/", model: "m1", apiKey: "k-secret", timeoutMs: 1000, maxRetries: 2 };
const ok = (text = "hi") =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
const noSleep = async () => {};

describe("OpenAiCompatClient", () => {
  it("posts to {baseUrl}/chat/completions with bearer key, model and options", async () => {
    const f = vi.fn().mockResolvedValue(ok("hello"));
    const c = new OpenAiCompatClient(settings, f as unknown as typeof fetch, noSleep);
    const r = await c.chat([{ role: "user", content: "yo" }], { temperature: 0, maxTokens: 50, json: true });
    expect(r).toEqual({ text: "hello", usage: { promptTokens: 3, completionTokens: 2 } });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://gw.test/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer k-secret");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "m1", temperature: 0, max_tokens: 50, response_format: { type: "json_object" },
    });
  });

  it("omits the authorization header when no key is configured", async () => {
    const f = vi.fn().mockResolvedValue(ok());
    await new OpenAiCompatClient({ ...settings, apiKey: undefined }, f as unknown as typeof fetch, noSleep).chat([]);
    expect(f.mock.calls[0]![1].headers.authorization).toBeUndefined();
  });

  it("retries 429/5xx then succeeds", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("oops", { status: 503 }))
      .mockResolvedValueOnce(ok("done"));
    const r = await new OpenAiCompatClient(settings, f as unknown as typeof fetch, noSleep).chat([]);
    expect(r.text).toBe("done");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("does not retry 4xx and never leaks the key in errors", async () => {
    const f = vi.fn().mockResolvedValue(new Response("bad model", { status: 400 }));
    const p = new OpenAiCompatClient(settings, f as unknown as typeof fetch, noSleep).chat([]);
    await expect(p).rejects.toThrow(LlmError);
    await expect(p).rejects.not.toThrow(/k-secret/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries and retries network errors", async () => {
    const f = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(new OpenAiCompatClient(settings, f as unknown as typeof fetch, noSleep).chat([])).rejects.toThrow(/ECONNRESET/);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("rejects a response without message content", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] })));
    await expect(new OpenAiCompatClient(settings, f as unknown as typeof fetch, noSleep).chat([])).rejects.toThrow(/no message content/);
  });
});

describe("llm config", () => {
  const base = { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y" };
  it("defaults to the OpenAI base url with no model", () => {
    const c = loadConfig(base);
    expect(c.llm.baseUrl).toBe("https://api.openai.com/v1");
    expect(c.llm.model).toBeUndefined();
    expect(() => createLlm(c)).toThrow(/llm.model is not set/);
  });
  it("takes base url, model and key from env, overriding the file", () => {
    const c = loadConfig(
      { ...base, NEOTAGS_CONFIG: "f", LLM_BASE_URL: "http://litellm:4000/v1", LLM_MODEL: "claude-x", LLM_API_KEY: "sk-1" },
      () => "llm:\n  baseUrl: https://other.test/v1\n  model: file-model\n",
    );
    expect(c.llm).toMatchObject({ baseUrl: "http://litellm:4000/v1", model: "claude-x" });
    expect(c.secrets.llmApiKey).toBe("sk-1");
    expect(createLlm(c)).toBeInstanceOf(OpenAiCompatClient);
  });
  it("rejects an invalid base url", () => {
    expect(() => loadConfig({ ...base, LLM_BASE_URL: "not a url" })).toThrow();
  });
});
