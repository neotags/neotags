import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const fileSchema = z.object({
  bot: z.object({ name: z.string().min(1).default("neotags") }).prefault({}),
  slack: z
    .object({
      port: z.number().int().default(3000),
      // empty = every public channel the bot is a member of
      allowedChannels: z.array(z.string()).default([]),
      // empty = everyone in the workspace
      allowedUsers: z.array(z.string()).default([]),
      // Record threads from private channels too (bot must be invited; needs groups:read + groups:history).
      // Off by default: KB entries are visible to everyone who can search the KB. DMs are never recorded.
      allowPrivateChannels: z.boolean().default(false),
    })
    .prefault({}),
  onyx: z
    .object({
      baseUrl: z.string().url().optional(),
      ingestionPath: z.string().default("/api/ingestion"),
      searchPath: z.string().default("/api/search"),
      ccPairId: z.number().int().default(1),
      // Sections fetched from Onyx to answer one question.
      maxResults: z.number().int().positive().default(8),
    })
    .prefault({}),
  // Slack files (PDF, Word, Excel, PowerPoint, text, HTML) read into the KB alongside recorded threads.
  attachments: z
    .object({
      enabled: z.boolean().default(true),
      maxFileMb: z.number().positive().default(25),
      // Per request; the rest are listed as skipped.
      maxFiles: z.number().int().positive().default(10),
      // Extracted text kept per file.
      maxTextChars: z.number().int().positive().default(600_000),
      // One LLM call per file writes a catalogue entry (what it is, contents, key facts) stored with its text.
      summarize: z.boolean().default(true),
    })
    .prefault({}),
  // Any OpenAI-compatible endpoint (OpenAI, LiteLLM, vLLM, an internal AI gateway, ...), driven by pi-ai.
  // baseUrl / model / routerModel can also be set with LLM_BASE_URL / LLM_MODEL / LLM_ROUTER_MODEL; the key only via LLM_API_KEY.
  llm: z
    .object({
      baseUrl: z.string().url().default("https://api.openai.com/v1"),
      model: z.string().min(1).optional(),
      // Optional smaller/faster model (same gateway and key) for intent routing; defaults to `model`.
      routerModel: z.string().min(1).optional(),
      contextWindow: z.number().int().positive().default(128_000),
      maxTokens: z.number().int().positive().default(8192),
      reasoning: z.boolean().default(false),
      timeoutMs: z.number().int().positive().default(60_000),
      maxRetries: z.number().int().min(0).default(2),
      // Per-gateway quirks (pi-ai `compat`); e.g. LiteLLM needs supportsStore: false.
      compat: z
        .object({
          supportsStore: z.boolean().optional(),
          supportsDeveloperRole: z.boolean().optional(),
          supportsReasoningEffort: z.boolean().optional(),
          supportsUsageInStreaming: z.boolean().optional(),
        })
        .prefault({}),
      // Extra JSON fields added to every chat request, for gateway-specific switches, e.g. turning off
      // thinking on a reasoning model: { chat_template_kwargs: { enable_thinking: false } }.
      extraBody: z.record(z.string(), z.unknown()).prefault({}),
      // Sampling temperature for every call. Some reasoning models only accept their own default; set the
      // gateway's required value here, or drop it with `null`.
      temperature: z.number().min(0).max(2).nullable().default(0),
      // Output budget (tokens) per kind of call. Reasoning models spend it thinking too, so give them room.
      outputTokens: z
        .object({
          router: z.number().int().positive().default(200), // pick a skill: one small JSON object
          notes: z.number().int().positive().default(1500), // working notes for one part of a long thread
          summary: z.number().int().positive().default(3000), // thread summary (the whole KB entry)
          fileSummary: z.number().int().positive().default(1200), // description, contents, key facts of a file
          answer: z.number().int().positive().default(1200), // kb-ask answer
        })
        .prefault({}),
      // Prompt budget for summaries and answers, in tokens. Default: half the context window minus the
      // summary output budget, so it follows the model (see `inputBudgetTokens`).
      summarizeMaxInputTokens: z.number().int().positive().optional(),
      // Rough size of a token in characters, to turn token budgets into character budgets.
      charsPerToken: z.number().positive().default(4),
    })
    .prefault({}),
  logLevel: z.string().default("info"),
});

export interface Secrets {
  slackBotToken: string;
  slackSigningSecret: string;
  onyxApiKey?: string;
  /** Bearer key for the LLM gateway; optional for gateways that need none. */
  llmApiKey?: string;
}

export type Config = z.infer<typeof fileSchema> & { secrets: Secrets };

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`missing required env var ${key}`);
  return v;
}

function parseJsonEnv(key: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`env var ${key} is not valid JSON`);
  }
}

/** Prompt budget in tokens: the explicit setting, else half the context window minus the summary output. */
export function inputBudgetTokens(llm: Config["llm"]): number {
  return llm.summarizeMaxInputTokens ?? Math.max(1000, Math.floor(llm.contextWindow / 2) - llm.outputTokens.summary);
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): Config {
  const path = env.NEOTAGS_CONFIG;
  const raw = path ? (parse(read(path)) ?? {}) : {};
  const llmEnv = {
    ...(env.LLM_BASE_URL && { baseUrl: env.LLM_BASE_URL }),
    ...(env.LLM_MODEL && { model: env.LLM_MODEL }),
    ...(env.LLM_ROUTER_MODEL && { routerModel: env.LLM_ROUTER_MODEL }),
    // Numbers arrive as strings; a bad value becomes NaN and fails validation with the field name.
    ...(env.LLM_CONTEXT_WINDOW && { contextWindow: Number(env.LLM_CONTEXT_WINDOW) }),
    ...(env.LLM_MAX_TOKENS && { maxTokens: Number(env.LLM_MAX_TOKENS) }),
    ...(env.LLM_EXTRA_BODY && { extraBody: parseJsonEnv("LLM_EXTRA_BODY", env.LLM_EXTRA_BODY) }),
  };
  const file = fileSchema.parse({ ...raw, llm: { ...raw.llm, ...llmEnv } });
  return {
    ...file,
    secrets: {
      slackBotToken: required(env, "SLACK_BOT_TOKEN"),
      slackSigningSecret: required(env, "SLACK_SIGNING_SECRET"),
      onyxApiKey: env.ONYX_API_KEY,
      llmApiKey: env.LLM_API_KEY || undefined,
    },
  };
}
