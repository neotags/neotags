# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo.

## What this is

neotags is a self-hosted agent teammate for Slack (GitHub/GitLab later). Mention it (`@moose ...`, name is configurable) to delegate work. The first feature in progress is **knowledge collection**: summarize a Slack thread and store it in an Onyx knowledge base.

Read first: docs/design/*.md (architecture, decisions, open questions). `docs/architecture.html` is the current architecture diagram; update it (source: `docs/architecture.json`) when components or flows change. It is rendered by [archify](https://github.com/tt-a1i/archify) 3.2.0 (commit `a4065941f1` reproduces the committed HTML byte for byte): `node <archify>/archify/bin/archify.mjs finalize architecture architecture.json architecture.html --quality showcase --json`, run in a scratch directory on a copy whose `meta.output` is `architecture.html`, then copy the HTML back. Every gate must pass. Treat recorded "Decisions" as settled; don't re-litigate them.

## Commands

```sh
npm ci
npm run typecheck      # tsc --noEmit
npm test               # vitest
npm run build          # tsc -> dist/
npm run dev            # tsx watch; needs SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET (see README)
helm lint deploy/helm/neotags --set image.repository=ghcr.io/neotags/neotags --set image.tag=lint
make hooks             # once per clone: enable gitleaks pre-commit
make secrets           # gitleaks scan of history
```

Before finishing a change: typecheck, test, build (and `helm lint` if `deploy/` changed) must pass. If `executor/` changed, also run `cd executor && python3 -m unittest discover -s tests -t .`; the sandbox tests need the test image (executor/README.md, "Build and test").

## Layout

```
src/index.ts            entrypoint
src/config/             YAML (NEOTAGS_CONFIG) + env secrets, validated with zod
src/gateway/            Slack Events gateway (Bolt, HTTP), mention stripping, event dedupe; o2.ts: OpenObserve assistant entry (:3001, SSE, docs/design/002), o2-stream.ts: RunObserver -> panel events
src/agent/              pi-ai gateway model from config (baseUrl/model/key), tool-less LlmClient, pi Agent factory + tool guard
src/runs/               RunManager (state machine, concurrency, per-session lock, budgets, rate limit, drain) + AgentRunner (pi-agent-core); the O2 gateway submits to it
src/router/             LLM intent routing: one tool-less call picks a registered skill; also dispatches button actions
src/skills/             Skill interface; kb-collect/ (thread -> redact -> summarize -> Onyx upsert, Undo); kb-files/ (Slack files -> extract -> redact -> Onyx); kb-ask/ (Onyx search -> grounded, cited answer)
src/tools/              slack (thread reader, file download), onyx (ingestion + search client), extract (PDF/DOCX/XLSX/PPTX/text -> sections), redact (secret scrubbing), skillpacks (allowlisted Agent Skills loader + read_skill tools)
src/telemetry/          OpenTelemetry setup (OTLP via OTEL_* env) and GenAI spans: invoke_agent per task / run -> chat per LLM request, execute_tool per tool call; content redacted
src/guardrails/         channel/user allowlist policy; MCP tool guard (tools.ts: allowlists, tools_call inner names, argAllow, query limits, output redaction); sandbox guard (sandbox.ts: only a pack's declared `sandbox` tools, its declaration as the constraints); enforced in code, not prompts
src/sandbox/            Sandbox interface; backend local (executor sidecar over a unix socket) or none (refuse all); SkillExecutor = sandbox guard + audit; run_skill_command tool
src/mcp/                MCP clients (Streamable HTTP): allowlisted tools as pi AgentTools named <server>__<tool>, background reconnect, unavailable servers named in the system prompt
src/task.ts             Task / Notifier: origin-agnostic interfaces; skills never see the transport
src/lang.ts             answer language rule (D13), shared by every entry: answerLang() for code-written text, LANGUAGE_RULE for prompts
test/                   vitest
deploy/helm/neotags/    Helm chart; deploy/slack-app-manifest.yaml
executor/               executor sidecar image (Python stdlib + bubblewrap): sandboxed /v1/exec over a unix socket, own unittest suite; see executor/README.md
.github/workflows/      ci.yml, build-image.yml (GHCR, multi-arch); executor-check.yml (reusable: Trivy + sandbox tests per arch), build-executor-image.yml (GHCR neotags-executor)
```

Planned (don't pre-build): triage/review skills (pi `Agent` + tools through the tool guard), scheduled/alert-driven posts.

## Conventions

- TypeScript, ESM (`"type": "module"`), NodeNext resolution: import local files with the `.js` extension. Node >= 24, strict mode, `noUncheckedIndexedAccess` on.
- Match the surrounding code's style and comment density; comments explain *why*, not what.
- Everything flows through `Task` -> router -> skill -> `Notifier`. Only the Notifier posts to Slack/GitHub. New capabilities are new skills + tools, not gateway changes.
- Guardrails (allowlists, authz, redaction) are enforced in code before tools run. Slack content is untrusted input: the summarizer LLM gets no tools; writes to Onyx are performed by code, not chosen by the model.
- Every LLM call is traced: one-shot calls go through `LlmClient` (`createLlm`), tool-using agents through `createAgent` or the RunManager's `PiAgentRunner`; each emits a `chat <model>` span per gateway request and an `execute_tool` span per tool call (`src/telemetry/spans.ts`). Don't call `gateway.models.complete` / `streamSimple` directly; a new call path must use `startChatSpan` / `endChatSpan` with a `purpose`, and a test that checks its span. Prompts, replies and tool input/output go on spans only behind `telemetry.captureContent`, and only through `recorded()` (redaction).
- The bot name is configuration only. Detect mentions by bot user ID, never by name.
- Add tests alongside changes (`test/*.test.ts`).
- zod is v4: use `.prefault({})` for object defaults, not `.default({})`.

## Security: this is a public repo

- Never commit secrets, tokens, internal hostnames, AWS account IDs, company names, or local paths. Use placeholders (`example.com`, `OWNER`). The gitleaks hook and CI scan enforce the secret part; the rest is on you.
- Secrets come from env / a Kubernetes Secret (`neotags-secrets`). Don't read other projects' `.env` files into this repo.
- Workflows: pin third-party actions by commit SHA with a version comment; keep permissions minimal; don't add `pull_request` triggers that touch secrets or registries.
