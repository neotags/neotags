import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";
import { z } from "zod";
import { ROUTINE_NAME, type JobCaller } from "../config/index.js";
import { PERIOD } from "../routines/schedule.js";
import { FireError, type Routines } from "../routines/period.js";
import { JobRequestError, type JobRunner } from "../runs/job.js";
import { decoded, header, HttpError, keyMatches, readBody, sendJson, TRACEPARENT, type Route } from "./http.js";

// The internal API (docs/design/003-internal-run-api.md): in-cluster callers with their own Bearer keys
// (jobsApi.callers), under /internal/v1/ on the port the O2 gateway uses. Nothing of the O2 gateway's applies here:
// the O2 key is not one of these keys, and these keys are not O2's.

/** The body: `input` (200k characters) plus the schema and a margin for JSON escaping. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** `source` and anything else not listed is dropped: the run's source is the caller whose key matched. */
const RunRequest = z.object({
  routine: z.string().regex(ROUTINE_NAME, "a routine name"),
  period: z.string().regex(PERIOD, "RFC 3339 UTC to the minute, e.g. 2026-11-18T01:00:00Z"),
  packs: z.array(z.string().min(1)).optional(),
  input: z.unknown(),
  outputSchema: z.record(z.string(), z.unknown()),
  budget: z.object({ wallClockSec: z.number().positive().optional(), maxSteps: z.number().int().positive().optional() }).optional(),
});

/** POST .../fire: the period is checked against the routine's schedule by the routines, with the reason in the 400. */
const FireRequest = z.object({ period: z.string().min(1), dryRun: z.boolean().optional(), force: z.boolean().optional() });

const ROUTINE_PATH = /^\/internal\/v1\/routines\/([^/]+)\/(fire|periods\/([^/]+))$/;

export interface InternalApiOptions {
  /** Bearer key per caller (secrets.jobKeys). */
  keys: Partial<Record<JobCaller, string>>;
  jobs: Pick<JobRunner, "runJob">;
  /** The routines' periods (fire, status); absent: those routes are 404. */
  routines?: Pick<Routines, "fire" | "status">;
  log: Pick<Logger, "info" | "warn" | "error">;
}

/** When to submit again after a 503: another Pod takes over within seconds of a shutdown; a busy slot takes longer. */
const RETRY_AFTER_SEC: Record<string, number> = { shutting_down: 5, busy: 60 };

function sendError(res: ServerResponse, e: HttpError): void {
  if (res.headersSent) return void res.end();
  const retry = e.retryAfterSec ?? RETRY_AFTER_SEC[e.code];
  res.writeHead(e.status, { "content-type": "application/json", ...(retry !== undefined && e.status === 503 && { "retry-after": String(retry) }) });
  res.end(JSON.stringify({ error: { code: e.code, message: e.message } }));
}

/** `/internal/` on the shared port server: `POST /internal/v1/runs`; anything else under it is 404 in this API's shape. */
export function createInternalApi(o: InternalApiOptions): { route: Route } {
  const { log } = o;
  const keys = Object.entries(o.keys).filter((e): e is [JobCaller, string] => typeof e[1] === "string" && e[1].length > 0);

  /** The caller whose key the request carries. Every key is compared, so the time does not tell which matched. */
  function caller(req: IncomingMessage): JobCaller | undefined {
    // The scheme is case-insensitive (RFC 9110).
    const m = /^bearer\s+(\S+)\s*$/i.exec(header(req, "authorization") ?? "");
    let found: JobCaller | undefined;
    for (const [name, key] of keys) if (keyMatches(m?.[1], key) && !found) found = name;
    return found;
  }

  async function runs(req: IncomingMessage, res: ServerResponse, source: JobCaller): Promise<void> {
    const parsed = RunRequest.safeParse(await readBody(req, MAX_BODY_BYTES, 413));
    if (!parsed.success) throw new HttpError(400, "bad_request", z.prettifyError(parsed.error));
    const body = parsed.data;
    const traceparent = header(req, "traceparent")?.trim().toLowerCase();
    // Nobody reads the result of a request whose caller went away: its run is cancelled.
    const gone = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded) gone.abort();
    });
    try {
      const result = await o.jobs.runJob(
        { routine: body.routine, period: body.period, input: body.input, outputSchema: body.outputSchema, ...(body.packs && { packs: body.packs }), ...(body.budget && { budget: body.budget }) },
        { caller: source, signal: gone.signal, ...(traceparent && TRACEPARENT.test(traceparent) && { traceparent }) },
      );
      log.info({ routine: body.routine, period: body.period, source, runId: result.runId, state: result.state, degraded: result.degraded }, "internal run finished");
      if (res.destroyed) return;
      sendJson(res, { runId: result.runId ?? null, traceId: result.traceId ?? null, state: result.state, output: result.output, degraded: result.degraded, ...(result.reason && { reason: result.reason }) });
    } catch (err) {
      if (err instanceof JobRequestError) throw new HttpError(err.status, err.code, err.message);
      throw err;
    }
  }

  /** POST .../fire answers once the period is taken (202) or already over (200); the period runs in the background. */
  async function firePeriod(req: IncomingMessage, res: ServerResponse, name: string, source: JobCaller): Promise<void> {
    const parsed = FireRequest.safeParse(await readBody(req, 64 * 1024, 413));
    if (!parsed.success) throw new HttpError(400, "bad_request", z.prettifyError(parsed.error));
    const answer = await o.routines!.fire(name, parsed.data, source);
    log.info({ routine: name, period: parsed.data.period, dryRun: parsed.data.dryRun ?? false, source, status: answer.status, ...("state" in answer.body && { state: answer.body.state }) }, "period submitted");
    sendJson(res, answer.body, answer.status);
  }

  async function periodStatus(req: IncomingMessage, res: ServerResponse, name: string, period: string): Promise<void> {
    const q = new URL(req.url ?? "/", "http://internal").searchParams.get("dryRun");
    if (q !== null && q !== "true" && q !== "false") throw new HttpError(400, "bad_request", "dryRun is true or false");
    const s = await o.routines!.status(name, period, q === "true");
    if (!s) throw new HttpError(404, "not_found", `no record of period ${period}`);
    sendJson(res, s);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0]!;
    const source = caller(req);
    if (!source) throw new HttpError(401, "unauthorized", "missing or wrong Authorization: Bearer key");
    if (path === "/internal/v1/runs") {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");
      return runs(req, res, source);
    }
    const m = ROUTINE_PATH.exec(path);
    if (m && o.routines) {
      const name = decoded(m[1]!);
      try {
        if (m[2] === "fire") {
          if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");
          return await firePeriod(req, res, name, source);
        }
        if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
        return await periodStatus(req, res, name, decoded(m[3]!));
      } catch (err) {
        if (err instanceof FireError) throw new HttpError(err.status, err.code, err.message);
        throw err;
      }
    }
    throw new HttpError(404, "not_found", "not found");
  }

  const route: Route = (req, res) =>
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) return sendError(res, err);
      if (res.destroyed || req.destroyed) return;
      log.error({ err }, "internal api request failed");
      sendError(res, new HttpError(500, "internal_error", "internal error"));
    });

  return { route };
}
