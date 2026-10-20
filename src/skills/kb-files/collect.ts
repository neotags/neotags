import { describeFile, renderFileSummary, type FileSummary } from "./describe.js";
import { detectKind, extract, UnsupportedFileError } from "../../tools/extract.js";
import type { OnyxDocument } from "../../tools/onyx.js";
import { redact } from "../../tools/redact.js";
import { SlackFileError, type SlackFile, type SlackMessage } from "../../tools/slack.js";
import type { SkillContext } from "../types.js";

/** Slack file ids are stable, so sharing or collecting the same file again updates the same KB entry. */
export const fileDocId = (fileId: string) => `neotags-file-${fileId}`;

/** Input cap for one file summary, whatever the prompt budget allows. */
const MAX_SUMMARY_INPUT_CHARS = 80_000;

export const FILE_SCHEMA_VERSION = "2";

export interface SharedFile {
  file: SlackFile;
  sharedBy: string;
  /** ts of the message that carried the file. */
  ts: string;
  /** Text of that message; it often says what the file is for. */
  note?: string;
}

export interface IndexedFile {
  id: string;
  name: string;
  kind: string;
  sections: number;
  chars: number;
  redactions: number;
  truncated: boolean;
  /** One-line description from the file summary, when one was written. */
  description?: string;
}

export interface CollectResult {
  indexed: IndexedFile[];
  skipped: { name: string; reason: string }[];
}

export interface CollectSource {
  channelName: string;
  isPrivate: boolean;
  recordedBy: string;
  actorId: string;
  /** KB entry of the thread summary the files belong to, when they were collected with one. */
  threadDocId?: string;
  threadLink?: string;
}

/** Distinct files across messages, in order of appearance. */
export function sharedFiles(msgs: SlackMessage[]): SharedFile[] {
  const seen = new Set<string>();
  const out: SharedFile[] = [];
  for (const m of msgs) {
    for (const file of m.attachments ?? []) {
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      out.push({ file, sharedBy: m.userName, ts: m.ts, note: m.text.trim() || undefined });
    }
  }
  return out;
}

/**
 * Download, extract, redact and upsert each file into Onyx, one at a time (bounded memory). A file that
 * can't be used is reported as skipped; an Onyx failure aborts, since nothing could be stored anyway.
 */
export async function collectFiles(files: SharedFile[], ctx: SkillContext, src: CollectSource): Promise<CollectResult> {
  const { maxFileBytes, maxFiles, maxTextChars } = ctx.attachments;
  const result: CollectResult = { indexed: [], skipped: [] };
  const batch = files.slice(0, maxFiles);
  for (const f of files.slice(maxFiles)) result.skipped.push({ name: f.file.name, reason: `over the limit of ${maxFiles} files per request` });

  for (const { file, sharedBy, ts, note: rawNote } of batch) {
    try {
      detectKind(file.name, file.mimetype); // refuse images/video/legacy formats before downloading them
      const bytes = await ctx.slack.download(file, maxFileBytes);
      const ex = await extract(bytes, file.name, file.mimetype, { maxChars: maxTextChars });

      let redactions = 0;
      const sections = ex.sections
        .map((s) => {
          const r = redact(s.text);
          redactions += r.count;
          return { title: s.title, text: r.text };
        })
        .filter((s) => s.text.trim());
      if (!sections.length) {
        throw new UnsupportedFileError("no text found in it (a scan or image-only file? OCR isn't supported yet)");
      }

      // The message that came with the file (redacted, clipped) is context for the summary and for search.
      const note = rawNote ? redact(rawNote).text.replace(/\s+/g, " ").slice(0, 500) : undefined;

      // A catalogue entry (what the file is, what it holds, key facts) makes vague questions findable. It is
      // best effort: if the model fails, the file is still indexed from its own text.
      let summary: FileSummary | undefined;
      if (ctx.attachments.summarize) {
        try {
          const budget = Math.min(ctx.maxInputTokens * 4, MAX_SUMMARY_INPUT_CHARS);
          summary = await describeFile(ctx.llm, { name: file.name, kind: ex.kind, note, sections }, budget);
          // The input was already redacted; scrub the output too in case the model reconstructs a secret.
          const scrub = (t: string) => redact(t).text;
          summary = {
            description: scrub(summary.description),
            contents: summary.contents.map(scrub),
            key_facts: summary.key_facts.map(scrub),
            tags: summary.tags.map(scrub),
          };
        } catch (err) {
          ctx.log.warn({ err, fileId: file.id }, "file summary failed; indexing without it");
        }
      }

      const link = file.permalink;
      const header = `${file.name}\n${ex.kind.toUpperCase()} file shared by ${sharedBy} in #${src.channelName}${src.threadLink ? ` (thread: ${src.threadLink})` : ""}`;
      const doc: OnyxDocument = {
        id: fileDocId(file.id),
        semantic_identifier: file.name,
        sections: [
          ...(summary ? [{ text: `${header}\n\n${renderFileSummary(summary, note)}`, ...(link && { link }) }] : []),
          ...sections.map((s, i) => ({
            text: `${i === 0 && !summary ? `${header}\n\n` : ""}${s.title}\n${s.text}`,
            ...(link && { link }),
          })),
        ],
        metadata: {
          type: "attachment",
          file_name: file.name,
          file_type: ex.kind,
          channel: `#${src.channelName}`,
          shared_by: sharedBy,
          recorded_by: src.recordedBy,
          slack_user: src.actorId,
          origin: "neotags",
          source_visibility: src.isPrivate ? "private-channel" : "public-channel",
          schema_version: FILE_SCHEMA_VERSION,
          truncated: String(ex.truncated),
          summarized: String(Boolean(summary)),
          ...(summary?.tags.length && { tags: summary.tags }),
          ...(src.threadDocId && { thread_doc: src.threadDocId }),
        },
        doc_updated_at: new Date(Number(ts) * 1000 || Date.now()).toISOString(),
      };
      await ctx.onyx!.upsert(doc);

      result.indexed.push({
        id: doc.id,
        name: file.name,
        kind: ex.kind,
        sections: sections.length,
        chars: sections.reduce((n, s) => n + s.text.length, 0),
        redactions,
        truncated: ex.truncated,
        ...(summary && { description: summary.description }),
      });
      ctx.log.info({ docId: doc.id, kind: ex.kind, sections: sections.length, redactions, truncated: ex.truncated }, "attachment indexed");
    } catch (err) {
      if (err instanceof UnsupportedFileError || err instanceof SlackFileError) {
        result.skipped.push({ name: file.name, reason: err.message });
        ctx.log.info({ fileId: file.id, reason: err.message }, "attachment skipped");
      } else throw err;
    }
  }
  return result;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Slack mrkdwn lines describing the outcome (file names are user-controlled, so escaped). */
export function describeCollected(r: CollectResult): string[] {
  const lines: string[] = [];
  for (const f of r.indexed) {
    const notes = [
      `${f.sections} section${f.sections === 1 ? "" : "s"}`,
      f.truncated ? "truncated (very large)" : "",
      f.redactions ? `${f.redactions} secret(s) redacted` : "",
    ].filter(Boolean);
    lines.push(`• ${esc(f.name)}: ${notes.join(", ")}${f.description ? `\n    _${esc(clip(f.description, 220))}_` : ""}`);
  }
  for (const s of r.skipped) lines.push(`• ${esc(s.name)}: skipped, ${esc(s.reason)}`);
  return lines;
}
