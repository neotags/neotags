# neotags — Design 002: OpenObserve assistant gateway contract

Status: **v1** · Date: 2026-11-05

The OpenObserve (O2) enterprise AI assistant panel can be pointed at an external agent. O2 forwards each chat turn to `POST {agent}/o2/v1/query` and pipes the agent's `text/event-stream` response **byte for byte** to the browser, so this document is the contract between the neotags O2 gateway (`src/gateway/o2.ts`) and the O2 web panel.

It was derived from the O2 sources (`web/src/components/O2AIChat.reducer.ts`, `O2AIChat.framing.ts`, `O2AIChat.navigation.ts`, `O2AIChat.toolcall.ts`, `web/src/composables/useAiChat.ts`, `useChatStream.ts`, `src/api/management/src/request/ai/chat.rs`) and checked by feeding the fixtures in `test/fixtures/o2/` through the panel's reducer. `test/o2-fixtures.test.ts` checks the fixtures against the rules below; gateway tests should reuse the fixtures.

Transport: [SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html) over HTTP/1.1, using a strict subset (one `data:` line per event, no `event:`/`id:`/`retry:`); event payloads are JSON with a `type` discriminator. Errors before the stream starts use HTTP status codes; errors after it starts are in-band `error` events.

## 1. Request

`POST /o2/v1/query`, `Content-Type: application/json`. Example: `test/fixtures/o2/request/query-request.json`.

Headers (lower-case on the wire):

| Header | Required | Meaning |
|---|---|---|
| `x-o2-agent-key` | yes | Shared secret between O2 and neotags; compare in constant time. |
| `x-o2-user-email` | yes | The asking user. Audit and rate limiting only; never an authorization input. |
| `x-o2-assistant-session-id` | yes in practice | UUID (lower-case, validated by O2). One chat panel conversation. The panel always sends one. |
| `x-o2-assistant-turn-id` | yes in practice | UUID of this turn; a retried turn reuses it. |
| `traceparent` | optional | W3C trace context; parent the `invoke_agent` span on it. |
| `user-agent` | optional | Browser user agent. |

O2 must not forward the user's `Authorization` or cookies. Treat any that arrive as an error in the O2 build, not as credentials.

Body (`QueryRequest`; every field is always present, absent values are `null`):

| Field | Type | Meaning |
|---|---|---|
| `query` | string | The last user message. |
| `history` | `{role, content}[]` \| null | Earlier messages in order, `role` is `user` or `assistant`. Text only: tool calls and results are not replayed, and assistant `content` may contain panel notices ("Navigated to …", error text). |
| `context` | object | The page context, see below. Untrusted user-controlled data. |
| `images` | `{data, mime_type, filename}[]` \| null | Pasted images, base64. Ignored in v1. |
| `model` | string \| null | Ignored; neotags picks the model. |
| `turn_id`, `known_seq`, `known_opencode_session_id`, `session_epoch` | null | O2 server-side persistence fields; null because persistence stays off. Use the turn-id header. |
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

Only when the turn cannot start. JSON body `{"error": "<message>", "error_code": "<code>"}`:

| Status | `error_code` | When |
|---|---|---|
| 400 | `bad_request` | Body is not a `QueryRequest`, or `query` is empty. |
| 401 | `unauthorized` | `x-o2-agent-key` missing or wrong. |
| 429 | `turn_limit` | Per-user rate limit or concurrency cap. Add `Retry-After`. The panel then puts the prompt back in the input box and shows its turn-limit notice. |
| 503 | `unavailable` | Shutting down or draining. Add `Retry-After`. |

O2 maps the upstream status and `error_code` onto its own response; the panel shows a generic "server error (status)" for anything except 429 (and 403, which it words as "you are not authorized", so never return 403). The O2 side must keep 429 and `error_code` intact for the turn-limit behaviour.

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

Cancellation: the panel's Stop button aborts the HTTP request (O2's cancel endpoint is only used with server-side persistence, which is off). **A closed connection cancels the run.** `POST /o2/v1/cancel` cancels by session and turn id for other callers; if the stream is still open it ends with `cancelled`.

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
- `action: "navigate_direct"`: `resource_type` `alert` | `dashboard` | `pipeline` with `target.{alert_id|dashboard_id|pipeline_id, name?, folder?}`, or `target.path`.
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

- `POST /o2/v1/cancel` — body `{session_id, turn_id?}`; `200 {"cancelled": bool}`.
- `POST /o2/v1/feedback` — body as sent by the panel: `{feedback_type: "thumbs_up"|"thumbs_down", query_index, trace_id?}`, session id in `x-o2-assistant-session-id`. Recorded as one log event; `200 {}`.

Both require `x-o2-agent-key`.
