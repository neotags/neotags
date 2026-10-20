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
- Safe by default: private-channel content is not recorded into a broadly searchable KB unless explicitly enabled (`slack.allowPrivateChannels`); secrets are redacted.
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
                                                           (+ OpenAI-compatible LLM gateway)
```

Components
1. **Slack gateway** — Slack Bolt. Verifies signing secret, acks within 3 s, drops duplicate `event_id`s (Slack retries), turns `app_mention`, DM `message.im` and `block_actions` into internal `Task`s. (`allowedChannels` does not apply to DMs — each DM has its own D-channel id — but `allowedUsers` does.)
2. **Router** — removes the bot mention, then picks a skill. v1: a cheap LLM/keyword intent match against the registered skills' descriptions (only `kb-collect` exists; anything else gets a friendly "I can't do that yet"). The router is where future skills register.
3. **Agent runtime** — pi-agent-core, consistent with the SRE Agent in the diagram. A skill is a prompt + a set of allowed tools. For `kb-collect` the flow is mostly deterministic; the LLM is used for summarization, not for deciding whether to write.
4. **Guardrails** — enforced in code before any tool runs, never delegated to the prompt.

Language: **TypeScript / Node** (pi is TypeScript; one runtime with the future SRE Agent). See open question Q1.

## 4. Knowledge-collection flow

1. User replies in a thread: `@moose record the knowledge` (optionally with a hint: `...focus on the root cause`).
2. Gateway acks; bot adds 👀 reaction to the trigger message.
3. Guardrails check: channel is public and allowlisted (or explicitly opted in), user is allowed, bot is a member of the channel.
4. `slack.read_thread` fetches all replies (paginated), resolves user IDs → display names, `<@U123>` mentions, permalinks, and file/attachment names (v1: text only; file contents skipped, filenames listed).
5. **Prepare** (`src/skills/kb-collect/prepare.ts`): drop low-signal messages (pure acknowledgements such as "👍"/"thanks"; empties) but keep confirmations like "done"/"fixed"; collapse repeated bot alerts into one message with a count; redact secrets per message (token/key regexes, `password=` assignments, URL credentials, an entropy check; the count is reported in the doc); clip absurdly long messages; number what is left as `#1…#n` so the summary can cite messages.
6. **Summarize** (`summary.ts`): if the transcript fits the prompt budget, one tool-less LLM call fills the schema below. Longer threads use **map-reduce**: each consecutive part yields working notes (symptoms, what was tried and ruled out, findings, actions, key messages), then one final call turns the ordered notes plus the opening and closing messages into the summary. Parts run with bounded concurrency (3). Beyond 8 parts the thread is thinned first: least informative messages go first, from the middle outward, technical content last, always keeping the opening and the last few messages. Output is validated; one retry on invalid output.
7. **Store**: `onyx.ingest` upserts the document (see §5) with two sections: the Markdown summary, and a verbatim "key excerpts" section (errors, commands, links, conclusions) so exact-match search works even when the summary paraphrases. The `evidence` message numbers the model cites are validated and rendered as "Key messages" with Slack permalinks.
8. Bot replies in-thread with the summary, a link to the KB entry, and an **Undo** button; ✅ replaces 👀. On failure: ❌ plus a short reason (full detail only in logs).

### Summary schema

| Field | Notes |
|---|---|
| `title` | Short, searchable, states the problem (not "Thread about X") |
| `type` | `incident` · `troubleshooting` · `howto` · `decision` · `other` |
| `summary` | 2–4 sentences |
| `problem` | What was observed, with error strings verbatim |
| `root_cause` | Or "unknown" — never invented |
| `resolution` | Steps taken, commands verbatim in code blocks |
| `ruled_out` | Hypotheses tried and disproved, and why (what a future reader would otherwise retry) |
| `outcome` | `resolved` · `mitigated` · `unresolved` · `unknown` (also stored as Onyx metadata for filtering) |
| `follow_ups` | Open actions / unresolved questions, with owners when stated |
| `services`, `tags` | For metadata filtering |
| `evidence` | Up to 6 message numbers that support the cause and resolution; hallucinated numbers are dropped |
| `confidence` | `high/medium/low`; low when the thread has no clear conclusion |

Participants are computed from the thread, not generated. Titles are capped at 80 characters in the prompt. Documents carry `schema_version` metadata (currently `2`) so entries can be found and re-summarized when the layout or prompt changes.

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
- Visibility: ingestion-API docs land in a dedicated connector/cc-pair; document-set and who can see it is decided in Q3. Until ACLs exist, entries are visible to everyone who can search the KB, so v1 records **public channels** by default; private channels are an explicit opt-in (`slack.allowPrivateChannels`, see §8). DMs and group DMs are never recorded.

## 6. Configuration

```yaml
bot:
  name: moose                 # display name only; matching uses bot user ID from auth.test
slack:
  mode: events-http           # or socket
  allowed_channels: ["C0123…"]   # empty = all channels the bot is in
  allowed_users: []           # empty = everyone in workspace
onyx:
  base_url: https://onyx.example.com
  ingestion_path: /api/ingestion
  cc_pair_id: 1
  api_key_secret: onyx-api-key
llm:                          # any OpenAI-compatible gateway
  baseUrl: https://api.openai.com/v1   # env LLM_BASE_URL
  model: gpt-4o-mini                   # env LLM_MODEL
  # api key: env LLM_API_KEY only (never in the config file)
  summarize_max_input_tokens: 60000
redaction:
  extra_patterns: []
```

Mention detection uses the bot's **user ID**, so renaming the bot (Slack app display name) requires no code or deploy. The name is only used in reply text and help output. Long threads over the token budget are summarized in chunks (map → reduce).

## 7. Deployment (EKS)

- One `Deployment`, 1 replica by default: the Slack event dedupe is in-memory per pod. More replicas are safe for kb-collect (deterministic Onyx IDs make duplicate delivery harmless) but not for non-idempotent skills until dedupe moves to a shared store. Graceful shutdown drains in-flight tasks (20s) on SIGTERM.
- Ingress → Slack Events API endpoint (needs a public HTTPS URL; if that is not acceptable, use Socket Mode, which needs only egress).
- Secrets (Slack bot token, signing secret, Onyx key, LLM gateway key) via our existing secret mechanism; IRSA for any AWS access.
- Stateless in v1: no database. Add Postgres/Redis when we need sessions, schedules or durable queues.
- Observability: structured JSON logs, Prometheus metrics (`neotags_tasks_total{skill,status}`, latency, LLM tokens, Onyx errors), shipped through the existing L1 stack.
- Helm chart in `deploy/`; GitLab CI via the repo's standard pipeline.

## 8. Security & audit

- Least-privilege Slack scopes. `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `reactions:write`, `users:read`, plus `groups:read` and `groups:history` only when private channels are enabled; `im:read` + `im:history` let the bot answer in DMs (record skills still refuse DM channels); interactivity is enabled for the Undo button. No group-DM (`mpim`) scopes.
- Private channels: off by default. When enabled the bot must be invited, the app needs `groups:read` + `groups:history`, entries are labelled (`source_visibility` metadata, a "Source: a private Slack channel" footer) and the reply warns that the entry is visible KB-wide, with Undo one click away.
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

Status (2026-10): milestones 1–3 are implemented and unit-tested with fakes (Slack, Onyx, LLM), including the LLM router, thread reader, redaction, summarizer, Onyx upsert/delete and the Undo button. Verified against a real OpenAI-compatible gateway (2026-10-19, flash-class model for both router and summarizer): plain completion, JSON-mode routing of five phrasings including a prompt-injection attempt, schema-valid summary of a sample thread with a planted secret, and a tool call through the pi `Agent` where the guard blocked a restart and the model reported the denial. No `compat` flags were needed. Not yet verified against live Slack or the live Onyx instance. Known limitations are listed in the next section. Checked live on a noisy 28-message incident thread (single pass and forced map-reduce): exact error strings, cause chain, ruled-out hypotheses, fix command, follow-up owners and cited messages were captured; chatter was excluded.


1. Skeleton: config, Slack gateway, health endpoint, mention → "pong"; deployed to EKS.
2. `slack.read_thread` + redaction + summarizer producing the schema (print in thread, no Onyx write).
3. Onyx ingest/delete, Undo button, idempotent re-record.
4. Guardrails, audit, metrics, Helm chart, runbook.

### Known limitations (backlog)

Not bugs: deliberate v1 scope. Grouped by area; none are scheduled.

**Summarization quality** (`src/skills/kb-collect`)
- Linked pages (Grafana, PRs, Jira, runbooks) are not read. Attached files are indexed separately (§16), but their content is not fed into the thread summary, and images/screenshots are not read (no OCR).
- Bot alerts are collapsed and quoted but not interpreted (e.g. which alert fired first, how long it lasted).
- A low-confidence or unresolved thread is saved with a warning instead of asking the requester to confirm first.
- A thread longer than 8 prompt-sized parts is thinned (least informative messages first), so a very long incident can lose detail.
- Context outside the thread (earlier channel messages, sibling threads, edited or deleted messages) is not considered.
- Prompt-budget sizing uses a rough 4 characters per token estimate.
- Tested live on one synthetic 28-message thread; no evaluation set of real, messy threads yet, so quality changes cannot be measured.
- No check for a near-duplicate entry already in the KB.

**Knowledge base and visibility**
- Private channels are opt-in (`slack.allowPrivateChannels`, default off): once enabled, their content is visible to everyone who can search the KB, flagged by `source_visibility: private-channel` metadata and a notice in the reply. Real per-channel access control needs Slack-to-Onyx ACL mapping (OIDC). DMs and group DMs are never recorded.
- Entries are visible to everyone in Onyx (cc-pair 1, decision Q3).
- Any user allowed to use the bot can click Undo, not only the person who recorded the thread.
- Slack-side edits or deletions are not propagated to an existing entry; re-recording the thread is the update path.
- No cross-system source identity (e.g. a `slack://<team>/<channel>/thread/<ts>` URI) to de-duplicate against other Slack ingestors.

**Redaction**
- Pattern and entropy based: it will miss secrets in unusual formats and may redact harmless high-entropy strings. File names are not scanned.

**Runtime**
- No conversation or session state: the router and skills are stateless per mention, so follow-ups in the same thread ("and the other region?") get no context. Needed before multi-turn triage.
- Slack event dedupe is in memory per pod, so more than one replica can process a retried event twice (harmless for kb-collect thanks to deterministic doc ids; not for non-idempotent skills).
- Work runs inline per mention; there is no durable queue, so a pod restart mid-task loses that task (Slack retries may recover it).
- The router has no thread context and uses one model call per mention.
- One Slack workspace only; the Slack and Onyx integrations are covered by fakes in tests but not yet run live end to end.

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
| Q8 | **OpenAI-compatible LLM gateway.** The user supplies `llm.baseUrl`, `llm.model` (config or `LLM_BASE_URL`/`LLM_MODEL`) and `LLM_API_KEY` (env/Secret only). Implemented on pi-ai (`src/agent/models.ts` builds a custom `openai-completions` model from config); `LlmClient` is a tool-less one-shot completion with timeout and retry on transient errors. Any provider (OpenAI, LiteLLM, vLLM, an internal gateway fronting Claude) works. Optional `llm.routerModel` (env `LLM_ROUTER_MODEL`) selects a smaller, faster model on the same gateway for intent routing; it defaults to `llm.model`, and summaries/agents always use `llm.model`. |
| Q9 | **Build on pi (`@earendil-works/pi-agent-core` + `pi-ai` 1.3.0, exact-pinned, MIT).** Diagnosis is coming right after knowledge collection and needs a tool-using agent loop, so the runtime is chosen now. kb-collect's summarize step stays a tool-less completion; tool use goes through `Agent` with every call passing a code-side guard (`beforeToolCall` → guardrails). The older `@mariozechner/*` packages are deprecated. |

## 13. Bidirectional model (impact of Q2)

Everything flows through one internal `Task` abstraction, so skills don't care about origin:

```
Triggers (inbound)                          Outputs (outbound)
 Slack app_mention / DM / button  ─┐         ┌─ Slack: reply in thread / post to channel / DM
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

## 16. Attachments and Q&A (added 2026-10-20)

Two skills plus a hook into kb-collect; no gateway changes.

- **Collect.** `kb-files` (explicit: "save these files") and `kb-collect` (automatically, for files in the recorded thread) call `collectFiles`: `SlackReader.download` -> `extract` -> `redact` -> Onyx upsert. One KB entry per file, id `neotags-file-<slack file id>` (idempotent). Sections carry a location label ("Page 3-4", "Sheet: Budget", "Slide 2"), and the link is the Slack file permalink. Metadata: `type: attachment`, `file_name`, `file_type`, `channel`, `shared_by`, `thread_doc` (when collected with a thread), plus the usual `origin`, `source_visibility`. Same channel policy as threads (`checkChannel`): public by default, private opt-in, never DMs. The thread entry lists its files; one Undo removes the thread entry and its files.
- **Searchable by meaning, not just by words.** Tables (XLSX sheets, CSV/TSV) are rendered as self-describing records (`Role: Compute6 | Inband: 100.82.3.4 | ...`, empty cells dropped, header repeated per row), so a hit on one row, or one chunk of a long sheet, still says which value is which column. Each file also gets a **catalogue entry** from one tool-less LLM call (`attachments.summarize`, default on): description, contents (sheets/sections/columns), key facts and tags, written from the redacted text plus the Slack message the file came with. It is stored as the entry's first section (with the sharing message) ahead of the file's own text; metadata carries `tags` and `summarized`. Long files are sampled evenly across their length (the summary says when it saw an excerpt). A failed summary never blocks indexing. The thread entry lists each file with its description.
- **Extraction is in-process** (unpdf, mammoth, exceljs, jszip), so redaction and limits stay in our code and the ingestion API is unchanged. Supported: PDF, DOCX, XLSX/XLSM (visible sheets, formula results), PPTX (slides + speaker notes), text-like files, HTML (including pages that render from a script: JS object/array literals such as `const ITEMS = [...]` are *parsed, never executed*, and flattened to labelled records with their group path; positional rows take column names from a same-width `<thead>`). PDF text has running headers/footers (lines repeated on many pages) and table-of-contents lines removed, and keeps `[Page n]` markers; table structure and figures/diagrams are not preserved (no OCR). Unsupported types are refused *before* downloading, with a reason shown to the user.
- **Safety.** The bot token is sent only to `https://*.slack.com`, redirects are not followed, downloads are size-capped while streaming, OOXML zip central directories are checked for absurd unpacked sizes, extracted text is capped (`attachments.maxTextChars`), and the Slack-supplied file name is escaped in replies. File content is untrusted: it is never given to an LLM with tools, and ask-time answers are escaped so documents cannot cause Slack pings.
- **Ask.** `kb-ask` calls Onyx `POST /search` (v5 search API, `{query}` -> ranked sections with text and link; verified in source at `v5.0.0-beta.1`, `backend/onyx/server/features/search`), then one tool-less LLM call answers only from the numbered sources with `[n]` citations; with no hits the LLM is not called. Retrieval permissions are the API key's, i.e. everything in the KB is visible to everyone who can ask (Q3).
- **Config.** `attachments.{enabled,maxFileMb,maxFiles,maxTextChars}`, `onyx.searchPath`, `onyx.maxResults`. Slack needs the `files:read` scope; the Onyx key needs `READ_SEARCH` in addition to `MANAGE_CONNECTORS`.

Known limitations: no OCR (images, scanned PDFs are reported as "no text found"); legacy Office formats and password-protected files are refused; extraction runs on the event loop (bounded by the size caps, Helm memory limit raised to 1Gi); questions are a single turn with no thread context; the search endpoint and `files:read` flow are covered by fakes, not yet run against live Slack/Onyx.

### 16.1 Attachment entry layout in Onyx

One Onyx document per Slack file, written by `collectFiles` (`src/skills/kb-files/collect.ts`) through the ingestion API (§5). Example for a two-sheet XLSX (values shortened):

```jsonc
{
  "id": "neotags-file-F0ABC123",                    // Slack file id: stable, so re-saving updates; Undo deletes by it
  "semantic_identifier": "Denver SRE subnet IP record.xlsx",   // title shown in Onyx and in our citations
  "sections": [
    { "text": "<file name>\nXLSX file shared by Ann in #sre-network (thread: <permalink>)\n\n"
            + "Summary: ...\nShared with the message: \"...\"\nContents:\n- ...\nKey facts:\n- Compute6 Inband: 100.82.3.4",
      "link": "<Slack file permalink>" },            // [0] catalogue section (only when summarize is on and succeeded)
    { "text": "Sheet: BareMetal\nColumns: Role | Rack | Inband | ...\nRole: Compute6 | Rack: BJ.18 | Inband: 100.82.3.4 | ...",
      "link": "<Slack file permalink>" },            // [1..n] the file's own text, ~6000 chars each
    { "text": "Sheet: VM\n...", "link": "<Slack file permalink>" }
  ],
  "metadata": { "type": "attachment", "file_name": "...", "file_type": "xlsx", "channel": "#sre-network",
                "shared_by": "Ann", "recorded_by": "Ann", "slack_user": "U1", "origin": "neotags",
                "source_visibility": "public-channel", "schema_version": "2", "truncated": "false",
                "summarized": "true", "tags": ["network", "ip"], "thread_doc": "neotags-slack-C1-1760000000.000100" },
  "doc_updated_at": "<time of the Slack message that carried the file>"
}
```

Rules that keep it retrievable:

- **Sections are self-contained.** Onyx chunks and embeds each section on its own, so every section carries its own location and labels: `Sheet: <name>` with `Column: value` records (header repeated per row), `[Page n]` for PDF, `Slide n` for PPTX, `[Group > Subgroup]` for data embedded in HTML. A chunk never depends on a header that lives in another chunk.
- **Section 0 is the catalogue** (file name, who shared it and where, summary, contents, key facts, the sharing message). Without a summary (disabled or failed) the same header line is prepended to the first text section instead, and `summarized` is `"false"`.
- **Every section links to the Slack file**, which is what `kb-ask` cites.
- **Metadata values are strings or lists of strings** (Onyx requirement). `tags` come from the summary; `thread_doc` is set only when the file was collected with `kb-collect`, and points at the thread entry `neotags-slack-<channel>-<thread_ts>`, which in turn lists its files and their descriptions. The link is informational: search does not follow it, and metadata is not yet used as a search filter.
- **`schema_version`** (now `2`) lets entries be found and re-generated when this layout changes. Version 1 had no catalogue section and rendered tables as pipe-joined rows.
- **Redaction** is applied to every section and to the summary before upsert; file names and metadata are not scanned.
- **Size limits:** extracted text is capped at `attachments.maxTextChars` (`truncated: "true"` when hit); files over `attachments.maxFileMb` are not read.
