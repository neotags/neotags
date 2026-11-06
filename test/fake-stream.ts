import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type JsonObject,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

/** One scripted model response: a message, a function of the request, or a request that never answers. */
export type Reply =
  | AssistantMessage
  | ((context: TranscriptContext, options: SimpleStreamOptions | undefined) => AssistantMessage | Promise<AssistantMessage>)
  | "hang"
  /** Streams this text, then stalls until aborted. */
  | { stall: string };

export const say = (text: string, usage = { input: 100, output: 10 }) => withUsage(fauxAssistantMessage(fauxText(text)), usage);
export const callTool = (name: string, args: JsonObject, id?: string) =>
  withUsage(fauxAssistantMessage(fauxToolCall(name, args, id ? { id } : undefined), { stopReason: "toolUse" }), { input: 100, output: 10 });
export const fail = (errorMessage: string) => fauxAssistantMessage([], { stopReason: "error", errorMessage });

function withUsage(m: AssistantMessage, u: { input: number; output: number }): AssistantMessage {
  return { ...m, usage: { ...m.usage, input: u.input, output: u.output, totalTokens: u.input + u.output } };
}

/** Text of a request's transcript, to assert on what the model was sent. */
export function transcriptText(context: TranscriptContext): string {
  return context.messages
    .map((m) => {
      const c = (m as { content?: unknown }).content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((b: { text?: string; thinking?: string }) => b.text ?? b.thinking ?? "").join("");
      return "";
    })
    .join("\n");
}

/** A StreamFn that plays `replies` in order and records every request. */
export function scripted(replies: Reply[]): StreamFn & { calls: { context: TranscriptContext; options: SimpleStreamOptions | undefined }[] } {
  const calls: { context: TranscriptContext; options: SimpleStreamOptions | undefined }[] = [];
  const fn = ((_model, context, options) => {
    calls.push({ context, options });
    const reply = replies.shift();
    const s = createAssistantMessageEventStream();
    void (async () => {
      if (reply === undefined) {
        const m = fail("script exhausted");
        s.push({ type: "error", reason: "error", error: m });
        return;
      }
      if (reply === "hang") {
        await new Promise<void>((r) => {
          if (options?.signal?.aborted) r();
          options?.signal?.addEventListener("abort", () => r(), { once: true });
        });
        s.push({ type: "error", reason: "aborted", error: fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "aborted" }) });
        return;
      }
      if (typeof reply === "object" && "stall" in reply) {
        const partial = { ...fauxAssistantMessage([]), content: [] as AssistantMessage["content"] };
        s.push({ type: "start", partial });
        s.push({ type: "text_start", contentIndex: 0, partial });
        s.push({ type: "text_delta", contentIndex: 0, delta: reply.stall, partial });
        await new Promise<void>((r) => options?.signal?.addEventListener("abort", () => r(), { once: true }));
        s.push({ type: "error", reason: "aborted", error: fauxAssistantMessage(fauxText(reply.stall), { stopReason: "aborted", errorMessage: "aborted" }) });
        return;
      }
      const msg = typeof reply === "function" ? await reply(context, options) : reply;
      const partial = { ...msg, content: [] as AssistantMessage["content"] };
      s.push({ type: "start", partial });
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        s.push({ type: "error", reason: msg.stopReason, error: msg });
        return;
      }
      msg.content.forEach((c, i) => {
        if (c.type === "text") {
          s.push({ type: "text_start", contentIndex: i, partial });
          s.push({ type: "text_delta", contentIndex: i, delta: c.text, partial });
          s.push({ type: "text_end", contentIndex: i, content: c.text, partial });
        } else if (c.type === "toolCall") {
          s.push({ type: "toolcall_start", contentIndex: i, partial });
          s.push({ type: "toolcall_end", contentIndex: i, toolCall: c, partial });
        }
      });
      s.push({ type: "done", reason: msg.stopReason as "stop", message: msg });
    })();
    return s;
  }) as StreamFn & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}
