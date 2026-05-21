# Architecture notes

This is a deeper companion to the README. Three sections: ingestion flow,
logging strategy, scaling considerations, and failure handling assumptions.

## Ingestion flow

1. **User sends a chat message.** The React UI POSTs to
   `/api/conversations/:id/chat` with a JSON body `{ message, model }`.
2. **Chatbot persists the user message** into Postgres immediately, before
   calling the LLM. If the model call fails, the user's message is still
   visible.
3. **Chatbot constructs a context** — system prompt + last 12 turns — and
   calls `LLMClient.chat({ model, messages, onDelta, signal })`.
4. **SDK selects the provider adapter** based on the `provider:model` spec.
   Each adapter (`anthropic`, `openai`, `gemini`) normalises into the same
   `{ text, usage, ttftMs }` return shape.
5. **Tokens stream back** through `onDelta`. The chatbot forwards them to
   the client as SSE `event: token` messages. The frontend appends them
   into the open assistant bubble.
6. **At end-of-stream**, the SDK enqueues an `InferenceLog` envelope into
   the in-memory `LogTransport` buffer. This includes:
   - request_id (uuid, idempotency key)
   - provider, model, status, error_type
   - latency_ms, ttft_ms, prompt/completion/total tokens
   - redacted input_preview, output_preview
   - request_started_at, request_finished_at
   - raw_payload (full envelope, JSONB)
7. **The transport flushes** every ~1s in batches of up to 50 to
   `POST /v1/logs` on the ingestion service. On failure, the batch is
   re-buffered with exponential backoff.
8. **Ingestion validates** the envelope with Zod, rejects malformed
   batches with 400, and `XADD`s each log onto the Redis Stream
   `inference.logs`.
9. **The consumer worker** `XREADGROUP`s in batches of 50 (5s block),
   bulk-inserts into `inference_logs` with `ON CONFLICT (request_id)
   DO UPDATE`, and `XACK`s. Multiple consumer replicas share the work
   via the `ingestion-consumers` group.

## Logging strategy

- **Non-blocking.** The chat hot-path doesn't await log delivery. The SDK
  fires logs in the background. Worst case, the user sees a fast reply
  and the log is briefly buffered.
- **Idempotent end-to-end.** `request_id` is generated at the SDK and is
  the natural primary key for retries. The DB upsert means duplicate
  deliveries are no-ops, not duplicates.
- **PII at the edge.** Redaction happens in the SDK before either the
  preview fields *or* the raw payload are filled. The original message
  text the user typed is still stored in `messages.content_raw` only if
  enabled; the default `messages.content` is post-redaction so the UI
  never re-displays unredacted strings.
- **What we capture.** Anything cheap and useful for ops: provider, model,
  status, error class, timestamps, latency, ttft for streams, token
  counts, input/output previews (capped at 500 chars). We do **not**
  capture full inputs/outputs by default — the previews + raw_payload
  give enough for debugging, and avoiding huge text columns keeps the
  table compact.
- **Where logs land.** Two paths:
  - **Happy path:** SDK → HTTP /v1/logs → Redis stream → consumer → Postgres.
  - **Fallback:** if Redis is down, ingestion writes directly to Postgres
    on the request thread. Slower but safe; the SDK keeps retrying.
- **Dashboard reads.** `/v1/metrics` runs SQL aggregations on
  `inference_logs` filtered by `request_started_at > now() - $interval`.
  Indexes cover the common dimensions (provider, model, status, time).

## Scaling considerations

- **Stateless services.** Chatbot, ingestion, consumer, and frontend are
  all stateless. Scale horizontally behind a load balancer (compose
  → k8s; see `k8s/`).
- **Consumer parallelism.** Redis Streams consumer groups split work
  across replicas; `inference_logs.request_id UNIQUE` keeps the
  database honest even if two consumers race on the same entry.
- **Write throughput.** Bulk-insert in batches of up to 50 keeps round
  trips low. At 1k logs/sec on a single Postgres instance we'd start
  seeing index contention on `idx_logs_started_at`; mitigations are
  partitioning by day (`PARTITION BY RANGE (request_started_at)`) and
  moving aggregations off to a TimescaleDB hypertable or ClickHouse.
- **Read throughput.** The dashboard polls once per 5s per viewer. At
  scale we'd cache the metrics endpoint (Redis, 5s TTL) and switch
  individual users to websocket fan-out from the consumer for a real
  "live" feel.
- **Hot-path latency budget.** The chatbot's only blocking call is the
  LLM stream itself. PII redaction is O(n_messages × n_patterns) regex
  — for messages under a few KB it's microseconds. Log enqueue is a
  no-network push into an array.
- **Postgres connection pool.** `pg.Pool(max: 10)` per process; with
  the chatbot at replicas=N, total connections = N × 10. Plan capacity
  for `max_connections` accordingly or add PgBouncer in front.

## Failure handling assumptions

| Failure                          | Behaviour                                      |
|----------------------------------|------------------------------------------------|
| Provider 5xx / timeout           | SDK throws; chatbot writes `[error]` SSE event and logs `status=error` with `error_type`. User can resend. |
| Provider 401 (bad key)           | Same path; `error_type=auth`.                  |
| User cancels (Cancel button)     | `POST /cancel` aborts the active stream via `AbortController`. Partial assistant text saved with `[cancelled]` suffix. Conversation `status=cancelled`. SDK logs `status=cancelled`. |
| Client disconnects mid-stream    | `req.on('close')` aborts upstream. Treated as cancellation. |
| Ingestion endpoint down          | SDK retries with exponential backoff (max ~30s). Buffer cap 5000; oldest dropped after that (counter exposed via `stats()`). |
| Redis down                       | Ingestion falls back to direct Postgres write. Slower per-request but no data loss. |
| Postgres down                    | Consumer stops acking; messages stay in the stream and replay when DB recovers. Ingestion's direct-write fallback also fails — SDK will retry. |
| Consumer crashes mid-batch       | XADD'd messages are not yet XACK'd → replayed on restart. Insert is upserted on `request_id`, so duplicates are no-ops. |
| Malformed log payload            | Ingestion rejects with 400; SDK drops from the buffer (we don't want a poison message to block the queue). For prod we'd quarantine to a DLQ stream. |
| Chatbot process killed mid-flush | Up to ~1s of buffered logs lost. Acceptable for chat metadata; not acceptable for billing data — see "What I'd improve" → durable transport. |

### Trust boundaries

- The ingestion endpoint validates a Bearer token (`INGESTION_TOKEN`).
  In production this would be a per-tenant key with revocation.
- The chatbot API has no authentication in this demo. In production it
  would sit behind your existing app auth (cookie/JWT) and pass the
  user id to the SDK as `userId`, which is already plumbed through to
  `inference_logs.user_id` and `conversations.user_id`.
