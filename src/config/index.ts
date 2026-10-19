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
    })
    .prefault({}),
  onyx: z
    .object({
      baseUrl: z.string().url().optional(),
      ingestionPath: z.string().default("/api/ingestion"),
      ccPairId: z.number().int().default(1),
    })
    .prefault({}),
  // Any OpenAI-compatible endpoint (OpenAI, LiteLLM, vLLM, an internal AI gateway, ...).
  // baseUrl / model can also be set with LLM_BASE_URL / LLM_MODEL; the key only via LLM_API_KEY.
  llm: z
    .object({
      baseUrl: z.string().url().default("https://api.openai.com/v1"),
      model: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().default(60_000),
      maxRetries: z.number().int().min(0).default(2),
      summarizeMaxInputTokens: z.number().int().default(60000),
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

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): Config {
  const path = env.NEOTAGS_CONFIG;
  const raw = path ? (parse(read(path)) ?? {}) : {};
  const llmEnv = {
    ...(env.LLM_BASE_URL && { baseUrl: env.LLM_BASE_URL }),
    ...(env.LLM_MODEL && { model: env.LLM_MODEL }),
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
