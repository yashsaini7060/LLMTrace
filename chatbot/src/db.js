import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || 5432),
  user: process.env.POSTGRES_USER || 'llm',
  password: process.env.POSTGRES_PASSWORD || 'llm',
  database: process.env.POSTGRES_DB || 'llm_logs',
  max: 5
});

export async function createConversation({ title, userId }) {
  const r = await pool.query(
    `INSERT INTO conversations (title, user_id) VALUES ($1,$2) RETURNING *`,
    [title || null, userId || null]
  );
  return r.rows[0];
}

export async function listConversations({ limit = 50 } = {}) {
  const r = await pool.query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT content FROM messages m WHERE m.conversation_id = c.id AND m.role='user'
             ORDER BY m.created_at ASC LIMIT 1) AS first_user_message
     FROM conversations c
     ORDER BY c.updated_at DESC LIMIT $1`, [limit]);
  return r.rows;
}

export async function getConversation(id) {
  const c = await pool.query('SELECT * FROM conversations WHERE id=$1', [id]);
  if (!c.rows[0]) return null;
  const m = await pool.query(
    `SELECT id, role, content, token_count, created_at
     FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC`, [id]);
  return { ...c.rows[0], messages: m.rows };
}

export async function addMessage({ conversationId, role, content, contentRaw, tokens }) {
  const r = await pool.query(
    `INSERT INTO messages (conversation_id, role, content, content_raw, token_count)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [conversationId, role, content, contentRaw || null, tokens || null]
  );
  await pool.query('UPDATE conversations SET updated_at=now() WHERE id=$1', [conversationId]);
  return r.rows[0];
}

export async function setConversationStatus(id, status) {
  const r = await pool.query(
    `UPDATE conversations SET status=$1, updated_at=now() WHERE id=$2 RETURNING *`,
    [status, id]);
  return r.rows[0];
}

export async function setTitle(id, title) {
  await pool.query(`UPDATE conversations SET title=$1 WHERE id=$2`, [title, id]);
}
