import { redact } from "../../tools/redact.js";
import type { SlackMessage } from "../../tools/slack.js";

/** A thread message after filtering and redaction, numbered so summaries can cite it as `#n`. */
export interface Msg {
  n: number;
  ts: string;
  who: string;
  bot: boolean;
  text: string;
  files: string[];
  /** Carries concrete information (code, error, link, long explanation, conclusion words). */
  salient: boolean;
  /** Code, error, link or conclusion: worth quoting verbatim in the excerpts section. */
  technical: boolean;
  /** Consecutive near-identical bot messages collapsed into this one. */
  repeats: number;
}

export interface Prepared {
  msgs: Msg[];
  /** Low-signal messages removed (acks, duplicate bot noise, empties). */
  filtered: number;
  /** Messages dropped (least informative first) to fit the budget; 0 unless the thread is huge. */
  budgetDropped: number;
  redactions: number;
}

const MAX_MESSAGE_CHARS = 4000;

// Pure acknowledgements. Deliberately excludes "done"/"fixed"/"works now": those confirm a resolution.
const ACK = /^(?:\+1|ok(?:ay)?|k|thanks?|thank you|thx|ty|tysm|got it|np|no problem|roger|ack|noted|cool|nice|great|sure|yep|yes|lol|haha|👍|🙏|👀|🙌|:[a-z0-9_+-]+:|[\s!.,~-])+$/i;

const CODE = /```|`[^`\n]+`/;
const ERROR = /\b(error|exception|fail(?:ed|ure|ing|s)?|timeout|timed out|panic|oom(?:killed)?|crash(?:ed|ing)?|refused|denied|unavailable|traceback|stack ?trace|segfault|exit code|too many|exhausted|[45]\d\d)\b/i;
const URL = /https?:\/\//;
const CONCLUSION = /\b(root cause|caused by|because|fixed|resolved|workaround|rolled? ?back|reverted|restart(?:ed)?|redeploy(?:ed)?|mitigat\w+|works now|back to normal|the fix|solution)\b/i;
const LONG = 120;

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function isTechnical(text: string): boolean {
  return CODE.test(text) || ERROR.test(text) || URL.test(text) || CONCLUSION.test(text);
}

/** Filter noise, redact, truncate absurdly long messages, and number what is left. */
export function prepare(input: SlackMessage[]): Prepared {
  const msgs: Msg[] = [];
  let filtered = 0;
  let redactions = 0;
  const lastBotKey = new Map<string, Msg>(); // bot noise key -> the message it collapses into

  for (const m of input) {
    const raw = m.text.trim();
    if (!raw && m.files.length === 0) {
      filtered++;
      continue;
    }
    const technical = isTechnical(raw);
    const isFirst = msgs.length === 0;
    if (!isFirst && !technical && m.files.length === 0 && raw.length <= 30 && ACK.test(raw)) {
      filtered++;
      continue;
    }

    if (m.bot) {
      const key = `${m.userName}|${normalize(raw).replace(/\d+/g, "#")}`;
      const prev = lastBotKey.get(key);
      if (prev) {
        prev.repeats++;
        filtered++;
        continue;
      }
      const r = redact(raw.slice(0, MAX_MESSAGE_CHARS));
      redactions += r.count;
      const msg = toMsg(msgs.length + 1, m, r.text, technical);
      lastBotKey.set(key, msg);
      msgs.push(msg);
      continue;
    }

    const clipped = raw.length > MAX_MESSAGE_CHARS ? `${raw.slice(0, MAX_MESSAGE_CHARS)} […]` : raw;
    const r = redact(clipped);
    redactions += r.count;
    msgs.push(toMsg(msgs.length + 1, m, r.text, technical));
  }
  return { msgs, filtered, budgetDropped: 0, redactions };
}

function toMsg(n: number, m: SlackMessage, text: string, technical: boolean): Msg {
  return {
    n,
    ts: m.ts,
    who: m.userName,
    bot: m.bot,
    text,
    files: m.files,
    technical,
    salient: technical || text.length >= LONG || m.files.length > 0,
    repeats: 1,
  };
}

export function line(m: Msg): string {
  const when = new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace("T", " ");
  const files = m.files.length ? ` [attachments: ${m.files.join(", ")}]` : "";
  const rep = m.repeats > 1 ? ` (repeated ×${m.repeats})` : "";
  return `#${m.n} [${when}] ${m.who}${m.bot ? " (bot)" : ""}: ${m.text}${files}${rep}`;
}

export const transcriptOf = (msgs: Msg[]) => msgs.map(line).join("\n");

/**
 * Hard cap for huge threads, so the number of LLM calls stays bounded. Always keeps the opening and the last
 * few messages (where the problem and the outcome usually are). In between, drops the least informative
 * first (chatter, then long-but-plain messages, technical content last), from the middle outward.
 */
export function fitToBudget(p: Prepared, maxChars: number): Prepared {
  let total = p.msgs.reduce((s, m) => s + line(m).length + 1, 0);
  if (total <= maxChars) return p;
  const KEEP_HEAD = 3;
  const KEEP_TAIL = 5;
  const mid = p.msgs.length / 2;
  const tier = (m: Msg) => (m.technical ? 2 : m.salient ? 1 : 0);
  const candidates = p.msgs
    .map((m, i) => ({ m, i }))
    .filter(({ i }) => i >= KEEP_HEAD && i < p.msgs.length - KEEP_TAIL)
    .sort((a, b) => tier(a.m) - tier(b.m) || Math.abs(a.i - mid) - Math.abs(b.i - mid));
  const drop = new Set<number>();
  for (const { m, i } of candidates) {
    if (total <= maxChars) break;
    total -= line(m).length + 1;
    drop.add(i);
  }
  return { ...p, msgs: p.msgs.filter((_, i) => !drop.has(i)), budgetDropped: drop.size };
}

/** Split into consecutive chunks whose transcripts stay under `maxChars` (map step of map-reduce). */
export function chunk(msgs: Msg[], maxChars: number): Msg[][] {
  const out: Msg[][] = [];
  let cur: Msg[] = [];
  let size = 0;
  for (const m of msgs) {
    const l = line(m).length + 1;
    if (cur.length && size + l > maxChars) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(m);
    size += l;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Verbatim technical lines (errors, commands, links, conclusions), stored as a second searchable section. */
export function excerpts(msgs: Msg[], maxChars = 4000): string {
  const out: string[] = [];
  let used = 0;
  for (const m of msgs) {
    if (!m.technical) continue;
    const text = m.text.length > 600 ? `${m.text.slice(0, 600)} […]` : m.text;
    const l = `#${m.n} ${m.who}: ${text}`;
    if (used + l.length > maxChars) break;
    out.push(l);
    used += l.length + 1;
  }
  return out.join("\n");
}
