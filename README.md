# neotags

Self-hosted agent teammate for Slack (GitHub/GitLab later). Mention it (`@moose ...`) to delegate work.
Design: [docs/design/001-knowledge-collection.md](docs/design/001-knowledge-collection.md).

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

Milestone 1 (skeleton): config, Slack Events gateway, dedupe, allowlist guardrail, mention → reply.

## Secret scanning

Run `make hooks` once after cloning: `.githooks/pre-commit` runs `gitleaks git --staged` and blocks commits with secrets (skips with a warning if gitleaks is missing). CI re-scans full history. Config: `.gitleaks.toml`.

## CI / deploy

- `.github/workflows/ci.yml`: typecheck, tests, build, helm lint/template, docker build, gitleaks.
- `.github/workflows/build-image.yml`: builds a multi-arch (amd64 + arm64) image on free GitHub-hosted runners and pushes it to GHCR (`ghcr.io/<owner>/<repo>`, tag `<git tag>-<sha7>`) with the built-in `GITHUB_TOKEN`; runs on push to `main` and manual dispatch; also reusable via `workflow_call`. Make the package public so the cluster pulls it without credentials.

Deploy (manual): `helm upgrade --install neotags deploy/helm/neotags --set image.repository=ghcr.io/<owner>/<repo> --set image.tag=<tag> -f my-values.yaml`. The Secret `neotags-secrets` (SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, ONYX_API_KEY, LLM_API_KEY) must already exist in the namespace.

## License

[Apache License 2.0](LICENSE)
