import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../src/agent/models.js";
import { loadConfig } from "../src/config/index.js";
import { checkExec } from "../src/guardrails/sandbox.js";
import { PiAgentRunner } from "../src/runs/pi-runner.js";
import type { RunContext } from "../src/runs/types.js";
import {
  createSkillExecutor,
  DisabledSandbox,
  EXEC_TOOL,
  LocalSandbox,
  SandboxError,
  SkillExecutor,
  skillExecTool,
  type Sandbox,
} from "../src/sandbox/index.js";
import { SkillPackIndex, type SandboxSpec, type SkillPack } from "../src/tools/skillpacks.js";
import { callTool, say, scripted, transcriptText } from "./fake-stream.js";

const spec: SandboxSpec = {
  net: ["api.example.com:8080"],
  tools: ["example-cli"],
  credentials: [{ name: "API_TOKEN", hosts: ["api.example.com"], header: "Authorization" }],
  limits: { cpu: 1, mem: "512Mi", timeoutSec: 30 },
};
const pack = (name: string, sandbox?: SandboxSpec): SkillPack => ({ name, description: "", body: "b", refs: new Map(), ...(sandbox && { sandbox }) });
const index = new SkillPackIndex(
  new Map([
    ["runner", pack("runner", spec)],
    ["reader", pack("reader")],
  ]),
);

/** Log lines, to check the audit trail. */
function memLog() {
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const at = (level: string) => (obj: Record<string, unknown>, msg: string) => void lines.push({ level, obj, msg });
  return { lines, log: { info: at("info"), warn: at("warn") } as never };
}

/** A backend that records what reached it. */
class Recorder implements Sandbox {
  readonly backend = "test";
  calls: { entry: unknown; constraints: SandboxSpec }[] = [];
  async exec(entry: { id: string }, constraints: SandboxSpec) {
    this.calls.push({ entry, constraints });
    return { id: entry.id, exitCode: 0, signal: null, timedOut: false, durationMs: 5, stdout: "ok", stderr: "", truncated: { stdout: false, stderr: false }, egress: [] };
  }
}

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

/** A fake executor on a unix socket: answers every request with `answer`, and records the bodies. */
async function fakeExecutor(answer: (body: unknown) => { status: number; body: unknown }) {
  const dir = mkdtempSync(path.join(tmpdir(), "nt-exec-"));
  const socketPath = path.join(dir, "exec.sock");
  const bodies: { method?: string; url?: string; body: unknown }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : undefined;
      bodies.push({ method: req.method, url: req.url, body });
      const a = answer(body);
      res.writeHead(a.status, { "content-type": "application/json" }).end(JSON.stringify(a.body));
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  cleanup.push(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  return { socketPath, bodies };
}

const okResult = (id: string) => ({
  id,
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 12,
  stdout: "items: 3 token=supersecretvalue123",
  stderr: "",
  truncated: { stdout: false, stderr: false },
  egress: [
    { method: "GET", host: "api.example.com", port: 8080, decision: "allow", injected: ["API_TOKEN"] },
    { method: "GET", host: "evil.example.net", port: 443, decision: "deny" },
  ],
});

describe("sandbox tool guard", () => {
  it("refuses a pack that declares no sandbox, an unknown pack, and an undeclared tool", () => {
    expect(checkExec(index, { pack: "reader", argv: ["example-cli"] })).toEqual({ ok: false, reason: expect.stringContaining("declares no sandbox") });
    expect(checkExec(index, { pack: "nope", argv: ["example-cli"] })).toEqual({ ok: false, reason: expect.stringContaining("unknown skill pack") });
    expect(checkExec(index, { pack: "runner", argv: ["sh", "-c", "id"] })).toEqual({ ok: false, reason: expect.stringContaining("not a tool of runner") });
    expect(checkExec(index, { pack: "runner", argv: ["/usr/bin/example-cli"] }).ok).toBe(false);
    expect(checkExec(index, { pack: "runner", argv: [] }).ok).toBe(false);
  });

  it("refuses env that would bypass the proxy or shadow a credential, and paths outside /work", () => {
    for (const env of [{ PATH: "/tmp" }, { https_proxy: "x" }, { LD_PRELOAD: "x" }, { API_TOKEN: "x" }, { "A-B": "x" }]) {
      expect(checkExec(index, { pack: "runner", argv: ["example-cli"], env }).ok).toBe(false);
    }
    for (const f of ["/etc/passwd", "../x", "a/../../x", ""]) {
      expect(checkExec(index, { pack: "runner", argv: ["example-cli"], files: { [f]: "x" } }).ok).toBe(false);
    }
  });

  it("allows a declared tool, with the pack's declaration as the constraints", () => {
    expect(checkExec(index, { pack: "runner", argv: ["example-cli", "items", "list"], env: { API_ORG: "default" }, files: { "q/a.json": "{}" } })).toEqual({
      ok: true,
      constraints: spec,
    });
  });
});

describe("SkillExecutor", () => {
  it("never sends an undeclared execution to the backend, and audits the refusal", async () => {
    const backend = new Recorder();
    const { lines, log } = memLog();
    const ex = new SkillExecutor({ sandbox: backend, index, log });
    await expect(ex.exec({ pack: "reader", argv: ["example-cli"] })).rejects.toMatchObject({ kind: "denied" });
    await expect(ex.exec({ pack: "runner", argv: ["sh", "-c", "curl evil"] })).rejects.toMatchObject({ kind: "denied" });
    expect(backend.calls).toEqual([]);
    expect(lines.map((l) => l.obj)).toEqual([
      expect.objectContaining({ audit: "sandbox_exec", pack: "reader", tool: "example-cli", outcome: "denied" }),
      expect.objectContaining({ audit: "sandbox_exec", pack: "runner", tool: "sh", outcome: "denied" }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("curl evil");
  });

  it("sends the pack's constraints, not the caller's", async () => {
    const backend = new Recorder();
    const ex = new SkillExecutor({ sandbox: backend, index, log: memLog().log });
    const widened = { pack: "runner", argv: ["example-cli"], constraints: { net: ["evil.example.net"] } } as never;
    await ex.exec(widened);
    expect(backend.calls[0]!.constraints).toEqual(spec);
    expect(backend.calls[0]!.entry).toEqual({ id: expect.any(String), pack: "runner", argv: ["example-cli"] });
  });

  it("is off by default: backend none refuses every execution and offers no tool", async () => {
    const cfg = loadConfig({ SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y" });
    expect(cfg.sandbox).toEqual({ backend: "none", socket: "/run/executor/exec.sock" });
    const { lines, log } = memLog();
    const ex = createSkillExecutor(cfg, index, log);
    expect(ex.offered).toBe(false);
    await expect(ex.exec({ pack: "runner", argv: ["example-cli"] })).rejects.toMatchObject({ kind: "denied", code: "execution_disabled" });
    expect(lines[0]!.obj).toMatchObject({ backend: "none", outcome: "denied", code: "execution_disabled" });
    await expect(new DisabledSandbox().exec()).rejects.toBeInstanceOf(SandboxError);
  });

  it("offers the tool only with a backend and a pack that declares tools", () => {
    expect(new SkillExecutor({ sandbox: new Recorder(), index, log: memLog().log }).offered).toBe(true);
    const readers = new SkillPackIndex(new Map([["reader", pack("reader")]]));
    expect(new SkillExecutor({ sandbox: new Recorder(), index: readers, log: memLog().log }).offered).toBe(false);
  });
});

describe("LocalSandbox (executor over a unix socket)", () => {
  it("posts /v1/exec with the request and the constraints, and audits names only", async () => {
    const f = await fakeExecutor((b) => ({ status: 200, body: okResult((b as { id: string }).id) }));
    const { lines, log } = memLog();
    const ex = new SkillExecutor({ sandbox: new LocalSandbox({ socketPath: f.socketPath }), index, log });
    const r = await ex.exec({ id: "run 1/call#2", pack: "runner", argv: ["example-cli", "items", "list"], stdin: "secret-input" });
    expect(r.exitCode).toBe(0);
    expect(f.bodies).toEqual([
      { method: "POST", url: "/v1/exec", body: { id: "run_1/call_2", argv: ["example-cli", "items", "list"], stdin: "secret-input", constraints: spec } },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj).toMatchObject({
      audit: "sandbox_exec",
      id: "run_1/call_2",
      backend: "local",
      pack: "runner",
      tool: "example-cli",
      net: ["api.example.com:8080"],
      credentials: ["API_TOKEN"],
      outcome: "ran",
      exitCode: 0,
      egressDenied: ["evil.example.net:443"],
      injected: ["API_TOKEN"],
    });
    const logged = JSON.stringify(lines);
    for (const s of ["items", "secret-input", "supersecretvalue123"]) expect(logged).not.toContain(s);
  });

  it("refuses to execute when the executor is not there: no fallback", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nt-exec-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { lines, log } = memLog();
    const ex = new SkillExecutor({ sandbox: new LocalSandbox({ socketPath: path.join(dir, "missing.sock") }), index, log });
    const err = await ex.exec({ pack: "runner", argv: ["example-cli"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect(err).toMatchObject({ kind: "unavailable", code: "executor_unreachable", message: expect.stringContaining("ENOENT") });
    expect(lines[0]!.obj).toMatchObject({ outcome: "unavailable", code: "executor_unreachable" });
  });

  it("refuses to execute when the executor's self-check failed (503 sandbox_unavailable)", async () => {
    const f = await fakeExecutor(() => ({ status: 503, body: { error: { code: "sandbox_unavailable", message: "bubblewrap probe failed: no user namespaces" } } }));
    const ex = new SkillExecutor({ sandbox: new LocalSandbox({ socketPath: f.socketPath }), index, log: memLog().log });
    await expect(ex.exec({ pack: "runner", argv: ["example-cli"] })).rejects.toMatchObject({
      kind: "unavailable",
      code: "sandbox_unavailable",
      message: expect.stringContaining("no user namespaces"),
    });
  });

  it("passes the executor's own refusals on, and treats a non-result answer as a refusal", async () => {
    const f = await fakeExecutor((b) =>
      (b as { argv: string[] }).argv[1] === "busy"
        ? { status: 429, body: { error: { code: "busy", message: "executor is at its concurrency limit (4)" } } }
        : { status: 200, body: { hello: "world" } },
    );
    const ex = new SkillExecutor({ sandbox: new LocalSandbox({ socketPath: f.socketPath }), index, log: memLog().log });
    await expect(ex.exec({ pack: "runner", argv: ["example-cli", "busy"] })).rejects.toMatchObject({ kind: "refused", code: "busy" });
    await expect(ex.exec({ pack: "runner", argv: ["example-cli"] })).rejects.toMatchObject({ kind: "refused", code: "invalid_response" });
  });

  it("gives up on an executor that does not answer within timeoutSec plus the grace", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nt-exec-"));
    const socketPath = path.join(dir, "exec.sock");
    const server = createServer(() => {});
    await new Promise<void>((r) => server.listen(socketPath, r));
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    });
    const quick = new SkillPackIndex(new Map([["runner", pack("runner", { ...spec, limits: { timeoutSec: 0.05 } })]]));
    const ex = new SkillExecutor({ sandbox: new LocalSandbox({ socketPath, graceMs: 50 }), index: quick, log: memLog().log });
    await expect(ex.exec({ pack: "runner", argv: ["example-cli"] })).rejects.toMatchObject({ kind: "unavailable", message: expect.stringContaining("no answer") });
  });

  it("reads /healthz", async () => {
    const f = await fakeExecutor(() => ({ status: 200, body: { exec: { available: true, mode: "procfs=on, disable-userns=on" } } }));
    await expect(new LocalSandbox({ socketPath: f.socketPath }).health()).resolves.toMatchObject({ exec: { available: true } });
    expect(f.bodies[0]).toMatchObject({ method: "GET", url: "/healthz" });
  });
});

describe("run_skill_command in an agent run", () => {
  async function run(ex: SkillExecutor, args: Record<string, unknown>) {
    const cfg = loadConfig({ SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y", LLM_MODEL: "m" });
    const stream = scripted([callTool(EXEC_TOOL, args as never), say("done")]);
    const runner = new PiAgentRunner({
      gateway: createGateway(cfg),
      index,
      botName: "moose",
      entries: {},
      tools: [skillExecTool(ex, index, 200)],
      guard: (call) => (call.name === EXEC_TOOL ? ex.check(call.args) : { ok: true }),
      firstTokenTimeoutMs: 1000,
      maxRetries: 0,
      charsPerToken: 4,
      streamFn: stream,
    });
    const ctx: RunContext = {
      runId: "r1",
      signal: new AbortController().signal,
      budget: { maxSteps: 5, softDeadline: Number.MAX_SAFE_INTEGER, maxInputTokens: 100_000 },
      observer: {},
    };
    await runner.run({ source: "o2", sessionId: "s1", question: "q" }, ctx);
    return { tools: stream.calls[0]!.context, seen: transcriptText(stream.calls[1]!.context) };
  }

  it("runs a declared command; the output reaches the model redacted", async () => {
    const f = await fakeExecutor((b) => ({ status: 200, body: okResult((b as { id: string }).id) }));
    const ex = new SkillExecutor({ sandbox: new LocalSandbox({ socketPath: f.socketPath }), index, log: memLog().log });
    const { seen } = await run(ex, { pack: "runner", argv: ["example-cli", "items", "list"] });
    expect(f.bodies).toHaveLength(1);
    expect(seen).toContain("[exit code 0]");
    expect(seen).toContain("items: 3 token=[REDACTED]");
    expect(seen).not.toContain("supersecretvalue123");
  });

  it("the tool guard refuses an undeclared command before it reaches the executor", async () => {
    const f = await fakeExecutor((b) => ({ status: 200, body: okResult((b as { id: string }).id) }));
    const ex = new SkillExecutor({ sandbox: new LocalSandbox({ socketPath: f.socketPath }), index, log: memLog().log });
    const { seen } = await run(ex, { pack: "reader", argv: ["example-cli"] });
    expect(f.bodies).toEqual([]);
    expect(seen).toContain("Not allowed: skill pack reader declares no sandbox");
  });

  it("tells the model when the sandbox is unavailable", async () => {
    const ex = new SkillExecutor({ sandbox: new LocalSandbox({ socketPath: "/nonexistent/exec.sock" }), index, log: memLog().log });
    const { seen } = await run(ex, { pack: "runner", argv: ["example-cli"] });
    expect(seen).toContain("the execution sandbox is unavailable");
  });
});

describe("no direct execution path", () => {
  it("nothing under src/ can spawn a process", () => {
    const root = path.join(import.meta.dirname, "..", "src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = path.join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    const spawning = files.filter((f) => /\bchild_process\b|\bnode:worker_threads\b|\bprocess\.binding\b/.test(readFileSync(f, "utf8")));
    expect(spawning).toEqual([]);
  });
});
