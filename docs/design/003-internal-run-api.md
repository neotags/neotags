# neotags — Design 003: Internal run API (routines)

Status: **v1** · Date: 2026-11-19

Routines are tasks neotags runs on its own, on a schedule (later on events), from configuration: `routines.<name>` names the skill packs a routine's runs may use, and later its trigger, steps and delivery targets. A Kubernetes CronJob only triggers a routine; the work, the model calls and the delivery happen in neotags. This document covers the first piece: one agent run for a routine, with a structured result, through `runJob` in process and `POST /internal/v1/runs` over HTTP. The CronJob entry (`fire`), periods, leases and delivery come later and build on it.

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
