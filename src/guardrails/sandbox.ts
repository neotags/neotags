import path from "node:path";
import type { SandboxSpec, SkillPackIndex } from "../tools/skillpacks.js";
import type { Decision } from "./policy.js";
import { isObj } from "./tools.js";

export interface ExecCall {
  pack: string;
  argv: unknown;
  env?: unknown;
  stdin?: unknown;
  files?: unknown;
}

/** `rule`: which check refused, for the audit line; `reason` can quote the caller's values, so it goes to the model only. */
export type ExecDecision = { ok: true; constraints: SandboxSpec } | { ok: false; reason: string; rule: string };

// Env names that would bypass the proxy or the tool check, or shadow a credential placeholder. The executor
// refuses them too; checking here keeps a refusal in the tool guard, where the model gets the reason.
const RESERVED_ENV = new Set(["PATH", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// The executor's request limits (executor/executor/policy.py).
const MAX_ARGV = 256;
const MAX_ARG_BYTES = 8192;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_FILES_BYTES = 4 * 1024 * 1024;

const deny = (rule: string, reason: string): ExecDecision => ({ ok: false, rule, reason });
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * Tool guard for command execution (§13 of the design), enforced in code before anything reaches the executor:
 * the pack must be one of `packs` (the run's own skill packs, when the caller is a run), be loaded and declare
 * `sandbox`; `argv[0]` must be one of its `tools`; env and file names must not escape the declaration, and the
 * request must fit the executor's size limits. The constraints sent to the executor are the pack's declaration,
 * never the caller's, so a prompt-injected call cannot widen the network, credentials or limits, nor borrow them
 * from a pack the run was not given.
 */
export function checkExec(index: SkillPackIndex, call: ExecCall, packs?: readonly string[]): ExecDecision {
  if (packs && !packs.includes(call.pack)) return deny("pack_not_in_run", `skill pack "${call.pack}" is not one of this run's (${packs.join(", ") || "none"})`);
  const pack = index.get(call.pack);
  if (!pack) return deny("unknown_pack", `unknown skill pack "${call.pack}"`);
  const spec = pack.sandbox;
  if (!spec) return deny("no_sandbox", `skill pack ${pack.name} declares no sandbox, so it cannot execute anything`);
  if (spec.tools.length === 0) return deny("no_tools", `skill pack ${pack.name} declares no tools in its sandbox`);

  const argv = call.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV || !argv.every((a) => typeof a === "string")) {
    return deny("argv", `argv must be a list of 1 to ${MAX_ARGV} strings`);
  }
  if (argv.some((a) => a.includes("\0") || bytes(a) > MAX_ARG_BYTES)) return deny("argv", `each argument must be at most ${MAX_ARG_BYTES} bytes, without NUL`);
  const tool = argv[0] as string;
  if (!spec.tools.includes(tool)) return deny("tool_not_declared", `${JSON.stringify(tool)} is not a tool of ${pack.name}; it may run ${spec.tools.join(", ")}`);

  if (call.env !== undefined) {
    if (!isObj(call.env)) return deny("env", "env must be an object of strings");
    const credentials = new Set(spec.credentials.map((c) => c.name));
    for (const [k, v] of Object.entries(call.env)) {
      if (typeof v !== "string" || v.includes("\0") || bytes(v) > MAX_ARG_BYTES) return deny("env", `env ${k} must be a string of at most ${MAX_ARG_BYTES} bytes, without NUL`);
      if (!ENV_NAME.test(k)) return deny("env", `env name ${JSON.stringify(k)} is invalid`);
      if (RESERVED_ENV.has(k.toUpperCase()) || k.startsWith("LD_") || credentials.has(k)) return deny("env", `env name ${k} is reserved`);
    }
  }
  if (call.stdin !== undefined) {
    if (typeof call.stdin !== "string" || call.stdin.includes("\0")) return deny("stdin", "stdin must be text without NUL");
    if (bytes(call.stdin) > MAX_STDIN_BYTES) return deny("stdin", `stdin is over ${MAX_STDIN_BYTES} bytes`);
  }
  if (call.files !== undefined) {
    if (!isObj(call.files)) return deny("files", "files must be an object of path to content");
    const seen = new Set<string>();
    let total = 0;
    for (const [f, content] of Object.entries(call.files)) {
      if (typeof content !== "string" || content.includes("\0")) return deny("files", `file ${f} must be text without NUL`);
      total += bytes(content);
      const norm = path.posix.normalize(f);
      // The executor refuses any normalized path that starts with "..", "..config" included.
      if (!f || f.includes("\\") || path.posix.isAbsolute(f) || norm === "." || norm.startsWith("..")) {
        return deny("files", `file path ${JSON.stringify(f)} must be relative and stay in the work directory`);
      }
      if (seen.has(norm)) return deny("files", `file path ${JSON.stringify(f)} is given twice`);
      seen.add(norm);
    }
    if (total > MAX_FILES_BYTES) return deny("files", `files are over ${MAX_FILES_BYTES} bytes in total`);
    for (const f of seen) {
      for (let dir = path.posix.dirname(f); dir !== "."; dir = path.posix.dirname(dir)) {
        if (seen.has(dir)) return deny("files", `file ${JSON.stringify(dir)} is also used as a directory`);
      }
    }
  }
  return { ok: true, constraints: spec };
}

/** The decision without the constraints, for the runner's `beforeToolCall`. */
export function execDecision(d: ExecDecision): Decision {
  return d.ok ? { ok: true } : { ok: false, reason: d.reason };
}
