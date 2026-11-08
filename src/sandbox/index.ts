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
  const sandbox = new LocalSandbox({ socketPath: s.socket });
  sandbox.health().then(
    (h) => log.info({ socket: s.socket, health: h }, "sandbox: executor reachable"),
    (err: Error) => log.warn({ socket: s.socket, err: err.message }, "sandbox: executor not reachable; executions are refused until it is"),
  );
  return new SkillExecutor({ sandbox, index, log });
}
