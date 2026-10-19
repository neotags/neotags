import { pino } from "pino";
import { createLlm, type LlmClient } from "./agent/llm.js";
import { createGateway } from "./agent/models.js";
import { loadConfig } from "./config/index.js";
import { createSlack } from "./gateway/slack.js";
import { Router } from "./router/index.js";
import { createKbCollect } from "./skills/kb-collect/index.js";
import { HttpOnyxClient, type OnyxClient } from "./tools/onyx.js";

// Kubernetes sends SIGTERM then waits terminationGracePeriodSeconds (default 30s) before SIGKILL.
const DRAIN_TIMEOUT_MS = 20_000;

const cfg = loadConfig();
const log = pino({ level: cfg.logLevel });

// Optional integrations: the bot still starts without them and tells users what is missing.
let llm: LlmClient | undefined;
let routerLlm: LlmClient | undefined;
if (cfg.llm.model) {
  const gateway = createGateway(cfg);
  llm = createLlm(cfg, { gateway });
  routerLlm = createLlm(cfg, { role: "router", gateway });
  log.info({ model: cfg.llm.model, routerModel: cfg.llm.routerModel ?? cfg.llm.model }, "llm configured");
} else log.warn("llm.model is not set; requests cannot be routed until it is configured");

let onyx: OnyxClient | undefined;
if (cfg.onyx.baseUrl) {
  onyx = new HttpOnyxClient({
    baseUrl: cfg.onyx.baseUrl,
    ingestionPath: cfg.onyx.ingestionPath,
    ccPairId: cfg.onyx.ccPairId,
    apiKey: cfg.secrets.onyxApiKey,
  });
} else log.warn("onyx.baseUrl is not set; knowledge collection is disabled");

const { app, drain } = createSlack(cfg, log, ({ notifier, slack }) =>
  new Router({
    botName: cfg.bot.name,
    notifier,
    llm: routerLlm,
    log,
    skills: [createKbCollect()],
    context: () =>
      llm && {
        notifier,
        slack,
        llm,
        onyx,
        log,
        botName: cfg.bot.name,
        allowPrivateChannels: cfg.slack.allowPrivateChannels,
        maxInputTokens: cfg.llm.summarizeMaxInputTokens,
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
