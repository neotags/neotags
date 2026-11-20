import { z } from "zod";
import { scheduleError, timeZoneError } from "../routines/schedule.js";

/**
 * A routine name, which is also its CronJob's name: the Job controller appends `-<minutes>` (8+ digits) and a Job
 * name is at most 63 characters.
 */
export const ROUTINE_NAME = /^[a-z][a-z0-9-]{0,51}$/;

// Objects here are strict: a misspelt key (`enable: false`, `schedul:`) must fail at startup, not be dropped and leave
// the routine running with a default.

const trigger = z
  .object({
    // Kubernetes CronJob syntax, 5 fields; cron-parser reads it for the periods.
    schedule: z.string().superRefine((s, ctx) => {
      const why = scheduleError(s);
      if (why) ctx.addIssue({ code: "custom", message: `schedule "${s}": ${why}` });
    }),
    // IANA name; the CronJob's timeZone, and the zone the periods are checked in.
    timeZone: z.string().superRefine((tz, ctx) => {
      const why = timeZoneError(tz);
      if (why) ctx.addIssue({ code: "custom", message: `timeZone "${tz}": ${why}` });
    }),
  })
  .strict();

const slackTarget = z
  .object({
    channel: z.string().min(1),
    lang: z.enum(["zh", "en"]),
    // Who to mention with the post, e.g. <!subteam^S0123>.
    mention: z.string().min(1).optional(),
    // Which part of the report; `all` is the whole of it, other names are the routine type's own.
    section: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).default("all"),
  })
  .strict();

const delivery = z
  .object({
    // when_findings: no post when the result says there is nothing to report.
    notify: z.enum(["always", "when_findings"]).default("always"),
    slack: z.array(slackTarget).default([]),
    // The page goes under `parent` (a page or folder id) in `space`; the Outbox checks the parent is in it.
    confluence: z.object({ space: z.string().min(1), parent: z.string().min(1), monthlyFolder: z.boolean().default(false) }).strict().optional(),
  })
  .strict()
  .refine((d) => d.slack.length > 0 || d.confluence !== undefined, "needs at least one target: slack or confluence");

const common = {
  // false: the CronJob is suspended. Validated in full either way.
  enabled: z.boolean().default(true),
  trigger,
  // Where failure notices go.
  owner: z.object({ slack: z.string().min(1) }).strict(),
  // Skill packs the routine's runs may load (and, for an agent routine, execute through when a pack declares
  // `sandbox`); a request can narrow them, never widen them.
  packs: z.array(z.string().min(1)).default([]),
  // MCP servers the routine's runs get; the others are hidden from them. Default none.
  mcp: z.array(z.string().min(1)).default([]),
  delivery,
};

const agentRoutine = z
  .object({
    kind: z.literal("agent"),
    ...common,
    // What the model is asked to do.
    instructions: z.string().min(1),
    // Facts for the run (org, window, ...).
    context: z.record(z.string(), z.unknown()).optional(),
    // Only below the defaults (agent.wallClockSec.job, agent.maxSteps).
    budget: z.object({ wallClockSec: z.number().positive().optional(), maxSteps: z.number().int().positive().optional() }).strict().optional(),
  })
  .strict();

const pipelineRoutine = z
  .object({
    kind: z.literal("pipeline"),
    ...common,
    // The routine type, declared by a step pack; it checks `params` (both when the step packs are loaded).
    type: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const routineSchema = z.discriminatedUnion("kind", [agentRoutine, pipelineRoutine]);
export type Routine = z.infer<typeof routineSchema>;

export const routinesSchema = z
  .record(z.string().regex(ROUTINE_NAME, "lowercase letters, digits and dashes, starting with a letter, at most 52"), routineSchema)
  .default({});

/** Where routines may deliver, and where everything goes on a dry run. */
export const outboxSchema = z
  .object({
    slack: z
      .object({
        // Channel ids routines may post to (delivery.slack, owner.slack).
        allowedChannels: z.array(z.string().min(1)).default([]),
        // Every Slack target is this on a dry run; one of allowedChannels.
        testChannel: z.string().min(1).optional(),
      })
      .strict()
      .prefault({}),
    // Email and API token: CONFLUENCE_EMAIL and CONFLUENCE_WRITE_TOKEN in the Secret.
    confluence: z
      .object({
        baseUrl: z.url(),
        // Space keys routines may write pages in.
        allowedSpaces: z.array(z.string().min(1)).default([]),
        // The parent of every page on a dry run; unset: a dry run skips Confluence.
        testParent: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .prefault({});

type Issue = { path: (string | number)[]; message: string };

/** What the routines refer to that the rest of the configuration does not allow. */
export function routineIssues(cfg: {
  routines: Record<string, Routine>;
  outbox: z.infer<typeof outboxSchema>;
  skillPacks: { packs: string[] };
  mcp: { servers: { name: string }[] };
  agent: { maxSteps: number; wallClockSec: { job: number } };
  jobsApi: { enabled: boolean };
}): Issue[] {
  const issues: Issue[] = [];
  const routines = Object.entries(cfg.routines);
  if (routines.length === 0) return issues;
  const { slack, confluence } = cfg.outbox;
  const channels = new Set(slack.allowedChannels);
  const servers = new Set(cfg.mcp.servers.map((s) => s.name));
  // The CronJobs call the internal API; without it every firing fails.
  if (!cfg.jobsApi.enabled) issues.push({ path: ["jobsApi", "enabled"], message: "routines are configured but jobsApi is not enabled: their CronJobs call it" });
  if (slack.testChannel === undefined) issues.push({ path: ["outbox", "slack", "testChannel"], message: "routines need a test channel: dry runs post there" });
  else if (!channels.has(slack.testChannel)) issues.push({ path: ["outbox", "slack", "testChannel"], message: `channel ${slack.testChannel} is not in outbox.slack.allowedChannels` });
  for (const [name, r] of routines) {
    const at = (...p: (string | number)[]) => ["routines", name, ...p];
    r.packs.forEach((p, i) => {
      if (!cfg.skillPacks.packs.includes(p)) issues.push({ path: at("packs", i), message: `skill pack "${p}" is not in skillPacks.packs` });
    });
    r.mcp.forEach((s, i) => {
      if (!servers.has(s)) issues.push({ path: at("mcp", i), message: `MCP server "${s}" is not in mcp.servers` });
    });
    if (!channels.has(r.owner.slack)) issues.push({ path: at("owner", "slack"), message: `channel ${r.owner.slack} is not in outbox.slack.allowedChannels` });
    r.delivery.slack.forEach((t, i) => {
      if (!channels.has(t.channel)) issues.push({ path: at("delivery", "slack", i, "channel"), message: `channel ${t.channel} is not in outbox.slack.allowedChannels` });
    });
    const page = r.delivery.confluence;
    if (page && !confluence) issues.push({ path: at("delivery", "confluence"), message: "Confluence delivery needs outbox.confluence" });
    else if (page && !confluence!.allowedSpaces.includes(page.space)) {
      issues.push({ path: at("delivery", "confluence", "space"), message: `space ${page.space} is not in outbox.confluence.allowedSpaces` });
    }
    if (r.kind === "agent" && r.budget) {
      const { wallClockSec, maxSteps } = r.budget;
      if (wallClockSec !== undefined && wallClockSec > cfg.agent.wallClockSec.job) {
        issues.push({ path: at("budget", "wallClockSec"), message: `may not exceed agent.wallClockSec.job (${cfg.agent.wallClockSec.job})` });
      }
      if (maxSteps !== undefined && maxSteps > cfg.agent.maxSteps) issues.push({ path: at("budget", "maxSteps"), message: `may not exceed agent.maxSteps (${cfg.agent.maxSteps})` });
    }
  }
  return issues;
}

/**
 * A pipeline routine's packs are those of its classify run, which reads untrusted alert data: none of them may be
 * able to execute anything (declare `sandbox`). Checked once the packs are loaded; returns the problems found.
 */
export function routinePackIssues(routines: Record<string, Routine>, canExecute: (pack: string) => boolean): string[] {
  return Object.entries(routines).flatMap(([name, r]) =>
    r.kind === "pipeline"
      ? r.packs.filter(canExecute).map((p) => `routines.${name}.packs: skill pack "${p}" declares sandbox; a pipeline routine's classify run may not execute anything`)
      : [],
  );
}
