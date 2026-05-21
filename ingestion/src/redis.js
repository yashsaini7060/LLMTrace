import Redis from 'ioredis';

export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  // ioredis will auto-reconnect; surface errors but don't crash.
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

redis.on('error', (e) => {
  // Keep noise low — connection errors are routine on container boot.
  if (!/(ECONNREFUSED|ETIMEDOUT)/.test(e.code || '')) {
    console.error('[redis]', e.message);
  }
});

export const STREAM = process.env.LOG_STREAM || 'inference.logs';
export const GROUP  = 'ingestion-consumers';
