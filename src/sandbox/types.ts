import type { SandboxSpec } from "../tools/skillpacks.js";

/** What to run, and for which skill pack. The constraints come from the pack's declaration, never from the caller. */
export interface ExecEntry {
  /** Skill pack whose `sandbox` declaration applies. */
  pack: string;
  /** `argv[0]` is a bare command name from the declaration's `tools`. */
  argv: string[];
  env?: Record<string, string>;
  stdin?: string;
  /** Written under the sandbox's /work; relative paths. */
  files?: Record<string, string>;
  /** Request id in the executor's audit line; generated when absent. */
  id?: string;
}

export interface ExecResult {
  id: string;
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  egress: { method?: string; host: string; port?: number; decision: string; injected?: string[] }[];
  /** Set by the client backend, not the executor: how long the call waited for a slot. */
  wait?: SlotWait;
}

/** Time a call spent before the executor took it: in this process's queue and retrying `429 busy`. */
export interface SlotWait {
  queueMs: number;
  busyRetries: number;
}

/**
 * Why an execution did not run:
 * - `denied`: the tool guard refused it (no declaration, undeclared tool, reserved env, execution disabled, ...);
 * - `unavailable`: no executor answered, or its self-check failed. Never a reason to run the command another way;
 * - `refused`: the executor refused the request (validation, missing credential), or no slot freed up in time
 *   (`busy`: the command did not run);
 * - `unknown`: the request was sent but no answer came (deadline, cancelled): the command may have run.
 */
export type SandboxErrorKind = "denied" | "unavailable" | "refused" | "unknown";

export class SandboxError extends Error {
  /** The wait for a slot before the failure, when the backend queued the call. */
  wait?: SlotWait;

  constructor(
    readonly kind: SandboxErrorKind,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

/**
 * A backend that runs one request under its constraints (§13 of the design). Callers (the tool guard, later the
 * alert gate) only say what to run under which constraints; the backend decides how it is isolated.
 */
export interface Sandbox {
  readonly backend: string;
  exec(entry: ExecEntry & { id: string }, constraints: SandboxSpec, signal?: AbortSignal): Promise<ExecResult>;
}
