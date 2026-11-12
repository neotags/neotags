import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Logger } from "pino";
import type { ToolGuard } from "../agent/index.js";
import type { Gateway } from "../agent/models.js";
import type { Config } from "../config/index.js";
import type { McpHub } from "../mcp/index.js";
import { EXEC_TOOL, skillExecTool, type SkillExecutor } from "../sandbox/index.js";
import { SkillPackIndex, loadSkillPacks, packsVersion, type SkillPack } from "../tools/skillpacks.js";
import { RunManager } from "./manager.js";
import { PiAgentRunner } from "./pi-runner.js";
import type { RunInput } from "./types.js";

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

/** Each entry's agent version: the packs from `agent.entries` that loaded. Entries without packs have none. */
export function entryVersions(cfg: Config, index: SkillPackIndex): Partial<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(cfg.agent.entries).map(([entry, names]) => [entry, packsVersion((names ?? []).map((n) => index.get(n)).filter((p): p is SkillPack => !!p))]),
  );
}

/** The run manager with the pi-agent-core runner, from config. Entries (O2 gateway, Slack) submit to it. */
export function createRunManager(
  cfg: Config,
  deps: {
    gateway: Gateway;
    index: SkillPackIndex;
    log: Logger;
    /** MCP tools behind its tool guard (`startMcp`). */
    mcp?: Pick<McpHub, "forRun" | "unavailable" | "guard">;
    tools?: AgentTool<any>[];
    guard?: ToolGuard;
    /** Command execution behind the sandbox tool guard; a run gets `run_skill_command` only when one of its packs can run something. */
    executor?: SkillExecutor;
  },
): RunManager {
  const a = cfg.agent;
  const { mcp, executor } = deps;
  const exec = executor?.enabled ? executor : undefined;
  // Built per run: the exec tool lists and allows only that run's skill packs.
  const tools =
    mcp || exec
      ? async ({ packs, input, signal, onEnd }: { packs: readonly string[]; input: RunInput; signal: AbortSignal; onEnd: (f: () => unknown) => void }) => {
          const run = exec && skillExecTool(exec, packs, a.toolOutputChars);
          // The run's own view of the MCP servers (o2Gateway.auth user: the page org's, as the user), closed with it.
          const servers = await mcp?.forRun(input.mcp, signal);
          if (servers) onEnd(servers.close);
          return [...(servers?.tools ?? []), ...(deps.tools ?? []), ...(run ? [run] : [])];
        }
      : deps.tools;
  const checks: ToolGuard[] = [
    ...(mcp ? [(call: Parameters<ToolGuard>[0]) => mcp.guard.check(call)] : []),
    ...(exec ? [(call: Parameters<ToolGuard>[0]) => (call.name === EXEC_TOOL ? exec.check(call.args, call.packs ?? []) : { ok: true as const })] : []),
    ...(deps.guard ? [deps.guard] : []),
  ];
  const guard: ToolGuard | undefined = checks.length
    ? async (call) => {
        for (const check of checks) {
          const d = await check(call);
          if (!d.ok) return d;
        }
        return { ok: true };
      }
    : undefined;
  const runner = new PiAgentRunner({
    gateway: deps.gateway,
    index: deps.index,
    botName: cfg.bot.name,
    entries: a.entries,
    ...(tools && { tools }),
    ...(guard && { guard }),
    ...(mcp && { unavailable: (input: RunInput) => mcp.unavailable(input.mcp) }),
    firstTokenTimeoutMs: cfg.llm.failover.firstTokenTimeoutSec * 1000,
    idleTimeoutMs: cfg.llm.timeoutMs,
    maxRetries: cfg.llm.maxRetries,
    extraBody: cfg.llm.extraBody,
    ...(cfg.llm.temperature !== null && { temperature: cfg.llm.temperature }),
    charsPerToken: cfg.llm.charsPerToken,
    captureContent: cfg.telemetry.captureContent,
    log: deps.log,
  });
  return new RunManager({
    runner,
    concurrency: a.concurrency.total,
    perUserPerHour: a.concurrency.perUserPerHour,
    exemptUsers: a.concurrency.exemptUsers,
    maxSteps: a.maxSteps,
    maxInputTokens: a.maxInputTokens,
    wallClockSec: a.wallClockSec,
    finalReserveSec: a.finalReserveSec,
    botName: cfg.bot.name,
    captureContent: cfg.telemetry.captureContent,
    log: deps.log,
  });
}
