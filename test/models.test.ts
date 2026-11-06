import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CircuitBreaker, type BreakerState } from "../src/agent/breaker.js";
import { ModelUnavailableError, createLlm, effortRequest } from "../src/agent/llm.js";
import { createGateway } from "../src/agent/models.js";
import { loadConfig } from "../src/config/index.js";

const base = { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y" };
const cfgFor = (yaml: string, env: Record<string, string> = {}) => loadConfig({ ...base, NEOTAGS_CONFIG: "f", ...env }, () => yaml);

const chains = (body: string) => `llm:\n  baseUrl: http://gw.test/v1\n${body}`;
const flash = `  models:
    flash: { id: flash-model, reasoning: true }
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
    return { b, states, tick: (ms: number) => (t += ms) };
  };

  it("opens after 5 failures within the window and fails fast while open", () => {
    const { b, states } = make();
    for (let i = 0; i < 4; i++) b.failure();
    expect(b.tryAcquire()).toBe(true);
    b.failure();
    expect(b.state).toBe("open");
    expect(b.tryAcquire()).toBe(false);
    expect(states).toEqual(["open"]);
  });

  it("does not count failures older than the window", () => {
    const { b, tick } = make();
    for (let i = 0; i < 4; i++) b.failure();
    tick(60_000);
    b.failure();
    expect(b.state).toBe("closed");
  });

  it("lets one probe through after the cooldown; success closes", () => {
    const { b, states, tick } = make();
    for (let i = 0; i < 5; i++) b.failure();
    tick(119_999);
    expect(b.tryAcquire()).toBe(false);
    tick(1);
    expect(b.tryAcquire()).toBe(true); // the probe
    expect(b.tryAcquire()).toBe(false); // everyone else waits for it
    b.success();
    expect(b.state).toBe("closed");
    expect(b.tryAcquire()).toBe(true);
    expect(states).toEqual(["open", "half-open", "closed"]);
  });

  it("reopens for another cooldown when the probe fails; a released probe frees the slot", () => {
    const { b, tick } = make();
    for (let i = 0; i < 5; i++) b.failure();
    tick(120_000);
    expect(b.tryAcquire()).toBe(true);
    b.release();
    expect(b.tryAcquire()).toBe(true);
    b.failure();
    expect(b.state).toBe("open");
    tick(119_000);
    expect(b.tryAcquire()).toBe(false);
    tick(1_000);
    expect(b.state).toBe("half-open");
  });

  it("ignores failures reported while already open", () => {
    const { b, tick } = make();
    for (let i = 0; i < 5; i++) b.failure();
    tick(60_000);
    b.failure(); // a call that started before the breaker opened
    tick(60_000);
    expect(b.state).toBe("half-open");
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
    const models = `    ds: { id: ds-model, reasoning: true, compat: { thinkingFormat: deepseek, supportsReasoningEffort: true }, effortBody: { none: { extra_off: true } } }
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
