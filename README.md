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

### LLM traces (OpenObserve / Langfuse)

Each request becomes one OpenTelemetry trace: `invoke_agent <bot>` (task id, Slack user, `session.id` = channel + thread) → `intent` (the router's choice: `neotags.intent.skill`, `matched`, `invalid_replies`) and `skill <name>`, each with one `chat <model>` span per gateway call under it, retries and budget widening included, so every billed call shows up. Chat spans carry the GenAI attributes both backends read: `gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens`, `gen_ai.response.finish_reasons`, plus `neotags.llm.purpose` (router, notes, summary, fileSummary, answer), `neotags.llm.chain` and `neotags.llm.effort` (the `llm.chains` entry that served the call, so failover to the next model is visible) and `neotags.llm.attempt`. Latency is the span duration.

Tracing is off unless an OTLP/HTTP endpoint is set with the standard env vars (protobuf; header values URL-encoded, so the space after `Basic` is `%20`):

```sh
# OpenObserve: Data Sources → Custom → Traces → OpenTelemetry shows the URL and the Basic token
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://o2.example.com/api/<org>/v1/traces
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic%20<token>,stream-name=neotags"

# Langfuse: Basic auth is base64("<public key>:<secret key>")
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://langfuse.example.com/api/public/otel/v1/traces
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic%20<base64>"

OTEL_SERVICE_NAME=neotags   # default
```

- **Quality.** Prompts and replies are left off spans by default. `telemetry.captureContent: true` (or `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`) adds them as `gen_ai.prompt.N.*` / `gen_ai.completion.0.*`, the shape OpenObserve and Langfuse show as a generation's input and output and run evaluations on. They are already redacted, but they are Slack threads and files: anyone who can read the traces can read them.
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
