export interface SlackMessage {
  ts: string;
  userId?: string;
  userName: string;
  text: string;
  /** Attachment names only; file contents are not read in v1. */
  files: string[];
  bot: boolean;
}

export type ChannelKind =
  | "public"
  | "private" // private channel
  | "dm" // 1:1 or group DM
  | "unknown"; // Slack will not describe it: bot not a member, or scope missing for private channels

export interface ChannelInfo {
  id: string;
  name: string;
  kind: ChannelKind;
}

export interface SlackReader {
  thread(channel: string, threadTs: string): Promise<SlackMessage[]>;
  permalink(channel: string, ts: string): Promise<string>;
  channel(channel: string): Promise<ChannelInfo>;
  userName(userId: string): Promise<string>;
}

interface RawMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  subtype?: string;
  files?: { name?: string; title?: string }[];
}

/** The slice of the Slack Web API we use (structural, so tests can fake it). */
export interface SlackWebApi {
  conversations: {
    replies(a: { channel: string; ts: string; cursor?: string; limit?: number }): Promise<{
      messages?: RawMessage[];
      response_metadata?: { next_cursor?: string };
    }>;
    info(a: { channel: string }): Promise<{
      channel?: { id?: string; name?: string; is_private?: boolean; is_im?: boolean; is_mpim?: boolean };
    }>;
  };
  users: {
    info(a: { user: string }): Promise<{
      user?: { real_name?: string; name?: string; profile?: { display_name?: string } };
    }>;
  };
  chat: { getPermalink(a: { channel: string; message_ts: string }): Promise<{ permalink?: string }> };
}

const MAX_MESSAGES = 1000;

export function createSlackReader(api: SlackWebApi): SlackReader {
  const names = new Map<string, Promise<string>>();

  const userName = (id: string): Promise<string> => {
    let p = names.get(id);
    if (!p) {
      p = api.users
        .info({ user: id })
        .then((r) => r.user?.profile?.display_name || r.user?.real_name || r.user?.name || id)
        .catch(() => id); // a failed lookup must not fail the whole recording
      names.set(id, p);
    }
    return p;
  };

  /** Turn Slack markup into plain text: user/channel mentions, links, entities. */
  async function clean(text: string): Promise<string> {
    const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!))];
    const resolved = new Map(await Promise.all(ids.map(async (id) => [id, await userName(id)] as const)));
    return text
      .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${resolved.get(id) ?? id}`)
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
      .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
      .replace(/<(https?:[^>|]+)\|([^>]+)>/g, "$2 ($1)")
      .replace(/<(https?:[^>]+)>/g, "$1")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  return {
    userName,

    async thread(channel, threadTs) {
      const raw: RawMessage[] = [];
      let cursor: string | undefined;
      do {
        const r = await api.conversations.replies({ channel, ts: threadTs, cursor, limit: 200 });
        raw.push(...(r.messages ?? []));
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor && raw.length < MAX_MESSAGES);

      const out: SlackMessage[] = [];
      for (const m of raw.slice(0, MAX_MESSAGES)) {
        if (!m.ts || m.subtype === "channel_join" || m.subtype === "channel_leave") continue;
        out.push({
          ts: m.ts,
          userId: m.user,
          userName: m.user ? await userName(m.user) : (m.username ?? "bot"),
          text: await clean(m.text ?? ""),
          files: (m.files ?? []).map((f) => f.name || f.title || "file"),
          bot: Boolean(m.bot_id),
        });
      }
      return out;
    },

    async permalink(channel, ts) {
      const r = await api.chat.getPermalink({ channel, message_ts: ts });
      if (!r.permalink) throw new Error("Slack returned no permalink");
      return r.permalink;
    },

    async channel(channel) {
      try {
        const c = (await api.conversations.info({ channel })).channel;
        const kind: ChannelKind = !c
          ? "unknown"
          : c.is_im || c.is_mpim
            ? "dm"
            : c.is_private
              ? "private"
              : "public";
        return { id: c?.id ?? channel, name: c?.name ?? channel, kind };
      } catch (err) {
        // Describing a private channel, DM or group DM needs groups:read / im:read / mpim:read, and a
        // channel the bot is not in is "not found". Report "unknown" so the skill can answer helpfully. A
        // missing channels:read on a public channel is a real configuration error and still throws.
        const d = (err as { data?: { error?: string; needed?: string } }).data;
        const privateScope = /^(groups|im|mpim):/.test(d?.needed ?? "");
        if ((d?.error === "missing_scope" && privateScope) || d?.error === "channel_not_found") {
          return { id: channel, name: channel, kind: "unknown" };
        }
        throw err;
      }
    },
  };
}
