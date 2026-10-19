import { pino } from "pino";
import { loadConfig } from "./config/index.js";
import { createSlack } from "./gateway/slack.js";
import { Router } from "./router/index.js";

const cfg = loadConfig();
const log = pino({ level: cfg.logLevel });

const app = createSlack(cfg, log, (notifier) => new Router(cfg.bot.name, notifier));
await app.start(cfg.slack.port);
log.info({ port: cfg.slack.port, bot: cfg.bot.name }, "neotags started");

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => void app.stop().finally(() => process.exit(0)));
}
