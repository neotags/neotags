import type { Logger } from "pino";
import type { Config } from "../config/index.js";
import type { SkillPackIndex } from "../tools/skillpacks.js";
import { SkillExecutor } from "./exec.js";
import { DisabledSandbox, LocalSandbox } from "./local.js";

export { EXEC_TOOL, SkillExecutor, skillExecTool, type SkillExecutorOptions } from "./exec.js";
export { DisabledSandbox, LocalSandbox, type LocalSandboxOptions } from "./local.js";
export * from "./types.js";

/**
 * The configured execution backend behind the sandbox tool guard. With `sandbox.backend: none` (the default) every
 * execution is refused; with `local`, the executor sidecar's self-check is logged once, without blocking startup.
 */
export function createSkillExecutor(cfg: Config, index: SkillPackIndex, log: Pick<Logger, "info" | "warn">): SkillExecutor {
  const s = cfg.sandbox;
  if (s.backend === "none") return new SkillExecutor({ sandbox: new DisabledSandbox(), index, log });
  const sandbox = new LocalSandbox({ socketPath: s.socket, maxConcurrency: s.maxConcurrency, queueTimeoutMs: s.queueTimeoutSec * 1000 });
  sandbox.health().then(
    (h) => {
      // The executor answers /healthz with 200 also when its self-check failed.
      const exec = (h as { exec?: { available?: unknown } }).exec;
      if (exec?.available === true) log.info({ socket: s.socket, health: h }, "sandbox: executor ready");
      else log.warn({ socket: s.socket, health: h }, "sandbox: executor reachable but per-call execution is unavailable; executions are refused");
    },
    (err: Error) => log.warn({ socket: s.socket, err: err.message }, "sandbox: executor not reachable; executions are refused until it is"),
  );
  return new SkillExecutor({ sandbox, index, log });
}
