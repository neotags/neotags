import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const EFFORTS = ["none", "low", "medium", "high", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const CHAINS = ["agent", "job", "gate", "summary"] as const;
export type ChainName = (typeof CHAINS)[number];
/** Where an agent run comes from; budgets and default skill packs are set per source. */
export const RUN_SOURCES = ["o2", "slack", "job"] as const;
export type RunSource = (typeof RUN_SOURCES)[number];
/** An O2 org identifier (the `{org}` of its API paths). */
export const O2_ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;

const effortSchema = z.enum(EFFORTS);

// Per-gateway quirks (pi-ai `compat`), for the whole gateway (llm.compat) or one model (llm.models.<key>.compat).
const compatSchema = z.object({
  // e.g. LiteLLM needs supportsStore: false.
  supportsStore: z.boolean().optional(),
  // With `reasoning: true` pi-ai sends the system prompt as a "developer" message. OpenAI-compatible
  // gateways that don't know that role drop it without an error, so every call silently loses its
  // instructions (and the untrusted-input rules). "system" works everywhere, so it is the default.
  supportsDeveloperRole: z.boolean().optional(),
  supportsReasoningEffort: z.boolean().optional(),
  supportsUsageInStreaming: z.boolean().optional(),
  // How the effort reaches the gateway: "openai" (reasoning_effort), "deepseek" (thinking + reasoning_effort),
  // "qwen", "chat-template", ... (see pi-ai). Unset: reasoning_effort when supportsReasoningEffort is on.
  thinkingFormat: z
    .enum(["openai", "openrouter", "deepseek", "together", "baseten", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"])
    .optional(),
});

const modelSchema = z.object({
  // Model id on the gateway.
  id: z.string().min(1),
  // Only OpenAI-compatible gateways today; the field is here so another API is a config change.
  api: z.literal("openai-completions").default("openai-completions"),
  // Defaults to llm.reasoning. A chain entry with an effort other than "none" needs a reasoning model.
  reasoning: z.boolean().optional(),
  // Merged over llm.compat.
  compat: compatSchema.optional(),
  // Gateway value per pi-ai thinking level, e.g. { max: max } to allow "max"; null marks a level unsupported.
  thinkingLevelMap: z.partialRecord(z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]), z.string().nullable()).optional(),
  // Extra request fields per effort, merged after llm.extraBody, e.g. { none: { chat_template_kwargs: { enable_thinking: false } } }.
  effortBody: z.partialRecord(effortSchema, z.record(z.string(), z.unknown())).optional(),
});

// effort: reasoning effort of every step; finalEffort: of the last step of a tool-using agent run.
// Unset effort sends no reasoning setting at all, leaving the gateway's default.
const chainEntrySchema = z.object({
  model: z.string().min(1),
  effort: effortSchema.optional(),
  finalEffort: effortSchema.optional(),
});
const chainSchema = z.array(chainEntrySchema).min(1);

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
  skills: z
    .object({
      // Skills to leave out (kb-collect, kb-files, kb-ask), e.g. while one is not good enough yet. They are
      // not registered: the router does not offer them and their buttons stop working. Unknown names fail at startup.
      disabled: z.array(z.string()).default([]),
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
      // Single-model setup: one model for everything. Ignored when `chains` is set.
      model: z.string().min(1).optional(),
      // Optional smaller/faster model (same gateway and key) for intent routing; defaults to `model`.
      routerModel: z.string().min(1).optional(),
      // Models on the gateway, by a local key that chains refer to.
      models: z.record(z.string().min(1), modelSchema).default({}),
      // Models per use, tried in order (the next one when a model's breaker is open). Unset: built from
      // `model` / `routerModel` with no effort, which is exactly the single-model behaviour.
      chains: z
        .object({ agent: chainSchema, job: chainSchema, gate: chainSchema, summary: chainSchema })
        .optional(),
      failover: z
        .object({
          // Agent runs stream; a request with no first token (text, thinking or tool call) by then is aborted
          // and retried like a gateway error.
          firstTokenTimeoutSec: z.number().positive().default(30),
          // Per model: `failures` within `windowSec` open it; after `cooldownSec` one probe call is let through.
          breaker: z
            .object({
              failures: z.number().int().positive().default(5),
              windowSec: z.number().positive().default(60),
              cooldownSec: z.number().positive().default(120),
            })
            .prefault({}),
        })
        .prefault({}),
      contextWindow: z.number().int().positive().default(128_000),
      maxTokens: z.number().int().positive().default(8192),
      reasoning: z.boolean().default(false),
      // A one-shot call's deadline, retries included; agent runs abort a stream that stalls this long.
      timeoutMs: z.number().int().positive().default(60_000),
      maxRetries: z.number().int().min(0).default(2),
      compat: compatSchema.extend({ supportsDeveloperRole: z.boolean().default(false) }).prefault({}),
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
    .superRefine((llm, ctx) => {
      for (const name of CHAINS) {
        (llm.chains?.[name] ?? []).forEach((entry, i) => {
          const path = ["chains", name, i, "model"];
          const model = llm.models[entry.model];
          if (!model) return ctx.addIssue({ code: "custom", path, message: `unknown model "${entry.model}" (not in llm.models)` });
          const thinks = [entry.effort, entry.finalEffort].some((e) => e !== undefined && e !== "none");
          if (thinks && !(model.reasoning ?? llm.reasoning)) {
            ctx.addIssue({ code: "custom", path, message: `model "${entry.model}" is not a reasoning model; only effort "none" applies` });
          }
          // Agent runs stream through pi-ai, which lowers a level the model does not map; "max" must be mapped.
          const max = [entry.effort, entry.finalEffort].includes("max");
          if (name === "agent" && max && typeof model.thinkingLevelMap?.max !== "string") {
            ctx.addIssue({ code: "custom", path, message: `model "${entry.model}" needs thinkingLevelMap.max for effort "max" in the agent chain` });
          }
        });
      }
    })
    .prefault({}),
  // Tool-using agent runs (RunManager): budgets, concurrency and the skill packs each entry starts with.
  agent: z
    .object({
      // Skill packs whose SKILL.md is in the system prompt of every run from that entry (o2, slack, job).
      entries: z.partialRecord(z.enum(RUN_SOURCES), z.array(z.string().min(1))).default({}),
      // Tool-calling turns per run; then the model answers with what it has.
      maxSteps: z.number().int().positive().default(30),
      // Wall clock per run, by entry. The last `finalReserveSec` are kept for the final answer.
      wallClockSec: z
        .object({
          slack: z.number().positive().default(360),
          o2: z.number().positive().default(600),
          job: z.number().positive().default(600),
        })
        .prefault({}),
      finalReserveSec: z.number().nonnegative().default(90),
      // Prompt budget of one request; the oldest tool outputs are stubbed out first.
      maxInputTokens: z.number().int().positive().default(100_000),
      concurrency: z
        .object({
          // Runs at once across all entries; more wait in a FIFO queue.
          total: z.number().int().positive().default(4),
          // Per user (or per session when the user is unknown).
          perUserPerHour: z.number().int().positive().default(20),
        })
        .prefault({}),
      // On shutdown, how long running runs may finish; keep below terminationGracePeriodSeconds.
      drainSec: z.number().positive().default(640),
      // One MCP tool output, after redaction; longer output is cut and the model is told to narrow the query.
      toolOutputChars: z.number().int().positive().default(16_000),
      // Enforced by the tool guard on SearchSQL and PrometheusRangeQuery calls, direct or through tools_call.
      queryLimits: z
        .object({
          // A query without a time range gets the last `defaultRangeSec`; one longer than `maxRangeSec` is refused.
          defaultRangeSec: z.number().int().positive().default(3600),
          maxRangeSec: z.number().int().positive().default(86_400),
          // SQL without a LIMIT gets `sqlDefaultLimit`; a LIMIT above `sqlMaxLimit` is refused.
          sqlDefaultLimit: z.number().int().positive().default(100),
          sqlMaxLimit: z.number().int().positive().default(1000),
          // PromQL range queries: points per series at most.
          promMaxPoints: z.number().int().min(2).default(1000),
        })
        .superRefine((q, ctx) => {
          // A default above its limit would make every query that relies on the default fail the check.
          if (q.defaultRangeSec > q.maxRangeSec) ctx.addIssue({ code: "custom", path: ["defaultRangeSec"], message: "must not exceed maxRangeSec" });
          if (q.sqlDefaultLimit > q.sqlMaxLimit) ctx.addIssue({ code: "custom", path: ["sqlDefaultLimit"], message: "must not exceed sqlMaxLimit" });
        })
        .prefault({}),
    })
    .prefault({}),
  // MCP servers (Streamable HTTP) whose allowlisted tools the agent gets, named <server>__<tool>.
  mcp: z
    .object({
      servers: z
        .array(
          z.object({
            // Prefix of the tool names; no underscores, so the first "__" in a tool name ends the server name.
            name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
            url: z.string().url(),
            // Request headers whose values come from env vars, e.g. { Authorization: O2_MCP_AUTH }. Never the value itself.
            headersFromEnv: z.record(z.string().min(1), z.string().min(1)).default({}),
            // Only these tools (names as the server lists them) are offered to the model.
            allowTools: z.array(z.string().min(1)).min(1),
            // O2 tools_call: the inner tool must be listed here; without it every tools_call is refused.
            innerAllow: z.array(z.string().min(1)).optional(),
            // Per tool, the values a parameter may take, e.g. { alerting_manage_rules: { operation: [list, get] } }.
            // Also applies to the inner tool of a tools_call.
            argAllow: z.record(z.string().min(1), z.record(z.string().min(1), z.array(z.string()).min(1))).default({}),
          }),
        )
        .default([])
        .superRefine((servers, ctx) => {
          const seen = new Set<string>();
          servers.forEach((s, i) => {
            if (seen.has(s.name)) ctx.addIssue({ code: "custom", path: [i, "name"], message: `duplicate MCP server "${s.name}"` });
            seen.add(s.name);
          });
        }),
      // Arguments of one call, as JSON.
      maxArgChars: z.number().int().positive().default(16_000),
      connectTimeoutSec: z.number().positive().default(10),
      callTimeoutSec: z.number().positive().default(60),
      // A server that is down is retried in the background, backing off up to this.
      reconnectMaxSec: z.number().positive().default(300),
    })
    .prefault({}),
  // Skill packs (Agent Skills: <pack>/SKILL.md + references/) mounted read-only. Only these files are loaded.
  skillPacks: z
    .object({
      dir: z.string().min(1).optional(),
      // Whole packs: SKILL.md and every file under references/.
      packs: z.array(z.string().min(1)).default([]),
      // Single reference files of other packs, relative to the pack's references/ (e.g. data/x.json).
      refs: z.record(z.string().min(1), z.array(z.string().min(1))).default({}),
      maxFileKb: z.number().positive().default(256),
    })
    .prefault({}),
  // Where skill-pack commands run (§13 of the design). Only packs whose front matter declares `sandbox` may run
  // anything, and only the declared tools, hosts, credentials and limits. Nothing ever runs in this process.
  sandbox: z
    .object({
      // none: every execution is refused. local: the executor sidecar in the Pod (executor/README.md).
      backend: z.enum(["none", "local"]).default("none"),
      // The executor's unix socket, on an emptyDir shared with the sidecar.
      socket: z.string().min(1).default("/run/executor/exec.sock"),
    })
    .prefault({}),
  // The OpenObserve AI assistant entry (docs/design/002-o2-gateway-contract.md): O2 forwards each chat turn here and
  // pipes the SSE answer to the panel. Its own port, for in-cluster callers only; the key is O2_AGENT_API_KEY.
  o2Gateway: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().min(1).max(65535).default(3001),
      // O2 org identifier -> MCP server that queries it, e.g. { default: o2, <org id>: o2prod }. Decides the run's
      // default org, and which queries get the panel's "View in Logs" button (only the current org's).
      orgs: z.record(z.string().regex(O2_ORG_ID, "an O2 org identifier"), z.string().min(1)).default({}),
      // Request body (the turn's history and page context); larger is refused.
      maxBodyKb: z.number().int().positive().default(4096),
      // Earlier turns kept for the model, newest first; older ones are dropped.
      maxHistoryChars: z.number().int().positive().default(48_000),
      // Runs waiting for a slot (all entries); beyond it a turn is refused with 429 turn_limit instead of queued.
      maxQueued: z.number().int().positive().default(8),
    })
    .prefault({}),
  // LLM traces over OTLP (OpenObserve, Langfuse, an OTel collector). The exporter is configured with the standard
  // OTEL_EXPORTER_OTLP_* env vars; tracing is off unless an endpoint is set.
  telemetry: z
    .object({
      // Put prompts, replies and tool input/output on spans (redacted), for judging answer quality. Off by default:
      // they carry Slack threads, files and O2 query results, and whoever can read the traces can read them. Or env
      // OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true.
      captureContent: z.boolean().default(false),
    })
    .prefault({}),
  logLevel: z.string().default("info"),
}).superRefine((cfg, ctx) => {
  const servers = new Set(cfg.mcp.servers.map((s) => s.name));
  // One server per org: "current org" is decided by the server a query went through.
  const taken = new Map<string, string>();
  for (const [org, server] of Object.entries(cfg.o2Gateway.orgs)) {
    if (!servers.has(server)) ctx.addIssue({ code: "custom", path: ["o2Gateway", "orgs", org], message: `MCP server "${server}" is not in mcp.servers` });
    const other = taken.get(server);
    if (other !== undefined) ctx.addIssue({ code: "custom", path: ["o2Gateway", "orgs", org], message: `MCP server "${server}" already queries org ${other}` });
    taken.set(server, org);
  }
  for (const [entry, packs] of Object.entries(cfg.agent.entries)) {
    (packs ?? []).forEach((p, i) => {
      if (!cfg.skillPacks.packs.includes(p)) {
        ctx.addIssue({ code: "custom", path: ["agent", "entries", entry, i], message: `skill pack "${p}" is not in skillPacks.packs` });
      }
    });
  }
});

export interface Secrets {
  slackBotToken: string;
  slackSigningSecret: string;
  onyxApiKey?: string;
  /** Bearer key for the LLM gateway; optional for gateways that need none. */
  llmApiKey?: string;
  /** Shared secret O2 sends as x-o2-agent-key; required when o2Gateway is enabled. */
  o2AgentKey?: string;
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

/** Is any model configured, through `chains` or the single `model`? */
export function llmConfigured(llm: Config["llm"]): boolean {
  return llm.chains !== undefined || llm.model !== undefined;
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
  // Comma-separated; set but empty means "none disabled" and overrides the file.
  const skillsEnv =
    env.NEOTAGS_DISABLED_SKILLS !== undefined
      ? { disabled: env.NEOTAGS_DISABLED_SKILLS.split(",").map((s) => s.trim()).filter(Boolean) }
      : {};
  const capture = env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
  const telemetryEnv = capture !== undefined ? { captureContent: capture.trim().toLowerCase() === "true" } : {};
  const file = fileSchema.parse({
    ...raw,
    llm: { ...raw.llm, ...llmEnv },
    skills: { ...raw.skills, ...skillsEnv },
    telemetry: { ...raw.telemetry, ...telemetryEnv },
  });
  return {
    ...file,
    secrets: {
      slackBotToken: required(env, "SLACK_BOT_TOKEN"),
      slackSigningSecret: required(env, "SLACK_SIGNING_SECRET"),
      onyxApiKey: env.ONYX_API_KEY,
      llmApiKey: env.LLM_API_KEY || undefined,
      o2AgentKey: file.o2Gateway.enabled ? required(env, "O2_AGENT_API_KEY") : undefined,
    },
  };
}
