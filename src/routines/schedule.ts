import { CronExpressionParser } from "cron-parser";

// Schedules and periods of routines. A routine's CronJob fires on `trigger.schedule` in `trigger.timeZone`; each
// firing is one period, named by its scheduled time in UTC (RFC 3339, to the minute).

/** A period: the scheduled time, RFC 3339 in UTC, to the minute. */
export const PERIOD = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;
/** How far back a period may be: a weekly routine that failed can still be run again for its last period. */
export const MAX_PERIOD_AGE_MS = 8 * 86_400_000;
/** Clock skew between the node that started the Job and this one. */
const FUTURE_SKEW_MS = 5 * 60_000;

/** Month and weekday names, the only letters a CronJob schedule takes (in fields 4 and 5). */
const NAMES = /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|SUN|MON|TUE|WED|THU|FRI|SAT)$/i;

/**
 * Why `expr` is not a schedule a Kubernetes CronJob takes, or undefined: five fields (minute, hour, day of month,
 * month, day of week) of numbers, `*`, `?`, lists, ranges and steps, with month and weekday names. cron-parser also
 * reads seconds, `@` macros and the `L`, `W`, `#`, `H` extensions, which a CronJob refuses or reads differently.
 */
export function scheduleError(expr: string): string | undefined {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return `has ${fields.length} fields; a CronJob schedule has 5 (minute hour day-of-month month day-of-week), without seconds or @ macros`;
  for (const [i, field] of fields.entries()) {
    const plain = i >= 3 ? field.replace(/[A-Za-z]+/g, (w) => (NAMES.test(w) ? "0" : w)) : field;
    if (!/^[\d*?,/-]+$/.test(plain)) return `field ${i + 1} (${JSON.stringify(field)}) is not CronJob syntax: digits, * ? , - / and month or weekday names only`;
  }
  try {
    CronExpressionParser.parse(fields.join(" "), { tz: "UTC" });
  } catch (err) {
    return (err as Error).message;
  }
  return undefined;
}

/** Why `tz` is not an IANA time zone name (what a CronJob's `timeZone` takes), or undefined. */
export function timeZoneError(tz: string): string | undefined {
  // Intl also takes offsets ("+08:00"); a CronJob only takes names from the tz database.
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return "not an IANA time zone name, e.g. Asia/Shanghai or UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return "not an IANA time zone name, e.g. Asia/Shanghai or UTC";
  }
  return undefined;
}

/** The period of an instant: UTC, to the minute. */
export function formatPeriod(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16)}:00Z`;
}

/**
 * The period a CronJob's Job is for. The CronJob controller names each Job `<CronJob name>-<scheduled time in
 * minutes since the epoch>`; a Job made by hand (`kubectl create job --from=cronjob/...`) has a name of its own, and
 * then there is no period to read from it.
 */
export function periodFromJobName(routine: string, jobName: string | undefined): string | undefined {
  if (!jobName?.startsWith(`${routine}-`)) return undefined;
  const suffix = jobName.slice(routine.length + 1);
  if (!/^\d{8,}$/.test(suffix)) return undefined;
  return formatPeriod(Number(suffix) * 60_000);
}

/** An RFC 3339 time (any offset) as a period, or undefined when it is not one or not on a whole minute. */
export function parsePeriod(s: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m) return undefined;
  const ms = Date.parse(s.toUpperCase());
  if (Number.isNaN(ms) || ms % 60_000 !== 0) return undefined;
  // Date.parse rolls 2026-02-30 over to March: the date must be the one written.
  const [, y, mo, d, h, mi] = m.map(Number) as number[];
  const written = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!));
  if (written.getUTCMonth() !== mo! - 1 || written.getUTCDate() !== d! || h! > 23 || mi! > 59) return undefined;
  return formatPeriod(ms);
}

const wallClockFormats = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock time of `ms` in `tz`, as if it were UTC. */
function wallClock(ms: number, tz: string): number {
  let f = wallClockFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    wallClockFormats.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
}

/**
 * Is `period` a time the schedule fires at in `tz`? Matched on the wall clock, as the CronJob controller does: in
 * the hour a DST change repeats, both instants with a matching wall-clock time are firings; times in the hour it
 * skips never occur, so no period names them.
 */
export function isScheduled(schedule: string, tz: string, period: string): boolean {
  const wall = wallClock(Date.parse(period), tz);
  const next = CronExpressionParser.parse(schedule, { tz: "UTC", currentDate: new Date(wall - 1000) }).next();
  return next.getTime() === wall;
}

/** Why `period` cannot be run for this trigger now, or undefined: it must be a firing of the last 8 days. */
export function periodError(trigger: { schedule: string; timeZone: string }, period: string, now = Date.now()): string | undefined {
  if (!PERIOD.test(period)) return "not a period: RFC 3339 in UTC to the minute, e.g. 2026-11-18T01:00:00Z";
  const ms = Date.parse(period);
  if (Number.isNaN(ms)) return "not a valid time";
  if (ms > now + FUTURE_SKEW_MS) return "in the future";
  if (ms < now - MAX_PERIOD_AGE_MS) return "more than 8 days ago";
  if (!isScheduled(trigger.schedule, trigger.timeZone, period)) return `not a time "${trigger.schedule}" fires at in ${trigger.timeZone}`;
  return undefined;
}
