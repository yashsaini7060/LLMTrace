/**
 * Ingestion HTTP API.
 *
 *   POST /v1/logs   - SDK delivers a batch of inference logs. The server
 *                     validates the envelope and pushes each log onto a
 *                     Redis Stream. The actual DB write happens in the
 *                     consumer process. This keeps the request path
 *                     bounded and lets us scale writers independently.
 *
 *   GET  /healthz   - liveness
 *   GET  /v1/metrics- simple dashboard aggregations
 *   GET  /v1/logs   - recent logs (for debug UI)
 */
import express from 'express';
import { BatchSchema } from './schema.js';
import { redis, STREAM } from './redis.js';
import { pool } from './db.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

const INGESTION_TOKEN = process.env.INGESTION_TOKEN || 'dev-ingestion-token';

function auth(req, res, next) {
  const h = req.header('authorization') || '';
  const got = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (got !== INGESTION_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/v1/logs', auth, async (req, res) => {
  const parsed = BatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
  }
  const { logs } = parsed.data;

  // Push onto the Redis stream. XADD per log gives us per-message ack semantics.
  // Pipelining keeps round-trips low.
  try {
    const pipe = redis.pipeline();
    for (const log of logs) {
      pipe.xadd(STREAM, '*', 'json', JSON.stringify(log));
    }
    await pipe.exec();
    res.json({ ok: true, accepted: logs.length });
  } catch (err) {
    // If Redis is unavailable, fall back to direct DB write so we don't
    // drop logs. Slower path but safe.
    console.error('[ingestion] redis xadd failed, writing direct:', err.message);
    try {
      const { insertLogs } = await import('./db.js');
      await insertLogs(logs);
      res.json({ ok: true, accepted: logs.length, fallback: 'db' });
    } catch (e2) {
      res.status(500).json({ error: 'ingest_failed', message: e2.message });
    }
  }
});

// Aggregations for the dashboard. Kept SQL-side for cheapness.
app.get('/v1/metrics', auth, async (req, res) => {
  const since = req.query.since || '1 hour';
  try {
    const overall = await pool.query(`
      SELECT
        COUNT(*)                                                         AS total,
        SUM(CASE WHEN status='success'  THEN 1 ELSE 0 END)               AS ok,
        SUM(CASE WHEN status='error'    THEN 1 ELSE 0 END)               AS errors,
        SUM(CASE WHEN status='cancelled'THEN 1 ELSE 0 END)               AS cancelled,
        AVG(latency_ms)::INT                                             AS avg_latency,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)         AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)         AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)         AS p99,
        SUM(total_tokens)                                                AS tokens
      FROM inference_logs
      WHERE request_started_at > now() - $1::interval`, [since]);

    const series = await pool.query(`
      SELECT
        date_trunc('minute', request_started_at) AS t,
        COUNT(*)                                AS n,
        AVG(latency_ms)::INT                    AS avg_latency,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors
      FROM inference_logs
      WHERE request_started_at > now() - $1::interval
      GROUP BY 1 ORDER BY 1`, [since]);

    const byModel = await pool.query(`
      SELECT provider, model, COUNT(*) AS n,
             AVG(latency_ms)::INT AS avg_latency,
             SUM(total_tokens)    AS tokens,
             SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors
      FROM inference_logs
      WHERE request_started_at > now() - $1::interval
      GROUP BY 1,2 ORDER BY n DESC`, [since]);

    res.json({
      since,
      overall: overall.rows[0],
      series: series.rows,
      byModel: byModel.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'metrics_failed', message: err.message });
  }
});

app.get('/v1/logs', auth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  try {
    const r = await pool.query(`
      SELECT id, request_id, conversation_id, provider, model, status, error_type,
             latency_ms, ttft_ms, total_tokens, input_preview, output_preview,
             request_started_at
      FROM inference_logs
      ORDER BY request_started_at DESC
      LIMIT $1`, [limit]);
    res.json({ logs: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'list_failed', message: err.message });
  }
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`[ingestion] listening on :${port}`));
