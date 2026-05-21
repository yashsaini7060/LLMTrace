-- =====================================================================
-- LLM Inference Logger – schema
--
-- Design choices:
--   * conversations + messages model multi-turn chat (UI source of truth)
--   * inference_logs holds one row per LLM call (request granularity).
--     A single chat turn = 1 inference_log + 1 user message + 1 assistant
--     message. Splitting the two lets us record failed/cancelled calls
--     that produced no assistant message.
--   * raw_payload JSONB keeps the original SDK envelope for replay/debug.
--     Indexed columns are pulled out for fast filtering.
--   * No FK from inference_logs -> messages because logs can exist for
--     failed/cancelled requests with no assistant reply. We do reference
--     conversation_id so we can join in a dashboard.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- A conversation = a multi-turn session in the UI.
CREATE TABLE IF NOT EXISTS conversations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT,
    user_id         TEXT,                                 -- optional, app-level user
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    status          TEXT NOT NULL DEFAULT 'active'        -- active | cancelled | archived
                    CHECK (status IN ('active','cancelled','archived')),
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
    ON conversations (updated_at DESC);

-- Chat messages (what the user sees).
CREATE TABLE IF NOT EXISTS messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
    content         TEXT NOT NULL,                        -- post-redaction text shown in UI
    content_raw     TEXT,                                 -- pre-redaction (optional, kept for debug)
    token_count     INTEGER,                              -- best-effort
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages (conversation_id, created_at);

-- One row per LLM call. This is what the dashboard reads from.
CREATE TABLE IF NOT EXISTS inference_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id          TEXT UNIQUE,                      -- idempotency key from SDK
    conversation_id     UUID REFERENCES conversations(id) ON DELETE SET NULL,
    user_id             TEXT,
    provider            TEXT NOT NULL,                    -- anthropic | openai | gemini | ...
    model               TEXT NOT NULL,
    status              TEXT NOT NULL                     -- success | error | cancelled
                        CHECK (status IN ('success','error','cancelled')),
    error_type          TEXT,                             -- e.g. rate_limit, timeout, auth
    error_message       TEXT,
    streamed            BOOLEAN NOT NULL DEFAULT false,
    latency_ms          INTEGER,                          -- end-to-end wall clock
    ttft_ms             INTEGER,                          -- time-to-first-token for streaming
    prompt_tokens       INTEGER,
    completion_tokens   INTEGER,
    total_tokens        INTEGER,
    input_preview       TEXT,                             -- truncated, redacted
    output_preview      TEXT,                             -- truncated, redacted
    request_started_at  TIMESTAMPTZ NOT NULL,
    request_finished_at TIMESTAMPTZ,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw_payload         JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Indexes for the dashboard queries (group by time, model, provider, status).
CREATE INDEX IF NOT EXISTS idx_logs_started_at
    ON inference_logs (request_started_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_provider_model
    ON inference_logs (provider, model);
CREATE INDEX IF NOT EXISTS idx_logs_status
    ON inference_logs (status);
CREATE INDEX IF NOT EXISTS idx_logs_conversation
    ON inference_logs (conversation_id, request_started_at);

-- Materialised summary view for quick dashboard hits. Refreshed by the
-- ingestion consumer after each batch. Kept tiny on purpose.
CREATE OR REPLACE VIEW v_inference_summary AS
SELECT
    date_trunc('minute', request_started_at) AS bucket,
    provider,
    model,
    status,
    COUNT(*)                                 AS n,
    AVG(latency_ms)::INT                     AS avg_latency_ms,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms) AS p50_latency_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms,
    SUM(total_tokens)                        AS tokens
FROM inference_logs
WHERE request_started_at > now() - interval '24 hours'
GROUP BY 1,2,3,4;
