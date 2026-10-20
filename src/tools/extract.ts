import ExcelJS from "exceljs";
import JSZip from "jszip";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

export interface ExtractLimits {
  /** Total extracted characters kept; the rest is dropped and `truncated` is set. */
  maxChars: number;
}

export interface ExtractedSection {
  /** "Page 3", "Sheet: Budget", "Slide 2"; shown to readers so a hit can be located in the file. */
  title: string;
  text: string;
}

export interface Extracted {
  kind: FileKind;
  sections: ExtractedSection[];
  truncated: boolean;
}

export type FileKind = "pdf" | "docx" | "xlsx" | "pptx" | "html" | "text";

/** The file cannot be indexed; `message` is safe to show the user. */
export class UnsupportedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFileError";
  }
}

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "log", "json", "jsonl", "yaml", "yml", "xml", "toml", "ini", "conf", "cfg",
  "sql", "sh", "py", "js", "ts", "go", "java", "rs", "tf", "properties", "env", "diff", "patch",
]);

const LEGACY: Record<string, string> = {
  doc: "legacy .doc isn't supported; save it as .docx",
  xls: "legacy .xls isn't supported; save it as .xlsx",
  ppt: "legacy .ppt isn't supported; save it as .pptx",
  rtf: "RTF isn't supported; save it as .docx",
  pages: "Apple Pages isn't supported; export it as PDF or .docx",
  numbers: "Apple Numbers isn't supported; export it as .xlsx",
  key: "Apple Keynote isn't supported; export it as PDF or .pptx",
};

const ext = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

export function detectKind(name: string, mimetype?: string): FileKind {
  const e = ext(name);
  const m = (mimetype ?? "").toLowerCase();
  if (e === "pdf" || m === "application/pdf") return "pdf";
  if (e === "docx" || m.includes("wordprocessingml")) return "docx";
  if (e === "xlsx" || e === "xlsm" || m.includes("spreadsheetml")) return "xlsx";
  if (e === "pptx" || m.includes("presentationml")) return "pptx";
  if (e === "html" || e === "htm" || m === "text/html") return "html";
  if (TEXT_EXT.has(e) || m.startsWith("text/") || m === "application/json") return "text";
  if (LEGACY[e]) throw new UnsupportedFileError(LEGACY[e]);
  if (m.startsWith("image/")) throw new UnsupportedFileError("images aren't supported yet (no OCR)");
  if (m.startsWith("video/") || m.startsWith("audio/")) throw new UnsupportedFileError("audio/video isn't supported");
  throw new UnsupportedFileError(`${e ? `.${e}` : "this"} file type isn't supported`);
}

const SECTION_CHARS = 6000;
// OOXML files are zip archives; refuse ones that would inflate absurdly before a parser touches them.
const MAX_UNZIPPED_BYTES = 250 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;

/** Sum the declared sizes in the zip central directory (no decompression). Parsers also verify them. */
export function assertSafeZip(buf: Buffer): void {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new UnsupportedFileError("the file is not a valid Office document");
  const entries = buf.readUInt16LE(eocd + 10);
  if (entries > MAX_ZIP_ENTRIES) throw new UnsupportedFileError("the file has too many parts");
  let p = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new UnsupportedFileError("the file is not a valid Office document");
    }
    total += buf.readUInt32LE(p + 24);
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  if (total > MAX_UNZIPPED_BYTES) throw new UnsupportedFileError("the file is too large once unpacked");
}

/** Split on paragraph/line boundaries into sections of roughly `SECTION_CHARS`. */
export function splitText(text: string, titlePrefix: string): ExtractedSection[] {
  const out: ExtractedSection[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push({ title: "", text: cur.trim() });
    cur = "";
  };
  for (const line of text.split(/\n/)) {
    // A single enormous line (minified JSON, a pasted blob) is cut so no section grows without bound.
    for (let i = 0; i < Math.max(line.length, 1); i += SECTION_CHARS) {
      const piece = line.slice(i, i + SECTION_CHARS);
      if (cur.length + piece.length + 1 > SECTION_CHARS) flush();
      cur += `${piece}\n`;
    }
  }
  flush();
  return out.map((s, i) => ({ ...s, title: out.length === 1 ? titlePrefix : `${titlePrefix} (part ${i + 1}/${out.length})` }));
}

function decodeText(buf: Buffer): string {
  // NUL bytes in the first KB mean binary data mislabelled as text.
  if (buf.subarray(0, 1024).includes(0)) throw new UnsupportedFileError("the file looks binary, not text");
  return buf.toString("utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|h[1-6]|li|tr|table|section|article)>|<br\s*\/?>/gi, "\n")
      .replace(/<\/t[dh]>/gi, "\t")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

// ---- data embedded in <script> ---------------------------------------------------------------------------
// Many generated pages (catalogues, reports) keep their content in a JS data literal and render it in the
// browser. The text is not in the markup, so we read the literal. It is parsed, never evaluated: scripts
// from a chat attachment are untrusted.

const MAX_LITERAL_DEPTH = 40;

class LiteralError extends Error {}

/** Strict-ish JSON5 subset: objects, arrays, strings, numbers, true/false/null, comments, trailing commas. */
function parseLiteral(src: string, start: number): { value: unknown; end: number } {
  let i = start;
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i]!)) i++;
      if (src.startsWith("//", i)) while (i < src.length && src[i] !== "\n") i++;
      else if (src.startsWith("/*", i)) {
        const e = src.indexOf("*/", i + 2);
        if (e < 0) throw new LiteralError("unterminated comment");
        i = e + 2;
      } else return;
    }
  };
  const str = (): string => {
    const q = src[i++]!;
    let out = "";
    while (i < src.length && src[i] !== q) {
      const c = src[i++]!;
      if (c === "\n" && q !== "`") throw new LiteralError("newline in string");
      if (q === "`" && c === "$" && src[i] === "{") throw new LiteralError("template expression");
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = src[i++]!;
      if (e === "u" || e === "x") {
        const n = e === "u" ? 4 : 2;
        const hex = src.slice(i, i + n);
        if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(hex)) throw new LiteralError("bad escape");
        out += String.fromCharCode(parseInt(hex, 16));
        i += n;
      } else out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" } as Record<string, string>)[e] ?? (e === "\n" ? "" : e);
    }
    if (i >= src.length) throw new LiteralError("unterminated string");
    i++;
    return out;
  };
  const value = (depth: number): unknown => {
    if (depth > MAX_LITERAL_DEPTH) throw new LiteralError("too deep");
    ws();
    const c = src[i];
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        ws();
        if (src[i] === "]") {
          i++;
          return arr;
        }
        arr.push(value(depth + 1));
        ws();
        if (src[i] === ",") i++;
        else if (src[i] !== "]") throw new LiteralError("expected , or ]");
      }
    }
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        ws();
        if (src[i] === "}") {
          i++;
          return obj;
        }
        let key: string;
        if (src[i] === "'" || src[i] === '"') key = str();
        else {
          const m = /^[A-Za-z_$][\w$]*|^\d+/.exec(src.slice(i, i + 80));
          if (!m) throw new LiteralError("bad key");
          key = m[0];
          i += key.length;
        }
        ws();
        if (src[i++] !== ":") throw new LiteralError("expected :");
        obj[key] = value(depth + 1);
        ws();
        if (src[i] === ",") i++;
        else if (src[i] !== "}") throw new LiteralError("expected , or }");
      }
    }
    if (c === "'" || c === '"' || c === "`") return str();
    const m = /^(?:-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|true|false|null|undefined)(?![\w$])/.exec(src.slice(i, i + 40));
    if (!m) throw new LiteralError(`unexpected token at ${i}`);
    i += m[0].length;
    return m[0] === "true" ? true : m[0] === "false" ? false : m[0] === "null" || m[0] === "undefined" ? null : Number(m[0]);
  };
  const v = value(0);
  return { value: v, end: i };
}

const isScalar = (v: unknown): v is string | number | boolean => ["string", "number", "boolean"].includes(typeof v);
const cleanScalar = (v: string | number | boolean) => (typeof v === "string" ? htmlToText(v).replace(/\s+/g, " ").trim() : String(v));
const LABEL_KEYS = ["title", "name", "g", "group", "id", "n", "label"];

/** "Fields: n=item k=metric/source ..." style comments name terse keys; use them as readable labels. */
function keyAliases(script: string): Record<string, string> {
  const m = /Fields?:\s*([^\n*]*)/.exec(script.slice(0, 2000));
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const part of m[1]!.trim().split(/\s+(?=[\w$]+=)/)) {
    const kv = /^([\w$]+)=(.+)$/.exec(part);
    if (kv) out[kv[1]!] = kv[2]!.trim();
  }
  return out;
}

/**
 * Render nested data as flat, self-describing lines. A leaf record carries the headings of the groups it
 * sits in, so any chunk of the output still says what it belongs to.
 */
function renderData(v: unknown, alias: Record<string, string>, headers: string[][], trail: string[], out: string[]): void {
  if (Array.isArray(v)) {
    // Rows as positional arrays: label the columns from a table header of the same width, if the page has one.
    const w = Array.isArray(v[0]) ? v[0].length : 0;
    if (w >= 2 && v.every((r) => Array.isArray(r) && r.length === w && r.every(isScalar))) {
      const cols = headers.find((h) => h.length === w);
      const prefix = trail.length ? `[${trail.join(" > ")}] ` : "";
      for (const r of v as (string | number | boolean)[][]) {
        out.push(prefix + r.map((c, i) => `${cols?.[i] ?? `Column ${i + 1}`}: ${cleanScalar(c)}`).filter((x) => !x.endsWith(": ")).join(" | "));
      }
      return;
    }
    for (const x of v) renderData(x, alias, headers, trail, out);
    return;
  }
  if (isScalar(v)) {
    const t = cleanScalar(v);
    if (t) out.push(trail.length ? `${trail.join(" > ")}: ${t}` : t);
    return;
  }
  if (!v || typeof v !== "object") return;
  const entries = Object.entries(v as Record<string, unknown>);
  const scalars = entries.filter(([, x]) => isScalar(x) && cleanScalar(x as string) !== "");
  const nested = entries.filter(([, x]) => x && typeof x === "object");
  const line = scalars.map(([k, x]) => `${alias[k] ?? k}: ${cleanScalar(x as string)}`).join(" | ");
  const labelKey = LABEL_KEYS.find((k) => typeof (v as Record<string, unknown>)[k] === "string" && (v as Record<string, string>)[k]);
  const label = labelKey ? cleanScalar((v as Record<string, string>)[labelKey]!) : undefined;
  const prefix = trail.length ? `[${trail.join(" > ")}] ` : "";
  if (line) out.push(prefix + line);
  const next = nested.length && label ? [...trail, label.slice(0, 80)] : trail;
  for (const [, x] of nested) renderData(x, alias, headers, next, out);
}

/** Data literals assigned in inline scripts (`const ITEMS = [...]`) and JSON data blocks, as text. */
export function scriptDataSections(html: string): ExtractedSection[] {
  const out: ExtractedSection[] = [];
  // Column names for positional rows: the <th> cells of every table header in the static markup.
  const markup = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const headers = [...markup.matchAll(/<thead[\s\S]*?<\/thead>/gi)].map((t) =>
    [...t[0].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((c) => htmlToText(c[1]!).replace(/\s+/g, " ").trim()),
  );
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    if (/\bsrc\s*=/i.test(attrs) || body.length < 200) continue;
    const alias = keyAliases(body);
    const found: { name: string; value: unknown }[] = [];
    if (/type\s*=\s*["']?application\/(?:ld\+)?json/i.test(attrs)) {
      try {
        found.push({ name: "data", value: JSON.parse(body) });
      } catch {
        // not JSON; ignore
      }
    } else {
      for (const a of body.matchAll(/(?:^|[\n;])\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?=[[{])/g)) {
        try {
          const { value } = parseLiteral(body, a.index! + a[0].length);
          found.push({ name: a[1]!, value });
        } catch {
          // code, not data (function calls, expressions, ...): skip
        }
      }
    }
    for (const { name, value } of found) {
      const lines: string[] = [];
      renderData(value, alias, headers, [], lines);
      const text = lines.join("\n");
      if (text.length >= 200) out.push(...splitText(text, `Data: ${name}`));
    }
  }
  return out;
}

const TOC_LINE = /\.{5,}\s*\d+\s*$/; // "Compute Tray ........ 8": a hit on these would outrank the real section
const normLine = (l: string) => l.trim().replace(/\d+/g, "#").replace(/\s+/g, " ");

/**
 * Per-page text with the furniture removed: running headers/footers (lines repeated on many pages, page
 * numbers aside) and table-of-contents lines. They add nothing to an answer and bury the real text.
 */
export function cleanPages(pages: string[]): string[] {
  const lines = pages.map((p) => p.split("\n").map((l) => l.trim()).filter(Boolean));
  const seen = new Map<string, number>();
  for (const ls of lines) for (const k of new Set(ls.map(normLine))) seen.set(k, (seen.get(k) ?? 0) + 1);
  // Only meaningful with enough pages to tell furniture from a phrase that happens to recur.
  const repeated = (l: string) => pages.length >= 4 && l.length < 200 && (seen.get(normLine(l)) ?? 0) >= Math.max(3, pages.length * 0.4);
  return lines.map((ls) => ls.filter((l) => !repeated(l) && !TOC_LINE.test(l)).join("\n"));
}

async function pdfSections(buf: Buffer): Promise<ExtractedSection[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 }); // 0 = errors only; pdf.js warns about harmless font quirks
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = cleanPages(Array.isArray(text) ? text : [text]);
  const out: ExtractedSection[] = [];
  // Group pages up to a section's size so a 200-page PDF is not 200 tiny sections.
  let from = 0;
  let cur = "";
  const flush = (to: number) => {
    if (cur.trim()) out.push({ title: from + 1 === to ? `Page ${to}` : `Pages ${from + 1}-${to}`, text: cur.trim() });
    cur = "";
    from = to;
  };
  pages.forEach((p, i) => {
    const t = p.trim();
    if (!t) return;
    if (cur && cur.length + t.length > SECTION_CHARS) flush(i);
    cur += `[Page ${i + 1}]\n${t}\n\n`; // keeps a citation point inside grouped sections
    // one dense page may exceed the size on its own; split it, keeping the page label
    if (cur.length > SECTION_CHARS * 2) {
      for (const s of splitText(cur, `Page ${i + 1}`)) out.push(s);
      cur = "";
      from = i + 1;
    }
  });
  flush(pages.length);
  return out;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("result" in v) return cellText(v.result as ExcelJS.CellValue); // formula: the computed value
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return String(v.text); // hyperlink
    if ("error" in v) return String(v.error);
  }
  return String(v);
}

const isNumeric = (s: string) => /^-?[\d.,%]+$/.test(s);

/**
 * Table rows as self-describing records ("Role: Compute6 | Inband: 100.82.3.4 | ..."), so a hit on one row
 * (or one chunk of a long table) still says which value is which column. Empty cells are dropped. The
 * header is the first row with several text cells; rows with a single cell (notes) stay as they are.
 */
export class RowRenderer {
  private header?: string[];

  /** The text line for this row, or undefined when it is empty. */
  line(cells: string[]): string | undefined {
    const filled = Array.from(cells, (c) => c ?? "");
    const nonEmpty = filled.filter(Boolean);
    if (!nonEmpty.length) return undefined;
    if (!this.header && nonEmpty.length >= 2 && nonEmpty.every((c) => !isNumeric(c))) {
      this.header = filled;
      return `Columns: ${nonEmpty.join(" | ")}`;
    }
    if (this.header && nonEmpty.length >= 2) {
      const h = this.header;
      return filled
        .map((c, i) => (c ? `${h[i] || `Column ${i + 1}`}: ${c}` : ""))
        .filter(Boolean)
        .join(" | ");
    }
    return nonEmpty.join(" | ");
  }
}

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, commas/newlines inside quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const clean = (f: string) => f.replace(/\s+/g, " ").trim(); // a newline inside a cell must not split the record
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) (row.push(clean(field)), (field = ""));
    else if (ch === "\n") (row.push(clean(field)), rows.push(row), (row = []), (field = ""));
    else field += ch;
  }
  row.push(clean(field));
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

async function xlsxSections(buf: Buffer, maxChars: number): Promise<ExtractedSection[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const out: ExtractedSection[] = [];
  let budget = maxChars;
  for (const ws of wb.worksheets) {
    if (ws.state !== "visible" || budget <= 0) continue; // hidden sheets are hidden for a reason
    const lines: string[] = [];
    const rr = new RowRenderer();
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (budget <= 0) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (c, col) => {
        cells[col - 1] = cellText(c.value).replace(/\s+/g, " ").trim();
      });
      const line = rr.line(cells);
      if (line === undefined) return;
      lines.push(line);
      budget -= line.length + 1;
    });
    if (lines.length) out.push(...splitText(lines.join("\n"), `Sheet: ${ws.name}`));
  }
  return out;
}

const xmlText = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<a:${tag}(?:\\s[^>]*)?>([^<]*)</a:${tag}>`, "g"))].map((m) => decodeEntities(m[1]!));

async function pptxSections(buf: Buffer): Promise<ExtractedSection[]> {
  const zip = await JSZip.loadAsync(buf);
  const num = (p: string) => Number(/(\d+)\.xml$/.exec(p)?.[1] ?? 0);
  const slides = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => num(a) - num(b));
  const out: ExtractedSection[] = [];
  for (const p of slides) {
    const n = num(p);
    const body = xmlText(await zip.file(p)!.async("string"), "t").join(" ").replace(/\s+/g, " ").trim();
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    const notes = notesFile ? xmlText(await notesFile.async("string"), "t").join(" ").trim() : "";
    const text = [body, notes && `Speaker notes: ${notes}`].filter(Boolean).join("\n");
    if (text) out.push(...splitText(text, `Slide ${n}`));
  }
  return out;
}

/** Text of a supported file, in sections that carry a human-readable location. Throws UnsupportedFileError. */
export async function extract(buf: Buffer, name: string, mimetype: string | undefined, limits: ExtractLimits): Promise<Extracted> {
  const kind = detectKind(name, mimetype);
  let sections: ExtractedSection[];
  try {
    switch (kind) {
      case "pdf":
        sections = await pdfSections(buf);
        break;
      case "docx":
        assertSafeZip(buf);
        sections = splitText((await mammoth.extractRawText({ buffer: buf })).value.replace(/\r\n?/g, "\n"), "Document");
        break;
      case "xlsx":
        assertSafeZip(buf);
        sections = await xlsxSections(buf, limits.maxChars);
        break;
      case "pptx":
        assertSafeZip(buf);
        sections = await pptxSections(buf);
        break;
      case "html": {
        const html = decodeText(buf);
        sections = [...splitText(htmlToText(html), "Page"), ...scriptDataSections(html)];
        break;
      }
      case "text": {
        const e = ext(name);
        const text = decodeText(buf);
        if (e === "csv" || e === "tsv") {
          const rr = new RowRenderer();
          const lines = parseDelimited(text, e === "tsv" ? "\t" : ",").map((r) => rr.line(r)).filter((l): l is string => l !== undefined);
          sections = splitText(lines.join("\n"), "Table");
        } else sections = splitText(text, "Text");
        break;
      }
    }
  } catch (err) {
    if (err instanceof UnsupportedFileError) throw err;
    const msg = (err as Error).message ?? "";
    if (/password/i.test(msg)) throw new UnsupportedFileError("the file is password-protected");
    throw new UnsupportedFileError(`couldn't read the ${kind.toUpperCase()} (corrupt or unusual format)`);
  }

  let remaining = limits.maxChars;
  let truncated = false;
  const kept: ExtractedSection[] = [];
  for (const s of sections) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (s.text.length > remaining) {
      kept.push({ ...s, text: s.text.slice(0, remaining) });
      truncated = true;
      break;
    }
    kept.push(s);
    remaining -= s.text.length;
  }
  return { kind, sections: kept, truncated };
}
