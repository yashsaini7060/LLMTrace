/**
 * Chatbot backend.
 *
 * Endpoints:
 *   POST   /api/conversations                  -> create new conversation
 *   GET    /api/conversations                  -> list (most recent first)
 *   GET    /api/conversations/:id              -> resume (messages + meta)
 *   POST   /api/conversations/:id/cancel       -> mark cancelled + abort active stream
 *   POST   /api/conversations/:id/chat         -> stream a reply (SSE)
 *   GET    /api/providers                      -> list available providers/models
 *   GET    /api/metrics                        -> proxy to ingestion metrics
 *
 * Short-term context: we send the last N (12) turns to keep the prompt
 * bounded. For longer sessions you'd add summarisation or a sliding
 * window with retrieval.
 */
import express from 'express';
import cors from 'cors';
import { LLMClient } from '@llm-logger/sdk';
import {
  createConversation, listConversations, getConversation,
  addMessage, setConversationStatus, setTitle
} from './db.js';
import { request as undiciRequest } from 'undici';

const CONTEXT_TURNS = 12;
const SYSTEM_PROMPT =
  'You are a helpful AI assistant. Keep responses concise unless the user asks for detail.';

const llm = new LLMClient({
  providers: {
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai:    process.env.OPENAI_API_KEY,
    gemini:    process.env.GEMINI_API_KEY
  },
  ingestion: {
    endpoint: (process.env.INGESTION_URL || 'http://localhost:4000') + '/v1/logs',
    token: process.env.INGESTION_TOKEN || 'dev-ingestion-token'
  }
});

// Map of conversationId -> AbortController for the active stream.
const liveStreams = new Map();

const app = express();
app.use(cors());
app.use(express.json({ limit: '512kb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/api/providers', (_req, res) => {
  // Default model catalog. Keeps the UI dropdown honest about what's wired up.
  const catalog = {
    anthropic: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'],
    openai:    ['gpt-4o-mini', 'gpt-4o'],
    gemini:    ['gemini-2.0-flash', 'gemini-2.5-pro']
  };
  const enabled = llm.listProviders();
  const out = {};
  for (const p of enabled) out[p] = catalog[p] || [];
  res.json({ providers: out, default: process.env.DEFAULT_MODEL || 'anthropic:claude-sonnet-4-20250514' });
});

app.post('/api/conversations', async (req, res) => {
  try {
    const c = await createConversation({ title: req.body?.title, userId: req.body?.userId });
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/conversations', async (_req, res) => {
  try { res.json({ conversations: await listConversations() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/conversations/:id', async (req, res) => {
  try {
    const c = await getConversation(req.params.id);
    if (!c) return res.status(404).json({ error: 'not_found' });
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/conversations/:id/cancel', async (req, res) => {
  const id = req.params.id;
  const ctrl = liveStreams.get(id);
  if (ctrl) ctrl.abort();
  try {
    const c = await setConversationStatus(id, 'cancelled');
    res.json({ ok: true, cancelled: !!ctrl, conversation: c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SSE streaming chat. Sends `event: token`/`event: done`/`event: error`.
app.post('/api/conversations/:id/chat', async (req, res) => {
  const id = req.params.id;
  const { message, model } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  const conv = await getConversation(id);
  if (!conv) return res.status(404).json({ error: 'conversation not found' });

  // Reopen cancelled conversations on a new message.
  if (conv.status !== 'active') await setConversationStatus(id, 'active');

  // Persist the user message first so it shows up even if the model call fails.
  const userMsg = await addMessage({
    conversationId: id, role: 'user', content: message
  });
  if (!conv.title) {
    await setTitle(id, message.slice(0, 60));
  }

  // Build context: last N turns (plus the new user message).
  const history = [...conv.messages, userMsg]
    .slice(-CONTEXT_TURNS)
    .map(m => ({ role: m.role, content: m.content }));
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];

  // SSE headers
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const ctrl = new AbortController();
  liveStreams.set(id, ctrl);
  // If the client disconnects, abort the upstream call.
  req.on('close', () => {
    if (!res.writableEnded) ctrl.abort();
  });

  let buffered = '';
  try {
    const { text, usage } = await llm.chat({
      model: model || process.env.DEFAULT_MODEL || 'anthropic:claude-sonnet-4-20250514',
      messages,
      conversationId: id,
      signal: ctrl.signal,
      onDelta: (t) => {
        buffered += t;
        send('token', { t });
      }
    });

    // Persist the assistant turn. Use `text` (full) rather than buffered
    // since some providers may emit usage-only chunks at the end.
    const stored = await addMessage({
      conversationId: id, role: 'assistant',
      content: text || buffered,
      tokens: usage?.completion_tokens ?? null
    });
    send('done', { messageId: stored.id, usage });
    res.end();
  } catch (err) {
    const isCancel = err?.name === 'AbortError' || /aborted/i.test(err?.message || '');
    if (isCancel) {
      // Persist whatever we got so the user can resume from a meaningful point.
      if (buffered) {
        await addMessage({
          conversationId: id, role: 'assistant', content: buffered + ' [cancelled]'
        });
      }
      await setConversationStatus(id, 'cancelled');
      send('cancelled', { partial: buffered });
    } else {
      console.error('[chat] error:', err);
      send('error', { message: err.message });
    }
    res.end();
  } finally {
    liveStreams.delete(id);
  }
});

// Pass-through to ingestion metrics so the frontend has one base URL.
app.get('/api/metrics', async (req, res) => {
  try {
    const url = (process.env.INGESTION_URL || 'http://localhost:4000') +
                '/v1/metrics?since=' + encodeURIComponent(req.query.since || '1 hour');
    const r = await undiciRequest(url, {
      headers: { authorization: `Bearer ${process.env.INGESTION_TOKEN || 'dev-ingestion-token'}` }
    });
    const body = await r.body.text();
    res.status(r.statusCode).type('application/json').send(body);
  } catch (e) {
    res.status(502).json({ error: 'metrics_proxy_failed', message: e.message });
  }
});

const port = Number(process.env.CHATBOT_PORT || process.env.PORT || 3001);
app.listen(port, () => console.log(`[chatbot] listening on :${port}`));
