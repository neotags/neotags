import { excerpts, fitToBudget, prepare } from "./prepare.js";
import { renderMarkdown, SCHEMA_VERSION, summarizeThread, type Summary } from "./summary.js";
import type { Task } from "../../task.js";
import { redact } from "../../tools/redact.js";
import { checkChannel } from "../channel-policy.js";
import { collectFiles, describeCollected, sharedFiles, type CollectResult } from "../kb-files/collect.js";
import { undoEntries, undoValue } from "../kb-files/index.js";
import type { Skill, SkillAction, SkillContext } from "../types.js";

/** Deterministic, so recording the same thread again updates the same KB entry. */
export const docId = (channel: string, threadTs: string) => `neotags-slack-${channel}-${threadTs}`;

const NAME = "kb-collect";
/** Up to this many prompt-sized parts are summarized by map-reduce; a thread beyond that is thinned first. */
const MAX_PARTS = 8;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function resultBlocks(s: Summary, ids: string[], redactions: number, permalink: string, isPrivate: boolean, files?: CollectResult) {
  const lines = [
    `*Saved to the knowledge base: ${esc(s.title)}*`,
    esc(clip(s.summary, 600)),
    s.root_cause && s.root_cause !== "unknown" ? `*Root cause:* ${esc(clip(s.root_cause, 300))}` : "",
    s.confidence === "low" ? "_Low confidence: the thread did not reach a clear conclusion._" : "",
    files?.indexed.length || files?.skipped.length ? `*Attachments:*\n${describeCollected(files).join("\n")}` : "",
    isPrivate ? ":lock: _This thread is from a private channel. The entry is visible to everyone who can search the knowledge base. Use Undo if that is not what you want._" : "",
  ].filter(Boolean);
  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${s.type} · ${s.outcome} · confidence ${s.confidence}${redactions ? ` · ${redactions} secret(s) redacted` : ""} · <${permalink}|source thread>`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: `${NAME}:undo`, value: undoValue(ids), text: { type: "plain_text", text: "Undo" }, style: "danger" },
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
      const check = await checkChannel(ctx, channel, "threads");
      if (!check.ok) return reply(check.message);
      const { info, isPrivate } = check;

      const all = await ctx.slack.thread(channel, task.thread.ts);
      const raw = all.filter((m) => m.ts !== task.triggerTs);

      // 1. drop noise, redact, number the messages
      const budgetChars = ctx.maxInputTokens * ctx.charsPerToken;
      const prepared = fitToBudget(prepare(raw), budgetChars * MAX_PARTS);
      if (prepared.msgs.length === 0) return reply("There is nothing in this thread to record yet.");

      // 2. summarize (single pass, or map-reduce for long threads)
      const { summary, parts } = await summarizeThread(ctx.llm, prepared, redact(task.text).text, budgetChars);

      // 3. link the messages the summary cites
      const byN = new Map(prepared.msgs.map((m) => [m.n, m]));
      const cited = summary.evidence.map((n) => byN.get(n)!).filter(Boolean);
      const links = await Promise.allSettled(cited.map((m) => ctx.slack.permalink(channel, m.ts)));
      const evidence = cited.map((m, i) => {
        const l = links[i]!;
        return {
          n: m.n,
          who: m.who,
          when: new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace("T", " "),
          snippet: m.text.replace(/\s+/g, " ").slice(0, 160),
          url: l.status === "fulfilled" ? l.value : undefined,
        };
      });

      const [permalink, recordedBy] = await Promise.all([
        ctx.slack.permalink(channel, task.thread.ts),
        ctx.slack.userName(task.actor.id),
      ]);
      const participants = [...new Set(prepared.msgs.filter((m) => !m.bot).map((m) => m.who))];
      const id = docId(channel, task.thread.ts);

      // Files shared in the thread are indexed as their own KB entries; a failure here must not lose the summary.
      let files: CollectResult | undefined;
      if (ctx.attachments.enabled) {
        try {
          const shared = sharedFiles(all);
          if (shared.length) {
            files = await collectFiles(shared, ctx, {
              channelName: info.name,
              isPrivate,
              recordedBy,
              actorId: task.actor.id,
              threadDocId: id,
              threadLink: permalink,
            });
          }
        } catch (err) {
          ctx.log.warn({ err, taskId: task.id }, "attachment collection failed; thread recorded without files");
        }
      }
      const markdown = renderMarkdown(summary, {
        participants,
        permalink,
        redactions: prepared.redactions,
        privateSource: isPrivate,
        filtered: prepared.filtered,
        budgetDropped: prepared.budgetDropped,
        parts,
        evidence,
      });
      // Second section: verbatim errors/commands/links, so exact-match search works even when the
      // summary paraphrases them.
      const verbatim = excerpts(prepared.msgs);

      await ctx.onyx.upsert({
        id,
        semantic_identifier: summary.title,
        sections: [
          { text: markdown, link: permalink },
          ...(verbatim ? [{ text: `Key excerpts from the thread (verbatim, redacted)\n\n${verbatim}`, link: permalink }] : []),
          ...(files?.indexed.length
            ? [{ text: `Files shared in this thread, indexed as separate entries:\n${files.indexed.map((f) => `- ${f.name}${f.description ? `: ${f.description}` : ""}`).join("\n")}`, link: permalink }]
            : []),
        ],
        metadata: {
          type: summary.type,
          outcome: summary.outcome,
          services: summary.services,
          tags: summary.tags,
          channel: `#${info.name}`,
          recorded_by: recordedBy,
          slack_user: task.actor.id,
          confidence: summary.confidence,
          origin: "neotags",
          source_visibility: isPrivate ? "private-channel" : "public-channel",
          schema_version: SCHEMA_VERSION,
          message_count: String(prepared.msgs.length),
        },
        doc_updated_at: new Date().toISOString(),
      });
      ctx.log.info(
        { taskId: task.id, docId: id, messages: prepared.msgs.length, filtered: prepared.filtered, parts, redactions: prepared.redactions },
        "knowledge recorded",
      );

      await reply(
        `Saved to the knowledge base: ${summary.title}`,
        resultBlocks(summary, [id, ...(files?.indexed.map((f) => f.id) ?? [])], prepared.redactions, permalink, isPrivate, files),
      );
    },

    async onAction(action: SkillAction, ctx: SkillContext) {
      if (action.id !== "undo") return "Unknown action.";
      if (!ctx.onyx) return "The knowledge base (Onyx) is not configured.";
      await undoEntries(action.value, ctx);
      ctx.log.info({ docIds: action.value, by: action.actor.id }, "knowledge entry undone");
      return `↩️ Removed from the knowledge base (undone by <@${action.actor.id}>).`;
    },
  };
}
