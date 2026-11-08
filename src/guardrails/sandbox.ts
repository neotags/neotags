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

export type ExecDecision = { ok: true; constraints: SandboxSpec } | { ok: false; reason: string };

// Env names that would bypass the proxy or the tool check, or shadow a credential placeholder. The executor
// refuses them too; checking here keeps a refusal in the tool guard, where the model gets the reason.
const RESERVED_ENV = new Set(["PATH", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ARGV = 256;

const deny = (reason: string): ExecDecision => ({ ok: false, reason });

/**
 * Tool guard for command execution (§13 of the design), enforced in code before anything reaches the executor:
 * the pack must be one of `packs` (the run's own skill packs, when the caller is a run), be loaded and declare
 * `sandbox`; `argv[0]` must be one of its `tools`; env and file names must not escape the declaration. The
 * constraints sent to the executor are the pack's declaration, never the caller's, so a prompt-injected call cannot
 * widen the network, credentials or limits, nor borrow them from a pack the run was not given.
 */
export function checkExec(index: SkillPackIndex, call: ExecCall, packs?: readonly string[]): ExecDecision {
  if (packs && !packs.includes(call.pack)) return deny(`skill pack "${call.pack}" is not one of this run's (${packs.join(", ") || "none"})`);
  const pack = index.get(call.pack);
  if (!pack) return deny(`unknown skill pack "${call.pack}"`);
  const spec = pack.sandbox;
  if (!spec) return deny(`skill pack ${pack.name} declares no sandbox, so it cannot execute anything`);
  if (spec.tools.length === 0) return deny(`skill pack ${pack.name} declares no tools in its sandbox`);

  const argv = call.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV || !argv.every((a) => typeof a === "string")) {
    return deny(`argv must be a list of 1 to ${MAX_ARGV} strings`);
  }
  const tool = argv[0] as string;
  if (!spec.tools.includes(tool)) return deny(`${JSON.stringify(tool)} is not a tool of ${pack.name}; it may run ${spec.tools.join(", ")}`);

  if (call.env !== undefined) {
    if (!isObj(call.env)) return deny("env must be an object of strings");
    const credentials = new Set(spec.credentials.map((c) => c.name));
    for (const [k, v] of Object.entries(call.env)) {
      if (typeof v !== "string") return deny(`env ${k} must be a string`);
      if (!ENV_NAME.test(k)) return deny(`env name ${JSON.stringify(k)} is invalid`);
      if (RESERVED_ENV.has(k.toUpperCase()) || k.startsWith("LD_") || credentials.has(k)) return deny(`env name ${k} is reserved`);
    }
  }
  if (call.stdin !== undefined && typeof call.stdin !== "string") return deny("stdin must be a string");
  if (call.files !== undefined) {
    if (!isObj(call.files)) return deny("files must be an object of path to content");
    for (const [f, content] of Object.entries(call.files)) {
      if (typeof content !== "string") return deny(`file ${f} must be text`);
      const norm = path.posix.normalize(f);
      if (!f || f.includes("\\") || path.posix.isAbsolute(f) || norm === "." || norm.split("/").includes("..")) {
        return deny(`file path ${JSON.stringify(f)} must be relative and stay in the work directory`);
      }
    }
  }
  return { ok: true, constraints: spec };
}

/** The decision without the constraints, for the runner's `beforeToolCall`. */
export function execDecision(d: ExecDecision): Decision {
  return d.ok ? { ok: true } : d;
}
