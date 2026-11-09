/** Key of a tool result's `details` with the arguments that ran (MCP tools, after the tool guard's defaults). */
export const EXECUTED_ARGS = "neotagsExecutedArgs";

/** Key of a tool result's `details` with `neotags.*` attributes for its `execute_tool` span (e.g. sandbox queue time). */
export const SPAN_ATTRIBUTES = "neotagsSpanAttributes";

/** The arguments a tool ran with when it reports them under {@link EXECUTED_ARGS}; else undefined (the model's ran). */
export function executedArgs(result: unknown): unknown {
  const details = (result as { details?: unknown })?.details;
  return details && typeof details === "object" && EXECUTED_ARGS in details ? (details as Record<string, unknown>)[EXECUTED_ARGS] : undefined;
}

/** The span attributes a tool reports under {@link SPAN_ATTRIBUTES}: only `neotags.*` keys with number, string or boolean values. */
export function spanAttributes(result: unknown): Record<string, number | string | boolean> | undefined {
  const details = (result as { details?: unknown })?.details;
  const raw = details && typeof details === "object" ? (details as Record<string, unknown>)[SPAN_ATTRIBUTES] : undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, number | string | boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("neotags.") && (typeof v === "number" || typeof v === "string" || typeof v === "boolean")) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
