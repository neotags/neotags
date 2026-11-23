import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, str } from "@earendil-works/pi-schema";
import { parse } from "yaml";
import { z } from "zod";

// Headers the executor never injects a credential into.
const HOP_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "keep-alive", "te", "trailer", "upgrade", "proxy-authorization", "proxy-connection"]);

// What a pack may run in the execution sandbox (§13 of the design). Parsed here, enforced by the tool guard. The
// rules are the executor's (executor/executor/policy.py), so a declaration it would refuse fails here, at load time.
// A host name (or an IP literal, IPv6 in brackets), as the executor's normalize_host and _valid_host read it.
const HOST = /^(?:(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*|\[[0-9a-f:.]+\])$/;
const normHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, "");
const validHost = (h: string) => HOST.test(h) && h.length <= 253 && h !== "localhost" && !h.endsWith(".localhost");

/** A `net` entry: one host, optionally with a port in 1..65535; no wildcards, paths, userinfo or spaces. */
function netEntry(entry: string): { host: string; port?: number } | undefined {
  const e = normHost(entry);
  // A bare IPv6 literal (more than one colon, no brackets) has no port, as in the executor's split_host_port.
  if (!e.startsWith("[") && e.split(":").length > 2) return /^[0-9a-f:.]+$/.test(e) ? { host: e } : undefined;
  const m = /^(.*?)(?::(\d+))?$/.exec(e);
  if (!m || !validHost(m[1]!)) return undefined;
  if (m[2] === undefined) return { host: m[1]! };
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 ? { host: m[1]!, port } : undefined;
}
const bare = (h: string) => h.replace(/^\[|\]$/g, "");

const sandboxSchema = z.object({
  net: z
    .array(z.string().refine((e) => netEntry(e) !== undefined, "a single host name (not localhost), optionally with a port in 1..65535"))
    .max(16)
    .default([]),
  // Bare command names: the executor looks them up on its PATH.
  tools: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, "a bare command name")).default([]),
  credentials: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "an upper-case env var name"),
        hosts: z.array(z.string().min(1)).min(1),
        header: z
          .string()
          .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/, "a header name")
          .refine((h) => !HOP_HEADERS.has(h.toLowerCase()), "not a header a credential may go into"),
      }),
    )
    .max(8)
    .default([]),
  limits: z
    .object({
      // Average cores over the timeout: a number (or "0.5"), not "500m".
      cpu: z
        .union([z.number(), z.string().regex(/^\d+(\.\d+)?$/, "a number of cores, not 500m")])
        .refine((c) => Number(c) > 0, "more than 0")
        .optional(),
      // MiB, or "512Mi" / "1Gi"; the executor's floor is 16 MiB.
      mem: z
        .union([z.number().int(), z.string().regex(/^\d+(Mi|Gi)$/, "like 512Mi")])
        .refine((m) => (typeof m === "number" ? m : Number.parseInt(m, 10) * (m.endsWith("Gi") ? 1024 : 1)) >= 16, "at least 16Mi")
        .optional(),
      timeoutSec: z.number().positive().optional(),
    })
    .optional(),
}).superRefine((s, ctx) => {
  // The executor's own cross-field rules; its upper limits (cpu, mem, timeoutSec) are its configuration and are
  // checked there.
  const hosts = new Set(s.net.map((e) => bare(netEntry(e)?.host ?? "")));
  const names = new Set<string>();
  s.credentials.forEach((c, i) => {
    if (names.has(c.name)) ctx.addIssue({ code: "custom", path: ["credentials", i, "name"], message: `duplicate credential ${c.name}` });
    names.add(c.name);
    for (const h of c.hosts) {
      // A host without a port: the executor matches credential hosts against net hosts, ports aside.
      if (!hosts.has(bare(normHost(h)))) ctx.addIssue({ code: "custom", path: ["credentials", i, "hosts"], message: `host ${h} is not a host (without port) in net` });
    }
  });
});
export type SandboxSpec = z.infer<typeof sandboxSchema>;

const budgetSchema = z.object({ wallClockSec: z.number().positive().optional(), maxSteps: z.number().int().positive().optional() }).strict();

// A routine type (S-D22, S-D23): the deterministic steps the pipeline engine runs in the sandbox under the pack's own
// `sandbox` declaration, and where the one model step (the classify run) goes between them. Never offered to a model.
const pipelineSchema = z
  .object({
    type: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, "lowercase letters, digits and dashes"),
    // JSON Schema of routines.<name>.params, a file of this pack (e.g. references/params.schema.json).
    params: z.string().min(1).optional(),
    steps: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "lowercase letters, digits and dashes"),
            argv: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
    classify: z
      .object({
        // The step whose output (`classifyInput`) the classify run reads.
        after: z.string().min(1),
        // `<pack>/<file>`: a file under another loaded pack's references/, read by name.
        outputSchema: z.string().regex(/^[^/]+\/references\/[^/].*$/, "<pack>/references/<file>"),
        budget: budgetSchema.optional(),
      })
      .strict()
      .optional(),
    // The step the engine goes on with, with problems: null, when the classify run fails or is degraded.
    degrade: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const names = p.steps.map((s) => s.name);
    names.forEach((n, i) => {
      if (names.indexOf(n) !== i) ctx.addIssue({ code: "custom", path: ["steps", i, "name"], message: `duplicate step ${n}` });
    });
    const after = p.classify ? names.indexOf(p.classify.after) : -1;
    if (p.classify && after < 0) ctx.addIssue({ code: "custom", path: ["classify", "after"], message: `${p.classify.after} is not a step` });
    if (p.classify && after === names.length - 1) ctx.addIssue({ code: "custom", path: ["classify", "after"], message: "a step must follow the classify run, to render its result" });
    if (p.degrade !== undefined) {
      if (!p.classify) ctx.addIssue({ code: "custom", path: ["degrade"], message: "degrade needs classify" });
      else if (names.indexOf(p.degrade) <= after) ctx.addIssue({ code: "custom", path: ["degrade"], message: `${p.degrade} is not a step after ${p.classify.after}` });
    }
  });
export type PipelineSpec = z.infer<typeof pipelineSchema> & {
  /** The `params` file, parsed. */
  paramsSchema?: Record<string, unknown>;
};

export interface SkillPack {
  name: string;
  description: string;
  /** SKILL.md without its front matter; absent when only some reference files of the pack are mounted. */
  body?: string;
  /** Reference files by path relative to the pack's references/. */
  refs: ReadonlyMap<string, string>;
  /** Front matter `sandbox`; a pack without one may not execute anything. */
  sandbox?: SandboxSpec;
  /** Front matter `metadata.version`. */
  version?: string;
  /**
   * Front matter `pipeline`: a step pack, whose commands only the pipeline engine runs (never `run_skill_command`),
   * under its `sandbox` declaration.
   */
  pipeline?: PipelineSpec;
}

/** Loaded packs. Reads come from this in-memory index only, so a model-chosen path never reaches the filesystem. */
export class SkillPackIndex {
  constructor(private packs: ReadonlyMap<string, SkillPack> = new Map()) {}

  list(): SkillPack[] {
    return [...this.packs.values()];
  }

  get(name: string): SkillPack | undefined {
    return this.packs.get(name);
  }

  skill(name: string): string | undefined {
    return this.packs.get(name)?.body;
  }

  ref(name: string, file: string): string | undefined {
    return this.packs.get(name)?.refs.get(file);
  }
}

export interface SkillPackOptions {
  dir: string;
  /** Whole packs: SKILL.md plus every file under references/. */
  packs: string[];
  /** Only these reference files (relative to references/) of each pack. */
  refs: Record<string, string[]>;
  maxFileBytes: number;
}

const TEXT_FILE = /\.(md|markdown|txt|json|ya?ml|csv)$/i;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A plain relative path inside the pack: no "..", no absolute path, no hidden segment. */
function cleanRelative(file: string): string | undefined {
  if (file.includes("\\") || path.posix.isAbsolute(file)) return undefined;
  const norm = path.posix.normalize(file);
  if (norm !== file || norm.split("/").some((s) => s === ".." || s === "." || s.startsWith("."))) return undefined;
  return norm;
}

export function parseSkillMd(text: string): { meta: Record<string, unknown>; body: string } {
  const m = FRONT_MATTER.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = parse(m[1] ?? "") as unknown;
  return { meta: meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {}, body: text.slice(m[0].length) };
}

/**
 * Load the allowlisted packs from `dir`. Problems (missing pack, file over the size limit, a path that escapes
 * the directory) skip that file or pack and are returned as warnings, so one bad pack does not stop the bot.
 * Symlinks are followed as long as they stay inside `dir`: Kubernetes mounts ConfigMap files as links into ..data/.
 */
export async function loadSkillPacks(o: SkillPackOptions): Promise<{ index: SkillPackIndex; warnings: string[] }> {
  const warnings: string[] = [];
  const packs = new Map<string, SkillPack>();
  let root: string;
  try {
    root = await realpath(o.dir);
  } catch (err) {
    return { index: new SkillPackIndex(), warnings: [`skill pack dir ${o.dir}: ${(err as Error).message}`] };
  }

  const read = async (rel: string): Promise<string | undefined> => {
    let real: string;
    try {
      real = await realpath(path.join(root, rel));
    } catch {
      warnings.push(`${rel}: not found`);
      return undefined;
    }
    if (!real.startsWith(root + path.sep)) {
      warnings.push(`${rel}: resolves outside the skill pack dir`);
      return undefined;
    }
    try {
      const st = await stat(real);
      if (!st.isFile()) return undefined;
      if (st.size > o.maxFileBytes) {
        warnings.push(`${rel}: ${st.size} bytes is over the ${o.maxFileBytes}-byte limit`);
        return undefined;
      }
      return await readFile(real, "utf8");
    } catch (err) {
      warnings.push(`${rel}: ${(err as Error).message}`);
      return undefined;
    }
  };

  // Every text file under <pack>/references/, recursively; hidden entries (ConfigMap ..data links) are skipped.
  const listRefs = async (pack: string, sub = ""): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(path.join(root, pack, "references", sub), { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      const isDir = e.isDirectory() || (e.isSymbolicLink() && (await stat(path.join(root, pack, "references", rel)).catch(() => undefined))?.isDirectory());
      if (isDir) out.push(...(await listRefs(pack, rel)));
      else if (TEXT_FILE.test(e.name)) out.push(rel);
    }
    return out;
  };

  const names = [...new Set([...o.packs, ...Object.keys(o.refs)])];
  for (const name of names) {
    if (!cleanRelative(name) || name.includes("/")) {
      warnings.push(`skill pack name "${name}" is not a plain directory name`);
      continue;
    }
    const whole = o.packs.includes(name);
    let description = "";
    let body: string | undefined;
    let sandbox: SandboxSpec | undefined;
    let version: string | undefined;
    let pipeline: PipelineSpec | undefined;
    if (whole) {
      const md = await read(`${name}/SKILL.md`);
      if (md === undefined) {
        warnings.push(`skill pack ${name}: no SKILL.md, skipped`);
        continue;
      }
      let parsed;
      try {
        parsed = parseSkillMd(md);
      } catch (err) {
        warnings.push(`skill pack ${name}: bad front matter (${(err as Error).message}), skipped`);
        continue;
      }
      const { meta } = parsed;
      body = parsed.body.trim();
      description = typeof meta.description === "string" ? meta.description.trim() : "";
      if (typeof meta.name === "string" && meta.name !== name) warnings.push(`skill pack ${name}: front matter name is "${meta.name}"`);
      const v = meta.metadata && typeof meta.metadata === "object" ? (meta.metadata as Record<string, unknown>).version : undefined;
      if (typeof v === "string" || typeof v === "number") version = String(v).trim() || undefined;
      // YAML has already turned 1.10 into 1.1: two releases could share a version.
      if (typeof v === "number") warnings.push(`skill pack ${name}: metadata.version ${v} is a number; quote it, or YAML drops trailing zeros (1.10 is read as 1.1)`);
      if (meta.sandbox !== undefined) {
        const s = sandboxSchema.safeParse(meta.sandbox);
        if (s.success) sandbox = s.data;
        else {
          const issues = s.error.issues.map((i) => `${["sandbox", ...i.path].join(".")}: ${i.message}`).join("; ");
          warnings.push(`skill pack ${name}: invalid sandbox declaration, ignored (the pack cannot execute anything): ${issues}`);
        }
      }
      if (meta.pipeline !== undefined) {
        // A step pack that cannot be read as declared is left out whole: half of one could end up offered to a model.
        const p = await loadPipeline(name, meta.pipeline, sandbox, read);
        if (typeof p === "string") {
          warnings.push(`skill pack ${name}: ${p}, skipped`);
          continue;
        }
        pipeline = p;
      }
    }
    const files = new Set(whole ? await listRefs(name) : []);
    for (const f of o.refs[name] ?? []) {
      if (cleanRelative(f)) files.add(f);
      else warnings.push(`skill pack ${name}: reference "${f}" is not a plain relative path`);
    }
    const refs = new Map<string, string>();
    for (const f of files) {
      const text = await read(`${name}/references/${f}`);
      if (text !== undefined) refs.set(f, text);
    }
    if (!whole && refs.size === 0) {
      warnings.push(`skill pack ${name}: none of its listed references could be read, skipped`);
      continue;
    }
    packs.set(name, { name, description, ...(body !== undefined && { body }), refs, ...(sandbox && { sandbox }), ...(version && { version }), ...(pipeline && { pipeline }) });
  }
  return { index: new SkillPackIndex(packs), warnings };
}

/** A step pack's `pipeline` declaration, checked against its `sandbox` and with its params schema read; or why not. */
async function loadPipeline(
  pack: string,
  raw: unknown,
  sandbox: SandboxSpec | undefined,
  read: (rel: string) => Promise<string | undefined>,
): Promise<PipelineSpec | string> {
  const parsed = pipelineSchema.safeParse(raw);
  if (!parsed.success) return `invalid pipeline declaration: ${parsed.error.issues.map((i) => `${["pipeline", ...i.path].join(".")}: ${i.message}`).join("; ")}`;
  const p: PipelineSpec = parsed.data;
  if (!sandbox) return "a pipeline needs a valid sandbox declaration: its steps run under it";
  for (const s of p.steps) {
    if (!sandbox.tools.includes(s.argv[0]!)) return `pipeline step ${s.name}: ${JSON.stringify(s.argv[0])} is not one of sandbox.tools`;
  }
  if (p.params !== undefined) {
    const rel = cleanRelative(p.params);
    if (!rel) return `pipeline.params ${JSON.stringify(p.params)} is not a plain relative path`;
    const text = await read(`${pack}/${rel}`);
    if (text === undefined) return `pipeline.params ${rel} could not be read`;
    let schema: unknown;
    try {
      schema = JSON.parse(text);
    } catch (err) {
      return `pipeline.params ${rel} is not JSON (${(err as Error).message})`;
    }
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return `pipeline.params ${rel} is not a JSON Schema object`;
    p.paramsSchema = schema as Record<string, unknown>;
  }
  return p;
}

/**
 * The agent version of an entry that starts with these packs: `name@version` of each, sorted by name, so only a
 * change to the packs makes a new version, not a new image. Undefined without packs.
 */
export function packsVersion(packs: readonly Pick<SkillPack, "name" | "version">[]): string | undefined {
  if (packs.length === 0) return undefined;
  return [...packs]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((p) => (p.version ? `${p.name}@${p.version}` : p.name))
    .join(",");
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/** read_skill / read_skill_ref over the loaded index. Unknown names fail with the list of what exists. */
export function skillPackTools(index: SkillPackIndex): AgentTool<any>[] {
  const withBody = () => index.list().filter((p) => p.body !== undefined).map((p) => p.name);
  const readSkillParams = obj({ name: str({ description: "Skill pack name" }) });
  const readSkill: AgentTool<typeof readSkillParams> = {
    name: "read_skill",
    label: "Read skill pack",
    description: "Read the instructions (SKILL.md) of a skill pack listed in the system prompt.",
    parameters: readSkillParams,
    executionMode: "parallel",
    execute: async (_id, { name }) => {
      const body = index.skill(name);
      if (body === undefined) throw new Error(`unknown skill pack "${name}"; available: ${withBody().join(", ") || "none"}`);
      return text(body);
    },
  };
  const readRefParams = obj({
    name: str({ description: "Skill pack name" }),
    file: str({ description: "Reference file, relative to the pack's references/" }),
  });
  const readRef: AgentTool<typeof readRefParams> = {
    name: "read_skill_ref",
    label: "Read skill pack reference",
    description: "Read one reference file of a skill pack, by the path listed in the system prompt (e.g. o2-sql.md).",
    parameters: readRefParams,
    executionMode: "parallel",
    execute: async (_id, { name, file }) => {
      const pack = index.get(name);
      if (!pack) throw new Error(`unknown skill pack "${name}"; available: ${index.list().map((p) => p.name).join(", ") || "none"}`);
      const content = pack.refs.get(file) ?? pack.refs.get(file.replace(/^references\//, ""));
      if (content === undefined) throw new Error(`no reference "${file}" in ${name}; available: ${[...pack.refs.keys()].join(", ") || "none"}`);
      return text(content);
    },
  };
  return [readSkill, readRef] as AgentTool<any>[];
}
