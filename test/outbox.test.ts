import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts/index.js";
import { loadConfig } from "../src/config/index.js";
import { periodMonth } from "../src/outbox/confluence.js";
import { ConfluenceApi, createOutbox, type SlackApi } from "../src/outbox/index.js";
import { createRoutines } from "../src/routines/period.js";
import type { DeliveredRecord, RunRecord } from "../src/routines/records.js";
import type { RoutineType } from "../src/routines/types.js";
import type { ExecResult } from "../src/sandbox/types.js";
import { Slots } from "../src/sandbox/slots.js";
import { startTelemetry } from "../src/telemetry/index.js";

const exporter = new InMemorySpanExporter();
const telemetry = startTelemetry({ exporter })!;
const flushed = async (): Promise<ReadableSpan[]> => {
  await telemetry.flush();
  return exporter.getFinishedSpans();
};

const P = "2026-11-20T09:00:00Z";
const T0 = Date.parse("2026-11-20T09:30:00Z");
const DIR = `jobs/daily/${P}/`;
const PAGES_DIR = `jobs/pages/${P}/`;
const AGENT_DIR = `jobs/weekly/${P}/`;
const TEAM_ZH = "slack:C0TEAM:all:zh";
const TEST_EN = "slack:C0TEST:all:en";
const PAGE = "confluence:OPS:456";

const cfgFor = () =>
  loadConfig({ SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y", MOOSE_JOB_KEY: "test-job-key", NEOTAGS_CONFIG: "f" }, () => `jobsApi: { enabled: true, callers: { job: { keyFromEnv: MOOSE_JOB_KEY } }, concurrency: 1 }
outbox:
  slack: { allowedChannels: [C0TEST, C0TEAM, C0OWNER], testChannel: C0TEST }
  confluence: { baseUrl: "https://wiki.example.com/wiki", allowedSpaces: [OPS], testParent: "999" }
artifacts: { s3: { bucket: test-bucket } }
routines:
  daily:
    kind: pipeline
    type: demo
    trigger: { schedule: "0 9 * * *", timeZone: UTC }
    owner: { slack: C0OWNER }
    delivery: { slack: [{ channel: C0TEAM, lang: zh, mention: "<!subteam^S0123>" }, { channel: C0TEST, lang: en }] }
  pages:
    kind: pipeline
    type: demo
    trigger: { schedule: "0 9 * * *", timeZone: UTC }
    owner: { slack: C0OWNER }
    delivery: { confluence: { space: OPS, parent: "456", monthlyFolder: true } }
  weekly:
    kind: agent
    trigger: { schedule: "0 9 * * *", timeZone: UTC }
    owner: { slack: C0OWNER }
    instructions: Review the alerts.
    delivery: { notify: when_findings, slack: [{ channel: C0TEAM, lang: en }] }
`);

const demoType = {
  pack: { name: "steps", description: "Demo steps", body: "Steps.", refs: new Map(), sandbox: { net: [], tools: ["python3"], credentials: [], limits: { timeoutSec: 60 } } },
  spec: { type: "demo", steps: [{ name: "pull", argv: ["python3", "step.py", "pull"] }, { name: "render", argv: ["python3", "step.py", "render"] }] },
} as unknown as RoutineType;

const put = (store: MemoryArtifactStore, key: string, v: unknown) => store.objects.set(key, { body: typeof v === "string" ? v : JSON.stringify(v), etag: `"pre-${key}"` });

/** A rendered bundle and the run.json of the attempt that rendered it (and then failed): only delivery is left. */
function rendered(store: MemoryArtifactStore, dir = DIR, o: { notify?: boolean; sections?: unknown } = {}) {
  put(store, `${dir}bundle/sections/all/zh/slack.md`, "*报告* 3 个问题");
  put(store, `${dir}bundle/sections/all/zh/attachments/report.html`, "<p>zh</p>");
  put(store, `${dir}bundle/sections/all/en/slack.md`, "*report* 3 problems");
  put(store, `${dir}bundle/confluence/page.xml`, "<p>page</p>");
  put(store, `${dir}bundle/confluence/attachments/report.html`, "<p>full</p>");
  put(store, `${dir}bundle/confluence/attachments/summary.html`, "<p>short</p>");
  put(store, `${dir}bundle/manifest.json`, {
    notify: o.notify ?? true,
    sections: o.sections ?? {
      all: {
        zh: { slack: "sections/all/zh/slack.md", attachments: { "report.html": "sections/all/zh/attachments/report.html" } },
        en: { slack: "sections/all/en/slack.md", attachments: {} },
      },
    },
    confluence: {
      title: "Digest 2026-11-20",
      body: "confluence/page.xml",
      attachments: { "report.html": "confluence/attachments/report.html", "summary.html": "confluence/attachments/summary.html" },
    },
  });
  failedRun(store, dir);
}

function failedRun(store: MemoryArtifactStore, dir: string, kind: "agent" | "pipeline" = "pipeline") {
  const run: RunRecord = {
    kind,
    state: "failed",
    token: "old",
    holder: "pod-old",
    deadlineAt: new Date(T0 + 1800_000).toISOString(),
    startedAt: new Date(T0 - 600_000).toISOString(),
    updatedAt: new Date(T0 - 60_000).toISOString(),
    steps: [],
    runIds: ["run-7"],
    holders: [],
    degraded: false,
    reason: "delivery failed",
  };
  put(store, `${dir}run.json`, run);
}

type Post = Parameters<SlackApi["chat"]["postMessage"]>[0];
type Upload = Parameters<SlackApi["files"]["uploadV2"]>[0];

/** Slack's Web API: records posts and uploads; `failUploads` uploads fail first; `onPost` runs inside each post. */
function fakeSlack(o: { failUploads?: number; onPost?: (a: Post) => void } = {}) {
  const posts: Post[] = [];
  const uploads: Upload[] = [];
  let failUploads = o.failUploads ?? 0;
  let n = 0;
  const api: SlackApi = {
    chat: {
      postMessage: async (a) => {
        posts.push(a);
        o.onPost?.(a);
        return { ok: true, ts: `1763629200.00010${++n}`, channel: a.channel };
      },
      getPermalink: async (a) => ({ permalink: `https://slack.example.com/archives/${a.channel}/p${a.message_ts.replace(".", "")}` }),
    },
    files: {
      uploadV2: async (a) => {
        if (failUploads > 0) {
          failUploads--;
          throw Object.assign(new Error("An API error occurred: ratelimited"), { data: { error: "ratelimited" } });
        }
        uploads.push(a);
        return { ok: true, files: [{ ok: true, files: [{ id: `F${uploads.length}` }] }] };
      },
    },
  };
  const notices = () => posts.filter((p) => p.channel === "C0OWNER" || /^:(x|warning):/.test(p.text));
  const messages = () => posts.filter((p) => !notices().includes(p));
  return { api, posts, uploads, notices, messages };
}

interface Content {
  id: string;
  type: string;
  title: string;
  parentId?: string;
  spaceId?: string;
}

/** Confluence's REST API behind fetch: space OPS is id 7, folder 456 the parent, 999 the test parent. */
function fakeConfluence(o: { parentSpace?: string; children?: Content[]; pages?: Content[]; failAttachments?: number; losePageAnswers?: number } = {}) {
  let losePageAnswers = o.losePageAnswers ?? 0;
  const calls: string[] = [];
  const children = [...(o.children ?? [])];
  const pages = [...(o.pages ?? [])];
  const attachments: { page: string; name: string; content: string }[] = [];
  let failAttachments = o.failAttachments ?? 0;
  let ids = 1000;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const f = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(String(input));
    const path = u.pathname.replace(/^\/wiki/, "");
    const m = init.method ?? "GET";
    calls.push(`${m} ${path}`);
    if (m === "GET" && path === "/api/v2/spaces") return json(200, { results: u.searchParams.get("keys")!.split(",").includes("OPS") ? [{ id: "7", key: "OPS" }] : [] });
    if (m === "GET" && path === "/api/v2/folders/456") return json(200, { id: "456", type: "folder", title: "Reports", spaceId: o.parentSpace ?? "7" });
    if (m === "GET" && path === "/api/v2/folders/999") return json(200, { id: "999", type: "folder", title: "Test", spaceId: "7" });
    if (m === "GET" && /^\/api\/v2\/folders\/\d+\/direct-children$/.test(path)) return json(200, { results: children.filter((c) => c.parentId === path.split("/")[4]), _links: {} });
    if (m === "POST" && path === "/api/v2/folders") {
      const b = JSON.parse(String(init.body)) as { title: string; parentId: string; spaceId: string };
      const c = { id: String(++ids), type: "folder", title: b.title, parentId: b.parentId, spaceId: b.spaceId };
      children.push(c);
      return json(200, c);
    }
    if (m === "GET" && path === "/api/v2/pages") return json(200, { results: pages.filter((p) => p.title === u.searchParams.get("title") && p.spaceId === u.searchParams.get("space-id")) });
    if (m === "POST" && path === "/api/v2/pages") {
      const b = JSON.parse(String(init.body)) as { title: string; parentId: string; spaceId: string; body: { value: string } };
      const p = { id: String(++ids), type: "page", title: b.title, parentId: b.parentId, spaceId: b.spaceId, body: b.body.value };
      pages.push(p);
      // Created, but the answer never makes it back.
      if (losePageAnswers > 0) {
        losePageAnswers--;
        return json(504, { message: "gateway timeout" });
      }
      return json(200, { ...p, _links: { webui: `/spaces/OPS/pages/${p.id}` } });
    }
    if (m === "POST" && /^\/api\/v2\/pages\/\d+\/properties$/.test(path)) return json(200, {});
    if (m === "GET" && /^\/rest\/api\/content\/\d+\/child\/attachment$/.test(path)) return json(200, { results: [] });
    if (m === "POST" && /^\/rest\/api\/content\/\d+\/child\/attachment$/.test(path)) {
      if ((init.headers as Record<string, string>)["x-atlassian-token"] !== "no-check") return json(403, { message: "XSRF check failed" });
      if (failAttachments > 0) {
        failAttachments--;
        return json(500, { message: "attachment store unavailable" });
      }
      const file = (init.body as FormData).get("file") as File;
      attachments.push({ page: path.split("/")[4]!, name: file.name, content: await file.text() });
      return json(200, { results: [{ id: `att${attachments.length}` }] });
    }
    return json(404, { message: "not found" });
  };
  return { fetch: f as typeof fetch, calls, children, pages, attachments };
}

const execResult = (over: Partial<ExecResult>): ExecResult => ({ id: "x", exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdout: "", stderr: "", truncated: { stdout: false, stderr: false }, egress: [], ...over });

function harness(o: { store?: MemoryArtifactStore; slack?: ReturnType<typeof fakeSlack>; confluence?: ReturnType<typeof fakeConfluence>; cfg?: ReturnType<typeof cfgFor>; holder?: string; clock?: { t: number }; exec?: () => Promise<ExecResult> } = {}) {
  const cfg = o.cfg ?? cfgFor();
  const store = o.store ?? new MemoryArtifactStore();
  const clock = o.clock ?? { t: T0 };
  const slack = o.slack ?? fakeSlack();
  const confluence = o.confluence ?? fakeConfluence();
  const logs: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const log = Object.fromEntries(
    ["info", "warn", "error"].map((level) => [level, (obj: unknown, msg?: string) => void logs.push({ level, obj: (typeof obj === "object" ? obj : {}) as Record<string, unknown>, msg: msg ?? String(obj) })]),
  ) as never;
  const outbox = createOutbox({ cfg, slack: slack.api, confluence: new ConfluenceApi({ baseUrl: cfg.outbox.confluence!.baseUrl, email: "bot@example.com", token: "test-token", fetch: confluence.fetch }), log });
  const routines = createRoutines({
    cfg,
    store,
    jobs: { runJob: async () => Promise.reject(new Error("no runs here")), slots: new Slots(1) } as never,
    executor: { exec: o.exec ?? (async () => Promise.reject(new Error("no steps here"))) },
    types: new Map([["demo", demoType]]),
    holder: o.holder ?? "pod-a",
    log,
    now: () => clock.t,
    outbox,
  });
  const json = <T = any>(key: string): T | undefined => {
    const b = store.objects.get(key)?.body;
    return b === undefined ? undefined : (JSON.parse(b) as T);
  };
  const fire = async (name = "daily", extra: { dryRun?: boolean } = {}) => {
    await routines.fire(name, { period: P, ...extra }, "job");
    await routines.idle();
  };
  return { cfg, store, clock, slack, confluence, logs, routines, json, fire };
}

describe("outbox: Slack", () => {
  it("posts each section as one message without unfurls, ending with the period and run, then its files in the thread", async () => {
    const store = new MemoryArtifactStore();
    rendered(store);
    const h = harness({ store });
    await h.fire();
    expect(h.json<RunRecord>(`${DIR}run.json`)!.state).toBe("delivered");
    const [zh, en] = h.slack.messages();
    expect(zh).toMatchObject({ channel: "C0TEAM", unfurl_links: false, unfurl_media: false });
    expect(zh!.text).toBe(`<!subteam^S0123>\n\n*报告* 3 个问题\n\n_期次 ${P} · run run-7_`);
    expect(en).toMatchObject({ channel: "C0TEST", text: `*report* 3 problems\n\n_period ${P} · run run-7_` });
    expect(h.slack.uploads).toEqual([expect.objectContaining({ channel_id: "C0TEAM", thread_ts: "1763629200.000101", filename: "report.html" })]);
    expect(h.slack.uploads[0]!.file.toString()).toBe("<p>zh</p>");
    const rec = h.json<DeliveredRecord>(`${DIR}delivered.json`)!;
    expect(rec.token).toBe(h.json<RunRecord>(`${DIR}run.json`)!.token);
    expect(rec.targets[TEAM_ZH]).toMatchObject({
      ok: true,
      link: "https://slack.example.com/archives/C0TEAM/p1763629200000101",
      detail: { channel: "C0TEAM", message: { ts: "1763629200.000101" }, files: { "report.html": { id: "F1" } } },
    });
    expect(rec.targets[TEST_EN]).toMatchObject({ ok: true, detail: { files: {} } });
    expect(h.slack.notices()).toEqual([]);
  });

  it("keeps the message when its file fails, and on the next try uploads only the file, never posting again", async () => {
    const store = new MemoryArtifactStore();
    rendered(store);
    const slack = fakeSlack({ failUploads: 1 });
    const a = harness({ store, slack });
    await a.fire();
    expect(a.json(`${DIR}run.json`)).toMatchObject({ state: "failed", reason: expect.stringMatching(/delivery failed: slack:C0TEAM:all:zh \(file: files.uploadV2 report.html: ratelimited\)/) });
    const after = a.json<DeliveredRecord>(`${DIR}delivered.json`)!.targets;
    expect(after[TEAM_ZH]).toMatchObject({ ok: false, step: "file", detail: { message: { ts: "1763629200.000101" }, files: {} } });
    // The other target is not held up by this one.
    expect(after[TEST_EN]).toMatchObject({ ok: true });
    expect(slack.messages()).toHaveLength(2);
    // The owner hears of it: routine, period, step, reason, run.
    expect(slack.notices()).toHaveLength(1);
    expect(slack.notices()[0]).toMatchObject({ channel: "C0OWNER" });
    expect(slack.notices()[0]!.text).toMatch(/Routine `daily` failed[\s\S]*Period: `2026-11-20T09:00:00Z`[\s\S]*Step: `deliver`[\s\S]*ratelimited[\s\S]*Run: `run-7`/);

    const b = harness({ store, slack, holder: "pod-b" });
    await b.fire();
    expect(b.json<RunRecord>(`${DIR}run.json`)!.state).toBe("delivered");
    expect(slack.messages()).toHaveLength(2);
    expect(slack.uploads.map((u) => [u.channel_id, u.thread_ts, u.filename])).toEqual([["C0TEAM", "1763629200.000101", "report.html"]]);
    expect(b.json<DeliveredRecord>(`${DIR}delivered.json`)!.targets[TEAM_ZH]).toMatchObject({ ok: true, link: expect.stringContaining("p1763629200000101"), detail: { files: { "report.html": { id: "F1" } } } });
  });

  it("records a message posted while a shutdown stops the period, so the next Pod does not post it again", async () => {
    const store = new MemoryArtifactStore();
    rendered(store);
    let stop = () => {};
    const slack = fakeSlack({ onPost: () => stop() });
    const a = harness({ store, slack });
    stop = () => {
      stop = () => {};
      void a.routines.drain(1000);
    };
    await a.fire();
    expect(a.json<RunRecord>(`${DIR}run.json`)).toMatchObject({ state: "running", reason: "interrupted" });
    expect(a.json<DeliveredRecord>(`${DIR}delivered.json`)!.targets[TEAM_ZH]).toMatchObject({ ok: false, detail: { message: { ts: "1763629200.000101" } } });
    expect(slack.uploads).toEqual([]);

    const b = harness({ store, slack, holder: "pod-b" });
    await b.fire();
    expect(b.json<RunRecord>(`${DIR}run.json`)!.state).toBe("delivered");
    expect(slack.messages().map((p) => p.channel)).toEqual(["C0TEAM", "C0TEST"]);
    expect(slack.uploads.map((u) => [u.thread_ts, u.filename])).toEqual([["1763629200.000101", "report.html"]]);
  });

  it("skips the targets delivered.json has as delivered by an earlier holder", async () => {
    const store = new MemoryArtifactStore();
    rendered(store);
    put(store, `${DIR}delivered.json`, { token: "old", targets: { [TEAM_ZH]: { ok: true, at: "x", link: "https://slack.example.com/1" } } });
    const h = harness({ store, holder: "pod-b" });
    await h.fire();
    expect(h.slack.messages().map((p) => p.channel)).toEqual(["C0TEST"]);
    expect(h.slack.uploads).toEqual([]);
    expect(h.json<DeliveredRecord>(`${DIR}delivered.json`)!.targets[TEAM_ZH]).toMatchObject({ link: "https://slack.example.com/1" });
  });

  it("delivers nothing more once the lease is taken over mid-delivery", async () => {
    const store = new MemoryArtifactStore();
    rendered(store);
    const clock = { t: T0 };
    const slack = fakeSlack({
      // While the first message is being posted, this Pod stalls past its lease and another one takes it over.
      onPost: () => {
        put(store, `${DIR}lease.json`, { holder: "pod-b", token: "b", expiresAt: "2099-01-01T00:00:00Z" });
        clock.t += 270_000;
      },
    });
    const h = harness({ store, slack, clock });
    await h.fire();
    expect(slack.posts).toHaveLength(1);
    expect(slack.uploads).toEqual([]);
    expect(h.json(`${DIR}lease.json`).holder).toBe("pod-b");
    expect(h.store.objects.has(`${DIR}delivered.json`)).toBe(false);
    expect(h.json<RunRecord>(`${DIR}run.json`)!.state).toBe("running");
    expect(h.logs.some((l) => l.msg === "period stopped: its lease was taken over")).toBe(true);
  });

  it("refuses a target outside the allowlist without posting, and tells the owner", async () => {
    const store = new MemoryArtifactStore();
    rendered(store);
    const cfg = cfgFor();
    // Startup refuses this; the Outbox checks again before it sends.
    cfg.outbox.slack.allowedChannels = ["C0TEST", "C0OWNER"];
    const h = harness({ store, cfg });
    await h.fire();
    expect(h.slack.messages().map((p) => p.channel)).toEqual(["C0TEST"]);
    expect(h.json<DeliveredRecord>(`${DIR}delivered.json`)!.targets[TEAM_ZH]).toMatchObject({ ok: false, step: "allowlist", error: expect.stringMatching(/C0TEAM is not in outbox.slack.allowedChannels/) });
    expect(h.slack.notices()).toHaveLength(1);
  });

  it("fails a target whose section or language the bundle does not have", async () => {
    const store = new MemoryArtifactStore();
    rendered(store, DIR, { sections: { all: { en: { slack: "sections/all/en/slack.md", attachments: {} } } } });
    const h = harness({ store });
    await h.fire();
    expect(h.json<DeliveredRecord>(`${DIR}delivered.json`)!.targets[TEAM_ZH]).toMatchObject({ ok: false, step: "bundle", error: "the bundle has no section all in zh" });
    expect(h.json<RunRecord>(`${DIR}run.json`)!.state).toBe("failed");
    expect(h.slack.notices()[0]!.text).toMatch(/no section all in zh/);
  });

  it("sends every Slack target and the owner's notice to the test channel on a dry run, without the mention", async () => {
    const store = new MemoryArtifactStore();
    rendered(store, `jobs/daily/dryrun/${P}/`, { sections: { all: { zh: { slack: "sections/all/zh/slack.md", attachments: { "report.html": "sections/all/zh/attachments/report.html" } } } } });
    const h = harness({ store });
    await h.fire("daily", { dryRun: true });
    expect(h.slack.posts.map((p) => p.channel)).toEqual(["C0TEST", "C0TEST"]);
    expect(h.slack.posts[0]!.text).toBe(`*报告* 3 个问题\n\n_期次 ${P} · run run-7 · 试运行_`);
    expect(h.slack.uploads.map((u) => u.channel_id)).toEqual(["C0TEST"]);
    // The en target is missing from the bundle: its failure notice goes to the test channel too.
    expect(h.slack.posts[1]!.text).toMatch(/^:x: Routine `daily` failed \(dry run\)/);
    expect(h.store.objects.has(`${DIR}delivered.json`)).toBe(false);
    expect(h.json<DeliveredRecord>(`jobs/daily/dryrun/${P}/delivered.json`)!.targets[TEAM_ZH]).toMatchObject({ ok: true, detail: { channel: "C0TEST" } });
  });

  it("opens a deliver span per target under the period's root, and logs one line per target", async () => {
    exporter.reset();
    const store = new MemoryArtifactStore();
    rendered(store);
    const h = harness({ store, slack: fakeSlack({ failUploads: 1 }) });
    await h.fire();
    const spans = await flushed();
    const traceId = h.json<RunRecord>(`${DIR}run.json`)!.holders.at(-1)!.traceId;
    const root = spans.find((s) => s.name === "routine daily" && s.spanContext().traceId === traceId)!;
    const deliver = spans.filter((s) => s.name === "deliver slack" && s.spanContext().traceId === traceId);
    expect(deliver).toHaveLength(2);
    for (const s of deliver) expect(s.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    const zh = deliver.find((s) => s.attributes["neotags.delivery.target"] === TEAM_ZH)!;
    expect(zh.attributes).toMatchObject({ "neotags.delivery.sink": "slack", "neotags.delivery.outcome": "failed", "neotags.delivery.failed_step": "file", "neotags.delivery.steps": ["message"] });
    const en = deliver.find((s) => s.attributes["neotags.delivery.target"] === TEST_EN)!;
    expect(en.attributes).toMatchObject({ "neotags.delivery.outcome": "ok", "neotags.delivery.steps": ["message"], "neotags.delivery.link": expect.stringContaining("C0TEST") });
    const lines = h.logs.filter((l) => l.msg === "delivery target finished").map((l) => l.obj);
    expect(lines).toEqual([
      expect.objectContaining({ routine: "daily", period: P, target: TEAM_ZH, sink: "slack", outcome: "failed", step: "file", steps: ["message"] }),
      expect.objectContaining({ target: TEST_EN, outcome: "ok", link: expect.any(String) }),
    ]);
  });
});

describe("outbox: agent routines", () => {
  it("posts nothing for when_findings without findings, and counts the period delivered", async () => {
    const store = new MemoryArtifactStore();
    put(store, `${AGENT_DIR}output.json`, { notify: false, summary: "quiet week", report: "nothing" });
    failedRun(store, AGENT_DIR, "agent");
    const h = harness({ store });
    await h.fire("weekly");
    expect(h.json<RunRecord>(`${AGENT_DIR}run.json`)!.state).toBe("delivered");
    expect(h.slack.posts).toEqual([]);
    expect(h.store.objects.has(`${AGENT_DIR}delivery-pending.json`)).toBe(false);
  });

  it("posts the summary with findings and attaches the report", async () => {
    const store = new MemoryArtifactStore();
    put(store, `${AGENT_DIR}output.json`, { notify: true, summary: "two new problems", report: "*full report*" });
    failedRun(store, AGENT_DIR, "agent");
    const h = harness({ store });
    await h.fire("weekly");
    expect(h.slack.posts).toEqual([expect.objectContaining({ channel: "C0TEAM", text: `two new problems\n\n_period ${P} · run run-7_` })]);
    expect(h.slack.uploads.map((u) => [u.filename, u.file.toString()])).toEqual([["report.md", "*full report*"]]);
  });
});

describe("outbox: failure notices", () => {
  it("tells the owner which step failed, with the reason and the period", async () => {
    const h = harness({ exec: async () => execResult({ exitCode: 2, stderr: "bad params" }) });
    await h.fire();
    expect(h.json<RunRecord>(`${DIR}run.json`)).toMatchObject({ state: "failed", reason: "step pull: exit code 2 (parameters or configuration)" });
    expect(h.slack.messages()).toEqual([]);
    expect(h.slack.notices()).toHaveLength(1);
    expect(h.slack.notices()[0]!.text).toBe(
      [":x: Routine `daily` failed", "• Period: `2026-11-20T09:00:00Z`", "• Step: `pull`", "• Reason: step pull: exit code 2 (parameters or configuration)", "• Run: none"].join("\n"),
    );
  });

  it("does not notify when a period is superseded", async () => {
    const store = new MemoryArtifactStore();
    rendered(store);
    const clock = { t: T0 };
    const slack = fakeSlack({
      onPost: () => {
        put(store, `${DIR}lease.json`, { holder: "pod-b", token: "b", expiresAt: "2099-01-01T00:00:00Z" });
        clock.t += 270_000;
      },
    });
    await harness({ store, slack, clock }).fire();
    expect(slack.notices()).toEqual([]);
  });
});

describe("outbox: Confluence", () => {
  const pageDetail = (h: ReturnType<typeof harness>) => h.json<DeliveredRecord>(`${PAGES_DIR}delivered.json`)!.targets[PAGE]!;

  it("creates the month's folder when there is none, the page in it, and uploads each attachment", async () => {
    const store = new MemoryArtifactStore();
    rendered(store, PAGES_DIR);
    const h = harness({ store });
    await h.fire("pages");
    expect(h.json<RunRecord>(`${PAGES_DIR}run.json`)!.state).toBe("delivered");
    expect(h.confluence.children).toEqual([expect.objectContaining({ type: "folder", title: "2026-11", parentId: "456", spaceId: "7" })]);
    const folder = h.confluence.children[0]!.id;
    expect(h.confluence.pages).toEqual([expect.objectContaining({ title: "Digest 2026-11-20", parentId: folder, spaceId: "7", body: "<p>page</p>" })]);
    const page = h.confluence.pages[0]!.id;
    expect(h.confluence.attachments).toEqual([
      { page, name: "report.html", content: "<p>full</p>" },
      { page, name: "summary.html", content: "<p>short</p>" },
    ]);
    expect(pageDetail(h)).toMatchObject({
      ok: true,
      link: `https://wiki.example.com/wiki/spaces/OPS/pages/${page}`,
      detail: { parent: "456", spaceId: "7", folder: { id: folder, title: "2026-11" }, page: { id: page }, attachments: { "report.html": { id: "att1" }, "summary.html": { id: "att2" } } },
    });
  });

  it("puts the page in the month's folder when it already exists", async () => {
    const store = new MemoryArtifactStore();
    rendered(store, PAGES_DIR);
    const h = harness({ store, confluence: fakeConfluence({ children: [{ id: "77", type: "folder", title: "2026-11", parentId: "456" }, { id: "76", type: "folder", title: "2026-10", parentId: "456" }] }) });
    await h.fire("pages");
    expect(h.confluence.calls).not.toContain("POST /api/v2/folders");
    expect(h.confluence.pages).toEqual([expect.objectContaining({ parentId: "77" })]);
    expect(pageDetail(h)).toMatchObject({ ok: true, detail: { folder: { id: "77", title: "2026-11" } } });
  });

  it("only uploads the missing attachments when the page was created before", async () => {
    const store = new MemoryArtifactStore();
    rendered(store, PAGES_DIR);
    const confluence = fakeConfluence({ failAttachments: 1 });
    const a = harness({ store, confluence });
    await a.fire("pages");
    expect(pageDetail(a)).toMatchObject({ ok: false, step: "attachment", error: expect.stringMatching(/attachment report.html: .*HTTP 500/), detail: { page: { id: expect.any(String) }, attachments: {} } });
    expect(a.slack.notices()).toHaveLength(1);
    const pagesBefore = confluence.pages.length;

    const b = harness({ store, confluence, holder: "pod-b" });
    await b.fire("pages");
    expect(b.json<RunRecord>(`${PAGES_DIR}run.json`)!.state).toBe("delivered");
    expect(confluence.pages).toHaveLength(pagesBefore);
    expect(confluence.calls.filter((c) => c === "POST /api/v2/pages")).toHaveLength(1);
    expect(confluence.calls.filter((c) => c === "POST /api/v2/folders")).toHaveLength(1);
    expect(confluence.attachments.map((x) => x.name)).toEqual(["report.html", "summary.html"]);
  });

  it("takes the page an attempt created but could not record, by the title it recorded, and makes it full width", async () => {
    const store = new MemoryArtifactStore();
    rendered(store, PAGES_DIR);
    const confluence = fakeConfluence({ losePageAnswers: 1 });
    const a = harness({ store, confluence });
    await a.fire("pages");
    expect(pageDetail(a)).toMatchObject({ ok: false, step: "page", detail: { pendingTitle: "Digest 2026-11-20" } });
    const b = harness({ store, confluence, holder: "pod-b" });
    await b.fire("pages");
    expect(confluence.pages).toHaveLength(1);
    expect(pageDetail(b)).toMatchObject({ ok: true, detail: { page: { id: confluence.pages[0]!.id, title: "Digest 2026-11-20" } } });
    expect(pageDetail(b).detail).not.toHaveProperty("pendingTitle");
    expect(confluence.calls.filter((c) => c.endsWith("/properties"))).toHaveLength(2);
  });

  it("never takes another period's page of the same title: a new page with the time", async () => {
    const store = new MemoryArtifactStore();
    rendered(store, PAGES_DIR);
    const confluence = fakeConfluence({
      children: [{ id: "77", type: "folder", title: "2026-11", parentId: "456" }],
      pages: [{ id: "500", type: "page", title: "Digest 2026-11-20", parentId: "77", spaceId: "7" }],
    });
    const h = harness({ store, confluence });
    await h.fire("pages");
    expect(confluence.pages.map((p) => p.title)).toEqual(["Digest 2026-11-20", "Digest 2026-11-20 09:00"]);
    expect(confluence.attachments.every((x) => x.page !== "500")).toBe(true);
    expect(pageDetail(h)).toMatchObject({ ok: true, detail: { page: { title: "Digest 2026-11-20 09:00" } } });
  });

  it("refuses a parent that is not in the configured space, and tells the owner", async () => {
    const store = new MemoryArtifactStore();
    rendered(store, PAGES_DIR);
    const h = harness({ store, confluence: fakeConfluence({ parentSpace: "8" }) });
    await h.fire("pages");
    expect(pageDetail(h)).toMatchObject({ ok: false, step: "parent", error: "parent 456 is not in space OPS" });
    expect(h.confluence.calls.filter((c) => c.startsWith("POST"))).toEqual([]);
    expect(h.slack.notices()[0]!.text).toMatch(/parent 456 is not in space OPS/);
  });

  it("refuses a space outside the allowlist before calling Confluence", async () => {
    const store = new MemoryArtifactStore();
    rendered(store, PAGES_DIR);
    const cfg = cfgFor();
    cfg.outbox.confluence!.allowedSpaces = ["OTHER"];
    const h = harness({ store, cfg });
    await h.fire("pages");
    expect(pageDetail(h)).toMatchObject({ ok: false, step: "allowlist" });
    expect(h.confluence.calls).toEqual([]);
  });

  it("puts a dry run's page under the test parent, and skips Confluence without one", async () => {
    const store = new MemoryArtifactStore();
    const dry = `jobs/pages/dryrun/${P}/`;
    rendered(store, dry);
    const h = harness({ store });
    await h.fire("pages", { dryRun: true });
    expect(h.confluence.children).toEqual([expect.objectContaining({ title: "2026-11", parentId: "999" })]);
    expect(h.json<DeliveredRecord>(`${dry}delivered.json`)!.targets[PAGE]).toMatchObject({ ok: true, detail: { parent: "999" } });

    const store2 = new MemoryArtifactStore();
    rendered(store2, dry);
    const cfg = cfgFor();
    delete cfg.outbox.confluence!.testParent;
    const h2 = harness({ store: store2, cfg });
    await h2.fire("pages", { dryRun: true });
    expect(h2.confluence.calls).toEqual([]);
    expect(h2.json<DeliveredRecord>(`${dry}delivered.json`)!.targets[PAGE]).toMatchObject({ ok: true, detail: { skipped: expect.stringMatching(/testParent/) } });
  });

  it("takes the month in the routine's time zone", () => {
    expect(periodMonth("2026-11-30T16:00:00Z", "Asia/Shanghai")).toBe("2026-12");
    expect(periodMonth("2026-11-30T16:00:00Z", "UTC")).toBe("2026-11");
  });
});
