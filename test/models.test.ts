import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CircuitBreaker, type BreakerState } from "../src/agent/breaker.js";
import { ModelUnavailableError, PiLlmClient, createLlm, effortRequest, mergeBody } from "../src/agent/llm.js";
import { createGateway } from "../src/agent/models.js";
import { loadConfig } from "../src/config/index.js";

const base = { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y" };
const cfgFor = (yaml: string, env: Record<string, string> = {}) => loadConfig({ ...base, NEOTAGS_CONFIG: "f", ...env }, () => yaml);

const chains = (body: string) => `llm:\n  baseUrl: http://gw.test/v1\n${body}`;
const flash = `  models:
    flash: { id: flash-model, reasoning: true, thinkingLevelMap: { max: max } }
  chains:
    agent: [{ model: flash, effort: high, finalEffort: max }]
    job: [{ model: flash, effort: high }]
    gate: [{ model: flash, effort: none }]
    summary: [{ model: flash, effort: low }]
`;

describe("model chains config", () => {
  it("resolves every chain to its model and effort, one breaker per model", () => {
    const { policy, model, routerModel } = createGateway(cfgFor(chains(flash)));
    expect(policy.steps("agent")).toMatchObject([{ key: "flash", model: { id: "flash-model", reasoning: true }, effort: "high", finalEffort: "max" }]);
    expect(policy.steps("gate")[0]).toMatchObject({ effort: "none" });
    expect(policy.steps("summary")[0]!.breaker).toBe(policy.steps("agent")[0]!.breaker);
    expect(routerModel).toBe(model);
  });

  it("accepts the commented chains example in config/neotags.example.yaml", () => {
    const lines = readFileSync("config/neotags.example.yaml", "utf8").split("\n");
    const from = lines.findIndex((l) => l.startsWith("  # models:"));
    const to = lines.findIndex((l) => l.startsWith("  #   breaker:"));
    expect(from).toBeGreaterThan(0);
    const block = lines.slice(from, to + 1).map((l) => "  " + l.slice(4).replace(/\s+#.*$/, "")).join("\n");
    const { policy } = createGateway(cfgFor(`llm:\n${block.replace("<gateway model id>", "m")}\n`));
    expect(policy.steps("agent")[0]).toMatchObject({ model: { id: "m" }, effort: "high", finalEffort: "max" });
  });

  it("ignores llm.model once chains are set", () => {
    const g = createGateway(cfgFor(chains(flash), { LLM_MODEL: "legacy" }));
    expect(g.model.id).toBe("flash-model");
  });

  it("merges per-model compat over llm.compat and passes thinkingLevelMap through", () => {
    const c = cfgFor(chains(`  compat: { supportsStore: false }
  models:
    flash: { id: f, reasoning: true, compat: { thinkingFormat: deepseek, supportsReasoningEffort: true }, thinkingLevelMap: { max: max } }
  chains:
    agent: [{ model: flash }]
    job: [{ model: flash }]
    gate: [{ model: flash }]
    summary: [{ model: flash }]
`));
    expect(createGateway(c).model).toMatchObject({
      compat: { supportsStore: false, supportsDeveloperRole: false, thinkingFormat: "deepseek", supportsReasoningEffort: true },
      thinkingLevelMap: { max: "max" },
    });
  });

  it("rejects an unknown model, a missing chain, and thinking on a non-reasoning model", () => {
    expect(() => cfgFor(chains(flash.replace("job: [{ model: flash", "job: [{ model: nope")))).toThrow(/unknown model .+nope.+not in llm.models/);
    expect(() => cfgFor(chains(flash.replace(/ {4}job:.*\n/, "")))).toThrow(/job/);
    expect(() => cfgFor(chains(flash.replace("reasoning: true", "reasoning: false")))).toThrow(/not a reasoning model/);
    expect(() => cfgFor(chains(flash.replace("effort: low", "effort: extreme")))).toThrow();
    // agent runs stream through pi-ai, which lowers an unmapped "max"
    expect(() => cfgFor(chains(flash.replace(", thinkingLevelMap: { max: max }", "")))).toThrow(/needs thinkingLevelMap.max/);
    expect(() => cfgFor(chains(flash.replace(", thinkingLevelMap: { max: max }", "").replace(", finalEffort: max", "")))).not.toThrow();
    // effort "none" is fine on any model
    const plain = flash.replace("reasoning: true", "reasoning: false").replace(/effort: \w+(, finalEffort: \w+)?/g, "effort: none");
    expect(() => cfgFor(chains(plain))).not.toThrow();
  });

  it("builds chains without effort from llm.model / llm.routerModel", () => {
    const g = createGateway(cfgFor("", { LLM_MODEL: "big", LLM_ROUTER_MODEL: "small" }));
    expect(g.policy.steps("gate").map((s) => s.model.id)).toEqual(["small"]);
    for (const c of ["agent", "job", "summary"] as const) expect(g.policy.steps(c).map((s) => s.model.id)).toEqual(["big"]);
    expect(g.policy.steps("agent")[0]).not.toHaveProperty("effort");
  });
});

describe("effortRequest", () => {
  it("maps an effort to pi-ai's reasoningEffort plus that effort's extra body", () => {
    const effortBody = { none: { chat_template_kwargs: { enable_thinking: false } }, max: { x: 1 } };
    expect(effortRequest(undefined)).toEqual({});
    expect(effortRequest({ effortBody })).toEqual({});
    expect(effortRequest({ effort: "none", effortBody })).toEqual({ body: { chat_template_kwargs: { enable_thinking: false } } });
    expect(effortRequest({ effort: "high", effortBody })).toEqual({ reasoningEffort: "high" });
    expect(effortRequest({ effort: "max", effortBody })).toEqual({ reasoningEffort: "max", body: { x: 1 } });
  });
});

describe("CircuitBreaker", () => {
  const make = () => {
    let t = 0;
    const states: BreakerState[] = [];
    const b = new CircuitBreaker({ failures: 5, windowMs: 60_000, cooldownMs: 120_000, now: () => t, onChange: (s) => states.push(s) });
    const fail = (n: number) => {
      for (let i = 0; i < n; i++) b.acquire()!.failure("boom");
    };
    return { b, states, fail, tick: (ms: number) => (t += ms) };
  };

  it("opens after 5 failed calls within the window and fails fast while open", () => {
    const { b, states, fail } = make();
    fail(4);
    expect(b.state).toBe("closed");
    fail(1);
    expect(b.state).toBe("open");
    expect(b.acquire()).toBeUndefined();
    expect(b.lastError).toBe("boom");
    expect(states).toEqual(["open"]);
  });

  it("does not count failures older than the window, nor released calls", () => {
    const { b, fail, tick } = make();
    fail(4);
    tick(60_000);
    fail(1);
    for (let i = 0; i < 10; i++) b.acquire()!.release();
    expect(b.state).toBe("closed");
  });

  it("lets one probe through after the cooldown; its success closes", () => {
    const { b, states, fail, tick } = make();
    fail(5);
    tick(119_999);
    expect(b.acquire()).toBeUndefined();
    tick(1);
    const probe = b.acquire()!;
    expect(b.acquire()).toBeUndefined(); // everyone else waits for the probe
    probe.success();
    expect(b.state).toBe("closed");
    expect(b.acquire()).toBeDefined();
    expect(states).toEqual(["open", "half-open", "closed"]);
  });

  it("reopens for another cooldown when the probe fails; a released probe frees the slot", () => {
    const { b, fail, tick } = make();
    fail(5);
    tick(120_000);
    b.acquire()!.release();
    b.acquire()!.failure();
    expect(b.state).toBe("open");
    tick(119_000);
    expect(b.acquire()).toBeUndefined();
    tick(1_000);
    expect(b.state).toBe("half-open");
  });

  it("only the probe decides while half-open: calls from before the breaker opened change nothing", () => {
    const { b, fail, tick } = make();
    const early = [b.acquire()!, b.acquire()!];
    fail(5);
    tick(120_000);
    const probe = b.acquire()!;
    early[0]!.failure(); // timed out long after it started
    early[1]!.success();
    expect(b.state).toBe("half-open");
    expect(b.acquire()).toBeUndefined(); // still one probe at a time
    probe.success();
    expect(b.state).toBe("closed");
  });

  it("takes only the first outcome of a lease", () => {
    const { b, fail, tick } = make();
    fail(5);
    tick(120_000);
    const probe = b.acquire()!;
    probe.success();
    probe.failure();
    expect(b.state).toBe("closed");
  });
});

describe("mergeBody", () => {
  it("merges nested objects and replaces everything else", () => {
    expect(mergeBody({ a: 1, k: { x: 1, y: 1 }, l: [1] }, undefined, { k: { y: 2, z: 2 }, l: [2], b: 2 })).toEqual({ a: 1, k: { x: 1, y: 2, z: 2 }, l: [2], b: 2 });
  });
});

describe("PiLlmClient with a model policy", () => {
  const ok = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 1, output: 1 } } as never;
  const err = (errorMessage: string) => ({ role: "assistant", content: [], stopReason: "error", errorMessage, usage: { input: 0, output: 0 } }) as never;
  const setup = (failures = 5, maxRetries = 2) => {
    const cfg = cfgFor(`llm:
  failover: { breaker: { failures: ${failures} } }
`, { LLM_MODEL: "m" });
    const { policy } = createGateway(cfg);
    const breaker = policy.steps("summary")[0]!.breaker;
    const client = (complete: () => Promise<never>) => new PiLlmClient({ complete, policy, timeoutMs: 1000, maxRetries, sleep: async () => {} });
    return { breaker, client };
  };
  const hi = [{ role: "user" as const, content: "hi" }];

  it("counts a failed call once, however many retries it made", async () => {
    const { breaker, client } = setup();
    const llm = client(async () => err("503 service unavailable"));
    for (let i = 0; i < 4; i++) await expect(llm.chat(hi)).rejects.toThrow(/after 3 attempts/);
    expect(breaker.state).toBe("closed"); // 12 attempts, 4 calls
    await expect(llm.chat(hi)).rejects.toThrow(/after 3 attempts/);
    expect(breaker.state).toBe("open");
  });

  it("counts a call that recovered on retry as a success", async () => {
    const { breaker, client } = setup(1);
    let n = 0;
    const llm = client(async () => (n++ % 2 === 0 ? err("502 bad gateway") : ok));
    for (let i = 0; i < 3; i++) await llm.chat(hi);
    expect(breaker.state).toBe("closed");
  });

  it("does not count rejections of the request's own content, but does count other 400s", async () => {
    const { breaker, client } = setup(2, 0);
    for (const m of ["400 This model's maximum context length is 131072 tokens", "400 prompt is too long", "400 content filter triggered"]) {
      await expect(client(async () => err(m)).chat(hi)).rejects.toThrow(m);
    }
    expect(breaker.state).toBe("closed");
    const unknownModel = client(async () => err("400 Invalid model name passed in model=nope"));
    await expect(unknownModel.chat(hi)).rejects.toThrow(/Invalid model name/);
    await expect(unknownModel.chat(hi)).rejects.toThrow(/Invalid model name/);
    expect(breaker.state).toBe("open");
  });

  it("says why the model is unavailable", async () => {
    const { client } = setup(1, 0);
    const llm = client(async () => err("401 invalid api key"));
    await expect(llm.chat(hi)).rejects.toThrow(/401/);
    const e = await llm.chat(hi).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ModelUnavailableError);
    expect((e as Error).message).toMatch(/chain "summary".*last error: 401 invalid api key/);
  });

  it("deep-merges per-effort fields over llm.extraBody and the payload", async () => {
    const cfg = cfgFor(`llm:
  extraBody: { chat_template_kwargs: { foo: 1 } }
  models:
    m: { id: m, effortBody: { none: { chat_template_kwargs: { enable_thinking: false } } } }
  chains:
    agent: [{ model: m, effort: none }]
    job: [{ model: m, effort: none }]
    gate: [{ model: m, effort: none }]
    summary: [{ model: m, effort: none }]
`);
    const { policy } = createGateway(cfg);
    let payload: unknown;
    const complete = async (_c: never, o: { onPayload: (p: unknown) => unknown }) => {
      payload = o.onPayload({ model: "m", chat_template_kwargs: { from_pi: true } });
      return ok;
    };
    await new PiLlmClient({ complete: complete as never, policy, extraBody: cfg.llm.extraBody, timeoutMs: 1000, maxRetries: 0 }).chat(hi);
    expect(payload).toEqual({ model: "m", chat_template_kwargs: { from_pi: true, foo: 1, enable_thinking: false } });
  });
});

describe("chains against a fake gateway", () => {
  let server: Server | undefined;
  afterEach(() => void server?.close());

  /** OpenAI-compatible gateway: the status per model id (default 200), recording every request body. */
  async function fakeGateway(status: (model: string) => number = () => 200) {
    const seen: Record<string, unknown>[] = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const b = JSON.parse(body) as Record<string, unknown>;
        seen.push(b);
        const code = status(String(b.model));
        if (code !== 200) return void res.writeHead(code).end("nope");
        const chunks = [
          { id: "c", object: "chat.completion.chunk", model: b.model, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
          { id: "c", object: "chat.completion.chunk", model: b.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
        ];
        res.writeHead(200, { "content-type": "text/event-stream" }).end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
  }
  const yamlFor = (url: string, models: string, chainsYaml: string, extra = "") =>
    `llm:\n  baseUrl: ${url}\n  maxRetries: 0\n${extra}  models:\n${models}  chains:\n${chainsYaml}`;
  const allOn = (entries: string) => ["agent", "job", "gate", "summary"].map((c) => `    ${c}: ${entries}\n`).join("");
  const hi = [{ role: "user" as const, content: "hi" }];

  it("sends the effort the way the model's compat asks for (deepseek thinking switch / OpenAI reasoning_effort)", async () => {
    const gw = await fakeGateway();
    const models = `    ds: { id: ds-model, reasoning: true, compat: { thinkingFormat: deepseek, supportsReasoningEffort: true }, thinkingLevelMap: { max: max }, effortBody: { none: { extra_off: true } } }
    oa: { id: oa-model, reasoning: true, compat: { supportsReasoningEffort: true } }
`;
    const chainsYaml = `    agent: [{ model: ds, effort: max }]
    job: [{ model: oa, effort: high }]
    gate: [{ model: ds, effort: none }]
    summary: [{ model: oa, effort: none }]
`;
    const cfg = cfgFor(yamlFor(gw.url, models, chainsYaml));
    const llm = createLlm(cfg);
    const results = [];
    for (const chain of ["agent", "gate", "job", "summary"] as const) results.push(await llm.chat(hi, { chain }));

    expect(gw.seen[0]).toMatchObject({ model: "ds-model", thinking: { type: "enabled" }, reasoning_effort: "max" });
    expect(gw.seen[1]).toMatchObject({ model: "ds-model", thinking: { type: "disabled" }, extra_off: true });
    expect(gw.seen[1]).not.toHaveProperty("reasoning_effort");
    expect(gw.seen[2]).toMatchObject({ model: "oa-model", reasoning_effort: "high" });
    expect(gw.seen[2]).not.toHaveProperty("thinking");
    expect(gw.seen[3]).not.toHaveProperty("reasoning_effort");
    expect(results.map((r) => [r.model, r.effort])).toEqual([["ds-model", "max"], ["ds-model", "none"], ["oa-model", "high"], ["oa-model", "none"]]);
  });

  it("routes purposes to chains: router to gate, the rest to summary; the router client always uses gate", async () => {
    const gw = await fakeGateway();
    const models = "    g: { id: gate-model }\n    s: { id: summary-model }\n    a: { id: agent-model }\n";
    const chainsYaml = "    agent: [{ model: a }]\n    job: [{ model: a }]\n    gate: [{ model: g }]\n    summary: [{ model: s }]\n";
    const cfg = cfgFor(yamlFor(gw.url, models, chainsYaml));
    const gateway = createGateway(cfg);
    const llm = createLlm(cfg, { gateway });
    for (const purpose of ["router", "notes", "summary", "fileSummary", "answer"] as const) await llm.chat(hi, { purpose });
    await llm.chat(hi);
    await createLlm(cfg, { role: "router", gateway }).chat(hi, { purpose: "summary" });
    expect(gw.seen.map((b) => b.model)).toEqual(["gate-model", "summary-model", "summary-model", "summary-model", "summary-model", "summary-model", "gate-model"]);
  });

  it("single-model config sends no reasoning fields and reports the model without an effort", async () => {
    const gw = await fakeGateway();
    const r = await createLlm(cfgFor("llm:\n  reasoning: true\n", { LLM_BASE_URL: gw.url, LLM_MODEL: "gw-model" })).chat(hi);
    expect(gw.seen[0]).toMatchObject({ model: "gw-model" });
    for (const k of ["reasoning_effort", "thinking", "enable_thinking", "chat_template_kwargs"]) expect(gw.seen[0]).not.toHaveProperty(k);
    expect(r).toMatchObject({ text: "ok", model: "gw-model" });
    expect(r).not.toHaveProperty("effort");
  });

  it("opens the breaker after 5 failed calls (a wrong model name counts), fails fast, and recovers after the cooldown", async () => {
    let broken = true;
    const gw = await fakeGateway(() => (broken ? 404 : 200));
    let t = 0;
    const states: string[] = [];
    const cfg = cfgFor(yamlFor(gw.url, "    m: { id: missing-model }\n", allOn("[{ model: m }]")));
    const llm = createLlm(cfg, { gateway: createGateway(cfg, { now: () => t, onBreakerChange: (m, s) => states.push(`${m}:${s}`) }) });

    for (let i = 0; i < 5; i++) await expect(llm.chat(hi)).rejects.not.toThrow(ModelUnavailableError);
    await expect(llm.chat(hi)).rejects.toThrow(ModelUnavailableError);
    expect(gw.seen).toHaveLength(5); // the 6th never reached the gateway

    broken = false;
    t += 120_000;
    expect((await llm.chat(hi)).text).toBe("ok"); // the probe
    expect((await llm.chat(hi)).text).toBe("ok");
    expect(states).toEqual(["missing-model:open", "missing-model:half-open", "missing-model:closed"]);
  });

  it("falls over to the next model of the chain while the first one's breaker is open", async () => {
    const gw = await fakeGateway((m) => (m === "first" ? 503 : 200));
    const cfg = cfgFor(yamlFor(gw.url, "    a: { id: first }\n    b: { id: second }\n", allOn("[{ model: a }, { model: b }]"), "  failover: { breaker: { failures: 2 } }\n"));
    const llm = createLlm(cfg);
    await expect(llm.chat(hi)).rejects.toThrow();
    await expect(llm.chat(hi)).rejects.toThrow();
    const r = await llm.chat(hi);
    expect(r.model).toBe("second");
    expect(gw.seen.map((b) => b.model)).toEqual(["first", "first", "second"]);
  });
});
