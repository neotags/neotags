import { parseArgs } from "node:util";
import { pino, type Logger } from "pino";
import { ROUTINE_NAME } from "../config/routines.js";
import { setTimeout as realSleep } from "node:timers/promises";
import { parsePeriod, periodFromJobName } from "./schedule.js";

// `fire <routine>`: what a routine's CronJob runs (docs/design/003-internal-run-api.md §6). It only submits the period
// to the bot and waits for its outcome; the bot holds the lease and does the work, so this process can be replaced
// at any time (evicted, retried by the Job) without losing anything. The Job's outcome is the period's:
//   0  delivered
//   1  failed, the bot unreachable for 5 minutes, or no outcome by the period's deadline (5 minutes after it)
//   2  a configuration or usage error, which a retry would not fix (the CronJob's podFailurePolicy fails the Job)

export const EXIT_DELIVERED = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** Between status checks. */
const POLL_MS = 30_000;
/** Every request is short: a dropped connection costs one poll, not the wait. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Submit retries back off from 5 s to 30 s: during a rollout a request can land on the Pod that is draining. */
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 30_000;
/** The bot unreachable (connection errors, 5xx) this long in a row: give up. */
const UNREACHABLE_MS = 5 * 60_000;
/** No record of the period this long after submitting: submit again (the first submit may not have arrived). */
const NOT_FOUND_RESUBMIT_MS = 2 * 60_000;
/** How long past the period's deadline the bot gets to mark it failed. */
const DEADLINE_GRACE_MS = 5 * 60_000;
/** Until the bot reports the period's deadline: the hour it gives a period, plus the grace. */
const UNKNOWN_DEADLINE_MS = 65 * 60_000;

export interface FireOptions {
  routine: string;
  period: string;
  dryRun: boolean;
  /** Run the period again even past its deadline (resets it). By hand only; only on the first submit. */
  force: boolean;
  /** The bot's internal API, e.g. http://neotags.bots:3001. */
  url: string;
  key: string;
}

export interface FireDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: Pick<Logger, "info" | "warn" | "error">;
}

/** What the bot reports for a period (GET .../periods/{period}). */
interface PeriodStatus {
  state?: string;
  step?: string;
  updatedAt?: string;
  deadlineAt?: string;
  reason?: string;
}

type Reply = { ok: true; status: number; body: unknown } | { ok: false; why: string };

class Exit extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
  }
}

/** Submit the period and wait for its outcome; returns the exit code. */
export async function fire(o: FireOptions, d: FireDeps): Promise<number> {
  const base = `${o.url.replace(/\/+$/, "")}/internal/v1/routines/${o.routine}`;
  const fields = { routine: o.routine, period: o.period, dryRun: o.dryRun };
  const started = d.now();
  /** Since when every request failed to reach the bot; undefined after any answer. */
  let downSince: number | undefined;
  let deadline: number | undefined;

  async function call(method: "GET" | "POST", url: string, body?: unknown): Promise<Reply> {
    let res: Response;
    try {
      res = await d.fetch(url, {
        method,
        headers: { authorization: `Bearer ${o.key}`, ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      return down((err as Error).message || String(err));
    }
    const text = await res.text().catch(() => "");
    // 503 (shutting down, busy), other 5xx, and a gateway's 408 or 429: the bot, not the request, is the problem.
    if (res.status >= 500 || res.status === 408 || res.status === 429) return down(`HTTP ${res.status} ${errorText(text)}`);
    downSince = undefined;
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { ok: true, status: res.status, body: parsed };
  }

  function down(why: string): Reply {
    downSince ??= d.now();
    if (d.now() - downSince >= UNREACHABLE_MS) throw new Exit(EXIT_FAILED, `the bot was unreachable for ${UNREACHABLE_MS / 60_000} minutes: ${why}`);
    return { ok: false, why };
  }

  function checkDeadline(): void {
    const by = (deadline ?? started + UNKNOWN_DEADLINE_MS - DEADLINE_GRACE_MS) + DEADLINE_GRACE_MS;
    if (d.now() > by) throw new Exit(EXIT_FAILED, `no outcome by ${new Date(by).toISOString()}, ${DEADLINE_GRACE_MS / 60_000} minutes past the period's deadline`);
  }

  /** POST .../fire until the bot takes it: started (202), already over (200) or someone else's (409) all go on to polling. */
  async function submit(force: boolean): Promise<void> {
    let backoff = BACKOFF_MIN_MS;
    for (;;) {
      const r = await call("POST", `${base}/fire`, { period: o.period, dryRun: o.dryRun, ...(force && { force: true }) });
      if (r.ok) {
        if (r.status === 200 || r.status === 202 || r.status === 409) {
          d.log.info({ ...fields, status: r.status, ...(isObject(r.body) && typeof r.body.state === "string" && { state: r.body.state }) }, "period submitted");
          return;
        }
        throw new Exit(EXIT_USAGE, `the bot refused the period: HTTP ${r.status} ${errorText(r.body)}`);
      }
      d.log.warn({ ...fields, error: r.why, retryInMs: backoff }, "submit failed; retrying");
      checkDeadline();
      await d.sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }

  try {
    await submit(o.force);
    let notFoundSince: number | undefined;
    for (let first = true; ; first = false) {
      if (!first) await d.sleep(POLL_MS);
      checkDeadline();
      const r = await call("GET", `${base}/periods/${encodeURIComponent(o.period)}?dryRun=${o.dryRun}`);
      if (!r.ok) {
        d.log.warn({ ...fields, error: r.why }, "status check failed");
        continue;
      }
      if (r.status === 404) {
        // Taken by another fire that has not written the record yet, or our submit never arrived: wait, then submit again.
        notFoundSince ??= d.now();
        d.log.info({ ...fields, state: "not_found" }, "period status");
        if (d.now() - notFoundSince >= NOT_FOUND_RESUBMIT_MS) {
          notFoundSince = undefined;
          await submit(false);
        }
        continue;
      }
      notFoundSince = undefined;
      if (r.status !== 200 || !isObject(r.body)) throw new Exit(EXIT_USAGE, `status check refused: HTTP ${r.status} ${errorText(r.body)}`);
      const s = r.body as PeriodStatus;
      const at = s.deadlineAt ? Date.parse(s.deadlineAt) : NaN;
      if (!Number.isNaN(at)) deadline = at;
      d.log.info({ ...fields, state: s.state, step: s.step, updatedAt: s.updatedAt, deadlineAt: s.deadlineAt, ...(s.reason && { reason: s.reason }) }, "period status");
      switch (s.state) {
        case "delivered":
          return EXIT_DELIVERED;
        case "failed":
          d.log.error({ ...fields, reason: s.reason }, "period failed");
          return EXIT_FAILED;
        case "orphaned":
          // Its holder is gone (shutdown, crash): submit again, and a live Pod takes the lease over.
          await submit(false);
          break;
        default:
          // running, stalled: the bot is on it.
          break;
      }
    }
  } catch (err) {
    if (!(err instanceof Exit)) throw err;
    d.log.error({ ...fields, exitCode: err.code }, err.message);
    return err.code;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The error message of an internal API answer, or the start of its text. */
function errorText(body: unknown): string {
  if (typeof body === "string") {
    try {
      return errorText(JSON.parse(body));
    } catch {
      return body.slice(0, 200);
    }
  }
  const e = isObject(body) && isObject(body.error) ? body.error : undefined;
  return e ? `${String(e.code)}: ${String(e.message)}`.slice(0, 500) : JSON.stringify(body ?? "").slice(0, 200);
}

const USAGE = "usage: fire <routine> [--period <RFC 3339>] [--dry-run] [--force]";

/**
 * The `fire` command line. Reads only its arguments and the env the CronJob gives it: MOOSE_URL, MOOSE_JOB_KEY and
 * JOB_NAME (the Job's name, which carries the scheduled time).
 */
export async function fireMain(argv: string[], env: NodeJS.ProcessEnv, deps: Partial<FireDeps> = {}): Promise<number> {
  const log = deps.log ?? pino({ level: env.LOG_LEVEL || "info" });
  const usage = (message: string) => {
    log.error({ exitCode: EXIT_USAGE }, `${message}; ${USAGE}`);
    return EXIT_USAGE;
  };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { period: { type: "string" }, "dry-run": { type: "boolean" }, force: { type: "boolean" } } });
  } catch (err) {
    return usage((err as Error).message);
  }
  const { values, positionals } = parsed;
  const [routine, ...extra] = positionals;
  if (!routine || extra.length) return usage("one routine name expected");
  if (!ROUTINE_NAME.test(routine)) return usage(`not a routine name: ${JSON.stringify(routine.slice(0, 64))}`);
  let period: string | undefined;
  if (values.period !== undefined) {
    period = parsePeriod(values.period);
    if (!period) return usage(`--period ${JSON.stringify(values.period)} is not an RFC 3339 time on a whole minute`);
  } else {
    period = periodFromJobName(routine, env.JOB_NAME);
    if (!period) return usage(`no period: JOB_NAME (${JSON.stringify(env.JOB_NAME ?? "")}) is not <routine>-<minutes>, as the CronJob names its Jobs; give --period`);
  }
  if (!env.MOOSE_URL) return usage("MOOSE_URL is not set");
  if (!env.MOOSE_JOB_KEY) return usage("MOOSE_JOB_KEY is not set");
  return fire(
    { routine, period, dryRun: values["dry-run"] ?? false, force: values.force ?? false, url: env.MOOSE_URL, key: env.MOOSE_JOB_KEY },
    { fetch: deps.fetch ?? fetch, now: deps.now ?? Date.now, sleep: deps.sleep ?? ((ms) => realSleep(ms).then(() => {})), log },
  );
}
