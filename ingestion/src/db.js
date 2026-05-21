import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || 5432),
  user: process.env.POSTGRES_USER || 'llm',
  password: process.env.POSTGRES_PASSWORD || 'llm',
  database: process.env.POSTGRES_DB || 'llm_logs',
  max: 10
});

export async function insertLogs(logs) {
  if (!logs.length) return 0;
  // Bulk insert with ON CONFLICT to make ingestion idempotent on request_id.
  const cols = [
    'request_id','conversation_id','user_id','provider','model','status',
    'error_type','error_message','streamed','latency_ms','ttft_ms',
    'prompt_tokens','completion_tokens','total_tokens','input_preview',
    'output_preview','request_started_at','request_finished_at','raw_payload'
  ];
  const placeholders = [];
  const values = [];
  logs.forEach((l, i) => {
    const base = i * cols.length;
    placeholders.push(
      '(' + cols.map((_, j) => `$${base + j + 1}`).join(',') + ')'
    );
    values.push(
      l.request_id, l.conversation_id || null, l.user_id || null,
      l.provider, l.model, l.status,
      l.error_type || null, l.error_message || null,
      !!l.streamed, l.latency_ms ?? null, l.ttft_ms ?? null,
      l.prompt_tokens ?? null, l.completion_tokens ?? null, l.total_tokens ?? null,
      l.input_preview ?? null, l.output_preview ?? null,
      l.request_started_at, l.request_finished_at ?? null,
      JSON.stringify(l.raw_payload || {})
    );
  });
  const sql = `
    INSERT INTO inference_logs (${cols.join(',')})
    VALUES ${placeholders.join(',')}
    ON CONFLICT (request_id) DO UPDATE SET
      status = EXCLUDED.status,
      latency_ms = COALESCE(EXCLUDED.latency_ms, inference_logs.latency_ms),
      total_tokens = COALESCE(EXCLUDED.total_tokens, inference_logs.total_tokens),
      output_preview = COALESCE(EXCLUDED.output_preview, inference_logs.output_preview),
      request_finished_at = COALESCE(EXCLUDED.request_finished_at, inference_logs.request_finished_at)
  `;
  const res = await pool.query(sql, values);
  return res.rowCount;
}
