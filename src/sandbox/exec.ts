import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Logger } from "pino";
import type { Decision } from "../guardrails/policy.js";
import { checkExec, execDecision } from "../guardrails/sandbox.js";
import { boundedOutput, isObj } from "../guardrails/tools.js";
import type { SkillPack, SkillPackIndex } from "../tools/skillpacks.js";
import { SandboxError, type ExecEntry, type ExecResult, type Sandbox } from "./types.js";

export const EXEC_TOOL = "run_skill_command";

// The executor's request id pattern; other characters are replaced.
const ID_CHARS = /[^A-Za-z0-9._:/-]/g;

export interface SkillExecutorOptions {
  sandbox: Sandbox;
  index: SkillPackIndex;
  log: Pick<Logger, "info" | "warn">;
}

/**
 * The only way neotags executes anything: every call passes the sandbox tool guard (`checkExec`), goes to the
 * backend with the pack's declared constraints, and writes one audit line whatever happens. Like the executor's own
 * audit, the line has names (pack, tool, hosts, credentials) and the outcome, never arguments, input or output.
 */
export class SkillExecutor {
  constructor(private o: SkillExecutorOptions) {}

  get backend(): string {
    return this.o.sandbox.backend;
  }

  /** Is execution configured at all? With backend `none`, no tool is offered. */
  get enabled(): boolean {
    return this.o.sandbox.backend !== "none";
  }

  /** Packs that can run something, of `packs` when given (a run's own packs), else of all loaded packs. */
  runnable(packs?: readonly string[]): SkillPack[] {
    if (!this.enabled) return [];
    const all = packs ? packs.flatMap((n) => this.o.index.get(n) ?? []) : this.o.index.list();
    return all.filter((p) => p.sandbox && p.sandbox.tools.length > 0);
  }

  /** The guard's decision for a `run_skill_command` call of a run with skill packs `packs`, for `beforeToolCall`. */
  check(args: unknown, packs: readonly string[]): Decision {
    const a = isObj(args) ? args : {};
    return execDecision(checkExec(this.o.index, { pack: typeof a.pack === "string" ? a.pack : "", argv: a.argv, stdin: a.stdin }, packs));
  }

  /** `packs`: limit the execution to these skill packs (a run passes its own). */
  async exec(entry: ExecEntry, opts: { signal?: AbortSignal; packs?: readonly string[] } = {}): Promise<ExecResult> {
    const { signal, packs } = opts;
    const id = (entry.id ?? `neotags-${randomUUID()}`).replace(ID_CHARS, "_").slice(0, 128);
    const tool = Array.isArray(entry.argv) && typeof entry.argv[0] === "string" ? entry.argv[0].slice(0, 64) : undefined;
    const audit = { audit: "sandbox_exec", id, backend: this.o.sandbox.backend, pack: entry.pack, tool };
    const d = checkExec(this.o.index, entry, packs);
    if (!d.ok) {
      this.o.log.warn({ ...audit, outcome: "denied", reason: d.reason }, "sandbox exec denied");
      throw new SandboxError("denied", "not_allowed", d.reason);
    }
    const c = d.constraints;
    const declared = { net: c.net, credentials: c.credentials.map((x) => x.name), ...(c.limits && { limits: c.limits }) };
    const started = Date.now();
    try {
      // Only the checked fields go on: anything else the caller put on the entry is dropped.
      const { pack, argv, env, stdin, files } = entry;
      const r = await this.o.sandbox.exec({ id, pack, argv, ...(env && { env }), ...(stdin !== undefined && { stdin }), ...(files && { files }) }, c, signal);
      const denied = r.egress?.filter((e) => e.decision !== "allow").map((e) => `${e.host}${e.port ? `:${e.port}` : ""}`) ?? [];
      const injected = [...new Set(r.egress?.flatMap((e) => e.injected ?? []) ?? [])];
      this.o.log.info(
        {
          ...audit,
          ...declared,
          outcome: "ran",
          exitCode: r.exitCode,
          signal: r.signal,
          timedOut: r.timedOut,
          durationMs: r.durationMs,
          ...(denied.length && { egressDenied: denied }),
          ...(injected.length && { injected }),
        },
        "sandbox exec",
      );
      return r;
    } catch (err) {
      const e = err instanceof SandboxError ? err : new SandboxError("refused", "error", (err as Error).message);
      this.o.log.warn({ ...audit, ...declared, outcome: e.kind, code: e.code, reason: e.message, durationMs: Date.now() - started }, "sandbox exec failed");
      throw e;
    }
  }
}

/**
 * `run_skill_command` for one run: runs a command that one of the run's skill packs (`packs`) declares, in the
 * execution sandbox; the pack's declaration, not the model, sets network, credentials and limits. Undefined when
 * none of the packs can run anything, so the tool is not offered.
 */
export function skillExecTool(executor: SkillExecutor, packs: readonly string[], outputChars: number): AgentTool<any> | undefined {
  const runnable = executor.runnable(packs);
  if (runnable.length === 0) return undefined;
  const listed = runnable.map((p) => `${p.name} (${p.sandbox!.tools.join(", ")})`);
  const params = Type.Object({
    pack: Type.String({ description: "Skill pack whose instructions call for the command" }),
    argv: Type.Array(Type.String(), { minItems: 1, description: "Command and arguments; argv[0] is one of the pack's tools" }),
    stdin: Type.Optional(Type.String({ description: "Standard input" })),
  });
  const tool: AgentTool<typeof params> = {
    name: EXEC_TOOL,
    label: "Run skill pack command",
    description:
      `Run a command that a skill pack's instructions call for, in an isolated sandbox with no shell. ` +
      `Packs and their commands: ${listed.join("; ")}. Only the hosts and credentials the pack declares are reachable.`,
    parameters: params,
    executionMode: "sequential",
    execute: async (toolCallId, { pack, argv, stdin }, signal) => {
      const r = await executor.exec({ id: `neotags/${toolCallId}`, pack, argv, ...(stdin !== undefined && { stdin }) }, { ...(signal && { signal }), packs });
      const status = r.timedOut ? "timed out" : r.signal ? `killed by ${r.signal}` : `exit code ${r.exitCode}`;
      const parts = [`[${status}]`];
      if (r.stdout) parts.push(`stdout:\n${r.stdout}${r.truncated?.stdout ? "\n[stdout truncated by the executor]" : ""}`);
      if (r.stderr) parts.push(`stderr:\n${r.stderr}${r.truncated?.stderr ? "\n[stderr truncated by the executor]" : ""}`);
      const text = boundedOutput(parts.join("\n\n"), outputChars, "Narrow the command (filters, fewer rows) to see the rest.");
      // A non-zero exit is often an answer (grep: no match), so only a command that did not finish is an error.
      return { content: [{ type: "text", text }], details: undefined, ...((r.timedOut || r.signal) && { isError: true }) };
    },
  };
  return tool as AgentTool<any>;
}
