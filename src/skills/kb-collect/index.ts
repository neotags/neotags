import type { Summary } from "./summary.js";
import { renderMarkdown, summarize } from "./summary.js";
import type { Task } from "../../task.js";
import { redact } from "../../tools/redact.js";
import type { SlackMessage } from "../../tools/slack.js";
import type { Skill, SkillAction, SkillContext } from "../types.js";

/** Deterministic, so recording the same thread again updates the same KB entry. */
export const docId = (channel: string, threadTs: string) => `neotags-slack-${channel}-${threadTs}`;

const NAME = "kb-collect";
const CHARS_PER_TOKEN = 4;

function transcriptOf(msgs: SlackMessage[]): string {
  return msgs
    .map((m) => {
      const when = new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace("T", " ");
      const files = m.files.length ? ` [attachments: ${m.files.join(", ")}]` : "";
      return `[${when}] ${m.userName}${m.bot ? " (bot)" : ""}: ${m.text}${files}`;
    })
    .join("\n");
}

/** Keep the start and end of an over-long thread; the middle is the least informative part. */
function fit(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const max = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= max) return { text, truncated: false };
  const half = Math.floor(max / 2);
  return {
    text: `${text.slice(0, half)}\n[... middle of the thread omitted ...]\n${text.slice(-half)}`,
    truncated: true,
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function resultBlocks(s: Summary, id: string, redactions: number, permalink: string) {
  const lines = [
    `*Saved to the knowledge base: ${esc(s.title)}*`,
    esc(clip(s.summary, 600)),
    s.root_cause && s.root_cause !== "unknown" ? `*Root cause:* ${esc(clip(s.root_cause, 300))}` : "",
    s.confidence === "low" ? "_Low confidence: the thread did not reach a clear conclusion._" : "",
  ].filter(Boolean);
  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${s.type} · confidence ${s.confidence}${redactions ? ` · ${redactions} secret(s) redacted` : ""} · <${permalink}|source thread>`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: `${NAME}:undo`, value: id, text: { type: "plain_text", text: "Undo" }, style: "danger" },
      ],
    },
  ];
}

export function createKbCollect(): Skill {
  return {
    name: NAME,
    description:
      "Summarize the current Slack thread and save it to the team knowledge base (e.g. 'record the knowledge', 'save this to the KB', 'document this thread'). Only for requests made inside a thread.",

    async run(task: Task, ctx: SkillContext) {
      const reply = (text: string, blocks?: unknown[]) => ctx.notifier.reply(task.reply, text, blocks);

      if (!task.thread) {
        return reply("I record a *thread*, so mention me in a reply inside the thread you want saved.");
      }
      if (!ctx.onyx) return reply("The knowledge base (Onyx) is not configured for me yet.");

      const channel = task.reply.channel;
      const info = await ctx.slack.channel(channel);
      if (!info.isPublic) {
        return reply("For now I only record threads from *public* channels.");
      }

      const all = await ctx.slack.thread(channel, task.thread.ts);
      const msgs = all.filter((m) => m.ts !== task.triggerTs && m.text.trim());
      if (msgs.length === 0) return reply("There is nothing in this thread to record yet.");

      const redacted = redact(transcriptOf(msgs));
      const fitted = fit(redacted.text, ctx.maxInputTokens);
      const summary = await summarize(ctx.llm, fitted.text, redact(task.text).text);

      const [permalink, recordedBy] = await Promise.all([
        ctx.slack.permalink(channel, task.thread.ts),
        ctx.slack.userName(task.actor.id),
      ]);
      const participants = [...new Set(msgs.filter((m) => !m.bot).map((m) => m.userName))];
      const id = docId(channel, task.thread.ts);
      const markdown = renderMarkdown(summary, {
        participants,
        permalink,
        redactions: redacted.count,
        truncated: fitted.truncated,
      });

      await ctx.onyx.upsert({
        id,
        semantic_identifier: summary.title,
        sections: [{ text: markdown, link: permalink }],
        metadata: {
          type: summary.type,
          services: summary.services,
          tags: summary.tags,
          channel: `#${info.name}`,
          recorded_by: recordedBy,
          slack_user: task.actor.id,
          confidence: summary.confidence,
          origin: "neotags",
        },
        doc_updated_at: new Date().toISOString(),
      });
      ctx.log.info({ taskId: task.id, docId: id, redactions: redacted.count }, "knowledge recorded");

      await reply(
        `Saved to the knowledge base: ${summary.title}`,
        resultBlocks(summary, id, redacted.count, permalink),
      );
    },

    async onAction(action: SkillAction, ctx: SkillContext) {
      if (action.id !== "undo") return "Unknown action.";
      if (!ctx.onyx) return "The knowledge base (Onyx) is not configured.";
      await ctx.onyx.delete(action.value);
      ctx.log.info({ docId: action.value, by: action.actor.id }, "knowledge entry undone");
      return `↩️ Removed from the knowledge base (undone by <@${action.actor.id}>).`;
    },
  };
}
