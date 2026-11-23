import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryArtifactStore, PreconditionError, S3ArtifactStore, type S3Like } from "../src/artifacts/index.js";
import { loadConfig } from "../src/config/index.js";
import { routinePackIssues } from "../src/config/routines.js";
import { acquireLease, LEASE_TIMING } from "../src/routines/lease.js";
import { OwnedRecord, Superseded } from "../src/routines/records.js";
import { routineTypes, stepPackIssues } from "../src/routines/types.js";
import { SkillExecutor, skillExecTool } from "../src/sandbox/exec.js";
import type { Sandbox } from "../src/sandbox/types.js";
import { loadSkillPacks } from "../src/tools/skillpacks.js";

const STEP_MD = `---
name: demo-steps
description: Deterministic steps of the demo routine (pipeline engine only).
pipeline:
  type: demo
  params: references/params.schema.json
  classify:
    after: pull
    outputSchema: demo-classify/references/problems.schema.json
    budget: { wallClockSec: 600, maxSteps: 12 }
  steps:
    - { name: pull,   argv: [python3, /skills/demo-steps/scripts/step.py, pull] }
    - { name: render, argv: [python3, /skills/demo-steps/scripts/step.py, render] }
  degrade: render
sandbox:
  tools: [python3]
  net: ["o2.example.com:5080"]
  limits: { timeoutSec: 300 }
---
Steps only.
`;

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function packsDir(files: Record<string, string>): string {
  dir = mkdtempSync(path.join(tmpdir(), "steps-"));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return dir;
}

const baseFiles = (stepMd = STEP_MD) => ({
  "demo-steps/SKILL.md": stepMd,
  "demo-steps/references/params.schema.json": JSON.stringify({ type: "object", properties: { window: { type: "string" } }, required: ["window"], additionalProperties: false }),
  "demo-classify/SKILL.md": "---\nname: demo-classify\ndescription: Group alerts\n---\nGroup.",
  "demo-classify/references/problems.schema.json": JSON.stringify({ type: "object", properties: { problems: { type: "array" } }, required: ["problems"] }),
  "helper/SKILL.md": "---\nname: helper\ndescription: Runs things\nsandbox:\n  tools: [python3]\n---\nRun.",
});

const load = (files: Record<string, string>, packs = ["demo-steps", "demo-classify", "helper"]) => loadSkillPacks({ dir: packsDir(files), packs, refs: {}, maxFileBytes: 256 * 1024 });

const cfgFor = (routine: string, extra = "") =>
  loadConfig({ SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y", MOOSE_JOB_KEY: "k", NEOTAGS_CONFIG: "f" }, () => `skillPacks: { packs: [demo-steps, demo-classify, helper] }
jobsApi: { enabled: true, callers: { job: { keyFromEnv: MOOSE_JOB_KEY } } }
outbox: { slack: { allowedChannels: [C0TEST], testChannel: C0TEST } }
artifacts: { s3: { bucket: b } }
${extra}
routines:
  daily:
${routine}
    trigger: { schedule: "0 9 * * *", timeZone: UTC }
    owner: { slack: C0TEST }
    delivery: { slack: [{ channel: C0TEST, lang: en }] }
`);

const pipelineRoutine = (packs = "[demo-classify]", params = "{ window: 24h }") => `    kind: pipeline\n    type: demo\n    packs: ${packs}\n    params: ${params}`;

describe("step packs", () => {
  it("loads the pipeline front matter with its params schema", async () => {
    const { index, warnings } = await load(baseFiles());
    expect(warnings).toEqual([]);
    const p = index.get("demo-steps")!.pipeline!;
    expect(p).toMatchObject({ type: "demo", degrade: "render", classify: { after: "pull", budget: { wallClockSec: 600, maxSteps: 12 } } });
    expect(p.steps.map((s) => s.name)).toEqual(["pull", "render"]);
    expect(p.paramsSchema).toMatchObject({ required: ["window"] });
    const t = routineTypes(index).get("demo")!;
    expect(t.pack.name).toBe("demo-steps");
    expect(t.outputSchema).toMatchObject({ required: ["problems"] });
  });

  it("skips a step pack whose declaration is invalid, rather than load half of it", async () => {
    const cases: [string, RegExp][] = [
      [STEP_MD.replace("after: pull", "after: nope"), /nope is not a step/],
      [STEP_MD.replace("degrade: render", "degrade: pull"), /pull is not a step after pull/],
      [STEP_MD.replace("[python3, /skills/demo-steps/scripts/step.py, pull]", "[bash, -c, x]"), /"bash" is not one of sandbox.tools/],
      [STEP_MD.replace("params: references/params.schema.json", "params: references/missing.json"), /could not be read/],
      [STEP_MD.replace("sandbox:\n  tools: [python3]", "sandboxx:\n  tools: [python3]"), /needs a valid sandbox/],
      [STEP_MD.replace("  degrade: render", "  degrade: render\n  extra: 1"), /invalid pipeline declaration/],
    ];
    for (const [md, why] of cases) {
      const { index, warnings } = await load(baseFiles(md));
      expect(index.get("demo-steps"), String(why)).toBeUndefined();
      expect(warnings.join("\n")).toMatch(why);
      rmSync(dir!, { recursive: true, force: true });
    }
  });

  it("checks routines against the step packs at startup", async () => {
    const { index } = await load(baseFiles());
    expect(stepPackIssues(cfgFor(pipelineRoutine()), index)).toEqual([]);
    // A step pack in a routine's packs (a pipeline's or an agent's) or an entry's.
    expect(stepPackIssues(cfgFor(pipelineRoutine("[demo-classify, demo-steps]")), index).join()).toMatch(/routines.daily.packs: skill pack "demo-steps" is a step pack/);
    expect(stepPackIssues(cfgFor("    kind: agent\n    instructions: x\n    packs: [demo-steps]"), index).join()).toMatch(/routines.daily.packs: skill pack "demo-steps" is a step pack/);
    expect(stepPackIssues(cfgFor(pipelineRoutine(), "agent: { entries: { o2: [demo-steps] } }"), index).join()).toMatch(/agent.entries.o2: skill pack "demo-steps" is a step pack/);
    // params against the type's schema.
    expect(stepPackIssues(cfgFor(pipelineRoutine("[demo-classify]", "{ windw: 24h }")), index).join()).toMatch(/routines.daily.params do not match routine type demo's schema/);
    // A type no pack declares.
    expect(stepPackIssues(cfgFor(pipelineRoutine().replace("type: demo", "type: other")), index).join()).toMatch(/no loaded step pack declares routine type other/);
  });

  it("refuses a pipeline routine whose packs declare sandbox, step pack or not", async () => {
    const { index } = await load(baseFiles());
    const c = cfgFor(pipelineRoutine("[demo-classify, helper]"));
    expect(routinePackIssues(c.routines, (p) => index.get(p)?.sandbox !== undefined).join()).toMatch(/"helper" declares sandbox/);
  });

  it("refuses two step packs of one type, a missing classify schema and a budget above the defaults", async () => {
    const second = STEP_MD.replace("name: demo-steps", "name: demo-steps2").replaceAll("/skills/demo-steps/", "/skills/demo-steps2/");
    const files = { ...baseFiles(), "demo-steps2/SKILL.md": second, "demo-steps2/references/params.schema.json": "{}" };
    const { index } = await load(files, ["demo-steps", "demo-steps2", "demo-classify"]);
    expect(stepPackIssues(cfgFor(pipelineRoutine()), index).join()).toMatch(/routine type demo is declared by more than one step pack: demo-steps, demo-steps2/);

    const noSchema = await load({ ...baseFiles(STEP_MD.replace("demo-classify/references/problems.schema.json", "demo-classify/references/nope.json")) });
    expect(stepPackIssues(cfgFor(pipelineRoutine()), noSchema.index).join()).toMatch(/outputSchema demo-classify\/references\/nope.json: demo-classify has no reference nope.json/);

    const big = await load(baseFiles(STEP_MD.replace("wallClockSec: 600", "wallClockSec: 9000")));
    expect(stepPackIssues(cfgFor(pipelineRoutine()), big.index).join()).toMatch(/budget.wallClockSec may not exceed agent.wallClockSec.job/);
  });

  it("never lets a model run a step pack's commands, even when a run is given the pack", async () => {
    const { index } = await load(baseFiles());
    const ran: string[] = [];
    const sandbox: Sandbox = {
      backend: "fake",
      exec: async (e) => (ran.push(e.pack), { id: e.id, exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdout: "{}", stderr: "", truncated: { stdout: false, stderr: false }, egress: [] }),
    };
    const ex = new SkillExecutor({ sandbox, index, log: { info: () => {}, warn: () => {} } });
    const argv = ["python3", "/skills/demo-steps/scripts/step.py", "pull"];
    // run_skill_command's guard and tool.
    expect(ex.check({ pack: "demo-steps", argv }, ["demo-steps"])).toMatchObject({ ok: false, reason: expect.stringMatching(/only the pipeline engine runs them/) });
    expect(ex.runnable(["demo-steps", "helper"]).map((p) => p.name)).toEqual(["helper"]);
    expect(skillExecTool(ex, ["demo-steps"], 1000)).toBeUndefined();
    await expect(ex.exec({ pack: "demo-steps", argv }, { packs: ["demo-steps"] })).rejects.toMatchObject({ kind: "denied" });
    // The engine runs step packs, and nothing else.
    await expect(ex.exec({ pack: "demo-steps", argv }, { packs: ["demo-steps"], pipelineStep: true })).resolves.toMatchObject({ exitCode: 0 });
    await expect(ex.exec({ pack: "helper", argv: ["python3"] }, { pipelineStep: true })).rejects.toMatchObject({ kind: "denied" });
    expect(ran).toEqual(["demo-steps"]);
  });
});

describe("S3 artifact store", () => {
  /** A fake S3 client: answers each command by name, recording the input. */
  function fake(answer: (name: string, input: Record<string, unknown>) => unknown) {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const client: S3Like = {
      send: async (cmd: unknown) => {
        const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
        sent.push({ name: c.constructor.name, input: c.input });
        const r = answer(c.constructor.name, c.input);
        if (r instanceof Error) throw r;
        return r;
      },
    };
    return { store: new S3ArtifactStore({ bucket: "b", client }), sent };
  }
  const s3Error = (status: number, name: string) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

  it("sends the conditions and maps S3's answers to PreconditionError", async () => {
    const { store, sent } = fake((name, input) => {
      if (name === "PutObjectCommand" && input.IfNoneMatch) return s3Error(412, "PreconditionFailed");
      if (name === "PutObjectCommand" && input.IfMatch === '"gone"') return s3Error(404, "NoSuchKey");
      if (name === "PutObjectCommand" && input.IfMatch === '"busy"') return s3Error(409, "ConditionalRequestConflict");
      if (name === "DeleteObjectCommand") return s3Error(412, "PreconditionFailed");
      if (name === "GetObjectCommand") return s3Error(404, "NoSuchKey");
      return { ETag: '"new"' };
    });
    await expect(store.put("jobs/a", "x", { ifNoneMatch: "*" })).rejects.toEqual(new PreconditionError(412, "jobs/a"));
    await expect(store.put("jobs/a", "x", { ifMatch: '"gone"' })).rejects.toMatchObject({ status: 404 });
    await expect(store.put("jobs/a", "x", { ifMatch: '"busy"' })).rejects.toMatchObject({ status: 409 });
    await expect(store.put("jobs/a.json", "x", { ifMatch: '"ok"' })).resolves.toEqual({ etag: '"new"' });
    await expect(store.delete("jobs/a", { ifMatch: '"e"' })).rejects.toMatchObject({ status: 412 });
    await expect(store.get("jobs/missing")).resolves.toBeUndefined();
    expect(sent.find((s) => s.input.IfMatch === '"ok"')!.input).toMatchObject({ Bucket: "b", Key: "jobs/a.json", ContentType: "application/json" });
    expect(sent.find((s) => s.name === "DeleteObjectCommand")!.input).toMatchObject({ IfMatch: '"e"' });
  });

  it("reads bodies and etags, and lists every page under a prefix", async () => {
    let page = 0;
    const { store, sent } = fake((name) => {
      if (name === "GetObjectCommand") return { Body: { transformToString: async () => "{}" }, ETag: '"e1"' };
      page++;
      return page === 1
        ? { CommonPrefixes: [{ Prefix: "jobs/r/2026-11-19T09:00:00Z/" }], IsTruncated: true, NextContinuationToken: "t2" }
        : { CommonPrefixes: [{ Prefix: "jobs/r/dryrun/" }], Contents: [{ Key: "jobs/r/x.json" }] };
    });
    await expect(store.get("jobs/r/run.json")).resolves.toEqual({ body: "{}", etag: '"e1"' });
    await expect(store.list("jobs/r/", { delimiter: "/" })).resolves.toEqual({ keys: ["jobs/r/x.json"], prefixes: ["jobs/r/2026-11-19T09:00:00Z/", "jobs/r/dryrun/"] });
    expect(sent.filter((s) => s.name === "ListObjectsV2Command").map((s) => s.input)).toEqual([
      { Bucket: "b", Prefix: "jobs/r/", Delimiter: "/" },
      { Bucket: "b", Prefix: "jobs/r/", Delimiter: "/", ContinuationToken: "t2" },
    ]);
  });
});

describe("S3 answers to the lease and its records", () => {
  const now = () => Date.parse("2026-11-20T09:30:00Z");
  const opts = { now, timing: LEASE_TIMING };

  it("judges a lost takeover (412 or 404) once more from what is there, without looping", async () => {
    for (const status of [412, 404] as const) {
      const store = new MemoryArtifactStore();
      store.objects.set("jobs/l", { body: JSON.stringify({ holder: "old", token: "o", expiresAt: "2026-11-20T09:00:00Z" }), etag: '"o"' });
      store.failNext("put", "jobs/l", () => new PreconditionError(412, "jobs/l")); // the create
      // The takeover loses to another Pod, which now holds a live lease.
      store.failNext("put", "jobs/l", () => {
        store.objects.set("jobs/l", { body: JSON.stringify({ holder: "pod-b", token: "b", expiresAt: "2026-11-20T09:35:00Z" }), etag: '"b"' });
        return new PreconditionError(status, "jobs/l");
      });
      expect(await acquireLease(store, "jobs/l", "pod-a", opts)).toMatchObject({ ok: false, current: { holder: "pod-b" } });
    }
  });

  it("ignores 404 and 409 on release", async () => {
    for (const status of [404, 409] as const) {
      const store = new MemoryArtifactStore();
      const got = await acquireLease(store, "jobs/l", "pod-a", opts);
      if (!got.ok) throw new Error("not acquired");
      store.failNext("delete", "jobs/l", () => new PreconditionError(status, "jobs/l"));
      await expect(got.lease.release()).resolves.toBeUndefined();
    }
  });

  it("supersedes a run.json writer on 412 and 404, and retries 409 once while the record is still its own", async () => {
    const store = new MemoryArtifactStore();
    const rec = new OwnedRecord<{ token: string; n: number }>(store, "jobs/run.json", "mine", async () => {});
    await rec.write({ token: "mine", n: 1 });
    store.failNext("put", "jobs/run.json", () => new PreconditionError(409, "jobs/run.json"));
    await rec.write({ token: "mine", n: 2 });
    expect(JSON.parse(store.objects.get("jobs/run.json")!.body)).toEqual({ token: "mine", n: 2 });
    // 409, and the record is someone else's now.
    store.failNext("put", "jobs/run.json", () => {
      store.objects.set("jobs/run.json", { body: JSON.stringify({ token: "other", n: 9 }), etag: '"x"' });
      return new PreconditionError(409, "jobs/run.json");
    });
    await expect(rec.write({ token: "mine", n: 3 })).rejects.toBeInstanceOf(Superseded);
    await expect(rec.write({ token: "mine", n: 4 })).rejects.toThrow(/HTTP 412/);
    store.objects.delete("jobs/run.json");
    await expect(rec.write({ token: "mine", n: 5 })).rejects.toThrow(/HTTP 404/);
  });

  it("confirms the lease before each write", async () => {
    const store = new MemoryArtifactStore();
    const rec = new OwnedRecord<{ token: string }>(store, "jobs/run.json", "mine", async () => {
      throw new Superseded("lease lost");
    });
    await expect(rec.write({ token: "mine" })).rejects.toThrow(/lease lost/);
    expect(store.objects.size).toBe(0);
  });
});

