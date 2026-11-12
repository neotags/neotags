# neotags

Self-hosted agent teammate for Slack (GitHub/GitLab later). Mention it (`@moose ...`) in a channel, or DM it, to delegate work.
Design: [docs/design/001-knowledge-collection.md](docs/design/001-knowledge-collection.md). Architecture diagram: [docs/architecture.html](docs/architecture.html) (open in a browser; source in `docs/architecture.json`).

## Dev

```sh
npm install
cp config/neotags.example.yaml config/neotags.yaml
export SLACK_BOT_TOKEN=xoxb-... SLACK_SIGNING_SECRET=... NEOTAGS_CONFIG=config/neotags.yaml
npm run dev            # listens on :3000, POST /slack/events, GET /healthz
npm test && npm run typecheck
```

Create the Slack app from `deploy/slack-app-manifest.yaml`; the Events request URL must be publicly reachable
(use a tunnel such as ngrok/cloudflared for local dev). Bot name is configuration (`bot.name`); mentions are matched by bot user ID.

## Status

Implemented (unit-tested with fakes; not yet run against live Slack/Onyx/LLM): Slack Events gateway, LLM intent router, `kb-collect` (record a thread to Onyx with Undo), `kb-files` (index shared PDF/Office/text files), `kb-ask` (answer questions from the KB with citations), configurable OpenAI-compatible LLM gateway, LLM traces over OTLP (OpenObserve / Langfuse), OpenObserve AI assistant entry (agent runs with MCP tools and the sandbox).

Try it: invite the bot to a public channel (private channels are off unless `slack.allowPrivateChannels: true`, which also needs the `groups:read` + `groups:history` Slack scopes and makes those entries visible to the whole KB) and, inside a thread, mention it: `@moose record the knowledge`. Needs `LLM_API_KEY`, `llm.model`, `onyx.baseUrl` and `ONYX_API_KEY`. Or DM the bot directly (the manifest enables the app's Messages tab): it answers questions there too — DMs are never recorded to the KB.

### Attachments and questions

- **Collect files.** `@moose save these files` (in a thread, or in a message that carries an upload) reads the PDF, DOCX, XLSX/XLSM, PPTX, CSV/text/log/JSON/YAML and HTML files shared there, redacts secrets, and indexes each as its own Onyx entry (tables become `Column: value` records and each file gets a short LLM-written summary with key facts, `attachments.summarize`) (`neotags-file-<slack file id>`, so repeating it updates rather than duplicates). `record the knowledge` also indexes the thread's files and links them from the thread entry. One Undo removes everything it saved. Needs the `files:read` Slack scope; `attachments.*` in the config sets limits.
- **Ask.** `@moose what does the Q3 report say about churn?` — or the same question in a DM with the bot — searches Onyx (`onyx.searchPath`, key needs `READ_SEARCH`), answers from the retrieved sections only, and cites them. The same entries are searchable in the Onyx UI.
- Switch a skill off with `skills.disabled: [kb-ask]` (or env `NEOTAGS_DISABLED_SKILLS=kb-ask`). It is then not offered by the router, not in the help text, and its buttons stop working. Without `kb-ask`, a question gets the help text.
- Not supported yet: images and scanned PDFs (no OCR), legacy `.doc`/`.xls`/`.ppt`, password-protected files.

### OpenObserve AI assistant

With `o2Gateway.enabled`, a second HTTP server on `o2Gateway.port` (3001) serves OpenObserve's AI assistant panel: O2 forwards each chat turn to `POST /o2_agent/o2/query/stream` and pipes the answer, an SSE stream, to the browser. The contract (request, pre-stream errors, events) is [docs/design/002-o2-gateway-contract.md](docs/design/002-o2-gateway-contract.md). Every request needs `x-o2-agent-key` = env `O2_AGENT_API_KEY`; keep the port in-cluster. Each turn is one agent run (RunManager) with the `agent.entries.o2` skill packs, the MCP tools and the sandbox; runs are rate-limited per `x-o2-user-email`, or per session when O2 could not name the user (`agent.concurrency.perUserPerHour`); emails in `agent.concurrency.exemptUsers`, such as an eval runner's, are not counted but still wait for the global `total`. Anyone holding the agent key can send any `x-o2-user-email`, so an exempt email is only as private as that key. `o2Gateway.orgs` maps O2 org identifiers to the MCP server that queries each: the run is told the user's org (from the page context's `org_id`), and only that org's SearchSQL results get the panel's "View in Logs" button and may be opened on the user's page (the `open_query_in_o2` tool, sent as `navigation_action` before `complete`). Likewise `open_dashboard_in_o2` opens a dashboard and `open_alerts_in_o2` the alerts list, the alert history or an alert's status page, but only one that a list call against the user's org returned in the same turn. `o2Gateway.auth` picks whose identity runs query O2 with: `service` (default) uses the MCP servers' configured headers for every org; `user` uses the asker's own O2 permissions, through the per-turn `x-o2-user-token` O2 signs, on the page org's server only (contract §7). In `user` mode a turn without a usable token, or from an org not in `o2Gateway.orgs`, is refused with `503 user_auth_unavailable`, never answered as the service account; switching back to `service` is the rollback. Closing the connection (the panel's Stop button) cancels the run; `POST /o2_agent/sessions/{id}/cancel` cancels by session, and `POST /o2_agent/feedback` logs one `o2_feedback` event per vote. When no model is available the answer is the context package written by code, over a normal stream. Answers, and every text code writes, are in Chinese when the question has a Chinese character, else in English.

### MCP tools (agent runs)

Agent runs get the tools of the MCP servers in `mcp.servers` (Streamable HTTP), named `<server>__<tool>`, for example `o2__SearchSQL`. Each server lists `allowTools`; nothing else is offered to the model. Header values come from env vars (`headersFromEnv: { Authorization: O2_MCP_AUTH }`), never from the file. A server that is down does not stop startup: it is retried in the background, and the system prompt names it until it is back. A call that loses its connection (a restarted server, an expired session) reconnects once and retries. A run of the O2 entry in `o2Gateway.auth: user` mode calls its org's server on a client of its own, with the user's bearer token instead of the configured headers, closed when the run ends; a 401 or 403 there is reported to the model as the user's sign-in or access, not retried. The O2 gateway starts it (`startMcp`) and passes it to `createRunManager`.

Every call passes the tool guard first (`src/guardrails/tools.ts`), in code:

- `tools_call` (O2) runs only an inner tool listed in `innerAllow`; without `innerAllow` it is always refused.
- `argAllow` limits a parameter to listed values, for tools that mix reads and writes, such as `{ alerting_manage_rules: { operation: [list, get] } }`.
- Arguments are capped at `mcp.maxArgChars`.
- `SearchSQL` and `PrometheusRangeQuery`, direct or through `tools_call`: a missing time range becomes the last hour, SQL without a `LIMIT` gets one, and a range query without a step gets about 60 points. A range over 30 days, a `LIMIT` over 1000 or a step that gives over 1000 points per series is refused with the reason (`agent.queryLimits`). Comments are removed from the SQL that runs, and backtick identifiers and backslash-escaped quotes are refused: those are where the guard and O2's parser could read a different `LIMIT`. The `LIMIT` check catches the model's mistakes; the hard bounds are the time range and the output budget.
- `ListDashboards` and `ListAlerts` through `tools_call` run at the `full` detail level, the only one with the ids that opening a result needs (`folder_id`, `alert_id`); the result is cut down to each item's ids, name and state (no panels, queries or conditions) before the model sees it. `ListDashboards` without a filter searches every folder (O2 would list only the default one).
- Output is redacted, then cut at `agent.toolOutputChars` with a note that asks the model to narrow the query.

### Command execution (agent runs)

neotags never runs a command in its own process. Skill-pack commands run in the executor sidecar ([executor/README.md](executor/README.md)), which starts a fresh bubblewrap sandbox for each one. With `sandbox.backend: none` (the default) every execution is refused; `sandbox.backend: local` sends executions to the sidecar's unix socket (`sandbox.socket`, default `/run/executor/exec.sock`).

Every execution passes the sandbox guard first (`src/guardrails/sandbox.ts`), in code:

- Only a skill pack whose `SKILL.md` front matter declares `sandbox` can run anything, and only the commands in its `tools` (`argv[0]`, a bare name, no shell). A run can only use its own skill packs (`agent.entries`, or the run's `packs`, which entries set from configuration), so it cannot borrow another pack's hosts or credentials. A declaration that breaks the executor's rules (a path as a tool, a wildcard host, a credential host not in `net`, `cpu: 500m`, `mem` under 16Mi, a bad credential name or header) is dropped when the pack loads; limits above the executor's configured maximums are still refused by the executor.
- The constraints sent to the executor (`net`, `credentials`, `limits`) are the pack's declaration, never the caller's, so a prompt-injected call cannot widen them. The executor checks the request again.
- Env names that would bypass the proxy or shadow a credential placeholder, and file paths outside the work directory, are refused.
- If the executor is unreachable or its self-check failed (`503 sandbox_unavailable`), the execution fails; there is no fallback that runs it some other way. If the request was sent but no answer came (deadline, cancelled run), the outcome is reported as unknown: the command may have run.
- At most `sandbox.maxConcurrency` executions are in flight (default 4; the chart sets it from `executor.maxConcurrency`), the executor's own limit. More wait in arrival order, and a `429 busy` from the executor is sent again with backoff. A call that has no slot after `sandbox.queueTimeoutSec` (default 30) fails as `busy` and did not run; a cancelled run leaves the queue at once. The command's own deadline starts when it is sent, so waiting never shortens it. A call that got no answer (deadline, or cancelled after it was sent) keeps its slot until its deadline: the executor does not stop a command when the client goes away, and reports no in-flight count to release on sooner.

Each execution, refused or not, writes one `sandbox_exec` audit log line with the pack, tool, declared hosts and credential names, the outcome (a refusal's rule or error code), exit code, duration and the wait for a slot (`queueMs`, `busyRetries`; also `neotags.sandbox.queue_ms` / `busy_retries` on the `execute_tool` span), never arguments, input, output or the refusal's text. A run gets the `run_skill_command` tool only when the backend is `local` and one of its packs declares tools. A non-zero exit is returned as an answer (`[exit code 1]`); only a timeout or a signal is a tool error. Its output is redacted and cut at `agent.toolOutputChars`. The O2 gateway creates it (`createSkillExecutor`) and passes it to `createRunManager`.

### LLM traces (OpenObserve / Langfuse)

Each request becomes one OpenTelemetry trace, rooted at an `invoke_agent <entry>` span. `gen_ai.agent.name` and `gen_ai.agent.id` are both the entry (`slack`, `o2`, `job`), so entries can be told apart in one stream; the configured bot name is `neotags.bot.name`, kept out of the agent id because it is a display name and renaming the bot would split an agent's history. `gen_ai.conversation.id` (and `session.id`, which Langfuse groups by) is the conversation: the Slack channel and thread, or the O2 assistant session. Every chat and tool span repeats `gen_ai.conversation.id`, `gen_ai.agent.name` and `gen_ai.agent.id`: OpenObserve reads each span on its own, so its session list sums tokens over the spans that carry the conversation, and its agent views count a chat or tool span without an agent as an orphan. Every span also carries `gen_ai.agent.version`: the skill packs the entry starts with (`agent.entries`), as `name@metadata.version` sorted by name (e.g. `o2-query-assistant@0.4.0`), or neotags' own version for an entry without packs. Without it OpenObserve would take `service.version` (the image tag), and every deploy would be a new agent version even when the packs did not change. The environment comes from the resource (`deployment.environment.name`, below). Every span carries `gen_ai.operation.name` (`invoke_agent`, `chat`, `execute_tool`), which OpenObserve's LLM views filter on.

- **Slack tasks:** `invoke_agent slack` (task id, Slack user) → `intent` (the router's choice: `neotags.intent.skill`, `matched`, `invalid_replies`) and `skill <name>`, each with one `chat <model>` span per gateway call under it.
- **Agent runs** (RunManager; the O2 assistant): `invoke_agent o2` per run, with `neotags.run.id`, `user.id` when the asker is known, and on completion `neotags.run.state` (done, budget_exhausted, failed, cancelled), `neotags.run.reason`, `neotags.run.degraded` (answered by the context package instead of the model), steps, tool calls and token totals. A failed run is an error span with `error.type` = `model_unavailable`, `model_error`, `deadline` or `error`; a cancelled one keeps an OK status with `error.type` = `cancelled` or `interrupted`. Under it, one `chat <model>` span per gateway request (`neotags.llm.phase`: `investigate` with tools, `final` for the tool-less answer at `finalEffort`) and one `execute_tool <tool>` span per tool call (`gen_ai.tool.name`, `gen_ai.tool.call.id`; failed with `error.type` = `tool_denied` when the tool guard refused it, `tool_error` when the tool failed). Run totals are `neotags.run.*`, not `gen_ai.usage.*`: backends sum tokens over a trace's spans, and the chat spans already carry them. A run's span is a trace root, whichever request started it, unless the caller sent a sampled `traceparent` (O2): then it is that trace's child, and an unsampled one becomes a span link, so the run is still recorded. The O2 panel gets the trace id with `complete` and sends it back with feedback.

Chat spans carry the GenAI attributes both backends read: `gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens`, `gen_ai.response.finish_reasons`, plus `neotags.llm.purpose` (router, notes, summary, fileSummary, answer, agent), `neotags.llm.chain` and `neotags.llm.effort` (the `llm.chains` entry that served the call, so failover to the next model is visible) and `neotags.llm.attempt` (`neotags.llm.widened` marks the repeat with a larger output budget). Retries, budget widening and first-token timeouts each get their own span, so every billed call shows up. Latency is the span duration.

Tracing is off unless an OTLP/HTTP endpoint is set with the standard env vars (protobuf; header values URL-encoded, so the space after `Basic` is `%20`):

```sh
# OpenObserve: Data Sources → Custom → Traces → OpenTelemetry shows the URL and the Basic token
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://o2.example.com/api/<org>/v1/traces
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic%20<token>,stream-name=neotags"

# Langfuse: Basic auth is base64("<public key>:<secret key>")
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://langfuse.example.com/api/public/otel/v1/traces
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic%20<base64>"

OTEL_SERVICE_NAME=neotags   # default; a collector can route on it (e.g. one deployment's traces to their own stream)
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=prod,service.version=<image tag>   # optional: tells environments and releases apart (OpenObserve: the agent's env)
```

- **Quality.** Prompts and replies are left off spans by default. `telemetry.captureContent: true` (or `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`) adds them as `gen_ai.input.messages` / `gen_ai.output.messages` (one JSON attribute each, so a long run's prompt stays within the SDK's 128 attributes per span), which OpenObserve shows as a generation's input and output and runs evaluations on; agent runs also get the question and answer on `invoke_agent`, and each tool call's `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`. Everything recorded, and every error message on a span, goes through the same secret redaction as the knowledge base first (an O2 question, its page context and tool output are not redacted upstream) and each value is capped at 32k characters; a chat span's prompt is capped at 256k in all, the oldest turns after the question replaced by a note. Redaction catches token shapes, not meaning: anyone who can read the traces can read the conversations, so restrict who can read the trace stream.
- **Cost.** The gateway's prices are unknown to neotags, so it sends tokens and the backend prices them: in OpenObserve enable model pricing (`ZO_MODEL_PRICING_ENABLED`), in Langfuse define the model's price. Self-hosted model names need a custom price entry in either.
- In Kubernetes, put `OTEL_EXPORTER_OTLP_HEADERS` in `neotags-secrets` and the endpoint in `extraEnv`.
- **Export failures never affect requests.** Batches are sent every 5s in the background; network errors, timeouts and HTTP 429/502/503/504 are retried with backoff within the 10s request timeout (`OTEL_EXPORTER_OTLP_TRACES_TIMEOUT`). A batch that still fails is dropped (no disk buffer) and logged as `trace export failed; spans dropped`, at most once a minute with running counts, then `trace export recovered`. Up to 2048 spans queue while the backend is down; more are dropped and logged. For no loss across long outages, point neotags at an OTel Collector with a persistent queue.

## Secret scanning

Run `make hooks` once after cloning: `.githooks/pre-commit` runs `gitleaks git --staged` and blocks commits with secrets (skips with a warning if gitleaks is missing). CI re-scans full history. Config: `.gitleaks.toml`.

## CI / deploy

- `.github/workflows/ci.yml`: typecheck, tests, build, helm lint/template, docker build, gitleaks.
- `.github/workflows/build-image.yml`: builds a multi-arch (amd64 + arm64) image on free GitHub-hosted runners and pushes it to GHCR (`ghcr.io/<owner>/<repo>`, tag `<git tag>-<sha7>`) with the built-in `GITHUB_TOKEN`; runs on push to `main` and manual dispatch; also reusable via `workflow_call`. Make the package public so the cluster pulls it without credentials.

Deploy (manual): `helm upgrade --install neotags deploy/helm/neotags --set image.repository=ghcr.io/<owner>/<repo> --set image.tag=<tag> -f my-values.yaml`. The Secret `neotags-secrets` (SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, ONYX_API_KEY, LLM_API_KEY; O2_AGENT_API_KEY and the MCP header values for agent runs) must already exist in the namespace. `deploy/helm/neotags/ci/full-values.yaml` shows every optional part switched on:

- **O2 assistant** (`config.o2Gateway.enabled`): a container and Service port `o2` (3001), never on the Ingress; the Service must stay ClusterIP. `networkPolicy.enabled` renders a policy that lets only `networkPolicy.o2Gateway` (OpenObserve's namespace by default) reach it, and only `networkPolicy.slack` (required) reach the Slack port. `networkPolicy.egress` also restricts the Pod's egress (DNS to `networkPolicy.dns` added), which is what bounds the executor's proxy: set it to the LLM gateway, MCP servers, Onyx, the OTLP collector and the hosts skill packs declare.
- **Skill packs** (`skillPacks.configMap`, `skillPacks.items`): a ConfigMap made outside the chart, mounted read-only at `/etc/neotags/skills` (and at `/skills` in the executor); the chart sets `config.skillPacks.dir`. Packs are read at startup: `helm upgrade` rolls the Pod when the ConfigMap's data changed; with `helm template` or a GitOps tool, bump `skillPacks.revision` instead. Listing `config.skillPacks.packs` or `refs` without a ConfigMap and `items` fails the render.
- **Executor sidecar** (`executor.enabled`, executor/README.md "Deploy as a sidecar"): a native sidecar (init container with `restartPolicy: Always`), so its socket is up before neotags starts and it keeps serving while agent runs drain on shutdown; its own image, non-root, read-only root filesystem, without the neotags Secret or a service account token (the Pod's token is mounted into the neotags container only, and EKS credential injection skips the sidecar). The Pod runs with `hostUsers: false` (Kubernetes 1.33+ with user namespaces on the nodes); the sidecar has `seccompProfile: Unconfined`, `procMount: Unmasked` and `EXECUTOR_REQUIRE_PROCFS=1`, so a Pod missing any of them refuses executions rather than running a weaker sandbox. The socket is shared on an `emptyDir` at `/run/executor` (`fsGroup` 65532); the chart sets `config.sandbox` to the local backend, with `maxConcurrency` from `executor.maxConcurrency`. `executor.maxConcurrency` x `executor.maxMemMib` + 256Mi must fit the sidecar's memory limit (the chart refuses to render otherwise); a command that declares no `mem` gets `executor.defaultMemMib` (default `min(512, maxMemMib)`, never above `maxMemMib`), and per-call directories are bounded by `executor.tmpSizeLimit`. Execution credentials (`executor.credentialsSecret`) are mounted at `/etc/executor/credentials`, outside the directory neotags shares with it.
- **Rollout**: `maxSurge: 1`, `maxUnavailable: 0`. `terminationGracePeriodSeconds` defaults to `config.agent.drainSec` + 20 (660) with the O2 gateway on and 30 without; a set value must be at least `drainSec` + 15, or the chart refuses to render.
- **Traces**: `otel.endpoint`, `otel.serviceName`, `otel.resourceAttributes` set the standard `OTEL_*` variables; `config.telemetry.captureContent` decides whether content is recorded.

## License

[Apache License 2.0](LICENSE)
