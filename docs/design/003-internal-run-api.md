# neotags — Design 003: Internal run API (routines)

Status: **v1** · Date: 2026-11-19

Routines are tasks neotags runs on its own, on a schedule (later on events), from configuration: `routines.<name>` names the skill packs a routine's runs may use, and later its trigger, steps and delivery targets. A Kubernetes CronJob only triggers a routine; the work, the model calls and the delivery happen in neotags. This document covers the first piece: one agent run for a routine, with a structured result, through `runJob` in process and `POST /internal/v1/runs` over HTTP. §6 adds the routines' configuration, their CronJobs and the `fire` command; the `fire` endpoint, period records, leases, the pipeline engine and delivery (the Outbox) come later and build on them.

## 1. Transport and authentication

The internal API is served under `/internal/v1/` on the in-cluster agent port (`o2Gateway.port`, 3001), next to the O2 gateway's `/o2_agent/` (`src/gateway/http.ts` routes by path prefix; anything under `/internal/` gets this API's error shape). `jobsApi.enabled` opens the port even when the O2 gateway is off.

- `Authorization: Bearer <key>`; one key per caller in `jobsApi.callers` (`{ job: { keyFromEnv: MOOSE_JOB_KEY } }`), compared in constant time. The caller whose key matched is the run's `source` (`job` today); a `source` in the body is ignored.
- Each route accepts only its own credential: `/internal/v1/*` never accepts O2's `x-o2-agent-key`, and `/o2_agent/*` never accepts a caller's Bearer key. Startup fails when a caller's key equals another caller's or O2's.
- The chart's NetworkPolicy lets in only Pods labelled `app.kubernetes.io/component: <bot name>-job` (the routines' CronJob Pods) of the release's namespace, plus `networkPolicy.jobsApi`. The keys are the second layer.
- Errors: `{"error": {"code", "message"}}` with the HTTP status.

## 2. `POST /internal/v1/runs`

Request:

```json
{
  "routine": "daily-triage",
  "period": "2026-11-18T01:00:00Z",
  "packs": ["triage"],
  "input": { "...": "..." },
  "outputSchema": { "type": "object", "properties": { "...": {} }, "required": ["..."] },
  "budget": { "wallClockSec": 600, "maxSteps": 12 }
}
```

| Field | Rule |
|---|---|
| `routine` | A name in `routines`; otherwise 403. |
| `period` | The scheduled time, RFC 3339 UTC to the minute. With the routine it is the run's session, `job:<routine>:<period>`: a retry of the same period queues behind the previous try, never beside it. |
| `packs` | Optional; a subset of the routine's `packs`, else 403. The packs decide what the run may read (its `read_skill` tools and system prompt see only them, plus reference-only packs from `skillPacks.refs`) and, for packs that declare `sandbox`, execute, so they come from configuration; a request can only narrow them. |
| `input` | Any JSON; a string as it is, anything else serialized. Over 200,000 characters: 413. In the prompt inside `<job_input>`, marked untrusted and redacted like every other untrusted block. |
| `outputSchema` | Required. A JSON Schema with `type: "object"`, read as draft 2020-12 whatever its `$schema` says; one ajv cannot compile is 400. |
| `budget` | Optional, only below the defaults (`agent.wallClockSec.job`, 900 s; `agent.maxSteps`, 30); above them is 400. |

The call waits for the run and answers 200:

```json
{ "runId": "...", "traceId": "...", "state": "done", "output": { "...": "..." }, "degraded": false }
```

- `state`: `done` (the output validated), `failed` (no valid output), `cancelled`. `output` is null unless `done`.
- `degraded: true`: every model of the `job` chain is failing (circuit breakers open). The answer comes at once, without a run (`runId: null`); retrying now would not help.
- 503 `shutting_down` while the process drains, also for a run the shutdown interrupts (submit again, to another Pod; `Retry-After: 5`); 503 `busy` when no routine slot came free within an hour (`Retry-After: 60`).
- A caller that closes the connection cancels its run.

The pipeline engine calls the same `runJob` in process; the HTTP route is for other in-cluster callers and debugging. `runJob` also takes an AbortSignal (cancels the run, or the wait for a slot) and a `traceparent`, and, from a routine's own configuration only, `instructions` (what the model is asked; without them it is asked to do the task its packs describe).

## 3. Structured output: `submit_output`

A run with an `outputSchema` gets a `submit_output` tool whose parameters are the schema, and the system prompt says the result is delivered only through it. A call is checked twice: pi checks (and coerces) the arguments against the schema, then ajv validates them (`strict: false`, with `ajv-formats`). Both read the schema as draft 2020-12, so the two checks never disagree on what it means. An invalid call is a tool error carrying the validation errors, so the model can fix them. The first valid call ends the run; its arguments are `RunResult.output`.

- One invalid call gets its retry; a second fails the run.
- When the investigation ends without a valid call, or a budget runs out (steps, time, context), the run gets one last turn whose only tool is `submit_output`, asking for the result from the evidence so far. No call there fails the run.
- The model's text is never the result. A failed structured run has `output` undefined; `runJob` reports it `failed`.

## 4. Budgets and concurrency

- `RunInput.budget` lowers the run's wall clock and steps: the RunManager and the runner use `min(configured, budget)`.
- Routine runs wait for `jobsApi.concurrency` (default 1 per process), a FIFO semaphore of their own, held for one run and released when it ends. They neither wait for nor take `agent.concurrency.total`, and are not counted against `perUserPerHour`: a routine never delays an interactive question, nor the other way round. The semaphore is shared with the rest of a routine's work (the pipeline engine's sandbox steps), which takes it per step, never across a run.
- Job runs take their model from the `job` chain (`llm.chains.job`). Breakers are per model, not per chain: when the `job` chain uses the same model as `agent`, an outage the O2 entry sees also degrades routines, and the other way round.

## 5. Traces

A job run's `invoke_agent job` span has `gen_ai.agent.name = job`, `neotags.routine.name` and `neotags.routine.period`, and is the child of the `traceparent` given to `runJob` when that is sampled (a link otherwise), so a routine's runs hang under the routine's own root span.

## 6. Routines: configuration, CronJobs and `fire`

### Configuration

`routines.<name>` (`src/config/routines.ts`; every field in `config/neotags.example.yaml`). The name is the CronJob's: lowercase letters, digits and dashes, starting with a letter, at most 52 (the Job controller appends `-<minutes>`, and a Job name is at most 63). Every routine is checked in full at startup, enabled or not, and the process refuses to start on any problem; keys are strict, so a misspelt one fails instead of being dropped.

| Field | Rule |
|---|---|
| `kind` | `agent` (one run: `instructions`, optional `context`, `budget`) or `pipeline` (a routine type's steps: `type`, `params`; both checked by the type's step pack once loaded). |
| `enabled` | Default true; false suspends the CronJob. |
| `trigger` | `schedule`: Kubernetes CronJob syntax, 5 fields (no seconds, no `@` macros, no `L`/`W`/`#`/`H`); `timeZone`: an IANA name. Both required. Later, event triggers go here too. |
| `owner.slack` | Where failure notices go; in `outbox.slack.allowedChannels`. |
| `packs` | In `skillPacks.packs`. A pipeline's packs are its classify run's, which reads untrusted data: none may declare `sandbox` (checked when the packs are loaded). |
| `mcp` | The MCP servers its runs get, in `mcp.servers`; default none. `runJob` hides every other server from the run (`RunInput.mcp.hide`), so untrusted input cannot steer a run to another org's data. |
| `budget` | agent only; `{wallClockSec, maxSteps}`, at most `agent.wallClockSec.job` and `agent.maxSteps`. |
| `delivery` | `notify` (`always` \| `when_findings`), `slack: [{channel, lang, mention?, section?}]` (channels in `outbox.slack.allowedChannels`; `section` default `all`), `confluence: {space, parent, monthlyFolder?}` (`space` in `outbox.confluence.allowedSpaces`; the Outbox checks that `parent` is in it). At least one target. |

`outbox`: `slack.allowedChannels`, `slack.testChannel` (required with routines, one of the allowed channels: every Slack target on a dry run), `confluence.{baseUrl, allowedSpaces, testParent}` (`testParent` unset: a dry run skips Confluence). Routines also need `jobsApi.enabled`.

### Periods

A period is a scheduled time in UTC, RFC 3339 to the minute (`2026-11-18T01:00:00Z`). The CronJob controller names each Job `<routine>-<scheduled time in minutes since the epoch>`; `fire` reads the period from it (`JOB_NAME`, from the Pod's `batch.kubernetes.io/job-name` label). A Job made by hand has no such suffix and needs `--period`. The bot accepts a period only when the schedule fires at it in the routine's time zone and it is at most 8 days old (`periodError`). Matching is on the wall clock, as the controller does: in the hour clocks go back both instants of a matching time are firings; in the hour they skip, nothing fires.

### CronJobs (chart)

One CronJob per routine, named after it, on the bot's image: `node dist/index.js fire <name>`. `concurrencyPolicy: Forbid`, `startingDeadlineSeconds: 600`, history 3 and 3. `backoffLimit: 1` (fire already waits and takes over within one run; the retry re-runs a failed period), `activeDeadlineSeconds: 4500` (the bot's hour per period, plus 5 minutes for a dead holder's lease to expire, plus polling), so the Job never outlives the bot's decision by being killed first. `podFailurePolicy`: exit code 2 fails the Job at once; a Pod with a `DisruptionTarget` condition (evicted, node drained) does not count against the backoff limit. The labels `app.kubernetes.io/component: <bot>-job` and `<bot>.neotags.io/routine: <name>` are on the CronJob, the Job and the Pod (the NetworkPolicy selects Pods by the first); the Pod does not carry the bot's selector labels. Its service account `<bot>-job-fire` mounts no token; its env is `JOB_NAME`, `MOOSE_URL` (the bot's Service) and `MOOSE_JOB_KEY` (a `secretKeyRef` to the job caller's `keyFromEnv` key, never `envFrom`).

### `fire`

`fire <name> [--period <RFC 3339>] [--dry-run] [--force]` reads no configuration and opens no Slack or MCP connection. It submits the period and polls; the bot does the work and holds the lease, so the Pod can be replaced at any time.

1. `POST /internal/v1/routines/{name}/fire` `{period, dryRun, force?}`. 202, 200 and 409 all go on to polling; 503, other 5xx, 408, 429 and connection errors are retried, backing off from 5 s to 30 s. Any other 4xx exits 2. `force` (by hand: run again past the deadline) is sent only with the first submit.
2. `GET /internal/v1/routines/{name}/periods/{period}?dryRun=<as --dry-run>` at once, then every 30 s, one log line each (period, state, step): `delivered` exits 0; `failed` exits 1; `running` and `stalled` wait; `orphaned` (no live lease) submits again, so a live Pod takes over; 404 waits, and after 2 minutes of 404s submits again.
3. Every request times out after 10 s. Unreachable (as in 1) for 5 minutes in a row exits 1; so does no outcome 5 minutes past the period's `deadlineAt` (an hour from the start until the bot reports it).

Exit codes: 0 delivered, 1 failed or gave up (the Job retries once), 2 usage or configuration (the Job fails).
