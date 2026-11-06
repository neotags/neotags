import type { Effort, RunSource } from "../config/index.js";

export type { RunSource };

export type RunState = "queued" | "running" | "done" | "failed" | "cancelled" | "budget_exhausted";
export const FINAL_STATES: readonly RunState[] = ["done", "failed", "cancelled", "budget_exhausted"];

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** One question to the agent, already mapped from its entry (O2 QueryRequest, Slack thread, job request). */
export interface RunInput {
  source: RunSource;
  /** Conversation the run belongs to (O2 assistant session, Slack thread); one run per session at a time. */
  sessionId: string;
  /** Asker, for rate limits and audit only; data is always queried with the agent's own read-only identity. */
  user?: string;
  question: string;
  /** Earlier turns of the conversation, oldest first. Untrusted. */
  history?: HistoryTurn[];
  /** Page context (O2: stream, SQL, time range, org) or alert labels. Untrusted. */
  context?: Record<string, unknown>;
  /** Skill packs in the system prompt; default: agent.entries[source]. */
  packs?: string[];
  /** Links for the "AI unavailable" answer (stream, dashboard, ...), built by the entry. */
  links?: { title: string; url: string }[];
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RunResult {
  id: string;
  sessionId: string;
  state: Extract<RunState, "done" | "failed" | "cancelled" | "budget_exhausted">;
  /** Markdown for the asker. Also set for failed runs (the degraded answer) and cancelled ones (why). */
  answer: string;
  /** The answer is the context package written by code, not by the model. */
  degraded?: boolean;
  /** Why the run did not finish normally (error, budget, cancel reason). */
  reason?: string;
  steps: number;
  toolCalls: number;
  usage: RunUsage;
  model?: string;
  effort?: Effort;
  durationMs: number;
}

/**
 * Progress of one run, for the entry that asked (SSE to O2, a Slack message edited in place). Callbacks must
 * not throw; errors are logged and ignored so a broken client cannot fail the run.
 */
export interface RunObserver {
  /** Waiting for a slot; `ahead` runs are before this one. */
  queued?(info: { runId: string; ahead: number }): void;
  started?(info: { runId: string }): void;
  toolStart?(call: { id: string; name: string; args: unknown }): void;
  toolEnd?(call: { id: string; name: string; isError: boolean; output: string; durationMs?: number }): void;
  /** Text of the answer, in order. Concatenated, the deltas are the answer. */
  delta?(text: string): void;
  done?(result: RunResult): void;
}

export interface RunBudget {
  maxSteps: number;
  /** Epoch ms after which the model is asked to wrap up (wall clock minus the final reserve). */
  softDeadline: number;
  maxInputTokens: number;
}

export interface RunContext {
  runId: string;
  /** Aborted on cancel, disconnect, hard deadline or shutdown; `signal.reason` is a {@link RunAbort}. */
  signal: AbortSignal;
  budget: RunBudget;
  observer: RunObserver;
}

export class RunAbort extends Error {
  constructor(public readonly kind: "cancelled" | "deadline" | "shutdown", message: string) {
    super(message);
    this.name = "RunAbort";
  }
}

export interface RunOutcome {
  state: "done" | "budget_exhausted" | "cancelled";
  answer: string;
  reason?: string;
  steps: number;
  toolCalls: number;
  usage: RunUsage;
  model?: string;
  effort?: Effort;
}

/** A run that ended without an answer, with what it had used up to then. */
export class RunError extends Error {
  constructor(
    message: string,
    /** model_unavailable: every model's breaker is open; model_error: the gateway failed this run. */
    public readonly kind: "model_unavailable" | "model_error" | "error",
    /** `answer`: text already streamed to the asker, which stands as the answer instead of the context package. */
    public readonly partial: Partial<Pick<RunOutcome, "steps" | "toolCalls" | "usage" | "model" | "effort" | "answer">> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RunError";
  }
}

/**
 * Runs one question to an answer. Throws when it cannot produce one (model unavailable, gateway errors); the
 * RunManager then answers with the context package instead. The pi-agent-core runner is the MVP implementation.
 */
export interface AgentRunner {
  run(input: RunInput, ctx: RunContext): Promise<RunOutcome>;
}
