# LLM Inference Logger

A small but real-shaped system that demonstrates end-to-end inference logging for
an LLM chat application:

- a multi-provider chatbot (Claude, OpenAI, Gemini) with streaming responses
- a lightweight SDK / wrapper around the provider SDKs that captures inference
  metadata and forwards it asynchronously
- an ingestion API that validates payloads, pushes them onto a Redis Stream,
  and a separate consumer that persists them to Postgres
- a React UI with conversation list / resume / cancel and a live dashboard for
  latency, throughput, and errors

The whole stack is `docker compose up` to start.

## Table of contents

1. [Architecture at a glance](#architecture-at-a-glance)
2. [Setup](#setup)
3. [Repository layout](#repository-layout)
4. [Schema design](#schema-design)
5. [Tradeoffs](#tradeoffs)
6. [What I'd improve with more time](#what-id-improve-with-more-time)
7. [Bonus checklist](#bonus-checklist)

## Architecture at a glance

```
┌──────────┐     SSE      ┌──────────┐    LLMClient    ┌──────────────┐
│ Frontend │ ───────────► │ Chatbot  │ ──────────────► │  Provider    │
│  (React) │ ◄─────────── │ (Express)│ ◄────────────── │ (Anthropic/  │
└────┬─────┘   tokens     └────┬─────┘    streamed     │  OpenAI/Gem) │
     │                         │                       └──────────────┘
     │ /api/conversations*     │ enqueue InferenceLog
     │ /api/metrics            ▼
     │                   ┌──────────┐    HTTP /v1/logs    ┌────────────┐
     │                   │   SDK    │ ───────────────────►│ Ingestion  │
     │                   │ transport│                     │  (Express) │
     │                   └──────────┘                     └─────┬──────┘
     │                                                          │ XADD
     │                                                          ▼
     │                                                  ┌──────────────┐
     │                                                  │ Redis Stream │
     │                                                  └─────┬────────┘
     │                                                        │ XREADGROUP
     ▼                                                        ▼
┌──────────┐                                            ┌──────────────┐
│ Postgres │ ◄────────────── conversations + messages   │   Consumer   │
│          │ ◄────────────── inference_logs (bulk)      │  (worker)    │
└──────────┘                                            └──────────────┘
```

- The chatbot calls the LLM via the SDK. The SDK streams tokens back through
  a callback and asynchronously delivers an `InferenceLog` to the ingestion
  endpoint. **The log path never blocks the chat hot-path.**
- Ingestion pushes each log onto a Redis Stream and acks the SDK.
- A separate consumer worker pulls in batches and bulk-inserts into Postgres
  with `ON CONFLICT (request_id) DO UPDATE`. Restarts are safe.
- The frontend polls `/api/metrics` every 5 seconds for the dashboard.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for ingestion flow, logging strategy,
scaling, and failure handling notes.

## Setup

### One-command (Docker Compose)

```bash
# 1) Copy env and fill in at least one provider key.
cp .env.example .env
$EDITOR .env

# 2) Bring everything up.
docker compose up --build
```

Services:

| Service     | URL                        | Notes                                  |
|-------------|----------------------------|----------------------------------------|
| Frontend    | http://localhost:5173      | Chat UI + dashboard                    |
| Chatbot API | http://localhost:3001      | `/api/*`                               |
| Ingestion   | http://localhost:4000      | `POST /v1/logs`, `GET /v1/metrics`     |
| Postgres    | localhost:5432             | user/pw `llm`/`llm`, db `llm_logs`     |
| Redis       | localhost:6379             | stream `inference.logs`                |

### Local dev (without Docker)

```bash
# Postgres + Redis still required — run them however you like, then:
psql -U llm -d llm_logs -f db/init.sql

# In separate terminals:
npm install --workspaces
npm run dev:ingestion          # :4000
node ingestion/src/consumer.js # background
npm run dev:chatbot            # :3001
npm run dev:frontend           # :5173
```

### Kubernetes

Manifests in `k8s/`. See `k8s/README.md`.

## Repository layout

```
.
├── docker-compose.yml
├── .env.example
├── package.json                  # npm workspaces root
├── db/init.sql                   # Postgres schema (loaded on first boot)
├── sdk/                          # @llm-logger/sdk — provider wrapper + transport
│   └── src/
│       ├── index.js              # LLMClient
│       ├── providers/{anthropic,openai,gemini}.js
│       ├── transport.js          # async batched log delivery
│       └── pii.js                # regex-based redactor
├── ingestion/                    # Ingestion API + Redis consumer
│   └── src/{server,consumer,schema,db,redis}.js
├── chatbot/                      # Express backend (uses the SDK)
│   └── src/{server,db}.js
├── frontend/                     # Vite + React UI (chat + dashboard)
│   └── src/{App.jsx, components/Dashboard.jsx, sse.js, api.js, styles.css}
└── k8s/                          # k3s/kind manifests
```

## Schema design

Three tables, all in `db/init.sql`:

**`conversations`** — UI source of truth for a chat session.
- `status` is `active | cancelled | archived`. The UI uses this to render a
  "cancelled" tag and reopens on the next user message.
- `metadata JSONB` is reserved for future per-conversation flags (tags,
  user agents, A/B groups).

**`messages`** — what the user sees.
- `content` is the post-redaction text shown in the UI. `content_raw` is the
  pre-redaction copy, kept for debugging and disabled in prod via a column
  drop or a write-time toggle if PII storage policy is strict.
- We store the **assistant's full reply** at end-of-stream rather than
  per-token. Streaming is purely a UX concern; the persistent record is
  the final string (or the partial + `[cancelled]` marker if aborted).

**`inference_logs`** — one row per LLM call.
- Separate from `messages` so we can record failed and cancelled calls that
  produced no assistant turn.
- `request_id UNIQUE` lets the ingest path be idempotent (`ON CONFLICT DO
  UPDATE`). Retries from the SDK don't double-write.
- `raw_payload JSONB` keeps the original SDK envelope. The hot columns
  (provider, model, latency, tokens, status, timestamps) are pulled out
  for cheap indexing and aggregation.
- Indexed by `(request_started_at DESC)`, `(provider, model)`, `(status)`,
  and `(conversation_id, request_started_at)` to cover the dashboard
  queries and per-conversation drilldowns.

**Why one Postgres instead of split OLTP+OLAP?**
ClickHouse / DuckDB would be a better fit at production volume, but
Postgres handles tens of millions of rows comfortably with the indexes
above. The split is something I'd reach for once the dashboard queries
start showing up in pg_stat_statements. See "What I'd improve."

## Tradeoffs

- **Async transport vs synchronous DB writes.**
  The SDK fires log batches over HTTP every second; chat latency never pays
  the cost of the DB write. Tradeoff: a few seconds of logs are at risk if
  the chatbot process is killed before the buffer drains. For higher
  durability you'd ship to Redis directly from the SDK (the ingestion
  service already consumes from the same stream), or use an at-least-once
  durable queue like Kafka.

- **Regex PII redaction.**
  Demonstrates the pipeline stage clearly and is dependency-free. It catches
  the common high-leverage patterns (emails, phones, CC, SSN, IPs, API keys)
  but will miss free-form PII (names, addresses, anything contextual). For
  serious usage I'd swap in Presidio or a small classifier — the interface
  is one function.

- **Redis Streams over Kafka/RabbitMQ.**
  Streams give us consumer groups, ack semantics, and replay with one
  dependency we already wanted for cache/coordination. For multi-region or
  >100k logs/sec you'd graduate to Kafka.

- **Polling dashboard (5s) instead of websockets.**
  Cheap and good enough at this volume. If we wanted true real-time we'd
  publish a fan-out channel from the consumer.

- **Conversation context = last 12 turns.**
  Short, hard cap. Real systems need summarisation or RAG once chats grow,
  but that's orthogonal to the logging story.

- **No auth on the chatbot API.**
  The brief is about the inference pipeline, not the app. The ingestion
  endpoint *is* token-gated via `INGESTION_TOKEN` because the SDK could
  run in any process.

## What I'd improve with more time

1. **Tests.** I included the seams (`pii.redact`, `transport.flush`,
   `BatchSchema.parse`) but didn't add a real test suite. Vitest for unit,
   a small docker-compose-based e2e ("send 50 chats, assert 50 rows").
2. **Durable SDK transport.** Today the SDK buffers in memory. A small SQLite
   WAL or local Redis on the same host would survive process restarts.
3. **OLAP store for the dashboard.** ClickHouse or a Postgres logical
   replica with TimescaleDB would handle dashboard queries at scale
   without contending with the OLTP path.
4. **Trace IDs.** Add `traceparent` / OTLP export so an inference log lines
   up with the upstream HTTP request in a tracing UI.
5. **Cost.** Per-provider price table → derived `cost_usd` column at write
   time, so dashboards can show $$ alongside tokens.
6. **PII redaction quality.** Presidio + an opt-in audit log of what was
   redacted (with hashed originals) so we can tune the rules.
7. **Streaming auth + rate limits.** Per-user request limits at the chatbot
   layer (Redis token bucket) and an ingestion-side schema fingerprint to
   reject malformed log shapes early.
8. **CI.** GitHub Actions: lint, run schema migration in a Postgres
   service, build all images, push to GHCR, deploy to k8s.

## Bonus checklist

- [x] Multi-provider support — Anthropic, OpenAI, Gemini behind one interface
- [x] Streaming responses — SDK + chatbot SSE + UI token rendering
- [x] Latency / throughput / error dashboards — `/api/metrics` + Recharts
- [x] Docker Compose one-command setup — `docker compose up`
- [x] Event-based architecture — SDK → Ingestion → Redis Stream → Consumer → DB
- [x] PII redaction — regex scrubber in the SDK before logging or storage
- [x] k8s manifests — `k8s/` for self-hosted clusters
- [x] Cancel a conversation — backend route + UI button + AbortController
- [x] List conversations — sidebar
- [x] Resume a conversation — click any conversation; status reopens on next message
