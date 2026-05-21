/**
 * Redis Stream consumer.
 *
 * Long-running worker. Pops messages off the stream in batches and bulk-
 * inserts into Postgres with ON CONFLICT (request_id) DO UPDATE so retries
 * are idempotent.
 *
 * Uses a consumer group so multiple replicas can run in parallel without
 * double-writing.
 */
import { redis, STREAM, GROUP } from './redis.js';
import { insertLogs } from './db.js';

const CONSUMER = process.env.HOSTNAME || `worker-${process.pid}`;
const BATCH = 50;
const BLOCK_MS = 5000;

async function ensureGroup() {
  try {
    await redis.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM');
    console.log(`[consumer] created group ${GROUP} on ${STREAM}`);
  } catch (e) {
    if (!String(e.message).includes('BUSYGROUP')) throw e;
  }
}

function parseEntries(entries) {
  // entries shape: [streamName, [[id, [field, val, field, val, ...]], ...]]
  const out = [];
  for (const [, msgs] of entries) {
    for (const [id, kv] of msgs) {
      const obj = {};
      for (let i = 0; i < kv.length; i += 2) obj[kv[i]] = kv[i + 1];
      try {
        out.push({ id, log: JSON.parse(obj.json) });
      } catch (e) {
        console.warn(`[consumer] skipping malformed entry ${id}: ${e.message}`);
        out.push({ id, log: null });
      }
    }
  }
  return out;
}

async function loop() {
  while (true) {
    try {
      const reply = await redis.xreadgroup(
        'GROUP', GROUP, CONSUMER,
        'COUNT', BATCH,
        'BLOCK', BLOCK_MS,
        'STREAMS', STREAM, '>'
      );
      if (!reply) continue;
      const parsed = parseEntries(reply);
      const valid = parsed.filter(p => p.log).map(p => p.log);
      if (valid.length) {
        try {
          const n = await insertLogs(valid);
          console.log(`[consumer] persisted ${n}/${valid.length}`);
        } catch (e) {
          // DB write failed -> do NOT ack so the stream replays on next run.
          console.error('[consumer] db write failed:', e.message);
          continue;
        }
      }
      // Ack everything (including malformed — we logged them).
      const ids = parsed.map(p => p.id);
      if (ids.length) await redis.xack(STREAM, GROUP, ...ids);
    } catch (e) {
      console.error('[consumer] loop error:', e.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

(async () => {
  await ensureGroup();
  console.log(`[consumer] ${CONSUMER} starting`);
  loop().catch(err => {
    console.error('[consumer] fatal:', err);
    process.exit(1);
  });
})();
