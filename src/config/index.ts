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
  llm: z
    .object({
      model: z.string().default("claude-sonnet-5-5"),
      summarizeMaxInputTokens: z.number().int().default(60000),
    })
    .prefault({}),
  logLevel: z.string().default("info"),
});

export interface Secrets {
  slackBotToken: string;
  slackSigningSecret: string;
  onyxApiKey?: string;
  anthropicApiKey?: string;
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
  const file = fileSchema.parse(raw);
  return {
    ...file,
    secrets: {
      slackBotToken: required(env, "SLACK_BOT_TOKEN"),
      slackSigningSecret: required(env, "SLACK_SIGNING_SECRET"),
      onyxApiKey: env.ONYX_API_KEY,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
    },
  };
}
