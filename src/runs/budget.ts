import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Rough size of a message in characters: text, thinking, tool arguments and tool definitions. */
export function messageChars(m: AgentMessage): number {
  const msg = m as { role?: string; content?: unknown; sections?: Record<string, string | null>; toolsAdded?: unknown[] };
  let n = 0;
  if (typeof msg.content === "string") n += msg.content.length;
  else if (Array.isArray(msg.content)) {
    for (const c of msg.content as { type: string; text?: string; thinking?: string; arguments?: unknown; data?: string }[]) {
      if (c.type === "text") n += c.text?.length ?? 0;
      else if (c.type === "thinking") n += c.thinking?.length ?? 0;
      else if (c.type === "toolCall") n += JSON.stringify(c.arguments ?? {}).length + 32;
      else if (c.type === "image") n += 4000; // providers bill images by size, not characters; a flat guess
    }
  }
  for (const s of Object.values(msg.sections ?? {})) n += s?.length ?? 0;
  if (msg.toolsAdded?.length) n += JSON.stringify(msg.toolsAdded).length;
  return n;
}

export const STUB = "[Output dropped to fit the context budget. Run the query again, narrower, if you still need it.]";

/**
 * Fit the transcript into `maxTokens` by replacing the oldest tool outputs with a one-line stub. The results of
 * the latest turn (every tool result after the last assistant message, parallel calls included) stay intact so
 * the model always sees what it just asked for. Returns a new array;
 * the transcript itself is untouched. `fits` is false when even the stubbed transcript is over the budget.
 */
export function compactToBudget(
  messages: AgentMessage[],
  o: { maxTokens: number; charsPerToken: number },
): { messages: AgentMessage[]; tokens: number; stubbed: number; fits: boolean } {
  const max = o.maxTokens * o.charsPerToken;
  let chars = messages.reduce((n, m) => n + messageChars(m), 0);
  const tokens = () => Math.ceil(chars / o.charsPerToken);
  if (chars <= max) return { messages, tokens: tokens(), stubbed: 0, fits: true };

  const lastTurn = messages.findLastIndex((m) => (m as { role?: string }).role === "assistant");
  const candidates = messages.flatMap((m, i) => ((m as { role?: string }).role === "toolResult" && i < lastTurn ? [i] : []));
  const out = [...messages];
  let stubbed = 0;
  for (const i of candidates) {
    if (chars <= max) break;
    const m = out[i] as Extract<AgentMessage, { role: "toolResult" }>;
    const before = messageChars(m);
    if (before <= STUB.length) continue;
    out[i] = { ...m, content: [{ type: "text", text: STUB }] };
    chars += STUB.length - before;
    stubbed++;
  }
  return { messages: out, tokens: tokens(), stubbed, fits: chars <= max };
}
