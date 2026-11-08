import type { Logger } from "pino";
import type { Config } from "../config/index.js";
import { McpGuard } from "../guardrails/tools.js";
import { McpHub } from "./hub.js";

export { McpHub, resultText, type McpHubOptions, type McpServerConfig } from "./hub.js";

/** The configured MCP servers behind the tool guard, connected. Servers that are down do not fail startup. */
export async function startMcp(cfg: Config, log: Pick<Logger, "info" | "warn">, env: NodeJS.ProcessEnv = process.env): Promise<McpHub> {
  const m = cfg.mcp;
  const guard = new McpGuard({
    servers: m.servers,
    maxArgChars: m.maxArgChars,
    outputChars: cfg.agent.toolOutputChars,
    limits: cfg.agent.queryLimits,
  });
  const hub = new McpHub({
    servers: m.servers,
    guard,
    connectTimeoutMs: m.connectTimeoutSec * 1000,
    callTimeoutMs: m.callTimeoutSec * 1000,
    reconnectMaxMs: m.reconnectMaxSec * 1000,
    env,
    log,
  });
  await hub.start();
  return hub;
}
