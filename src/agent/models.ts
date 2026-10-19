import {
  createModels,
  createProvider,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Config } from "../config/index.js";

export const GATEWAY_PROVIDER = "gateway";
const KEYLESS_PLACEHOLDER = "not-needed";

export interface Gateway {
  models: Models;
  /** Main model: summaries and tool-using agents. */
  model: Model<"openai-completions">;
  /** Model for intent routing; the same object as `model` unless `llm.routerModel` is set. */
  routerModel: Model<"openai-completions">;
}

/** Build the pi-ai model registry for the configured OpenAI-compatible gateway (base URL, model, key). */
export function createGateway(cfg: Config): Gateway {
  const { llm, secrets } = cfg;
  if (!llm.model) {
    throw new Error("llm.model is not set (config file `llm.model` or env LLM_MODEL)");
  }
  const compat = Object.fromEntries(
    Object.entries(llm.compat).filter(([, v]) => v !== undefined),
  );
  const modelFor = (id: string): Model<"openai-completions"> => ({
    id,
    name: id,
    api: "openai-completions",
    provider: GATEWAY_PROVIDER,
    baseUrl: llm.baseUrl,
    reasoning: llm.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: llm.contextWindow,
    maxTokens: llm.maxTokens,
    ...(Object.keys(compat).length > 0 && { compat }),
  });
  const model = modelFor(llm.model);
  const routerModel = llm.routerModel && llm.routerModel !== llm.model ? modelFor(llm.routerModel) : model;
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
    models: routerModel === model ? [model] : [model, routerModel],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, model, routerModel };
}
