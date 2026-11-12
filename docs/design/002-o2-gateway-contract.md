# neotags — Design 002: OpenObserve assistant gateway contract

Status: **v5** · Date: 2026-11-12 (v2: upstream o2-ai paths and error body, no turn-id header, user email optional; v3: the gateway's choices, §6; v4: `x-o2-user-token` and querying as the user, §1, §2, §7; v5: the token's lifetime bounds the run, HTTP errors are O2's answer, the run lists tools itself, §2, §7)

The OpenObserve (O2) enterprise AI assistant panel can be pointed at an external agent. O2 forwards each chat turn to `POST {O2_AGENT_URL}/o2_agent/{agent}/query/stream` and pipes the agent's `text/event-stream` response **byte for byte** to the browser, so this document is the contract between the neotags O2 gateway (`src/gateway/o2.ts`) and the O2 web panel.

It was derived from the O2 sources (`web/src/components/O2AIChat.reducer.ts`, `O2AIChat.framing.ts`, `O2AIChat.navigation.ts`, `O2AIChat.toolcall.ts`, `web/src/composables/useAiChat.ts`, `useChatStream.ts`, `src/api/management/src/request/ai/chat.rs`) and checked by feeding the fixtures in `test/fixtures/o2/` through the panel's reducer. `test/o2-fixtures.test.ts` checks the fixtures against the rules below; gateway tests should reuse the fixtures.

Transport: [SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html) over HTTP/1.1, using a strict subset (one `data:` line per event, no `event:`/`id:`/`retry:`); event payloads are JSON with a `type` discriminator. Errors before the stream starts use HTTP status codes; errors after it starts are in-band `error` events.

## 1. Request

`POST /o2_agent/{agent}/query/stream`, `Content-Type: application/json`. Example: `test/fixtures/o2/request/query-request.json`.

The path follows upstream OpenObserve's own agent service (o2-ai), which the enterprise tests in `chat.rs` pin together with the pre-stream error body (§2), so the O2-side client can be checked against them. `{agent}` is O2's `DEFAULT_AGENT_TYPE`, `o2`, and selects the agent entry. Any other value is `404 agent_not_found`. O2's incident RCA agent type `rca` is not served.

Headers (lower-case on the wire):

| Header | Required | Meaning |
|---|---|---|
| `x-o2-agent-key` | yes | Shared secret between O2 and neotags; compare in constant time. |
| `x-o2-user-email` | optional | The asking user: the user O2 authenticated for this request (older O2 builds parsed it from the user's credentials). It is absent when O2 has none. Audit and rate limiting only, never an authorization input. Rate-limit by session id when it is absent. |
| `x-o2-user-token` | optional | `o2ut.<claims>.<mac>`: a short-lived (15 minutes), read-only token O2 signs for this turn's user and page org. Stream requests only (not cancel or feedback); absent when O2 cannot sign one. Used only with `o2Gateway.auth: user` (§7). |
| `x-o2-assistant-session-id` | yes in practice | UUID (lower-case, validated by O2). One chat panel conversation. The panel always sends one. |
| `traceparent` | optional | W3C trace context; parent the `invoke_agent` span on it when it is sampled, else link it (§6). |
| `user-agent` | optional | Browser user agent. |

There is no turn id. With persistence off, O2 neither forwards `x-o2-assistant-turn-id` nor fills `turn_id`, so neotags generates its own run id.

O2 must not forward the user's `Authorization` or cookies. Treat any that arrive as an error in the O2 build, not as credentials. The user token is not the user's credential: O2 issues it for the assistant alone, and only O2 can check it.

Body (`QueryRequest`; every field is always present, absent values are `null`):

| Field | Type | Meaning |
|---|---|---|
| `query` | string | The last user message. |
| `history` | `{role, content}[]` \| null | Earlier messages in order, `role` is `user` or `assistant`. Text only: tool calls and results are not replayed, and assistant `content` may contain panel notices ("Navigated to …", error text). |
| `context` | object | The page context, see below. Untrusted user-controlled data. |
| `images` | `{data, mime_type, filename}[]` \| null | Pasted images, base64. Ignored in v1. |
| `model` | string \| null | Ignored; neotags picks the model. |
| `turn_id`, `known_seq`, `known_opencode_session_id`, `session_epoch` | null | O2 server-side persistence fields; null because persistence stays off. |
| `mcps`, `clis`, `skills` | null | O2-pushed toolsets; not used. |
| `confirm_timeout_secs` | number \| null | For `confirmation_required`, which neotags does not use. |

`context` is the active page provider's object only (no merge with the default provider), plus `user_timezone` (IANA name) and `org_id` added by O2:

| Key | Pages | Meaning |
|---|---|---|
| `org_id` | all | The org **identifier** from the URL path; default org for queries. |
| `organization_identifier` | all | Same value, set by the browser. |
| `currentPage` | all | `logs`, `traces`, … or the translated page title on pages without a provider. |
| `request_timestamp` | most | Browser time, microseconds. |
| `routeName`, `routePath`, `routeFullPath`, `routeParams`, `routeQuery` | pages without a provider (e.g. metrics) | Route info. |
| `currentSQLQuery`, `sqlMode`, `currentVRLQuery`, `selectedStreams`, `streamType`, `interestingFields`, `quickMode` | logs | The user's query and streams. |
| `currentQuery`, `searchMode`, `selectedTrace{traceId,traceStartTime,traceEndTime}` | traces | Trace search state. |
| `timeRange{type, relativeTimePeriod?, startTime, endTime}` | logs, traces | `startTime`/`endTime` in microseconds, already resolved for relative ranges. |

Other pages (alerts, dashboards, pipelines, incidents) add their own keys. A context carrying `incident_id` may be replaced by O2 with an RCA context when incident RCA is enabled; neotags treats it as opaque page data.

## 2. Response before the stream

Only when the turn cannot start. JSON body in o2-ai's shape, `{"detail": {"code": "<code>", "message": "<message>"}}`:

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | Body is not a `QueryRequest`, `query` is empty, or `x-o2-assistant-session-id` is not a UUID. |
| 401 | `unauthorized` | `x-o2-agent-key` missing or wrong. |
| 404 | `agent_not_found` | `{agent}` is not `o2`. |
| 429 | `turn_limit` | Per-user rate limit or concurrency cap. Add `Retry-After`. The panel then puts the prompt back in the input box and shows its turn-limit notice. |
| 503 | `unavailable` | Shutting down or draining. Add `Retry-After`. |
| 503 | `user_auth_unavailable` | `o2Gateway.auth: user` only: no usable `x-o2-user-token` (missing, not the token's shape, no readable `exp`), a token that expires too soon (§7), or the page org (`context.org_id`) is missing or not in `o2Gateway.orgs`. The `message` says which. No `Retry-After`: asking again only helps once O2 sends a token. |

The O2 client turns this into its own response to the browser, `{"code": <status>, "error": "<message>", "error_code": "<code>"}`, with the same status (502 when neotags is unreachable). The panel shows a generic "server error (status)" for anything except 429 (and 403, which it words as "you are not authorized", so never return 403). The O2 side must keep 429 and `error_code` intact for the turn-limit behaviour.

An unavailable model is not a pre-stream error: the run answers with the degraded "context pack" reply over a normal stream.

## 3. Stream

`200`, headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`.

Framing (the panel splits on `\n` and parses from the first `{` of each `data: ` line):

- One event = `data: <JSON on one line>\n\n`. Never split JSON over several `data:` lines; escape newlines inside strings.
- Lines not starting with `data: ` are ignored, so `: ping\n\n` is the keepalive.
- Every frame ends with `\n\n`. A frame without a trailing newline is handled in a "tail flush" where `navigation_action` is dropped.

Order and timing:

1. First bytes within 2 s: `title` on the first turn of a session, else `: ping`.
2. `: ping` every 15 s while nothing else is sent.
3. Any interleaving of `message_delta`, `tool_call`, `tool_result`.
4. At most one `navigation_action`, after the last text.
5. Exactly one terminal event, `complete` | `error` | `cancelled`, then close the response.

Cancellation: the panel's Stop button aborts the HTTP request (O2's cancel endpoint is only used with server-side persistence, which is off). **A closed connection cancels the run.** The cancel endpoint (§5) cancels by session for other callers; if the stream is still open it ends with `cancelled`.

## 4. Events

Example of each: `test/fixtures/o2/events/`. Full streams: `test/fixtures/o2/streams/`.

### `title`
`{"type":"title","title":"…"}`. Short chat title, first turn only (empty `history`), at most once.

### `message_delta`
`{"type":"message_delta","content":"…"}`. Markdown text, appended verbatim. **Always set `type`**: a bare `{"content":…}` is treated as a whole paragraph, so the panel inserts blank lines between chunks and rewrites code fences. Text after a tool call starts a new text block; begin its first delta with `\n\n` so the joined message (replayed as `history`) keeps paragraphs apart.

### `tool_call`
`{"type":"tool_call","tool","call_id","message","context"}`

- `tool`: the O2 MCP **inner** tool name without the server prefix (`SearchSQL`, `StreamSchema`, `GetAlert`, …); the panel has dedicated wording for these. Non-O2 tools use their own short name.
- `call_id`: unique within the turn; `tool_result` matches on it.
- `message`: one-line description shown on the card.
- `context`: the (redacted, size-capped) arguments the card shows: `request_body.query.{sql,start_time,end_time,size}` for SQL, flat `sql`, `stream_name`, `type` (stream type), `command`.

### `tool_result`
`{"type":"tool_result","tool","call_id","success", …}`

- `success` (bool, required). On failure add `message` (shown on the card), `error_type`, `suggestion`.
- `summary`: `{count?, took?}`, rows and milliseconds. Summary only: no `response`/`hits`, which the panel would render raw.
- `call_args` (optional): the SearchSQL-shaped arguments `{stream_name, stream_type, request_body:{query:{sql,start_time,end_time}}}`. The panel turns them into a "View in Logs/Traces" button on the card. This is the default way to link evidence. Include them **only when the query ran against the user's current org** (`context.org_id`): the button always opens the current org. For another org, put a full link (with `org_identifier`) in the text instead.

### `navigation_action`
`{"type":"navigation_action","resource_type","action","label","target"}`

- `action: "load_query"`: `resource_type` is `logs` or `traces`; `target` is `{query, sql_mode: true, stream: [names], from, to}` with `from`/`to` in microseconds (or `period`, e.g. `15m`). PromQL to the metrics page is not supported in v1.
- `action: "navigate_direct"`: `resource_type` `alert` | `dashboard` | `pipeline` with `target.{alert_id|dashboard_id|pipeline_id, name?, folder?}`, or `target.path` (with `target.query`, merged into the URL query) for any other `resource_type`.
  - `dashboard` opens `/dashboards/view?dashboard=<id>&folder=<folder>`. `folder` must be the dashboard's real folder id (default `default`): the page checks access by it, and saves the dashboard to it when it fixes duplicate panel ids.
  - `alert` with an `alert_id` opens the alert **in its editor** (`/alerts?action=update`). neotags never sends it: an alert's status page is `target.path` `/alerts/detail/<alert_id>` with `target.query.folder`, under `resource_type: "alerts"`; the list is `/alerts`, the history `/alerts/history`.
- Auto-navigation is on by default in the panel, so this event **moves the user's page immediately**. Send it only when the user asked to open or run something, at most once, as the last event before `complete`. Same current-org rule as `call_args`.

### `complete`
`{"type":"complete","trace_id":"<32 hex>"}`. Successful end. `trace_id` is the trace id of the run's `invoke_agent` span; the panel sends it back with thumbs up/down feedback.

### `error`
`{"type":"error","error":"…","error_type"?,"suggestion"?}`. Terminal: the panel stops reading at this event, so nothing after it (no `complete`) is seen. `error` is user-facing text, `suggestion` is appended below it.

- Never use `code: "session_owner_unavailable"`: the panel would discard the session and replay the turn.
- Keep the words *unauthorized*, *forbidden*, *not authorized*, *permission denied* out of `error`, and `unauthorized`/`forbidden`/`permission_denied` out of `error_type`: the panel replaces the message with "you are not authorized", which is wrong when the agent's own data account was refused. Say "the data source refused the query" instead.

### `cancelled`
`{"type":"cancelled"}`. The run was cancelled while the stream was still open; the panel marks the turn stopped.

### Not used
`confirmation_required` (write actions are out of scope), `sync` / `sync_state` (O2 persistence).

## 5. Other endpoints

- `POST /o2_agent/sessions/{session_id}/cancel`: body `{org_id}`. Cancels the session's active run. Responds `200 {"active": bool, "cancelled": bool}`, the fields O2's cancel path reads.
- `POST /o2_agent/feedback`: body as sent by the panel, `{feedback_type: "thumbs_up"|"thumbs_down", query_index, trace_id?}`, with the session id in `x-o2-assistant-session-id`. Recorded as one log event; responds `200 {}`.

Both require `x-o2-agent-key` and use the §2 error body. Upstream does not pin these two paths; they sit under the same `/o2_agent` prefix.

## 6. How neotags fills the contract

Choices the contract left to the gateway (`src/gateway/o2.ts`, `o2-stream.ts`, `o2-events.ts`):

- **Title.** Written by code from the question (redacted, at most 60 characters), so it is also the first byte. No LLM call.
- **Text.** Only the final answer streams: an investigation turn's text is either commentary before tool calls or a draft the final turn rewrites. So `message_delta` usually follows the last `tool_result`.
- **Tool cards.** Every tool call gets a card except the navigation tools (`open_query_in_o2`, `open_dashboard_in_o2`, `open_alerts_in_o2`). O2 tools by inner name; others by their own name (`read_skill_ref`, `run_skill_command`, `search_indexed_documents`). `message` is written by code in the answer language. A call to another org than the user's says so on the card.
- **Current org.** `o2Gateway.orgs` maps an org identifier to the MCP server that queries it, one server per org. `context.org_id` (checked against the identifier format) picks the user's org; the run is told it in code, outside the untrusted page context.
- **Evidence.** `call_args` carries the SearchSQL that **ran** (after the tool guard's time range and `LIMIT`), and only for a successful call through the current org's server.
- **Navigation.** The model asks for it with a navigation tool; code builds the target. The event is sent once, after the last text, right before `complete`, and only when the run ends `done`; when the model asks more than once, the last request wins.
  - `open_query_in_o2` (no arguments) opens the last SearchSQL that succeeded against the current org, exactly as it ran. It refuses when there is none, for another org, and for stream types other than logs and traces.
  - `open_dashboard_in_o2 {dashboard_id}` opens a dashboard that a ListDashboards against the current org returned in this turn, in its folder. The tool guard runs ListDashboards at the `full` detail level (the summary has no `folder_id`), with `title: ""` when no filter is given (no filter lists only the default folder), and cuts the result down to each dashboard's id, title, folder and owner before the model sees it.
  - `open_alerts_in_o2 {page: list|history|alert, alert_id?}` opens the alerts list, the alert history, or the status page of an alert that a ListAlerts against the current org returned in this turn (also `full`: the summary has no `alert_id`; cut down to what the alert watches and its state).
- **Ends.** By the run's outcome:

  | Run | Stream ends with |
  |---|---|
  | done | (`navigation_action`), `complete` |
  | failed, degraded (no model) | the context package as `message_delta`, then `complete` |
  | failed after part of the answer streamed | `error`, `error_type` = `model_error` \| `deadline` \| `error` (a deadline says so and suggests a narrower question) |
  | budget_exhausted | the answer, then `error`, `error_type: budget_exhausted` |
  | cancelled (cancel endpoint) | `cancelled` |
  | interrupted (shutdown drain) | `error`, `error_type: interrupted` |
  | client disconnected | nothing: the run is cancelled |

- **Trace id.** `complete.trace_id` is the `invoke_agent` span's trace id. A sampled `traceparent` makes the span its child (same trace id); an unsampled one would make the default sampler drop every span of the run, so it becomes a span link on a new root. With tracing off, the caller's trace id, else a random one.
- **Limits.** History keeps the newest turns within `o2Gateway.maxHistoryChars`, the oldest kept one cut to what is left; a page-context value over 4000 characters is replaced by a note, and keys past 32k characters in all are dropped; the body is capped at `o2Gateway.maxBodyKb`. A turn that would wait (no free slot, or its session busy) is refused with `429 turn_limit` once `o2Gateway.maxQueued` runs are queued; one that can start at once never is. A client that stops reading (over 1 MB unsent) is disconnected and its run cancelled.

## 7. Querying as the user (`o2Gateway.auth: user`)

By default (`auth: service`) every run queries O2 through the MCP servers' configured headers, the agent's own read-only service account, and `x-o2-user-token` is ignored. With `auth: user` the run queries with the asking user's own O2 permissions:

- **Token.** The gateway checks the shape: the `o2ut.` prefix, then two unpadded base64url parts joined by one `.`, at most 4096 characters, and reads `exp` from the claims part for timing only. It never verifies the MAC (only O2 holds the key; O2 checks every call, so a forged `exp` buys nothing). A token of another shape or without a readable `exp` counts as no token. There is no fallback to the service account: a turn without a usable token gets `503 user_auth_unavailable` before the stream (§2).
- **Token lifetime.** The run's tool calls must end before the token does (15 minutes, while a run may take 10 and wait in its session's queue first). The deadline is `exp` less 30 s (clock skew, a call in flight). A turn with less than `o2Gateway.minUserTokenSec` (default 120 s) left before it is refused with `503 user_auth_unavailable`; a run left with less than that when it leaves the queue is not started, and is answered "ask again" (`error_type` `sign_in_expiring`). A run that starts gets its wall clock cut so that its tool calls end by the deadline; the final answer, which needs no token, may take the final reserve after it.
- **One org.** The token is valid for the page org only. The run gets only the tools of that org's MCP server (`o2Gateway.orgs`); other orgs' servers are not offered, and the run is told it can only link to them.
- **The calls.** That server's `tools/call` requests go out on an MCP client of the run alone, as `Authorization: Bearer <token>`, without the server's configured headers; it is closed when the run ends. The tool schemas are the ones the shared client listed; when it has listed none (its credential is missing or refused, or the server was down at startup), the run client lists them itself as the user, so the user mode does not depend on the service account. A run whose own listing fails gets no tools for the server and is told it is unavailable.
- **O2's answers.** O2 checks the token on every request, then the user's org membership and permissions.
  | Status | Meaning | The model is told |
  |---|---|---|
  | 401 | bad signature or expired | the sign-in for this question is no longer valid: ask again; no retry |
  | 403 | other org, a route outside the read-only list, not a member, or no permission | the user's account cannot see this data: no other org, no guessing |
  | 404 | the server no longer knows the MCP session (it restarted) | nothing: one reconnect and retry |
  | other (400, 429, 5xx) | O2's answer to this call | the status and the start of O2's body, redacted; for 429, not to retry now. No retry |
  None of them marks the shared client down. The same rule holds on the shared client, except that 401 and 403 there are the service account's and count as the connection (reconnect, then down); only network errors, a closed connection and 404 are retried.
- **Secrecy.** The token is kept out of the prompt, the page context, logs, audit lines and spans; on the run's input it is wrapped so that serializing it shows `[REDACTED]`, and `redact()` replaces any `o2ut.` token. The `invoke_agent` span carries `neotags.o2.auth` (`user` or `service`).
- **Unchanged.** The tool guard (`allowTools`, `innerAllow`, `argAllow`, query limits), the current-org rules of §6, and rate limiting by `x-o2-user-email` (`agent.concurrency.exemptUsers` for an eval account). Slack and job runs always use the service account.
