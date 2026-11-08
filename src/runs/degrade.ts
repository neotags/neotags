import { answerLang } from "../lang.js";
import { redact } from "../tools/redact.js";
import type { RunInput } from "./types.js";

const MAX_VALUE_CHARS = 500;
const MAX_FIELDS = 12;

function show(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > MAX_VALUE_CHARS ? `${one.slice(0, MAX_VALUE_CHARS)}…` : one;
}

/** Why a run is answered by code. The raw error stays in the logs: it can name internal hosts. */
export type DegradeReason = "model_unavailable" | "model_error" | "deadline" | "error";

const REASONS: Record<DegradeReason, { zh: string; en: string }> = {
  model_unavailable: { zh: "模型暂时不可用（熔断已打开）", en: "the model is unavailable (circuit breaker open)" },
  model_error: { zh: "模型调用失败", en: "the model request failed" },
  deadline: { zh: "超过了单次排查的时长上限", en: "the run hit its time limit" },
  error: { zh: "内部错误", en: "internal error" },
};

/**
 * The answer when no model can answer: what the asker was looking at, the entry's links, and a clear note that
 * the AI is unavailable. Written by code from the request alone, so it works with the gateway down.
 */
export function contextPackage(input: RunInput, why: DegradeReason): string {
  const lang = answerLang(input.question);
  const reason = REASONS[why][lang];
  const zh = lang === "zh";
  const lines = [zh ? "⚠️ *AI 暂时不可用*，下面是这次提问的上下文，可以先手动查看。" : "⚠️ *AI is temporarily unavailable.* Here is the context of your question to check by hand."];
  const fields = Object.entries(input.context ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (fields.length > 0) {
    lines.push("", zh ? "*页面上下文*" : "*Page context*");
    for (const [k, v] of fields.slice(0, MAX_FIELDS)) {
      lines.push(`• ${k}: \`${redact(show(v)).text.replace(/`/g, "'")}\``);
    }
  }
  if (input.links?.length) {
    lines.push("", zh ? "*相关链接*" : "*Links*");
    for (const l of input.links) lines.push(`• [${l.title}](${l.url})`);
  }
  lines.push("", zh ? `_原因：${reason}。稍后再问一次即可。_` : `_Reason: ${reason}. Ask again in a few minutes._`);
  return lines.join("\n");
}

/** Short notices for runs that never started or were stopped. */
export function notice(kind: "shutting_down" | "interrupted" | "cancelled", question: string): string {
  const zh = answerLang(question) === "zh";
  switch (kind) {
    case "shutting_down":
      return zh ? "服务正在更新，请稍后重新提问。" : "The service is restarting; please ask again in a moment.";
    case "interrupted":
      return zh ? "排查被中断（服务正在更新），请重新提问。" : "The run was interrupted (the service is restarting); please ask again.";
    case "cancelled":
      return zh ? "已取消。" : "Cancelled.";
  }
}
