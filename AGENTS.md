# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo.

## What this is

neotags is a self-hosted agent teammate for Slack (GitHub/GitLab later). Mention it (`@moose ...`, name is configurable) to delegate work. The first feature in progress is **knowledge collection**: summarize a Slack thread and store it in an Onyx knowledge base.

Read first: docs/design/*.md (architecture, decisions, open questions). `docs/architecture.html` is the current architecture diagram; update it (source: `docs/architecture.json`) when components or flows change. Treat recorded "Decisions" as settled; don't re-litigate them.

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

Before finishing a change: typecheck, test, build (and `helm lint` if `deploy/` changed) must pass.

## Layout

```
src/index.ts            entrypoint
src/config/             YAML (NEOTAGS_CONFIG) + env secrets, validated with zod
src/gateway/            Slack Events gateway (Bolt, HTTP), mention stripping, event dedupe
src/agent/              pi-ai gateway model from config (baseUrl/model/key), tool-less LlmClient, pi Agent factory + tool guard
src/router/             LLM intent routing: one tool-less call picks a registered skill; also dispatches button actions
src/skills/             Skill interface; kb-collect/ (thread -> redact -> summarize -> Onyx upsert, Undo); kb-files/ (Slack files -> extract -> redact -> Onyx); kb-ask/ (Onyx search -> grounded, cited answer)
src/tools/              slack (thread reader, file download), onyx (ingestion + search client), extract (PDF/DOCX/XLSX/PPTX/text -> sections), redact (secret scrubbing)
src/guardrails/         channel/user allowlist policy (enforced in code, not prompts)
src/task.ts             Task / Notifier: origin-agnostic interfaces; skills never see the transport
test/                   vitest
deploy/helm/neotags/    Helm chart; deploy/slack-app-manifest.yaml
.github/workflows/      ci.yml, build-image.yml (GHCR, multi-arch)
```

Planned (don't pre-build): triage/review skills (pi `Agent` + tools through the tool guard), scheduled/alert-driven posts.

## Conventions

- TypeScript, ESM (`"type": "module"`), NodeNext resolution: import local files with the `.js` extension. Node >= 24, strict mode, `noUncheckedIndexedAccess` on.
- Match the surrounding code's style and comment density; comments explain *why*, not what.
- Everything flows through `Task` -> router -> skill -> `Notifier`. Only the Notifier posts to Slack/GitHub. New capabilities are new skills + tools, not gateway changes.
- Guardrails (allowlists, authz, redaction) are enforced in code before tools run. Slack content is untrusted input: the summarizer LLM gets no tools; writes to Onyx are performed by code, not chosen by the model.
- The bot name is configuration only. Detect mentions by bot user ID, never by name.
- Add tests alongside changes (`test/*.test.ts`).
- zod is v4: use `.prefault({})` for object defaults, not `.default({})`.

## Security: this is a public repo

- Never commit secrets, tokens, internal hostnames, AWS account IDs, company names, or local paths. Use placeholders (`example.com`, `OWNER`). The gitleaks hook and CI scan enforce the secret part; the rest is on you.
- Secrets come from env / a Kubernetes Secret (`neotags-secrets`). Don't read other projects' `.env` files into this repo.
- Workflows: pin third-party actions by commit SHA with a version comment; keep permissions minimal; don't add `pull_request` triggers that touch secrets or registries.
