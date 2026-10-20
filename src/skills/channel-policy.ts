import type { ChannelInfo } from "../tools/slack.js";
import type { SkillContext } from "./types.js";

export type ChannelCheck = { ok: true; info: ChannelInfo; isPrivate: boolean } | { ok: false; message: string };

/**
 * Whether the bot may copy content from this channel into the KB. `what` is the plural noun used in
 * replies ("threads", "files"). DMs are never recorded; private channels only when enabled.
 */
export async function checkChannel(ctx: SkillContext, channel: string, what: string): Promise<ChannelCheck> {
  const info = await ctx.slack.channel(channel);
  if (info.kind === "dm") return { ok: false, message: "I don't record direct messages." };
  if (info.kind === "unknown") {
    return {
      ok: false,
      message: ctx.allowPrivateChannels
        ? "I can't see this channel. If it's private, invite me to it and make sure the Slack app has the `groups:read` and `groups:history` scopes."
        : `I can't see this channel, so I only record ${what} from *public* channels I'm in. (Private channels need to be enabled for me.)`,
    };
  }
  if (info.kind === "private" && !ctx.allowPrivateChannels) {
    return { ok: false, message: `For now I only record ${what} from *public* channels. Private channels aren't enabled for me.` };
  }
  return { ok: true, info, isPrivate: info.kind === "private" };
}
