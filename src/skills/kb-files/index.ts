import type { Task } from "../../task.js";
import { checkChannel } from "../channel-policy.js";
import type { Skill, SkillAction, SkillContext } from "../types.js";
import { collectFiles, describeCollected, sharedFiles } from "./collect.js";

const NAME = "kb-files";

/** Undo button value: the KB entries to remove, comma-separated (Slack caps a value at 2000 chars). */
export const undoValue = (ids: string[]) => ids.join(",");

/** Remove the KB entries named by an Undo value. Shared with kb-collect, whose button can carry files too. */
export async function undoEntries(value: string, ctx: SkillContext): Promise<number> {
  const ids = value.split(",").filter(Boolean);
  for (const id of ids) await ctx.onyx!.delete(id);
  return ids.length;
}

export function createKbFiles(): Skill {
  return {
    name: NAME,
    description:
      "Save the files shared in the current Slack thread or message (PDF, Word, Excel, PowerPoint, CSV, text, HTML) to the team knowledge base so they can be searched and asked about (e.g. 'save these files', 'index the attached report', 'add this PDF to the KB'). Use this, not kb-collect, when the user wants the files rather than a summary of the discussion.",

    async run(task: Task, ctx: SkillContext) {
      const reply = (text: string, blocks?: unknown[]) => ctx.notifier.reply(task.reply, text, blocks);

      if (!ctx.attachments.enabled) return reply("Reading attachments is turned off for me.");
      if (!ctx.onyx) return reply("The knowledge base (Onyx) is not configured for me yet.");
      // In a thread: every file in it. Otherwise the mention itself may carry the upload.
      const root = task.thread?.ts ?? task.triggerTs;
      if (!root) return reply("Mention me in a message with a file, or in a thread that has files.");

      const channel = task.reply.channel;
      const check = await checkChannel(ctx, channel, "files");
      if (!check.ok) return reply(check.message);

      const files = sharedFiles(await ctx.slack.thread(channel, root));
      if (!files.length) return reply("I don't see any files in this message or thread.");

      const [recordedBy, threadLink] = await Promise.all([
        ctx.slack.userName(task.actor.id),
        task.thread ? ctx.slack.permalink(channel, task.thread.ts) : undefined,
      ]);
      const result = await collectFiles(files, ctx, {
        channelName: check.info.name,
        isPrivate: check.isPrivate,
        recordedBy,
        actorId: task.actor.id,
        threadLink,
      });

      if (!result.indexed.length) {
        return reply(`I couldn't save any of the files:\n${describeCollected(result).join("\n")}`);
      }
      const ids = result.indexed.map((f) => f.id);
      const text = `Saved ${result.indexed.length} file${result.indexed.length === 1 ? "" : "s"} to the knowledge base`;
      await reply(text, [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              `*${text}* (searchable in a few minutes)`,
              ...describeCollected(result),
              check.isPrivate ? ":lock: _These files are from a private channel. They are visible to everyone who can search the knowledge base. Use Undo if that is not what you want._" : "",
              `Ask about them: \`@${ctx.botName} what does <file> say about ...?\``,
            ].filter(Boolean).join("\n"),
          },
        },
        {
          type: "actions",
          elements: [
            { type: "button", action_id: `${NAME}:undo`, value: undoValue(ids), text: { type: "plain_text", text: "Undo" }, style: "danger" },
          ],
        },
      ]);
    },

    async onAction(action: SkillAction, ctx: SkillContext) {
      if (action.id !== "undo") return "Unknown action.";
      if (!ctx.onyx) return "The knowledge base (Onyx) is not configured.";
      const n = await undoEntries(action.value, ctx);
      ctx.log.info({ docIds: action.value, by: action.actor.id }, "file entries undone");
      return `↩️ Removed ${n} file${n === 1 ? "" : "s"} from the knowledge base (undone by <@${action.actor.id}>).`;
    },
  };
}
