import {
  createModels,
  createProvider,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { CHAINS, type ChainName, type Config, type Effort } from "../config/index.js";
import { CircuitBreaker, type BreakerState, type Lease } from "./breaker.js";

export const GATEWAY_PROVIDER = "gateway";
const KEYLESS_PLACEHOLDER = "not-needed";

export type GatewayModel = Model<"openai-completions">;

/** One chain entry, resolved: the model to call, its reasoning effort, and its breaker (one per model, shared by chains). */
export interface ChainStep {
  /** Key in llm.models ("default" / "router" in the single-model setup). */
  key: string;
  model: GatewayModel;
  effort?: Effort;
  finalEffort?: Effort;
  /** Extra request fields per effort (llm.models.<key>.effortBody). */
  effortBody?: Partial<Record<Effort, Record<string, unknown>>>;
  breaker: CircuitBreaker;
}

/** Picks the model for a use: the first entry of its chain whose breaker lets a call through. */
export class ModelPolicy {
  constructor(private chains: Record<ChainName, ChainStep[]>) {}

  /**
   * Undefined when every model of the chain is unavailable; the caller degrades. The lease is the call's slot
   * on the model's breaker: report the call's outcome on it once, with `success()`, `failure()` or `release()`.
   */
  pick(chain: ChainName): { step: ChainStep; lease: Lease } | undefined {
    for (const step of this.chains[chain]) {
      const lease = step.breaker.acquire();
      if (lease) return { step, lease };
    }
    return undefined;
  }

  /** The chain as configured, without touching breakers. */
  steps(chain: ChainName): readonly ChainStep[] {
    return this.chains[chain];
  }
}

export interface Gateway {
  models: Models;
  policy: ModelPolicy;
  /** First model of the agent chain (tool-using agents) and, in the single-model setup, of every chain but gate. */
  model: GatewayModel;
  /** First model of the gate chain (intent routing); the same object as `model` unless a separate model is set. */
  routerModel: GatewayModel;
}

export interface GatewayOptions {
  /** Called when a model's breaker opens, half-opens or closes. */
  onBreakerChange?: (model: string, state: BreakerState) => void;
  now?: () => number;
}

interface ModelSpec {
  id: string;
  reasoning: boolean;
  compat: Record<string, unknown>;
  thinkingLevelMap?: GatewayModel["thinkingLevelMap"];
  effortBody?: ChainStep["effortBody"];
}
type ChainEntry = { model: string; effort?: Effort; finalEffort?: Effort };

const defined = (o: object): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Models and chains from config. The single-model setup (`llm.model` / `llm.routerModel`) becomes chains without effort. */
function resolve(llm: Config["llm"]): { specs: Map<string, ModelSpec>; chains: Record<ChainName, ChainEntry[]> } {
  const compat = defined(llm.compat);
  if (llm.chains) {
    const specs = new Map<string, ModelSpec>();
    for (const [key, m] of Object.entries(llm.models)) {
      specs.set(key, {
        id: m.id,
        reasoning: m.reasoning ?? llm.reasoning,
        compat: { ...compat, ...defined(m.compat ?? {}) },
        ...(m.thinkingLevelMap && { thinkingLevelMap: m.thinkingLevelMap }),
        ...(m.effortBody && { effortBody: m.effortBody }),
      });
    }
    return { specs, chains: llm.chains };
  }
  if (!llm.model) {
    throw new Error("llm.model is not set (config file `llm.model` or env LLM_MODEL), and neither is llm.chains");
  }
  const specs = new Map<string, ModelSpec>([["default", { id: llm.model, reasoning: llm.reasoning, compat }]]);
  const gate = llm.routerModel && llm.routerModel !== llm.model ? "router" : "default";
  if (llm.routerModel && gate === "router") specs.set("router", { id: llm.routerModel, reasoning: llm.reasoning, compat });
  const only = (model: string): ChainEntry[] => [{ model }];
  return { specs, chains: { agent: only("default"), job: only("default"), gate: only(gate), summary: only("default") } };
}

/** Build the pi-ai model registry and the model policy for the configured OpenAI-compatible gateway. */
export function createGateway(cfg: Config, opts: GatewayOptions = {}): Gateway {
  const { llm, secrets } = cfg;
  const { specs, chains } = resolve(llm);
  const b = llm.failover.breaker;
  const byKey = new Map<string, { model: GatewayModel; spec: ModelSpec; breaker: CircuitBreaker }>();
  for (const [key, spec] of specs) {
    const model: GatewayModel = {
      id: spec.id,
      name: spec.id,
      api: "openai-completions",
      provider: GATEWAY_PROVIDER,
      baseUrl: llm.baseUrl,
      reasoning: spec.reasoning,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: llm.contextWindow,
      maxTokens: llm.maxTokens,
      ...(Object.keys(spec.compat).length > 0 && { compat: spec.compat }),
      ...(spec.thinkingLevelMap && { thinkingLevelMap: spec.thinkingLevelMap }),
    };
    const onChange = opts.onBreakerChange;
    const breaker = new CircuitBreaker({
      failures: b.failures,
      windowMs: b.windowSec * 1000,
      cooldownMs: b.cooldownSec * 1000,
      ...(opts.now && { now: opts.now }),
      ...(onChange && { onChange: (s: BreakerState) => onChange(spec.id, s) }),
    });
    byKey.set(key, { model, spec, breaker });
  }

  const steps = {} as Record<ChainName, ChainStep[]>;
  for (const name of CHAINS) {
    steps[name] = chains[name].map((e) => {
      const m = byKey.get(e.model);
      if (!m) throw new Error(`llm.chains.${name}: unknown model "${e.model}"`);
      return {
        key: e.model,
        model: m.model,
        breaker: m.breaker,
        ...(e.effort && { effort: e.effort }),
        ...(e.finalEffort && { finalEffort: e.finalEffort }),
        ...(m.spec.effortBody && { effortBody: m.spec.effortBody }),
      };
    });
  }

  const provider = createProvider({
    id: GATEWAY_PROVIDER,
    name: "LLM gateway",
    baseUrl: llm.baseUrl,
    // Bearer key from LLM_API_KEY. pi-ai refuses to call a provider without any key, so a keyless
    // gateway gets a placeholder, which such gateways ignore.
    auth: {
      apiKey: {
        name: "LLM gateway",
        resolve: async () => ({ auth: { apiKey: secrets.llmApiKey || KEYLESS_PLACEHOLDER } }),
      },
    },
    models: [...byKey.values()].map((m) => m.model),
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, policy: new ModelPolicy(steps), model: steps.agent[0]!.model, routerModel: steps.gate[0]!.model };
}
