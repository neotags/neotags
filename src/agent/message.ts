import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

/** Characters of reasoning in a reply (pi-ai `thinking` parts); a reasoning model can spend its whole budget there. */
export function thinkingChars(msg: Pick<AssistantMessage, "content">): number {
  return msg.content.reduce((n, c) => n + (c.type === "thinking" ? c.thinking.length : 0), 0);
}

/** Plain text of a pi message: its text parts, tool calls as `name(args)`. Images and thinking are left out. */
export function messageText(m: Pick<Message, "content">): string {
  if (typeof m.content === "string") return m.content;
  return (m.content as { type: string; text?: string; name?: string; arguments?: unknown }[])
    .map((c) => (c.type === "text" ? c.text : c.type === "toolCall" ? `${c.name}(${JSON.stringify(c.arguments)})` : undefined))
    .filter(Boolean)
    .join("\n");
}

/** An agent transcript as prompt messages for a trace span (tool results under the GenAI role "tool"). */
export function promptMessages(messages: readonly Pick<Message, "role" | "content">[]): { role: string; content: string }[] {
  return messages.map((m) => ({ role: m.role === "toolResult" ? "tool" : m.role, content: messageText(m) }));
}
