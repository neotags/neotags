import type { Config } from "../config/index.js";
import { DeliveryError, type DeliveryContext, type DeliveryResult } from "../routines/outbox.js";
import type { Bundle } from "./bundle.js";

// Slack delivery (S-D13): the section's text as one message, then each attachment as a file in that message's thread.
// Two steps, recorded apart: a retry never posts the message again once it has a ts, it only uploads the files that
// are not recorded yet.

/** What the Outbox needs of Slack's Web API (the bot token's WebClient). */
export interface SlackApi {
  chat: {
    postMessage(a: { channel: string; text: string; unfurl_links: boolean; unfurl_media: boolean; mrkdwn?: boolean }): Promise<{ ok?: boolean; ts?: string; channel?: string; error?: string }>;
    getPermalink(a: { channel: string; message_ts: string }): Promise<{ permalink?: string }>;
  };
  files: {
    uploadV2(a: { channel_id: string; thread_ts: string; file: Buffer; filename: string; title: string }): Promise<unknown>;
  };
}

export interface SlackDetail {
  channel: string;
  /** Step one: the message. */
  message?: { ts: string; link?: string; at: string };
  /** Step two: each attachment, by file name. */
  files: Record<string, { id?: string; at: string }>;
}

/** Slack cuts a message's text at 40,000 characters; cut it ourselves, leaving room for the footer. */
const MAX_TEXT_CHARS = 38_000;

type Target = Config["routines"][string]["delivery"]["slack"][number];

export function slackChannel(cfg: Pick<Config, "outbox">, channel: string, dryRun: boolean): string {
  const to = dryRun ? cfg.outbox.slack.testChannel : channel;
  // Checked at startup too; here because a send is the side effect that must never leave the allowlist.
  if (!to || !cfg.outbox.slack.allowedChannels.includes(to)) throw new DeliveryError("allowlist", `channel ${to ?? "(no test channel)"} is not in outbox.slack.allowedChannels`);
  return to;
}

export function footer(ctx: Pick<DeliveryContext, "period" | "runIds" | "dryRun">, lang: string): string {
  const runs = ctx.runIds.length ? ctx.runIds.join(", ") : undefined;
  const parts =
    lang === "zh"
      ? [`期次 ${ctx.period}`, ...(runs ? [`run ${runs}`] : []), ...(ctx.dryRun ? ["试运行"] : [])]
      : [`period ${ctx.period}`, ...(runs ? [`run ${runs}`] : []), ...(ctx.dryRun ? ["dry run"] : [])];
  return `_${parts.join(" · ")}_`;
}

/** The message: the mention (never on a dry run: the test channel is not the team's), the text, the footer. */
export function messageText(text: string, t: Pick<Target, "mention" | "lang">, ctx: Pick<DeliveryContext, "period" | "runIds" | "dryRun">): string {
  const body = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n…` : text;
  return [...(t.mention && !ctx.dryRun ? [t.mention] : []), body, footer(ctx, t.lang)].join("\n\n");
}

const slackError = (err: unknown): string => {
  const data = (err as { data?: { error?: unknown } }).data;
  return typeof data?.error === "string" ? data.error : err instanceof Error ? err.message : String(err);
};

/** The file id from files.uploadV2's answer: `{files: [{files: [{id}]}]}`. */
const uploadedId = (r: unknown): string | undefined => {
  const outer = (r as { files?: { files?: { id?: unknown }[] }[] }).files;
  const id = outer?.[0]?.files?.[0]?.id;
  return typeof id === "string" ? id : undefined;
};

export async function deliverSlack(
  api: SlackApi,
  cfg: Pick<Config, "outbox">,
  t: Target,
  bundle: Bundle,
  ctx: DeliveryContext,
  did: (step: string) => void,
  warn: (obj: object, msg: string) => void,
): Promise<DeliveryResult> {
  const channel = slackChannel(cfg, t.channel, ctx.dryRun);
  const part = await bundle.part(t.section, t.lang);
  if (!part) throw new DeliveryError("bundle", `the bundle has no section ${t.section} in ${t.lang}`);
  const prev = ctx.previous?.detail as Partial<SlackDetail> | undefined;
  // A message in another channel (the test channel then, say) is not this one's: start over.
  const same = prev?.channel === channel;
  const detail: SlackDetail = { channel, ...(same && prev?.message && { message: prev.message }), files: same ? { ...prev?.files } : {} };

  if (!detail.message) {
    await ctx.confirm();
    let ts: string | undefined;
    try {
      const r = await api.chat.postMessage({ channel, text: messageText(part.slack, t, ctx), unfurl_links: false, unfurl_media: false, mrkdwn: true });
      ts = r.ts;
      if (!ts) throw new Error(r.error ?? "no ts in the answer");
    } catch (err) {
      throw new DeliveryError("message", `chat.postMessage: ${slackError(err)}`, detail);
    }
    detail.message = { ts, at: new Date().toISOString() };
    did("message");
    // Recorded before anything else: from here on a retry must not post it again.
    await ctx.progress(detail);
  }
  // Also on a retry whose first attempt could not get it.
  if (!detail.message.link) {
    let link: string | undefined;
    try {
      link = (await api.chat.getPermalink({ channel, message_ts: detail.message.ts })).permalink;
    } catch (err) {
      // The message is there; only its link is missing from the records.
      warn({ routine: ctx.routine, period: ctx.period, channel, err: slackError(err) }, "chat.getPermalink failed");
    }
    if (link) {
      detail.message = { ...detail.message, link };
      await ctx.progress(detail);
    }
  }
  const threadTs = detail.message.ts;
  for (const [name, content] of Object.entries(part.attachments)) {
    if (detail.files[name]) continue;
    await ctx.confirm();
    let id: string | undefined;
    try {
      id = uploadedId(await api.files.uploadV2({ channel_id: channel, thread_ts: threadTs, file: Buffer.from(content, "utf8"), filename: name, title: name }));
    } catch (err) {
      throw new DeliveryError("file", `files.uploadV2 ${name}: ${slackError(err)}`, detail);
    }
    detail.files[name] = { ...(id && { id }), at: new Date().toISOString() };
    did(`file:${name}`);
    await ctx.progress(detail);
  }
  return { ...(detail.message.link && { link: detail.message.link }), detail };
}
