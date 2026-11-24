# neotags — Design 003: Internal run API (routines)

Status: **v1** · Date: 2026-11-19

Routines are tasks neotags runs on its own, on a schedule (later on events), from configuration: `routines.<name>` names the skill packs a routine's runs may use, and later its trigger, steps and delivery targets. A Kubernetes CronJob only triggers a routine; the work, the model calls and the delivery happen in neotags. This document covers the first piece: one agent run for a routine, with a structured result, through `runJob` in process and `POST /internal/v1/runs` over HTTP. §6 adds the routines' configuration, their CronJobs and the `fire` command; §7 the `fire` endpoint, period records, leases and the pipeline engine; §8 delivery (the Outbox) and the owner's failure notices.

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
| `packs` | Optional; a subset of the routine's `packs`, else 403. The packs decide what the run may read (its `read_skill` tools and system prompt see only them, plus reference-only packs from `skillPacks.refs`) and, for packs that declare `sandbox`, execute, so they come from configuration; a request can only narrow them. The other entries' runs (O2, Slack) see every loaded pack except step packs (§7) and packs only routines use: in some routine's `packs` and in no other entry's `agent.entries`. |
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

`routines.<name>` (`src/config/routines.ts`; every field in `config/neotags.example.yaml`). The name is the CronJob's: lowercase letters, digits and dashes, starting with a letter and not ending in a dash, at most 52 (the Job controller appends `-<minutes>`, and a Job name is at most 63). Every routine is checked in full at startup, enabled or not, and the process refuses to start on any problem; keys are strict, so a misspelt one fails instead of being dropped.

| Field | Rule |
|---|---|
| `kind` | `agent` (one run: `instructions`, optional `context`, `budget`) or `pipeline` (a routine type's steps: `type`, `params`; both checked by the type's step pack once loaded). |
| `enabled` | Default true; false suspends the CronJob. |
| `trigger` | `schedule`: Kubernetes CronJob syntax, 5 fields (no seconds, no `@` macros, no `L`/`W`/`#`/`H`, day of week 0-6); `timeZone`: an IANA name, case as written (Kubernetes reads it case-sensitively). Both required. Later, event triggers go here too. |
| `owner.slack` | Where failure notices go; in `outbox.slack.allowedChannels`. |
| `packs` | In `skillPacks.packs`. A pipeline's packs are its classify run's, which reads untrusted data: none may declare `sandbox` (checked when the packs are loaded). |
| `mcp` | The MCP servers its runs get, in `mcp.servers`; default none. `runJob` passes them as an allowlist (`RunInput.mcp.only`): the run gets no other server, including one added later, so untrusted input cannot steer it to another org's data. |
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

## 7. Periods: `fire`, records, leases and the pipeline engine

`src/routines/period.ts` (fire, status, the period in the background), `lease.ts`, `records.ts`, `engine.ts` (pipeline steps), `types.ts` (routine types); the store is `src/artifacts/` (S3, `artifacts.s3.bucket`, credentials from the AWS SDK's default chain: IRSA in the cluster, never static keys).

### Records

Everything of a period is under `jobs/<routine>/<period>/` in the bucket (a dry run's under `jobs/<routine>/dryrun/<period>/`), written by the bot only:

| File | What |
|---|---|
| `lease.json` | `{holder, token, expiresAt}`: who runs the period now. |
| `run.json` | `state` (`running`, `delivered`, `failed`), the writer's lease `token`, `deadlineAt`, the current `step` and its budget, every step's state and attempts, run ids, each holder with its trace id, `degraded`, `reason`, `updatedAt`. Written at every step's start and end, and every minute during a run. |
| `input.json` | The steps' `in.json` without `data`. |
| `data.json` | `{after, data, classifyInput}`: the last checkpointed step (up to the classify run). |
| `output.json` | The classify run's result, or an agent routine's output: the next period's memory. |
| `state.json` | The last step's `state`: the next period's `previous.state`. |
| `bundle/` | The delivery bundle split into files; `manifest.json`, written last, lists them. |
| `delivered.json` | Per delivery target (`slack:<channel>:<section>:<lang>`, `confluence:<space>:<parent>`): `ok`, `link`, `error` and the failed `step`, and the `detail` of each step done (§8), with the writer's lease token. A target recorded as delivered is not delivered again; one partly delivered goes on from its `detail`. |
| `delivery-pending.json` | Only without an Outbox (tests, a bot without one): the targets the period would have delivered to. |

The previous period is the latest formal (not `dryrun/`) period before this one whose `run.json` is `delivered`, zero targets included; listed with `ListObjectsV2` under `jobs/<routine>/` (never the bucket root, never `HeadBucket`: the policy allows neither).

### `POST /internal/v1/routines/{name}/fire` `{period, dryRun?, force?}`

1. Unknown routine 404; draining 503 `shutting_down`; a period the schedule does not fire at, or older than 8 days, 400 with `periodError`'s reason.
2. Already over (`delivered`, or `failed` past `deadlineAt`) and no `force`: 200 `{state}`.
3. Take the lease (below); held by someone else: 409.
4. Under the lease, write `run.json`: `running`, the new token, `deadlineAt` kept from an earlier try (an hour from now on the first, or with `force`). Then 202 `{period}`; the period runs in the background, apart from the request, as its own trace (`routine <name>`).
5. Where to go on: `bundle/manifest.json` present, deliver; `data.json` present, skip the steps up to it; anything else runs again. A `failed` period before its deadline runs again.
6. Deliver, mark `run.json` `delivered`, release the lease. Past `deadlineAt` the period stops and is `failed` (`reason: deadline`); a takeover or retry never resets it, only `force` does.

### Leases

Taken with `PutObject` `If-None-Match: *` (5 minutes), renewed every 2 minutes with `If-Match` on the holder's last etag, taken over once expired with `If-Match` on the etag read, released with `DeleteObject` `If-Match`. Before every write of `run.json` or `delivered.json`, and before each delivery target, the holder confirms its lease (renewing first with under a minute left). S3's answers: a create's 412 reads the lease (live: 409 to the caller; expired: take over) and its 409 tries once more; a takeover's 412 or 404 judges once more, never in a loop; a renewal's or record write's 412 or 404 stops the period, and 409 reads again and retries once if the record is still the holder's; a release's 412, 404 or 409 is ignored. A lost lease stops the period at once: its `runJob` and sandbox step are cancelled and it writes and delivers nothing more.

A shutdown interrupts a period (also mid-step) without failing it: `run.json` stays `running` with `reason: interrupted`, the lease is released, and the fire command, seeing `orphaned`, submits again to a live Pod, which goes on from the records. `fire` during the drain is 503.

### `GET /internal/v1/routines/{name}/periods/{period}?dryRun=`

`{state, step, updatedAt, leaseExpiresAt, deadlineAt, runIds, delivered[], reason?}`; 404 without `run.json`. `state`: `delivered`; `failed` when the lease is gone (or the failed record is the live holder's); `running` while a live lease exists, with step, time and reason only from the live holder's own record (a superseded holder's is not taken); `stalled` when that record's `updatedAt` is older than its step's budget (a sandbox step's `timeoutSec`, a run's wall clock) plus 5 minutes, logged as a warning; `orphaned` when the lease is gone or expired before the period ended.

### Routine types and the pipeline engine

A step pack declares `pipeline:` next to `sandbox:` in its front matter: `type`, `params` (a JSON Schema file of the pack), `steps` (`name`, `argv`), `classify` (`after`, `outputSchema` as `<pack>/references/<file>`, `budget`), `degrade`. A pack whose declaration does not load is skipped whole. At startup: one step pack per type; no step pack in `agent.entries` or any routine's `packs`; a pipeline routine's `packs` declare no `sandbox`; its `type` has a step pack, its `params` pass the type's schema, the classify schema exists and its budget is within the defaults. `run_skill_command` never offers or runs a step pack, and the engine runs nothing else. No run lists or reads a step pack either: a job run sees only its routine's packs, and other entries' runs leave step packs out of their system prompt and `read_skill` / `read_skill_ref`.

A reference-only pack (`skillPacks.refs`) has no `SKILL.md`: the system prompt marks it `reference files only, no read_skill` with its files, and `read_skill` on it fails naming `read_skill_ref` and those files.

The engine runs the steps in order through `SkillExecutor.exec` with `/work/in.json` (`{task, period, window: {start, end}, params, delivery, dryRun, previous: {state} | null, data?, problems?}`; the window is the previous firing to the period); each prints one JSON object. Not JSON, truncated, a timeout or a non-zero exit is retried once; exit 2 is not. Each step takes a `jobsApi.concurrency` slot only for its call (the job runner's own `Slots`, not a second set), so with `concurrency: 1` the classify run, which takes the slot in `runJob`, never waits for the engine; a slot not free within 15 minutes or a busy executor fails the attempt. After `classify.after` comes the classify run: `runJob` with `{summary: classifyInput, previous: {problems, state} | null, team}` (over 200k characters: `previous` goes first, then the summary is cut), the routine's packs, the step pack's schema and budget, and the root span's `traceparent`. A failed or degraded classify run goes on at `degrade` with `problems: null`, and `run.json` says `degraded`. The last step's `bundle` is split into `bundle/` and its `state` written to `state.json`.

An agent routine is one `runJob` with its `instructions`, `budget`, and `{routine, period, window, context, previous_period: {summary, state} | null}` as input; its output schema is fixed: `{notify, summary (≤ 4k), report, state? (≤ 8k)}`. With `notify: when_findings` and `notify: false` there are no targets, and the period is delivered.

### Observability

One log line at each step's start and end (`routine`, `period`, `step`, `durationMs`, outcome, `exitCode`, `stdoutBytes`); a failed step attempt's stderr, redacted, in `steps/<step>-<attempt>.stderr.txt`. The root span `routine <name>` (`gen_ai.agent.name = job`, `neotags.routine.name`, `.period`, `.state`, `.degraded`) has a child `routine.step <step>` per sandbox step (attempts, duration, exit code, stdout bytes, `truncated`) and the classify run's `invoke_agent job` (a link instead when the root span is not sampled).

## 8. Delivery: the Outbox

`src/outbox/` (`index.ts`: `createOutbox`, the span and log line per target, owner notices; `bundle.ts`; `slack.ts`; `confluence.ts`), behind the `Outbox` interface of `src/routines/outbox.ts`. The period decides which targets are due (`delivery`, and `notify: when_findings` with `notify: false` gives none), skips those `delivered.json` has as delivered, confirms the lease before each target, and records each outcome; the Outbox delivers one target, confirming the lease again before each step's side effect (`ctx.confirm`) and recording each step as soon as it is done (`ctx.progress`, a `delivered.json` write that is not `ok` yet). A target that fails keeps its steps' `detail`; the next attempt (a retry, or another holder) gets it as `ctx.previous` and only does what is left. After the loop the period is `delivered` when every due target is (zero included), else `failed`, and the next fire delivers only what is missing.

**Bundle.** A pipeline's `bundle/manifest.json` (`{notify, sections: {<section>: {<lang>: {slack, attachments}}}, confluence?: {title, body, attachments}}`, paths under `bundle/`). An agent routine's `output.json` becomes one section, `all`, in any language: `summary` is the Slack text and `report` the attachment `report.md` (and the Confluence page). A section and language the configuration names but the bundle lacks fails that target.

**Slack.** The bot token's `WebClient` (two retries: a post retried after Slack took it shows up twice). Step one, `chat.postMessage` (`unfurl_links`, `unfurl_media` off): the `mention` (not on a dry run), the section's text, and a footer with the period and run ids; its `ts` is recorded at once, then the `chat.getPermalink` link (a missing link does not fail the target). Step two, each attachment with `files.uploadV2` into the message's thread, each recorded. A retry with a recorded `ts` never posts again; it uploads the files not recorded. Needs `files:write`.

**Confluence** (REST v2; v1 for attachments). Basic auth with `CONFLUENCE_EMAIL` and `CONFLUENCE_WRITE_TOKEN` (without them the bot starts, logs a warning, and Confluence targets fail). Steps: the parent (a folder or a page) must be in the configured `space` (its `spaceId` against the space key's id), else the target fails; with `monthlyFolder`, find or create the folder `YYYY-MM` (the period's month in the routine's time zone) under the parent; create the page (storage format) in it, full width: its title is recorded first, and a retry takes a page of that recorded title under the same parent as its own (an attempt that created it but could not record it); a title already taken in the space gets the time, then the period, appended; then each attachment (a new version when one of that name exists). A recorded page is never created again; a retry only uploads the missing attachments.

**Allowlists and dry runs.** Before it sends, the Outbox checks again what startup checked: the channel is in `outbox.slack.allowedChannels`, the space in `outbox.confluence.allowedSpaces`. On a dry run every Slack target (and the owner's notice) is `outbox.slack.testChannel`, and the Confluence parent is `outbox.confluence.testParent` (in any allowed space), or Confluence is skipped (recorded as delivered with `detail.skipped`). `delivered.json` keys are always the configured targets.

**Failure notices.** Each time a period's attempt fails (a step, the run, a delivery target, the deadline; the Job's retry and a `--force` are attempts of their own), and when it is delivered degraded (the classify run failed), one message in the routine's `owner.slack`: the routine, period, step, reason and run ids. A superseded or interrupted period sends none; a notice that cannot be sent is logged. When the bot itself is unreachable, only the CronJob's alerts tell.

**Observability.** A span `deliver <sink>` per target under the period's root span (`neotags.delivery.target`, `.sink`, `.outcome`, `.steps` done in this attempt, `.failed_step`, `.link`), and one log line per target, `delivery target finished` (`routine`, `period`, `target`, `sink`, `outcome`, `steps`, `step`, `durationMs`, `link`, `reason`).
