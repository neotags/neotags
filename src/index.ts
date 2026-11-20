import { pino } from "pino";
import { createLlm, type LlmClient } from "./agent/llm.js";
import { createGateway, type Gateway } from "./agent/models.js";
import { CHAINS, inputBudgetTokens, llmConfigured, loadConfig } from "./config/index.js";
import { createPortServer, type PortServer, type Route } from "./gateway/http.js";
import { createInternalApi } from "./gateway/internal.js";
import { createO2Gateway } from "./gateway/o2.js";
import { createSlack } from "./gateway/slack.js";
import { startMcp, type McpHub } from "./mcp/index.js";
import { Router } from "./router/index.js";
import { createJobRunner, createRunManager, entryVersions, loadConfiguredSkillPacks, type RunManager } from "./runs/index.js";
import { createSkillExecutor } from "./sandbox/index.js";
import { allSkills, selectSkills } from "./skills/registry.js";
import { startTelemetry } from "./telemetry/index.js";
import { setAgentVersions } from "./telemetry/spans.js";
import { HttpOnyxClient, type OnyxClient } from "./tools/onyx.js";

// Kubernetes sends SIGTERM then waits terminationGracePeriodSeconds (default 30s) before SIGKILL.
const DRAIN_TIMEOUT_MS = 20_000;
// What is left of the grace period after the drain, for exporting the last traces.
const TRACE_FLUSH_TIMEOUT_MS = 5_000;

const cfg = loadConfig();
const log = pino({ level: cfg.logLevel });
const telemetry = startTelemetry({ log });
if (telemetry) log.info({ captureContent: cfg.telemetry.captureContent }, "tracing to OTLP");

// Optional integrations: the bot still starts without them and tells users what is missing.
let llm: LlmClient | undefined;
let routerLlm: LlmClient | undefined;
let gateway: Gateway | undefined;
if (llmConfigured(cfg.llm)) {
  const g = createGateway(cfg, {
    onBreakerChange: (model, state) =>
      state === "closed" ? log.info({ model, breaker: state }, "llm model available again") : log.warn({ model, breaker: state }, "llm model circuit breaker"),
  });
  gateway = g;
  llm = createLlm(cfg, { gateway: g });
  routerLlm = createLlm(cfg, { role: "router", gateway: g });
  const chains = Object.fromEntries(
    CHAINS.map((c) => [c, g.policy.steps(c).map((s) => (s.effort ? `${s.model.id}@${s.effort}` : s.model.id))]),
  );
  log.info({ chains }, "llm configured");
  if (cfg.llm.chains && (cfg.llm.model || cfg.llm.routerModel)) {
    log.warn("llm.model / llm.routerModel (or LLM_MODEL / LLM_ROUTER_MODEL) are ignored because llm.chains is set");
  }
  if (!cfg.llm.chains && Object.keys(cfg.llm.models).length > 0) log.warn("llm.models is ignored without llm.chains");
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
// Agent runs (the O2 entry and routines' internal API): MCP tools, the sandbox and the skill packs behind the run
// manager. Both share the in-cluster port (o2Gateway.port), routed by path.
let runs: RunManager | undefined;
let mcp: McpHub | undefined;
let port: PortServer | undefined;
if (cfg.o2Gateway.enabled || cfg.jobsApi.enabled) {
  if (!gateway) log.error("o2Gateway or jobsApi is enabled but no LLM is configured; neither is started");
  else {
    const index = await loadConfiguredSkillPacks(cfg, log);
    const versions = entryVersions(cfg, index);
    setAgentVersions(versions);
    log.info({ versions }, "agent versions");
    mcp = await startMcp(cfg, log);
    const executor = createSkillExecutor(cfg, index, log);
    runs = createRunManager(cfg, { gateway, index, log, mcp, executor });
    const routes: Record<string, Route> = {};
    if (cfg.o2Gateway.enabled) routes["/o2_agent/"] = createO2Gateway({ cfg: cfg.o2Gateway, key: cfg.secrets.o2AgentKey!, runs, log }).route;
    if (cfg.jobsApi.enabled) {
      const g = gateway;
      const jobs = createJobRunner({ cfg, runs, log, modelAvailable: () => g.policy.steps("job").some((s) => s.breaker.state !== "open") });
      routes["/internal/"] = createInternalApi({ keys: cfg.secrets.jobKeys ?? {}, jobs, log }).route;
    }
    port = createPortServer({ routes, log, name: "agent api" });
    await port.listen(cfg.o2Gateway.port);
    log.info({ port: cfg.o2Gateway.port, o2: cfg.o2Gateway.enabled, jobsApi: cfg.jobsApi.enabled, orgs: cfg.o2Gateway.orgs, routines: Object.keys(cfg.routines) }, "agent api listening");
  }
}

await app.start(cfg.slack.port);
log.info({ port: cfg.slack.port, bot: cfg.bot.name }, "neotags started");

let shuttingDown = false;
async function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ sig }, "shutting down");
  let code = 0;
  port?.stopAccepting();
  try {
    await app.stop(); // stop accepting new events
  } catch (err) {
    log.error({ err }, "failed to stop cleanly");
    code = 1;
  }
  // Slack tasks are short; agent runs get agent.drainSec, which the pod's grace period must cover.
  const [tasksDone, runsDone] = await Promise.all([drain(DRAIN_TIMEOUT_MS), runs?.drain(cfg.agent.drainSec * 1000) ?? true]);
  if (!tasksDone) {
    log.warn("timed out waiting for in-flight tasks");
    code = 1;
  }
  if (!runsDone) {
    log.warn("agent runs still going after agent.drainSec were aborted");
    code = 1;
  }
  await port?.close();
  await mcp?.close().catch((err: unknown) => log.warn({ err }, "failed to close MCP clients"));
  if (telemetry) {
    const timeout = new Promise<"timeout">((r) => setTimeout(r, TRACE_FLUSH_TIMEOUT_MS, "timeout").unref());
    const flushed = await Promise.race([telemetry.shutdown().then(() => "ok" as const), timeout]).catch((err: unknown) => {
      log.warn({ err }, "failed to flush traces");
      return "failed" as const;
    });
    if (flushed === "timeout") log.warn("timed out flushing traces");
  }
  process.exit(code);
}
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void shutdown(sig));
