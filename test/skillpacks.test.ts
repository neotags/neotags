import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { loadSkillPacks, parseSkillMd, skillPackTools } from "../src/tools/skillpacks.js";

let dir: string;
let outside: string;
const put = (rel: string, text: string) => {
  const p = path.join(dir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "packs-"));
  outside = mkdtempSync(path.join(tmpdir(), "outside-"));
  put(
    "o2-query-assistant/SKILL.md",
    `---
name: o2-query-assistant
description: Write and run O2 SQL from the page context
sandbox:
  net: [o2.example.com]
  tools: [openobserve-cli]
  credentials:
    - { name: O2_RO_TOKEN, hosts: [o2.example.com], header: Authorization }
  limits: { cpu: 1, mem: 512Mi, timeoutSec: 60 }
---
# O2 query assistant
Check StreamSchema first.
`,
  );
  put("o2-query-assistant/references/o2-sql.md", "SELECT count(*) ...");
  put("o2-query-assistant/references/data/streams.json", "{}");
  put("o2-query-assistant/references/.hidden.md", "hidden");
  put("o2-query-assistant/references/tool.py", "print('not text')");
  put("o2-query-assistant/scripts/run.sh", "rm -rf /");
  put("governance/SKILL.md", "---\nname: governance\ndescription: not mounted whole\n---\nbody");
  put("governance/references/research-method.md", "method");
  put("governance/references/credentials.md", "not allowlisted");
  writeFileSync(path.join(outside, "secret.md"), "outside the dir");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const load = (o: Partial<Parameters<typeof loadSkillPacks>[0]> = {}) =>
  loadSkillPacks({ dir, packs: ["o2-query-assistant"], refs: { governance: ["research-method.md"] }, maxFileBytes: 64 * 1024, ...o });

describe("skill pack loader", () => {
  it("loads whole packs with their references, and only the listed references of other packs", async () => {
    const { index, warnings } = await load();
    expect(warnings).toEqual([]);
    const pack = index.get("o2-query-assistant")!;
    expect(pack.description).toBe("Write and run O2 SQL from the page context");
    expect(pack.body).toBe("# O2 query assistant\nCheck StreamSchema first.");
    expect([...pack.refs.keys()]).toEqual(["data/streams.json", "o2-sql.md"]); // no hidden file, no script
    const gov = index.get("governance")!;
    expect(gov.body).toBeUndefined(); // its SKILL.md is not allowlisted
    expect([...gov.refs.keys()]).toEqual(["research-method.md"]);
    expect(index.ref("governance", "credentials.md")).toBeUndefined();
  });

  it("reads the sandbox declaration from the front matter", async () => {
    const { index } = await load();
    expect(index.get("o2-query-assistant")!.sandbox).toEqual({
      net: ["o2.example.com"],
      tools: ["openobserve-cli"],
      credentials: [{ name: "O2_RO_TOKEN", hosts: ["o2.example.com"], header: "Authorization" }],
      limits: { cpu: 1, mem: "512Mi", timeoutSec: 60 },
    });
    expect(index.get("governance")!.sandbox).toBeUndefined();
  });

  it("drops an invalid sandbox declaration, so the pack cannot execute", async () => {
    put("bad/SKILL.md", "---\nname: bad\ndescription: d\nsandbox: { credentials: [{ name: X }] }\n---\nbody");
    const { index, warnings } = await load({ packs: ["bad"], refs: {} });
    expect(index.get("bad")!.sandbox).toBeUndefined();
    expect(warnings.join()).toMatch(/invalid sandbox/);
  });

  it("drops declarations the executor would refuse: paths as tools, Kubernetes CPU, bad credential names or headers", async () => {
    const bad = [
      "{ tools: [/usr/bin/jq] }",
      "{ tools: ['my tool'] }",
      "{ tools: [jq], limits: { cpu: 500m } }",
      "{ tools: [jq], limits: { mem: 1G } }",
      "{ tools: [jq], net: [a.example.com], credentials: [{ name: api-token, hosts: [a.example.com], header: Authorization }] }",
      "{ tools: [jq], net: [a.example.com], credentials: [{ name: TOKEN, hosts: [a.example.com], header: Host }] }",
      "{ tools: [jq], net: ['*.example.com'] }",
      "{ tools: [jq], net: [a.example.com/path] }",
      "{ tools: [jq], net: [localhost] }",
      "{ tools: [jq], net: [a.example.com], credentials: [{ name: TOKEN, hosts: [b.example.com], header: Authorization }] }",
      "{ tools: [jq], net: [a.example.com], credentials: [{ name: T, hosts: [a.example.com], header: X-A }, { name: T, hosts: [a.example.com], header: X-B }] }",
      "{ tools: [jq], limits: { mem: 8Mi } }",
    ];
    bad.forEach((s, i) => put(`bad${i}/SKILL.md`, `---\nname: bad${i}\ndescription: d\nsandbox: ${s}\n---\nbody`));
    const { index } = await load({ packs: bad.map((_, i) => `bad${i}`), refs: {} });
    bad.forEach((s, i) => expect(index.get(`bad${i}`)!.sandbox, s).toBeUndefined());
  });

  it("keeps declarations the executor accepts: host with port, credential host with a port in net, numeric cpu strings", async () => {
    put("ok/SKILL.md", "---\nname: ok\ndescription: d\nsandbox: { tools: [jq], net: ['API.example.com:8080'], credentials: [{ name: TOKEN, hosts: [api.example.com], header: Authorization }], limits: { cpu: '0.5', mem: 1Gi } }\n---\nbody");
    const { index } = await load({ packs: ["ok"], refs: {} });
    expect(index.get("ok")!.sandbox?.limits).toEqual({ cpu: "0.5", mem: "1Gi" });
  });

  it("rejects paths that escape the pack dir, by name or by symlink", async () => {
    symlinkSync(path.join(outside, "secret.md"), path.join(dir, "governance/references/link.md"));
    const { index, warnings } = await load({ refs: { governance: ["../../etc/passwd", "/etc/passwd", "link.md", "research-method.md"], "../x": ["a.md"] } });
    expect([...index.get("governance")!.refs.keys()]).toEqual(["research-method.md"]);
    expect(warnings.join("\n")).toMatch(/not a plain relative path/);
    expect(warnings.join("\n")).toMatch(/link.md: resolves outside/);
    expect(warnings.join("\n")).toMatch(/"\.\.\/x" is not a plain directory name/);
  });

  it("follows symlinks that stay inside the dir (ConfigMap ..data layout)", async () => {
    mkdirSync(path.join(dir, "..data/cm/references"), { recursive: true });
    writeFileSync(path.join(dir, "..data/cm/SKILL.md"), "---\nname: cm\ndescription: from a ConfigMap\n---\nbody");
    writeFileSync(path.join(dir, "..data/cm/references/a.md"), "a");
    symlinkSync("..data/cm", path.join(dir, "cm"));
    const { index, warnings } = await load({ packs: ["cm"], refs: {} });
    expect(warnings).toEqual([]);
    expect(index.get("cm")).toMatchObject({ description: "from a ConfigMap", body: "body" });
    expect(index.ref("cm", "a.md")).toBe("a");
  });

  it("skips files over the size limit and packs without SKILL.md, with warnings", async () => {
    put("o2-query-assistant/references/big.md", "x".repeat(2000));
    const { index, warnings } = await load({ packs: ["o2-query-assistant", "missing"], maxFileBytes: 1000 });
    expect(index.ref("o2-query-assistant", "big.md")).toBeUndefined();
    expect(index.get("missing")).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/big.md: 2000 bytes is over/);
    expect(warnings.join("\n")).toMatch(/missing: no SKILL.md/);
  });

  it.skipIf(process.getuid?.() === 0)("skips an unreadable file with a warning instead of failing the load", async () => {
    const { chmodSync } = await import("node:fs");
    chmodSync(path.join(dir, "o2-query-assistant/references/o2-sql.md"), 0);
    const { index, warnings } = await load();
    expect(index.ref("o2-query-assistant", "o2-sql.md")).toBeUndefined();
    expect(index.get("o2-query-assistant")!.body).toContain("Check StreamSchema first.");
    expect(warnings.join("\n")).toMatch(/o2-sql.md: EACCES/);
  });

  it("reports a missing dir instead of throwing", async () => {
    const { index, warnings } = await load({ dir: path.join(dir, "nope") });
    expect(index.list()).toEqual([]);
    expect(warnings[0]).toMatch(/skill pack dir/);
  });

  it("parses SKILL.md with and without front matter", () => {
    expect(parseSkillMd("---\nname: a\n---\nbody")).toEqual({ meta: { name: "a" }, body: "body" });
    expect(parseSkillMd("# just markdown")).toEqual({ meta: {}, body: "# just markdown" });
  });
});

describe("skill pack tools", () => {
  it("read_skill and read_skill_ref serve the index and list what exists on a miss", async () => {
    const { index } = await load();
    const [readSkill, readRef] = skillPackTools(index);
    const text = (r: { content: { type: string; text?: string }[] }) => r.content[0]!.text;
    expect(text(await readSkill!.execute("1", { name: "o2-query-assistant" }))).toContain("Check StreamSchema first.");
    await expect(readSkill!.execute("2", { name: "governance" })).rejects.toThrow(/available: o2-query-assistant/);
    expect(text(await readRef!.execute("3", { name: "o2-query-assistant", file: "references/o2-sql.md" }))).toBe("SELECT count(*) ...");
    expect(text(await readRef!.execute("4", { name: "governance", file: "research-method.md" }))).toBe("method");
    await expect(readRef!.execute("5", { name: "governance", file: "credentials.md" })).rejects.toThrow(/available: research-method.md/);
    await expect(readRef!.execute("6", { name: "o2-query-assistant", file: "../../governance/references/credentials.md" })).rejects.toThrow(/no reference/);
  });
});

describe("agent config", () => {
  const base = { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y" };
  const cfgFor = (yaml: string) => loadConfig({ ...base, NEOTAGS_CONFIG: "f" }, () => yaml);

  it("defaults to the design's budgets", () => {
    const c = cfgFor("");
    expect(c.agent).toMatchObject({
      maxSteps: 30,
      maxInputTokens: 100_000,
      wallClockSec: { slack: 360, o2: 600, job: 600 },
      finalReserveSec: 90,
      concurrency: { total: 4, perUserPerHour: 20 },
      drainSec: 640,
      entries: {},
    });
    expect(c.llm.failover.firstTokenTimeoutSec).toBe(30);
    expect(c.skillPacks).toEqual({ packs: [], refs: {}, maxFileKb: 256 });
  });

  it("accepts the commented agent / skillPacks example in config/neotags.example.yaml", () => {
    const lines = readFileSync("config/neotags.example.yaml", "utf8").split("\n");
    const from = lines.findIndex((l) => l.startsWith("# agent:"));
    const to = lines.findIndex((l) => l.startsWith("logLevel:"));
    expect(from).toBeGreaterThan(0);
    const block = lines.slice(from, to).map((l) => l.slice(2).replace(/\s+#.*$/, "")).join("\n");
    const c = cfgFor(block);
    expect(c.agent.entries.o2).toEqual(["o2-query-assistant"]);
    expect(c.skillPacks).toMatchObject({ dir: "/etc/neotags/skills", refs: { "some-pack": ["method.md", "data/table.json"] } });
  });

  it("requires entry packs to be mounted whole", () => {
    const ok = cfgFor("agent:\n  entries: { o2: [o2-query-assistant] }\nskillPacks:\n  dir: /etc/neotags/skills\n  packs: [o2-query-assistant]\n");
    expect(ok.agent.entries.o2).toEqual(["o2-query-assistant"]);
    expect(() => cfgFor("agent:\n  entries: { o2: [nope] }\n")).toThrow(/nope.*is not in skillPacks.packs/);
    expect(() => cfgFor("agent:\n  entries: { github: [x] }\n")).toThrow();
  });
});
