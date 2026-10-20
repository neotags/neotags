import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toBeforeToolCall } from "../src/agent/index.js";
import { LlmError, PiLlmClient, createLlm } from "../src/agent/llm.js";
import { createGateway } from "../src/agent/models.js";
import { loadConfig } from "../src/config/index.js";

const base = { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y" };
const cfgFor = (env: Record<string, string> = {}, yaml = "") =>
  loadConfig({ ...base, ...(yaml && { NEOTAGS_CONFIG: "f" }), ...env }, () => yaml);

describe("llm config", () => {
  it("defaults to the OpenAI base url with no model, and fails fast without one", () => {
    const c = cfgFor();
    expect(c.llm.baseUrl).toBe("https://api.openai.com/v1");
    expect(c.llm.model).toBeUndefined();
    expect(() => createLlm(c)).toThrow(/llm.model is not set/);
  });
  it("takes base url, model and key from env, overriding the file", () => {
    const c = cfgFor(
      { LLM_BASE_URL: "http://litellm:4000/v1", LLM_MODEL: "gw-model", LLM_API_KEY: "sk-1" },
      "llm:\n  baseUrl: https://other.test/v1\n  model: file-model\n",
    );
    expect(c.llm).toMatchObject({ baseUrl: "http://litellm:4000/v1", model: "gw-model" });
    expect(c.secrets.llmApiKey).toBe("sk-1");
  });
  it("rejects an invalid base url", () => {
    expect(() => cfgFor({ LLM_BASE_URL: "not a url" })).toThrow();
  });
});

describe("createGateway", () => {
  it("builds an openai-completions model from config, passing compat flags through", () => {
    const c = cfgFor(
      { LLM_MODEL: "m", LLM_BASE_URL: "http://gw.test/v1" },
      "llm:\n  contextWindow: 32000\n  compat:\n    supportsStore: false\n",
    );
    const { model } = createGateway(c);
    expect(model).toMatchObject({
      id: "m", api: "openai-completions", baseUrl: "http://gw.test/v1", contextWindow: 32000,
      compat: { supportsStore: false },
    });
  });
  it("omits compat when none is configured", () => {
    expect(createGateway(cfgFor({ LLM_MODEL: "m" })).model.compat).toBeUndefined();
  });
});

describe("router model", () => {
  it("is optional, comes from file or env, and falls back to the main model", () => {
    expect(createGateway(cfgFor({ LLM_MODEL: "big" })).routerModel.id).toBe("big");
    expect(createGateway(cfgFor({ LLM_MODEL: "big", LLM_ROUTER_MODEL: "small" })).routerModel.id).toBe("small");
    const c = cfgFor({ LLM_MODEL: "big" }, "llm:\n  routerModel: flash\n");
    const g = createGateway(c);
    expect(g.model.id).toBe("big");
    expect(g.routerModel).toMatchObject({ id: "flash", baseUrl: g.model.baseUrl, api: "openai-completions" });
    const same = createGateway(cfgFor({ LLM_MODEL: "big", LLM_ROUTER_MODEL: "big" }));
    expect(same.routerModel).toBe(same.model); // identical id: one model registered, not two
  });
});

describe("PiLlmClient", () => {
  const msg = (over: object = {}) =>
    ({
      role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop",
      usage: { input: 3, output: 2 }, ...over,
    }) as never;
  const noSleep = async () => {};

  it("maps messages, usage and the json option", async () => {
    const complete = vi.fn().mockResolvedValue(msg());
    const c = new PiLlmClient({ complete, timeoutMs: 1000, maxRetries: 0 });
    const r = await c.chat(
      [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      { temperature: 0, maxTokens: 50, json: true },
    );
    expect(r).toEqual({ text: "ok", usage: { promptTokens: 3, completionTokens: 2 } });
    const [ctx, opts] = complete.mock.calls[0]!;
    expect(ctx.systemPrompt).toBe("sys");
    expect(ctx.messages).toMatchObject([{ role: "user", content: "hi" }]);
    expect(opts).toMatchObject({ temperature: 0, maxTokens: 50 });
    expect(opts.onPayload({ a: 1 })).toEqual({ a: 1, response_format: { type: "json_object" } });
  });

  it("retries transient errors then succeeds", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(msg({ stopReason: "error", errorMessage: "429 rate limit" }))
      .mockRejectedValueOnce(new Error("503 service unavailable"))
      .mockResolvedValueOnce(msg());
    const c = new PiLlmClient({ complete, timeoutMs: 1000, maxRetries: 2, sleep: noSleep });
    expect((await c.chat([{ role: "user", content: "x" }])).text).toBe("ok");
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("does not retry permanent errors, and gives up after maxRetries", async () => {
    const bad = vi.fn().mockResolvedValue(msg({ stopReason: "error", errorMessage: "400 unknown model" }));
    await expect(new PiLlmClient({ complete: bad, timeoutMs: 1, maxRetries: 2, sleep: noSleep }).chat([])).rejects.toThrow(LlmError);
    expect(bad).toHaveBeenCalledTimes(1);

    const flaky = vi.fn().mockResolvedValue(msg({ stopReason: "error", errorMessage: "502 bad gateway" }));
    await expect(new PiLlmClient({ complete: flaky, timeoutMs: 1, maxRetries: 2, sleep: noSleep }).chat([])).rejects.toThrow(/after 3 attempts/);
    expect(flaky).toHaveBeenCalledTimes(3);
  });

  it("rejects an empty response", async () => {
    const complete = vi.fn().mockResolvedValue(msg({ content: [] }));
    await expect(new PiLlmClient({ complete, timeoutMs: 1, maxRetries: 0 }).chat([])).rejects.toThrow(/no text/);
  });

  // The model "thinks" until max_tokens, so the reply has no text block (seen with a reasoning model on the router's 200 tokens).
  it("retries once with a bigger budget when the answer was eaten by thinking", async () => {
    const thinkingOnly = msg({ content: [{ type: "thinking", thinking: "hmm..." }], stopReason: "length", usage: { input: 3, output: 200 } });
    const complete = vi.fn().mockResolvedValueOnce(thinkingOnly).mockResolvedValueOnce(msg({ content: [{ type: "text", text: '{"skill":"kb-ask"}' }] }));
    const c = new PiLlmClient({ complete, timeoutMs: 1000, maxRetries: 0, maxTokensCap: 8192 });
    expect((await c.chat([{ role: "user", content: "x" }], { maxTokens: 200 })).text).toBe('{"skill":"kb-ask"}');
    expect(complete.mock.calls.map((c) => c[1].maxTokens)).toEqual([200, 1024]);
  });

  it("also widens when the reply was cut off mid-JSON, but only once and never past the cap", async () => {
    const cut = msg({ content: [{ type: "text", text: '{"description": "cut' }], stopReason: "length" });
    const complete = vi.fn().mockResolvedValue(cut);
    const c = new PiLlmClient({ complete, timeoutMs: 1000, maxRetries: 0, maxTokensCap: 3000 });
    await c.chat([{ role: "user", content: "x" }], { maxTokens: 1200 });
    expect(complete.mock.calls.map((c) => c[1].maxTokens)).toEqual([1200, 3000]);
    // no budget given, or already at the cap: nothing to widen
    const again = vi.fn().mockResolvedValue(cut);
    await new PiLlmClient({ complete: again, timeoutMs: 1000, maxRetries: 0, maxTokensCap: 3000 }).chat([{ role: "user", content: "x" }], { maxTokens: 3000 });
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("explains an empty reply in the error: stop reason, tokens, thinking", async () => {
    const complete = vi.fn().mockResolvedValue(msg({ content: [{ type: "thinking", thinking: "abc" }], stopReason: "length", usage: { input: 1, output: 4096 } }));
    await expect(new PiLlmClient({ complete, timeoutMs: 1, maxRetries: 0, maxTokensCap: 4096 }).chat([{ role: "user", content: "x" }], { maxTokens: 4096 })).rejects.toThrow(
      /stopReason=length, output tokens=4096, thinking chars=3, maxTokens=4096/,
    );
  });

  it("adds llm.extraBody to the request, next to json mode", async () => {
    const complete = vi.fn().mockResolvedValue(msg());
    const c = new PiLlmClient({ complete, timeoutMs: 1000, maxRetries: 0, extraBody: { chat_template_kwargs: { enable_thinking: false } } });
    await c.chat([{ role: "user", content: "x" }], { json: true });
    expect(complete.mock.calls[0]![1].onPayload({ model: "m" })).toEqual({
      model: "m", response_format: { type: "json_object" }, chat_template_kwargs: { enable_thinking: false },
    });
    await c.chat([{ role: "user", content: "x" }]);
    expect(complete.mock.calls[1]![1].onPayload({ model: "m" })).toEqual({ model: "m", chat_template_kwargs: { enable_thinking: false } });
  });
});

describe("end to end against a fake OpenAI-compatible gateway", () => {
  let server: Server | undefined;
  afterEach(() => void server?.close());

  async function fakeGateway(handler: (req: IncomingMessage, body: string) => string | number) {
    const seen: { url?: string; auth?: string; body?: Record<string, unknown> }[] = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
        const out = handler(req, body);
        if (typeof out === "number") return void res.writeHead(out).end("nope");
        res.writeHead(200, { "content-type": "text/event-stream" }).end(out);
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
  }
  const sse = (text: string) =>
    [
      { id: "c1", object: "chat.completion.chunk", model: "gw-model", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
      { id: "c1", object: "chat.completion.chunk", model: "gw-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
    ].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

  it("calls the configured base url with the bearer key and model", async () => {
    const gw = await fakeGateway(() => sse("hello from gateway"));
    const llm = createLlm(cfgFor({ LLM_BASE_URL: gw.url, LLM_MODEL: "gw-model", LLM_API_KEY: "sk-test" }));
    const r = await llm.chat([{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]);
    expect(r.text).toBe("hello from gateway");
    expect(r.usage).toEqual({ promptTokens: 7, completionTokens: 3 });
    expect(gw.seen[0]).toMatchObject({ url: "/v1/chat/completions", auth: "Bearer sk-test", body: { model: "gw-model" } });
  });

  it("sends the router model for the router role and the main model otherwise, on one gateway", async () => {
    const gw = await fakeGateway(() => sse("ok"));
    const cfg = cfgFor({ LLM_BASE_URL: gw.url, LLM_MODEL: "big-model", LLM_ROUTER_MODEL: "flash-model", LLM_API_KEY: "sk-test" });
    const gateway = createGateway(cfg);
    await createLlm(cfg, { role: "router", gateway }).chat([{ role: "user", content: "route me" }]);
    await createLlm(cfg, { gateway }).chat([{ role: "user", content: "summarize me" }]);
    expect(gw.seen.map((r) => r.body?.model)).toEqual(["flash-model", "big-model"]);
    expect(gw.seen.every((r) => r.auth === "Bearer sk-test" && r.url === "/v1/chat/completions")).toBe(true);
  });

  it("works against a keyless gateway", async () => {
    const gw = await fakeGateway(() => sse("ok"));
    const llm = createLlm(cfgFor({ LLM_BASE_URL: gw.url, LLM_MODEL: "gw-model" }));
    await llm.chat([{ role: "user", content: "hi" }]);
    // pi-ai needs some key; a keyless gateway just ignores this placeholder.
    expect(gw.seen[0]!.auth).toBe("Bearer not-needed");
  });

  it("surfaces a gateway error without leaking the key", async () => {
    const gw = await fakeGateway(() => 400);
    const llm = createLlm(cfgFor({ LLM_BASE_URL: gw.url, LLM_MODEL: "gw-model", LLM_API_KEY: "sk-secret" }));
    const p = llm.chat([{ role: "user", content: "hi" }]);
    await expect(p).rejects.toThrow(LlmError);
    await expect(p).rejects.not.toThrow(/sk-secret/);
  });
});

describe("toBeforeToolCall", () => {
  const call = (name: string) => ({ toolCall: { name }, args: {} });
  it("allows what the guard allows and blocks the rest with a reason for the model", async () => {
    const hook = toBeforeToolCall(({ name }) => (name === "query" ? { ok: true } : { ok: false, reason: "needs approval" }));
    expect(await hook(call("query"))).toBeUndefined();
    expect(await hook(call("restart"))).toEqual({ block: true, reason: "Not allowed: needs approval" });
  });
});
