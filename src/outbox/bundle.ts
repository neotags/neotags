import { isObj } from "../guardrails/tools.js";
import { DeliveryError, type DeliveryContext } from "../routines/outbox.js";
import { parseJson } from "../routines/records.js";

// The delivery bundle of a period, read from the store (contracts: bundle.md). A pipeline's render step wrote it to
// bundle/ (manifest.json lists the files, relative to bundle/); an agent routine's output.json becomes the same shape:
// one section, `all`, with the summary as the Slack text and the report as an attachment, in whatever language the
// target asks for (the run answers in one).

export interface BundlePart {
  /** Slack mrkdwn. */
  slack: string;
  /** File name -> text. */
  attachments: Record<string, string>;
}

export interface BundlePage {
  title: string;
  /** Confluence storage format. */
  body: string;
  attachments: Record<string, string>;
}

export interface Bundle {
  /** The section in that language, undefined when the bundle has no such combination. */
  part(section: string, lang: string): Promise<BundlePart | undefined>;
  /** The Confluence page, undefined when the bundle has none. */
  page(): Promise<BundlePage | undefined>;
}

/** Report attachment of an agent routine. */
export const AGENT_REPORT_FILE = "report.md";

const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** Escaped for storage format; control characters XML cannot hold (a model's ANSI escapes, say) are dropped. */
const escapeXml = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export async function loadBundle(ctx: Pick<DeliveryContext, "kind" | "dir" | "store" | "routine" | "period">): Promise<Bundle> {
  const read = async (file: string) => (await ctx.store.get(ctx.dir + file))?.body;
  if (ctx.kind === "agent") {
    const out = parseJson<{ summary?: unknown; report?: unknown }>(await read("output.json"));
    if (!out || typeof out.summary !== "string" || typeof out.report !== "string") throw new DeliveryError("bundle", "output.json has no summary and report");
    const { summary, report } = out as { summary: string; report: string };
    return {
      part: async (section) => (section === "all" ? { slack: summary, attachments: { [AGENT_REPORT_FILE]: report } } : undefined),
      page: async () => ({
        title: `${ctx.routine} ${ctx.period}`,
        body: `<p>${escapeXml(summary)}</p><pre>${escapeXml(report)}</pre>`,
        attachments: { [AGENT_REPORT_FILE]: report },
      }),
    };
  }
  const manifest = parseJson<unknown>(await read("bundle/manifest.json"));
  if (!isObj(manifest) || !isObj(manifest.sections)) throw new DeliveryError("bundle", "bundle/manifest.json is missing or unreadable");
  const sections = manifest.sections;
  // Paths come from the engine, which wrote them; still never outside bundle/.
  const file = async (where: string, p: unknown): Promise<string> => {
    if (typeof p !== "string" || !SAFE_PATH.test(p)) throw new DeliveryError("bundle", `${where}: not a file of the bundle`);
    const body = await read(`bundle/${p}`);
    if (body === undefined) throw new DeliveryError("bundle", `${where}: bundle/${p} is missing`);
    return body;
  };
  const files = async (where: string, v: unknown): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    if (isObj(v)) for (const [name, p] of Object.entries(v)) out[name] = await file(`${where}.attachments.${name}`, p);
    return out;
  };
  return {
    async part(section, lang) {
      const langs = Object.hasOwn(sections, section) ? sections[section] : undefined;
      const part = isObj(langs) && Object.hasOwn(langs, lang) ? langs[lang] : undefined;
      if (!isObj(part)) return undefined;
      const where = `sections.${section}.${lang}`;
      return { slack: await file(`${where}.slack`, part.slack), attachments: await files(where, part.attachments) };
    },
    async page() {
      const c = manifest.confluence;
      if (!isObj(c)) return undefined;
      if (typeof c.title !== "string") throw new DeliveryError("bundle", "confluence.title is not text");
      return { title: c.title, body: await file("confluence.body", c.body), attachments: await files("confluence", c.attachments) };
    },
  };
}
