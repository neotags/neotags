import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Logger } from "pino";
import type { ToolGuard } from "../agent/index.js";
import type { Gateway } from "../agent/models.js";
import type { Config } from "../config/index.js";
import { SkillPackIndex, loadSkillPacks } from "../tools/skillpacks.js";
import { RunManager } from "./manager.js";
import { PiAgentRunner } from "./pi-runner.js";

export { RunManager, type RunHandle, type SubmitResult } from "./manager.js";
export { PiAgentRunner } from "./pi-runner.js";
export * from "./types.js";

/** Load the configured skill packs, logging what was skipped. No `skillPacks.dir` means no packs. */
export async function loadConfiguredSkillPacks(cfg: Config, log: Pick<Logger, "info" | "warn">): Promise<SkillPackIndex> {
  const sp = cfg.skillPacks;
  if (!sp.dir) return new SkillPackIndex();
  const { index, warnings } = await loadSkillPacks({ dir: sp.dir, packs: sp.packs, refs: sp.refs, maxFileBytes: Math.floor(sp.maxFileKb * 1024) });
  for (const w of warnings) log.warn({ dir: sp.dir }, `skill packs: ${w}`);
  log.info({ packs: index.list().map((p) => ({ name: p.name, refs: p.refs.size })) }, "skill packs loaded");
  return index;
}

/** The run manager with the pi-agent-core runner, from config. Entries (O2 gateway, Slack) submit to it. */
export function createRunManager(
  cfg: Config,
  deps: { gateway: Gateway; index: SkillPackIndex; log: Logger; tools?: AgentTool<any>[]; guard?: ToolGuard },
): RunManager {
  const a = cfg.agent;
  const runner = new PiAgentRunner({
    gateway: deps.gateway,
    index: deps.index,
    botName: cfg.bot.name,
    entries: a.entries,
    ...(deps.tools && { tools: deps.tools }),
    ...(deps.guard && { guard: deps.guard }),
    firstTokenTimeoutMs: cfg.llm.failover.firstTokenTimeoutSec * 1000,
    idleTimeoutMs: cfg.llm.timeoutMs,
    maxRetries: cfg.llm.maxRetries,
    extraBody: cfg.llm.extraBody,
    ...(cfg.llm.temperature !== null && { temperature: cfg.llm.temperature }),
    charsPerToken: cfg.llm.charsPerToken,
    log: deps.log,
  });
  return new RunManager({
    runner,
    concurrency: a.concurrency.total,
    perUserPerHour: a.concurrency.perUserPerHour,
    maxSteps: a.maxSteps,
    maxInputTokens: a.maxInputTokens,
    wallClockSec: a.wallClockSec,
    finalReserveSec: a.finalReserveSec,
    log: deps.log,
  });
}
