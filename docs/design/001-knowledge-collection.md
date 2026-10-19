# neotags — Design 001: Knowledge Collection (Slack → Onyx)

Status: **Draft v2 (decisions in §12)** · Date: 2026-10-18

## 1. Context

neotags is a self-hosted agent teammate (Slack + GitHub/GitLab bot) running in our EKS cluster, a self-hosted alternative to Claude Tag. It is the "Slack bot" box of the L2/L3 *Agentic SRE Platform* diagram: Slack events in, SRE Agent (pi-agent-core) in the middle, Onyx and observability tools behind it.

The bot's display name is configurable (`@neotags`, `@moose`, ...). Nothing in the code may hardcode it.

Long-term capabilities (not in this design): incident triage, online troubleshooting, MR/PR review, daily summaries, general delegated tasks.

**This design covers only the first feature: knowledge collection.**

> In a Slack thread: `@moose record the knowledge` → the agent reads the thread, writes a structured summary, stores it in the Onyx-backed knowledge base, and replies in the thread with the result and a link.

It also lays down the platform skeleton (Slack gateway, agent runtime, tool/skill model, config, audit) that later features plug into, but builds nothing speculative beyond that.

## 2. Goals / non-goals

Goals
- Mention-triggered, in-thread knowledge capture; result visible in Onyx search within minutes.
- Idempotent: recording the same thread twice updates the same KB document rather than duplicating it.
- Safe by default: no private content leaks into a broadly searchable KB; secrets are redacted.
- Bot name, allowed channels and Onyx target are configuration, not code.
- Skeleton is reusable: a new capability = a new skill + tools, no gateway changes.

Non-goals (v1)
- GitHub/GitLab handling, alert webhooks, scheduler, daily summaries.
- Editing/curating KB entries in Slack beyond Undo.
- Multi-workspace Slack (single workspace).
- Bulk backfill of old threads (Onyx's built-in Slack connector already does raw indexing; we add *curated* summaries).

## 3. Architecture

```
 Slack ──Events API (HTTP)──▶ ┌──────────────── neotags (Deployment in EKS) ────────────────┐
 (mention, button click)      │ 1 Slack gateway   verify signature, ack <3s, dedupe event_id │
                              │        │ enqueue (in-process queue v1)                       │
                              │ 2 Router          strip mention, pick skill                  │
                              │        │                                                     │
                              │ 3 Agent runtime   pi-agent-core loop (LLM ⇄ tools)           │
                              │    skill: kb-collect                                         │
                              │      tools: slack.read_thread · redact · onyx.ingest ·       │
                              │             onyx.delete · slack.reply                        │
                              │ 4 Guardrails      channel allowlist · authz · audit log      │
                              └───────┬───────────────────────────┬──────────────────────────┘
                                      │ Slack Web API             │ HTTPS
                                      ▼                           ▼
                                    Slack                  Onyx ingestion API ──▶ index ──▶ search / MCP
                                                           (+ Claude API for summarization)
```

Components
1. **Slack gateway** — Slack Bolt. Verifies signing secret, acks within 3 s, drops duplicate `event_id`s (Slack retries), turns `app_mention` and `block_actions` into internal `Task`s.
2. **Router** — removes the bot mention, then picks a skill. v1: a cheap LLM/keyword intent match against the registered skills' descriptions (only `kb-collect` exists; anything else gets a friendly "I can't do that yet"). The router is where future skills register.
3. **Agent runtime** — pi-agent-core, consistent with the SRE Agent in the diagram. A skill is a prompt + a set of allowed tools. For `kb-collect` the flow is mostly deterministic; the LLM is used for summarization, not for deciding whether to write.
4. **Guardrails** — enforced in code before any tool runs, never delegated to the prompt.

Language: **TypeScript / Node** (pi is TypeScript; one runtime with the future SRE Agent). See open question Q1.

## 4. Knowledge-collection flow

1. User replies in a thread: `@moose record the knowledge` (optionally with a hint: `...focus on the root cause`).
2. Gateway acks; bot adds 👀 reaction to the trigger message.
3. Guardrails check: channel is public and allowlisted (or explicitly opted in), user is allowed, bot is a member of the channel.
4. `slack.read_thread` fetches all replies (paginated), resolves user IDs → display names, `<@U123>` mentions, permalinks, and file/attachment names (v1: text only; file contents skipped, filenames listed).
5. `redact` removes secrets before anything goes to the LLM or Onyx: token/key regexes (AWS keys, `xox*`, `ghp_*`, JWTs, private key blocks, `password=`), plus an entropy check. Redactions are counted and noted in the summary footer.
6. LLM summarizes into the fixed schema below. Output is validated against a JSON schema; one retry on invalid output.
7. `onyx.ingest` upserts the document (see §5).
8. Bot replies in-thread with the summary, a link to the KB entry, and an **Undo** button; ✅ replaces 👀. On failure: ❌ plus a short reason (full detail only in logs).

### Summary schema

| Field | Notes |
|---|---|
| `title` | Short, searchable, states the problem (not "Thread about X") |
| `type` | `incident` · `troubleshooting` · `howto` · `decision` · `other` |
| `summary` | 2–4 sentences |
| `symptoms` / `problem` | What was observed, with error strings verbatim |
| `root_cause` | Or "unknown" — never invented |
| `resolution` | Steps taken, commands verbatim in code blocks |
| `follow_ups` | Open actions / unresolved questions |
| `services`, `tags` | For metadata filtering |
| `participants` | Display names |
| `confidence` | `high/medium/low`; low when the thread has no clear conclusion |

The prompt must instruct: only state what the thread supports; mark unknowns explicitly. Rendered as Markdown into Onyx sections.

## 5. Onyx integration

Use the Onyx **ingestion API** (the same one the diagram labels "write back incident summaries"), authenticated with an API key held in a Kubernetes Secret.

Document shape (**verified against Onyx `v5.0.0-beta.1` source**, `backend/onyx/server/onyx_api/ingestion.py`; request body is `{document, cc_pair_id?}`):

```jsonc
{
  "document": {
    "id": "neotags-slack-<channel_id>-<thread_ts>",   // deterministic ⇒ idempotent upsert
    "semantic_identifier": "<title>",
    "source": "ingestion_api",
    "sections": [{ "text": "<markdown>", "link": "<slack thread permalink>" }],
    "metadata": { "type": "incident", "services": [...], "tags": [...], "channel": "#sre-oncall",
                  "recorded_by": "<display name>", "origin": "neotags" },
    "doc_updated_at": "<iso8601>"
  }
}
```

- **Re-record** (same thread, later, with new replies) overwrites the same document ⇒ the KB entry improves rather than duplicates.
- **Undo** calls delete by the same ID.
- Always include the Slack permalink so readers can reach the source discussion.
- Verified API facts: `POST /onyx-api/ingestion` upserts by `document.id` and returns `{document_id, already_existed}`; `DELETE /onyx-api/ingestion/{id}` only deletes docs created via the ingestion API. `metadata` values must be strings or lists of strings (we stringify everything). `source` may be omitted. `doc_updated_at` defaults to now.
- Auth: the endpoints require the **`MANAGE_CONNECTORS`** permission, so neotags needs an Onyx API key/service account holding it (least privilege: scoped to the target cc-pair if group scoping is available in 5.0).
- Target: `cc_pair_id` defaults to **1, the public default pair**, which matches "visible to everyone" for now. For OIDC-based ACLs later, create a dedicated cc-pair and set `cc_pair_id` in config. Delete/re-ingest must use a principal with EDIT access to the doc's cc-pair(s).
- Visibility: ingestion-API docs land in a dedicated connector/cc-pair; document-set and who can see it is decided in Q3. Until then v1 only accepts **public channels**.

## 6. Configuration

```yaml
bot:
  name: moose                 # display name only; matching uses bot user ID from auth.test
slack:
  mode: events-http           # or socket
  allowed_channels: ["C0123…"]   # empty = all public channels the bot is in
  allowed_users: []           # empty = everyone in workspace
onyx:
  base_url: https://onyx.example.com
  ingestion_path: /api/ingestion
  cc_pair_id: 1
  api_key_secret: onyx-api-key
llm:
  model: claude-sonnet-5-5
  summarize_max_input_tokens: 60000
redaction:
  extra_patterns: []
```

Mention detection uses the bot's **user ID**, so renaming the bot (Slack app display name) requires no code or deploy. The name is only used in reply text and help output. Long threads over the token budget are summarized in chunks (map → reduce).

## 7. Deployment (EKS)

- One `Deployment`, 1 replica by default: the Slack event dedupe is in-memory per pod. More replicas are safe for kb-collect (deterministic Onyx IDs make duplicate delivery harmless) but not for non-idempotent skills until dedupe moves to a shared store. Graceful shutdown drains in-flight tasks (20s) on SIGTERM.
- Ingress → Slack Events API endpoint (needs a public HTTPS URL; if that is not acceptable, use Socket Mode, which needs only egress).
- Secrets (Slack bot token, signing secret, Onyx key, Anthropic key) via our existing secret mechanism; IRSA for any AWS access.
- Stateless in v1: no database. Add Postgres/Redis when we need sessions, schedules or durable queues.
- Observability: structured JSON logs, Prometheus metrics (`neotags_tasks_total{skill,status}`, latency, LLM tokens, Onyx errors), shipped through the existing L1 stack.
- Helm chart in `deploy/`; GitLab CI via the repo's standard pipeline.

## 8. Security & audit

- Least-privilege Slack scopes. Milestone 1: `app_mentions:read`, `chat:write`, `reactions:write`. Added with thread reading (milestone 2): `channels:history`, `channels:read`, `users:read`. No private-channel/DM scopes in v1.
- Denied requests (channel/user not allowlisted) get a quiet 🚫 reaction rather than a public reply.
- Channel allowlist + user allowlist enforced in the gateway.
- Redaction before LLM and before storage; Slack content is treated as untrusted input (prompt injection): the summarizer has no tools, the thread is delimited as data, and the write action is performed by code, not chosen by the model.
- Audit record per task: who, channel, thread, skill, Onyx doc ID, redaction count, outcome. Logs contain no thread bodies.
- Retention: deleting the KB doc (Undo, or admin via Onyx) is the removal path; Slack-side deletions are not propagated in v1.

## 9. Repo layout (proposed)

```
src/
  gateway/slack.ts         # Bolt app, signature, dedupe, event → Task
  router/                  # intent → skill registry
  agent/                   # pi-agent-core wiring
  skills/kb-collect/       # prompt.md, schema.ts, skill.ts
  tools/{slack,onyx,redact}.ts
  guardrails/              # channel/user policy, audit
  config/
deploy/helm/
docs/design/
test/
```

## 10. Testing

- Unit: redaction patterns, schema validation, mention stripping, deterministic doc ID, thread pagination.
- Contract: Onyx and Slack clients against recorded fixtures.
- Golden tests: a handful of real (sanitized) threads → summary checked against schema and key facts.
- E2E in a test workspace/channel against a non-prod Onyx.

## 11. Milestones

1. Skeleton: config, Slack gateway, health endpoint, mention → "pong"; deployed to EKS.
2. `slack.read_thread` + redaction + summarizer producing the schema (print in thread, no Onyx write).
3. Onyx ingest/delete, Undo button, idempotent re-record.
4. Guardrails, audit, metrics, Helm chart, runbook.

## 12. Decisions

| # | Decision |
|---|---|
| Q1 | **TypeScript on pi.** pi is TypeScript, and the SRE Agent is built on it, so we share runtime, tools and skills. Bolt (Slack) and Octokit/Probot (GitHub) are first-class in TS. The work is I/O-bound LLM orchestration, so Go/Rust performance gains are irrelevant, and Rust would add cost without benefit. Choose Go only if the team won't maintain TS; you'd then lose pi and rebuild the agent loop. |
| Q2 | **Bidirectional from day one.** Inbound: Slack events/interactions (and later GitHub/GitLab webhooks). Outbound: agent-initiated posts (alerts, weekly reports) via a `notify` capability. Transport: **Slack Events API over HTTP**, since webhooks (alerts, GitHub) need an HTTP ingress anyway; Socket Mode is kept as a dev fallback. See §13. |
| Q3 | **KB visible to everyone for now.** Docs are written with a `slack_user`/`channel` metadata so Slack-user → Onyx-user (OIDC) ACLs can be added later without re-ingesting. Public channels only until then. |
| Q4 | Onyx **5.0 beta**, namespace `onyx`. Payload and auth verified from source at tag `v5.0.0-beta.1` (§5); only a live smoke test remains (milestone 3). |
| Q5 | **Auto-save + Undo.** |
| Q6 | **LLM-based intent routing** (the router is an LLM call choosing among registered skills, or "none/ask clarification"). |
| Q7 | **Summaries always in English**, whatever the thread language; verbatim error strings/commands stay untranslated. |

## 13. Bidirectional model (impact of Q2)

Everything flows through one internal `Task` abstraction, so skills don't care about origin:

```
Triggers (inbound)                          Outputs (outbound)
 Slack app_mention / button  ─┐             ┌─ Slack: reply in thread / post to channel / DM
 Alert webhook (later)        ├─▶ Router ─▶ Skill ─▶ Notifier ─┤ GitHub/GitLab: comment / review (later)
 Scheduler (cron, later)      ─┘             └─ Onyx: ingest/delete
```

- `Task { source, actor, channel/thread ref, text, reply_target }`. `reply_target` is where results go; for scheduled/alert tasks it is a configured channel rather than a thread.
- **Notifier** is the only component that posts to Slack/GitHub, and all outbound goes through the same guardrails and audit log.
- For v1 only the Slack mention source and the Slack thread notifier are built. Webhook ingress, scheduler and GitHub notifier are later additions that don't change the Task/Skill interfaces.
- Skills may return follow-up interaction (buttons) which come back in as new inbound Tasks, which is how Undo works.

## 14. Onyx live check (2026-10-18)

- Verified against a staging Onyx 5.0 beta instance (cc-pair `1`, same as our existing Confluence ingestor). The API key is kept out of the repo; neotags gets its own key via a K8s Secret.
- Read-only `GET /api/ingestion` with the key returned **200** and lists existing Confluence docs, so the key has `MANAGE_CONNECTORS`.
- The gateway exposes the ingestion API at **`/api/ingestion`** (`/onyx-api/ingestion` returns 404). The config therefore uses `onyx.ingestion_path: /api/ingestion`; POST/DELETE (`/api/ingestion/{id}`) follow the same prefix and will be confirmed by the milestone 3 write test.
- Doc IDs from other ingestors are namespaced (`confluence-<id>`); ours are `neotags-slack-...`, so no collisions and they're easy to filter.

## 15. Remaining open questions

- Ask for a **separate API key for neotags** (recommended, so it can be revoked independently).
- `kubectl` in my shell is broken (`_aws_sso_ensure` missing); not needed for v1 development.
