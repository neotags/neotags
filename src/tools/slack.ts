/** A file shared in Slack. Contents are fetched on demand with `SlackReader.download`. */
export interface SlackFile {
  id: string;
  name: string;
  mimetype?: string;
  size?: number;
  /** Slack's page for the file; used as the citation link. */
  permalink?: string;
  downloadUrl?: string;
}

export interface SlackMessage {
  ts: string;
  userId?: string;
  userName: string;
  text: string;
  /** Attachment names only (for the transcript). */
  files: string[];
  /** The same files with what is needed to fetch them. */
  attachments?: SlackFile[];
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
  /** Fetch a file's bytes. Throws SlackFileError (message safe to show) when it can't be read or is over `maxBytes`. */
  download(file: SlackFile, maxBytes: number): Promise<Buffer>;
}

export class SlackFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackFileError";
  }
}

interface RawMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  subtype?: string;
  files?: RawFile[];
}

interface RawFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  mode?: string;
  file_access?: string;
  permalink?: string;
  url_private_download?: string;
  url_private?: string;
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

export interface SlackDownloadSettings {
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Files that can actually be fetched: not deleted ("tombstone"), not hidden by the plan limit, not external links. */
function toFile(f: RawFile): SlackFile | undefined {
  if (!f.id || f.mode === "tombstone" || f.mode === "hidden_by_limit" || f.mode === "external" || f.file_access === "access_denied") {
    return undefined;
  }
  return {
    id: f.id,
    name: f.name || f.title || f.id,
    mimetype: f.mimetype,
    size: f.size,
    permalink: f.permalink,
    downloadUrl: f.url_private_download ?? f.url_private,
  };
}

export function createSlackReader(api: SlackWebApi, dl?: SlackDownloadSettings): SlackReader {
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
          attachments: (m.files ?? []).map(toFile).filter((f): f is SlackFile => Boolean(f)),
          bot: Boolean(m.bot_id),
        });
      }
      return out;
    },

    async download(file, maxBytes) {
      if (!dl) throw new SlackFileError("file download is not configured");
      if (file.size !== undefined && file.size > maxBytes) throw new SlackFileError("the file is too large");
      let url: URL;
      try {
        url = new URL(file.downloadUrl ?? "");
      } catch {
        throw new SlackFileError("Slack gave no download link for it");
      }
      // The bot token is sent along, so only ever to Slack's file host over https.
      if (url.protocol !== "https:" || !/(^|\.)slack\.com$/.test(url.hostname)) {
        throw new SlackFileError("unexpected download host");
      }
      let res: Response;
      try {
        res = await (dl.fetchImpl ?? fetch)(url, {
          headers: { authorization: `Bearer ${dl.token}` },
          redirect: "manual", // a redirect would carry (or drop) the token somewhere we did not vet
          signal: AbortSignal.timeout(dl.timeoutMs ?? 60_000),
        });
      } catch (err) {
        throw new SlackFileError(`download failed: ${(err as Error).message}`);
      }
      // Without files:read Slack answers with a login page instead of the bytes.
      if (res.status >= 300 || (/text\/html/i.test(res.headers.get("content-type") ?? "") && !/html?$/i.test(file.name))) {
        throw new SlackFileError("Slack refused the download (is the files:read scope granted?)");
      }
      const declared = Number(res.headers.get("content-length"));
      if (declared > maxBytes) throw new SlackFileError("the file is too large");
      const chunks: Uint8Array[] = [];
      let got = 0;
      for await (const chunk of res.body ?? []) {
        got += chunk.length;
        if (got > maxBytes) throw new SlackFileError("the file is too large");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
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
