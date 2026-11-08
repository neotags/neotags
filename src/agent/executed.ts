/** Key of a tool result's `details` with the arguments that ran (MCP tools, after the tool guard's defaults). */
export const EXECUTED_ARGS = "neotagsExecutedArgs";

/** The arguments a tool ran with when it reports them under {@link EXECUTED_ARGS}; else undefined (the model's ran). */
export function executedArgs(result: unknown): unknown {
  const details = (result as { details?: unknown })?.details;
  return details && typeof details === "object" && EXECUTED_ARGS in details ? (details as Record<string, unknown>)[EXECUTED_ARGS] : undefined;
}
