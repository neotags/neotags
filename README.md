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

Implemented (unit-tested with fakes; not yet run against live Slack/Onyx/LLM): Slack Events gateway, LLM intent router, `kb-collect` (record a thread to Onyx with Undo), `kb-files` (index shared PDF/Office/text files), `kb-ask` (answer questions from the KB with citations), configurable OpenAI-compatible LLM gateway, LLM traces over OTLP (OpenObserve / Langfuse).

Try it: invite the bot to a public channel (private channels are off unless `slack.allowPrivateChannels: true`, which also needs the `groups:read` + `groups:history` Slack scopes and makes those entries visible to the whole KB) and, inside a thread, mention it: `@moose record the knowledge`. Needs `LLM_API_KEY`, `llm.model`, `onyx.baseUrl` and `ONYX_API_KEY`. Or DM the bot directly (the manifest enables the app's Messages tab): it answers questions there too — DMs are never recorded to the KB.

### Attachments and questions

- **Collect files.** `@moose save these files` (in a thread, or in a message that carries an upload) reads the PDF, DOCX, XLSX/XLSM, PPTX, CSV/text/log/JSON/YAML and HTML files shared there, redacts secrets, and indexes each as its own Onyx entry (tables become `Column: value` records and each file gets a short LLM-written summary with key facts, `attachments.summarize`) (`neotags-file-<slack file id>`, so repeating it updates rather than duplicates). `record the knowledge` also indexes the thread's files and links them from the thread entry. One Undo removes everything it saved. Needs the `files:read` Slack scope; `attachments.*` in the config sets limits.
- **Ask.** `@moose what does the Q3 report say about churn?` — or the same question in a DM with the bot — searches Onyx (`onyx.searchPath`, key needs `READ_SEARCH`), answers from the retrieved sections only, and cites them. The same entries are searchable in the Onyx UI.
- Switch a skill off with `skills.disabled: [kb-ask]` (or env `NEOTAGS_DISABLED_SKILLS=kb-ask`). It is then not offered by the router, not in the help text, and its buttons stop working. Without `kb-ask`, a question gets the help text.
- Not supported yet: images and scanned PDFs (no OCR), legacy `.doc`/`.xls`/`.ppt`, password-protected files.

### MCP tools (agent runs)

Agent runs get the tools of the MCP servers in `mcp.servers` (Streamable HTTP), named `<server>__<tool>`, for example `o2__SearchSQL`. Each server lists `allowTools`; nothing else is offered to the model. Header values come from env vars (`headersFromEnv: { Authorization: O2_MCP_AUTH }`), never from the file. A server that is down does not stop startup: it is retried in the background, and the system prompt names it until it is back. A call that loses its connection (a restarted server, an expired session) reconnects once and retries. Like the RunManager, the MCP client is not wired to an entry yet: the O2 gateway will start it (`startMcp`) and pass it to `createRunManager`.

Every call passes the tool guard first (`src/guardrails/tools.ts`), in code:

- `tools_call` (O2) runs only an inner tool listed in `innerAllow`; without `innerAllow` it is always refused.
- `argAllow` limits a parameter to listed values, for tools that mix reads and writes, such as `{ alerting_manage_rules: { operation: [list, get] } }`.
- Arguments are capped at `mcp.maxArgChars`.
- `SearchSQL` and `PrometheusRangeQuery`, direct or through `tools_call`: a missing time range becomes the last hour, SQL without a `LIMIT` gets one, and a range query without a step gets about 60 points. A range over 24 hours, a `LIMIT` over 1000 or a step that gives over 1000 points per series is refused with the reason (`agent.queryLimits`). Comments are removed from the SQL that runs, and backtick identifiers and backslash-escaped quotes are refused: those are where the guard and O2's parser could read a different `LIMIT`. The `LIMIT` check catches the model's mistakes; the hard bounds are the time range and the output budget.
- Output is redacted, then cut at `agent.toolOutputChars` with a note that asks the model to narrow the query.

### Command execution (agent runs)

neotags never runs a command in its own process. Skill-pack commands run in the executor sidecar ([executor/README.md](executor/README.md)), which starts a fresh bubblewrap sandbox for each one. With `sandbox.backend: none` (the default) every execution is refused; `sandbox.backend: local` sends executions to the sidecar's unix socket (`sandbox.socket`, default `/run/executor/exec.sock`).

Every execution passes the sandbox guard first (`src/guardrails/sandbox.ts`), in code:

- Only a skill pack whose `SKILL.md` front matter declares `sandbox` can run anything, and only the commands in its `tools` (`argv[0]`, a bare name, no shell). A run can only use its own skill packs (`agent.entries`, or the run's `packs`, which entries set from configuration), so it cannot borrow another pack's hosts or credentials. A declaration that breaks the executor's rules (a path as a tool, a wildcard host, a credential host not in `net`, `cpu: 500m`, `mem` under 16Mi, a bad credential name or header) is dropped when the pack loads; limits above the executor's configured maximums are still refused by the executor.
- The constraints sent to the executor (`net`, `credentials`, `limits`) are the pack's declaration, never the caller's, so a prompt-injected call cannot widen them. The executor checks the request again.
- Env names that would bypass the proxy or shadow a credential placeholder, and file paths outside the work directory, are refused.
- If the executor is unreachable or its self-check failed (`503 sandbox_unavailable`), the execution fails; there is no fallback that runs it some other way. If the request was sent but no answer came (deadline, cancelled run), the outcome is reported as unknown: the command may have run.

Each execution, refused or not, writes one `sandbox_exec` audit log line with the pack, tool, declared hosts and credential names, the outcome (a refusal's rule or error code), exit code and duration, never arguments, input, output or the refusal's text. A run gets the `run_skill_command` tool only when the backend is `local` and one of its packs declares tools. A non-zero exit is returned as an answer (`[exit code 1]`); only a timeout or a signal is a tool error. Its output is redacted and cut at `agent.toolOutputChars`. Like the MCP client, it is not wired to an entry yet: the O2 gateway will create it (`createSkillExecutor`) and pass it to `createRunManager`.

### LLM traces (OpenObserve / Langfuse)

Each request becomes one OpenTelemetry trace, rooted at an `invoke_agent <entry>` span. `gen_ai.agent.name` is the entry (`slack`, `o2`, `job`), so entries can be told apart in one stream; the configured bot name is `neotags.bot.name`. `gen_ai.conversation.id` (and `session.id`, which Langfuse groups by) is the conversation: the Slack channel and thread, or the O2 assistant session. Every chat and tool span repeats `gen_ai.conversation.id`: OpenObserve's session list sums tokens over the spans that carry it. Every span carries `gen_ai.operation.name` (`invoke_agent`, `chat`, `execute_tool`), which OpenObserve's LLM views filter on.

- **Slack tasks:** `invoke_agent slack` (task id, Slack user) → `intent` (the router's choice: `neotags.intent.skill`, `matched`, `invalid_replies`) and `skill <name>`, each with one `chat <model>` span per gateway call under it.
- **Agent runs** (RunManager; the O2 assistant): `invoke_agent o2` per run, with `neotags.run.id`, `user.id` when the asker is known, and on completion `neotags.run.state` (done, budget_exhausted, failed, cancelled), `neotags.run.reason`, `neotags.run.degraded` (answered by the context package instead of the model), steps, tool calls and token totals. A failed run is an error span with `error.type` = `model_unavailable`, `model_error`, `deadline` or `error`; a cancelled one keeps an OK status with `error.type` = `cancelled` or `interrupted`. Under it, one `chat <model>` span per gateway request (`neotags.llm.phase`: `investigate` with tools, `final` for the tool-less answer at `finalEffort`) and one `execute_tool <tool>` span per tool call (`gen_ai.tool.name`, `gen_ai.tool.call.id`; failed with `error.type` = `tool_denied` when the tool guard refused it, `tool_error` when the tool failed). Run totals are `neotags.run.*`, not `gen_ai.usage.*`: backends sum tokens over a trace's spans, and the chat spans already carry them. A run's span is always a trace root, whichever request started it.

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
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=prod   # optional: more resource attributes, e.g. to tell environments apart
```

- **Quality.** Prompts and replies are left off spans by default. `telemetry.captureContent: true` (or `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`) adds them as `gen_ai.prompt.N.*` / `gen_ai.completion.0.*`, the shape OpenObserve and Langfuse show as a generation's input and output and run evaluations on; agent runs also get the question and answer on `invoke_agent`, and each tool call's `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`. Everything recorded, and every error message on a span, goes through the same secret redaction as the knowledge base first (an O2 question, its page context and tool output are not redacted upstream) and each value is capped at 32k characters. Redaction catches token shapes, not meaning: anyone who can read the traces can read the conversations, so restrict who can read the trace stream.
- **Cost.** The gateway's prices are unknown to neotags, so it sends tokens and the backend prices them: in OpenObserve enable model pricing (`ZO_MODEL_PRICING_ENABLED`), in Langfuse define the model's price. Self-hosted model names need a custom price entry in either.
- In Kubernetes, put `OTEL_EXPORTER_OTLP_HEADERS` in `neotags-secrets` and the endpoint in `extraEnv`.
- **Export failures never affect requests.** Batches are sent every 5s in the background; network errors, timeouts and HTTP 429/502/503/504 are retried with backoff within the 10s request timeout (`OTEL_EXPORTER_OTLP_TRACES_TIMEOUT`). A batch that still fails is dropped (no disk buffer) and logged as `trace export failed; spans dropped`, at most once a minute with running counts, then `trace export recovered`. Up to 2048 spans queue while the backend is down; more are dropped and logged. For no loss across long outages, point neotags at an OTel Collector with a persistent queue.

## Secret scanning

Run `make hooks` once after cloning: `.githooks/pre-commit` runs `gitleaks git --staged` and blocks commits with secrets (skips with a warning if gitleaks is missing). CI re-scans full history. Config: `.gitleaks.toml`.

## CI / deploy

- `.github/workflows/ci.yml`: typecheck, tests, build, helm lint/template, docker build, gitleaks.
- `.github/workflows/build-image.yml`: builds a multi-arch (amd64 + arm64) image on free GitHub-hosted runners and pushes it to GHCR (`ghcr.io/<owner>/<repo>`, tag `<git tag>-<sha7>`) with the built-in `GITHUB_TOKEN`; runs on push to `main` and manual dispatch; also reusable via `workflow_call`. Make the package public so the cluster pulls it without credentials.

Deploy (manual): `helm upgrade --install neotags deploy/helm/neotags --set image.repository=ghcr.io/<owner>/<repo> --set image.tag=<tag> -f my-values.yaml`. The Secret `neotags-secrets` (SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, ONYX_API_KEY, LLM_API_KEY) must already exist in the namespace.

## License

[Apache License 2.0](LICENSE)
