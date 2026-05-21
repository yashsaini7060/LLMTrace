/**
 * Async log transport.
 *
 * The SDK should never block the chat hot-path on log delivery, and a
 * single dropped log should never break a user request. Strategy:
 *
 *   1. Logs are appended to an in-memory ring buffer (capped).
 *   2. A background timer flushes the buffer to the ingestion HTTP
 *      endpoint in batches.
 *   3. On HTTP failure we keep the batch in-buffer and retry with
 *      exponential backoff. If the buffer overflows we drop the
 *      oldest entries and increment a counter (visible via getStats).
 *
 * For higher throughput / cross-process resilience we'd swap this for
 * a Redis Streams producer; the ingestion service already consumes from
 * the stream as well, so both paths are supported.
 */

import { request } from 'undici';

const DEFAULTS = {
  endpoint: 'http://localhost:4000/v1/logs',
  token: 'dev-ingestion-token',
  flushIntervalMs: 1000,
  maxBatch: 50,
  maxBuffer: 5000,
  maxRetries: 5
};

export class LogTransport {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.buffer = [];
    this.dropped = 0;
    this.sent = 0;
    this.failed = 0;
    this._backoff = 0;
    this._timer = setInterval(() => this.flush(), this.cfg.flushIntervalMs);
    // Don't keep the process alive just for the flusher.
    if (this._timer.unref) this._timer.unref();
  }

  enqueue(log) {
    if (this.buffer.length >= this.cfg.maxBuffer) {
      this.buffer.shift();
      this.dropped++;
    }
    this.buffer.push(log);
  }

  async flush() {
    if (this.buffer.length === 0) return;
    if (this._backoff > Date.now()) return;

    const batch = this.buffer.splice(0, this.cfg.maxBatch);
    try {
      const res = await request(this.cfg.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${this.cfg.token}`
        },
        body: JSON.stringify({ logs: batch })
      });
      if (res.statusCode >= 300) {
        throw new Error(`ingestion responded ${res.statusCode}`);
      }
      // drain body to free the socket
      await res.body.text();
      this.sent += batch.length;
      this._retries = 0;
    } catch (err) {
      // Push the batch back to the head and back off.
      this.buffer.unshift(...batch);
      this.failed += batch.length;
      this._retries = (this._retries || 0) + 1;
      const delay = Math.min(30_000, 250 * 2 ** this._retries);
      this._backoff = Date.now() + delay;
      if (this.cfg.onError) this.cfg.onError(err);
    }
  }

  async shutdown() {
    clearInterval(this._timer);
    // best-effort drain
    for (let i = 0; i < 3 && this.buffer.length; i++) {
      await this.flush();
    }
  }

  getStats() {
    return {
      bufferSize: this.buffer.length,
      sent: this.sent,
      failed: this.failed,
      dropped: this.dropped
    };
  }
}

// One shared transport per process by default.
let _shared = null;
export function getDefaultTransport(opts) {
  if (!_shared) _shared = new LogTransport(opts);
  return _shared;
}
