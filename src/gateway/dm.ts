/** The Slack `message` event, as much as the DM handler needs (Bolt's union is wide). */
export interface MaybeDm {
  channel: string;
  ts: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  channel_type?: string;
}

/**
 * Only a human talking 1:1 to the bot counts as a DM task. Bolt fires `message` for channel traffic, bot
 * echoes (including our own replies), edits and other machine subtypes; `file_share` is a human upload
 * with optional text, so it passes and the router decides what to do with it.
 */
export function isDmMessage(e: MaybeDm): e is MaybeDm & { channel_type: "im"; user: string; text: string } {
  return (
    e.channel_type === "im" &&
    !e.bot_id &&
    (e.subtype === undefined || e.subtype === "file_share") &&
    Boolean(e.user) &&
    e.text !== undefined
  );
}
