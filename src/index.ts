import { pino } from "pino";
import { loadConfig } from "./config/index.js";
import { createSlack } from "./gateway/slack.js";
import { Router } from "./router/index.js";

// Kubernetes sends SIGTERM then waits terminationGracePeriodSeconds (default 30s) before SIGKILL.
const DRAIN_TIMEOUT_MS = 20_000;

const cfg = loadConfig();
const log = pino({ level: cfg.logLevel });

const { app, drain } = createSlack(cfg, log, (notifier) => new Router(cfg.bot.name, notifier));
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
