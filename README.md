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

Implemented (unit-tested with fakes; not yet run against live Slack/Onyx/LLM): Slack Events gateway, LLM intent router, `kb-collect` (record a thread to Onyx with Undo), `kb-files` (index shared PDF/Office/text files), `kb-ask` (answer questions from the KB with citations), configurable OpenAI-compatible LLM gateway.

Try it: invite the bot to a public channel (private channels are off unless `slack.allowPrivateChannels: true`, which also needs the `groups:read` + `groups:history` Slack scopes and makes those entries visible to the whole KB) and, inside a thread, mention it: `@moose record the knowledge`. Needs `LLM_API_KEY`, `llm.model`, `onyx.baseUrl` and `ONYX_API_KEY`. Or DM the bot directly (the manifest enables the app's Messages tab): it answers questions there too — DMs are never recorded to the KB.

### Attachments and questions

- **Collect files.** `@moose save these files` (in a thread, or in a message that carries an upload) reads the PDF, DOCX, XLSX/XLSM, PPTX, CSV/text/log/JSON/YAML and HTML files shared there, redacts secrets, and indexes each as its own Onyx entry (tables become `Column: value` records and each file gets a short LLM-written summary with key facts, `attachments.summarize`) (`neotags-file-<slack file id>`, so repeating it updates rather than duplicates). `record the knowledge` also indexes the thread's files and links them from the thread entry. One Undo removes everything it saved. Needs the `files:read` Slack scope; `attachments.*` in the config sets limits.
- **Ask.** `@moose what does the Q3 report say about churn?` — or the same question in a DM with the bot — searches Onyx (`onyx.searchPath`, key needs `READ_SEARCH`), answers from the retrieved sections only, and cites them. The same entries are searchable in the Onyx UI.
- Not supported yet: images and scanned PDFs (no OCR), legacy `.doc`/`.xls`/`.ppt`, password-protected files.

## Secret scanning

Run `make hooks` once after cloning: `.githooks/pre-commit` runs `gitleaks git --staged` and blocks commits with secrets (skips with a warning if gitleaks is missing). CI re-scans full history. Config: `.gitleaks.toml`.

## CI / deploy

- `.github/workflows/ci.yml`: typecheck, tests, build, helm lint/template, docker build, gitleaks.
- `.github/workflows/build-image.yml`: builds a multi-arch (amd64 + arm64) image on free GitHub-hosted runners and pushes it to GHCR (`ghcr.io/<owner>/<repo>`, tag `<git tag>-<sha7>`) with the built-in `GITHUB_TOKEN`; runs on push to `main` and manual dispatch; also reusable via `workflow_call`. Make the package public so the cluster pulls it without credentials.

Deploy (manual): `helm upgrade --install neotags deploy/helm/neotags --set image.repository=ghcr.io/<owner>/<repo> --set image.tag=<tag> -f my-values.yaml`. The Secret `neotags-secrets` (SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, ONYX_API_KEY, LLM_API_KEY) must already exist in the namespace.

## License

[Apache License 2.0](LICENSE)
