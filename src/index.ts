import { pino } from "pino";
import { createLlm, type LlmClient } from "./agent/llm.js";
import { createGateway } from "./agent/models.js";
import { CHAINS, inputBudgetTokens, llmConfigured, loadConfig } from "./config/index.js";
import { createSlack } from "./gateway/slack.js";
import { Router } from "./router/index.js";
import { allSkills, selectSkills } from "./skills/registry.js";
import { HttpOnyxClient, type OnyxClient } from "./tools/onyx.js";

// Kubernetes sends SIGTERM then waits terminationGracePeriodSeconds (default 30s) before SIGKILL.
const DRAIN_TIMEOUT_MS = 20_000;

const cfg = loadConfig();
const log = pino({ level: cfg.logLevel });

// Optional integrations: the bot still starts without them and tells users what is missing.
let llm: LlmClient | undefined;
let routerLlm: LlmClient | undefined;
if (llmConfigured(cfg.llm)) {
  const gateway = createGateway(cfg, {
    onBreakerChange: (model, state) =>
      state === "closed" ? log.info({ model, breaker: state }, "llm model available again") : log.warn({ model, breaker: state }, "llm model circuit breaker"),
  });
  llm = createLlm(cfg, { gateway });
  routerLlm = createLlm(cfg, { role: "router", gateway });
  const chains = Object.fromEntries(
    CHAINS.map((c) => [c, gateway.policy.steps(c).map((s) => (s.effort ? `${s.model.id}@${s.effort}` : s.model.id))]),
  );
  log.info({ chains }, "llm configured");
} else log.warn("no LLM configured (llm.model or llm.chains); requests cannot be routed until it is");

let onyx: OnyxClient | undefined;
if (cfg.onyx.baseUrl) {
  onyx = new HttpOnyxClient({
    baseUrl: cfg.onyx.baseUrl,
    ingestionPath: cfg.onyx.ingestionPath,
    searchPath: cfg.onyx.searchPath,
    ccPairId: cfg.onyx.ccPairId,
    apiKey: cfg.secrets.onyxApiKey,
  });
} else log.warn("onyx.baseUrl is not set; knowledge collection is disabled");

const skills = selectSkills(allSkills(), cfg.skills.disabled);
log.info({ skills: skills.map((s) => s.name), disabled: cfg.skills.disabled }, "skills registered");

const { app, drain } = createSlack(cfg, log, ({ notifier, slack }) =>
  new Router({
    botName: cfg.bot.name,
    notifier,
    llm: routerLlm,
    log,
    skills,
    context: () =>
      llm && {
        notifier,
        slack,
        llm,
        onyx,
        log,
        botName: cfg.bot.name,
        allowPrivateChannels: cfg.slack.allowPrivateChannels,
        attachments: {
          enabled: cfg.attachments.enabled,
          maxFileBytes: Math.floor(cfg.attachments.maxFileMb * 1024 * 1024),
          maxFiles: cfg.attachments.maxFiles,
          maxTextChars: cfg.attachments.maxTextChars,
          summarize: cfg.attachments.summarize,
        },
        maxSearchResults: cfg.onyx.maxResults,
        maxInputTokens: inputBudgetTokens(cfg.llm),
        charsPerToken: cfg.llm.charsPerToken,
      },
  }),
);
await app.start(cfg.slack.port);
log.info({ port: cfg.slack.port, bot: cfg.bot.name }, "neotags started");

let shuttingDown = false;
async function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ sig }, "shutting down");
  let code = 0;
  try {
    await app.stop(); // stop accepting new events
  } catch (err) {
    log.error({ err }, "failed to stop cleanly");
    code = 1;
  }
  if (!(await drain(DRAIN_TIMEOUT_MS))) {
    log.warn("timed out waiting for in-flight tasks");
    code = 1;
  }
  process.exit(code);
}
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void shutdown(sig));
