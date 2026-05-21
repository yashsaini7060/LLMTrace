/**
 * @llm-logger/sdk
 *
 * Lightweight wrapper around LLM provider SDKs that:
 *   - normalises a `messages` API across providers
 *   - supports streaming (SSE / async iterator)
 *   - redacts PII before logging or returning previews
 *   - emits an InferenceLog event to the ingestion endpoint asynchronously
 *
 * Usage:
 *   const client = new LLMClient({
 *     providers: {
 *       anthropic: process.env.ANTHROPIC_API_KEY,
 *       openai:    process.env.OPENAI_API_KEY,
 *       gemini:    process.env.GEMINI_API_KEY
 *     },
 *     ingestion: { endpoint, token }
 *   });
 *
 *   await client.chat({
 *     model: 'anthropic:claude-3-5-sonnet-latest',
 *     messages,
 *     conversationId,
 *     onDelta: t => res.write(t)
 *   });
 */

import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { GeminiProvider } from './providers/gemini.js';
import { redact, redactMessages } from './pii.js';
import { getDefaultTransport, LogTransport } from './transport.js';
import { randomUUID } from 'node:crypto';

const PREVIEW_LIMIT = 500;
function preview(s) {
  if (!s) return '';
  const clean = redact(String(s));
  return clean.length > PREVIEW_LIMIT ? clean.slice(0, PREVIEW_LIMIT) + '…' : clean;
}

function classifyError(err) {
  const msg = (err?.message || '').toLowerCase();
  if (err?.name === 'AbortError' || msg.includes('aborted')) return 'cancelled';
  if (err?.status === 401 || msg.includes('unauthorized')) return 'auth';
  if (err?.status === 429 || msg.includes('rate')) return 'rate_limit';
  if (err?.status >= 500) return 'server';
  if (msg.includes('timeout')) return 'timeout';
  return 'unknown';
}

export class LLMClient {
  /**
   * @param {object} opts
   * @param {object} opts.providers       { anthropic?, openai?, gemini? } api keys
   * @param {object} [opts.ingestion]     { endpoint, token, ...transport opts }
   * @param {object} [opts.transport]     a pre-built LogTransport (overrides ingestion)
   * @param {boolean}[opts.redact]        run PII scrub on previews (default true)
   */
  constructor(opts = {}) {
    this.providers = {};
    if (opts.providers?.anthropic) {
      this.providers.anthropic = new AnthropicProvider({ apiKey: opts.providers.anthropic });
    }
    if (opts.providers?.openai) {
      this.providers.openai = new OpenAIProvider({ apiKey: opts.providers.openai });
    }
    if (opts.providers?.gemini) {
      this.providers.gemini = new GeminiProvider({ apiKey: opts.providers.gemini });
    }
    this.redact = opts.redact !== false;
    this.transport = opts.transport
      || getDefaultTransport(opts.ingestion || {});
  }

  /** Parses "provider:model" -> { provider, model }. */
  _parseModel(spec) {
    if (!spec || typeof spec !== 'string') throw new Error('model required as "provider:model"');
    const i = spec.indexOf(':');
    if (i < 0) throw new Error(`model must be "provider:model", got "${spec}"`);
    return { provider: spec.slice(0, i), model: spec.slice(i + 1) };
  }

  listProviders() {
    return Object.keys(this.providers);
  }

  /**
   * Single chat call. Streams via onDelta callback if provided.
   * Returns { text, usage, requestId }.
   */
  async chat({
    model,
    messages,
    conversationId,
    userId,
    onDelta,
    signal,
    maxTokens
  }) {
    const { provider, model: modelName } = this._parseModel(model);
    const adapter = this.providers[provider];
    if (!adapter) {
      throw new Error(`provider "${provider}" not configured (have: ${this.listProviders().join(', ')})`);
    }

    const requestId = randomUUID();
    const startedAt = new Date();
    const startTs = Date.now();
    const safeMessages = this.redact ? redactMessages(messages) : messages;
    const streamed = typeof onDelta === 'function';

    const baseLog = {
      request_id: requestId,
      conversation_id: conversationId || null,
      user_id: userId || null,
      provider,
      model: modelName,
      streamed,
      request_started_at: startedAt.toISOString(),
      input_preview: preview(safeMessages.map(m => `${m.role}: ${m.content}`).join('\n')),
      raw_payload: { messages: safeMessages, maxTokens: maxTokens || null }
    };

    try {
      const op = streamed
        ? adapter.stream({ model: modelName, messages, onDelta, signal, maxTokens })
        : adapter.complete({ model: modelName, messages, signal, maxTokens });
      const res = await op;
      const latency = Date.now() - startTs;
      const outputPreview = preview(res.text);

      this.transport.enqueue({
        ...baseLog,
        status: 'success',
        latency_ms: latency,
        ttft_ms: res.ttftMs ?? null,
        prompt_tokens: res.usage?.prompt_tokens ?? null,
        completion_tokens: res.usage?.completion_tokens ?? null,
        total_tokens: res.usage?.total_tokens ?? null,
        output_preview: outputPreview,
        request_finished_at: new Date().toISOString()
      });
      return { ...res, requestId };
    } catch (err) {
      const latency = Date.now() - startTs;
      const errType = classifyError(err);
      this.transport.enqueue({
        ...baseLog,
        status: errType === 'cancelled' ? 'cancelled' : 'error',
        error_type: errType,
        error_message: preview(err?.message || String(err)),
        latency_ms: latency,
        request_finished_at: new Date().toISOString()
      });
      throw err;
    }
  }

  async shutdown() {
    if (this.transport.shutdown) await this.transport.shutdown();
  }

  stats() { return this.transport.getStats(); }
}

export { redact, redactMessages, LogTransport };
