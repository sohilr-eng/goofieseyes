/**
 * Where posts, tokens and account IDs live.
 *
 * Production uses Upstash Redis, added from the Vercel Marketplace. The
 * Marketplace integration has named its variables both ways over time
 * (KV_REST_API_* and UPSTASH_REDIS_REST_*), so both are accepted.
 *
 * With neither set — `npm run dev` on a laptop — it falls back to an in-memory
 * store. That is for clicking around locally only: on Vercel every function
 * instance would get its own empty Map, so production refuses to run without
 * Redis rather than silently losing scheduled posts.
 */

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

function memoryStore() {
  const kv = new Map();
  const expiries = new Map();
  const live = (key) => {
    const at = expiries.get(key);
    if (at && at <= Date.now()) { kv.delete(key); expiries.delete(key); }
    return kv.has(key);
  };
  return {
    async get(key) { return live(key) ? structuredClone(kv.get(key)) : null; },
    async set(key, value, opts = {}) {
      if (opts.nx && live(key)) return null;
      kv.set(key, structuredClone(value));
      if (opts.ex) expiries.set(key, Date.now() + opts.ex * 1000); else expiries.delete(key);
      return 'OK';
    },
    async del(key) { kv.delete(key); expiries.delete(key); },
    async incr(key) { const n = (live(key) ? kv.get(key) : 0) + 1; kv.set(key, n); return n; },
    async expire(key, seconds) { if (live(key)) expiries.set(key, Date.now() + seconds * 1000); },
    async zadd(key, { score, member }) {
      const set = live(key) ? kv.get(key) : {};
      set[member] = score;
      kv.set(key, set);
    },
    async zrem(key, member) { const set = kv.get(key) || {}; delete set[member]; },
    async zrange(key, start, stop, opts = {}) {
      const entries = Object.entries(kv.get(key) || {}).sort((a, b) => a[1] - b[1]);
      if (opts.rev) entries.reverse();
      const end = stop < 0 ? entries.length + stop + 1 : stop + 1;
      return entries.slice(start, end).map(([member]) => member);
    },
  };
}

function redisStore() {
  const { Redis } = require('@upstash/redis');
  const redis = new Redis({ url, token });
  return {
    get: (key) => redis.get(key),
    set: (key, value, opts = {}) => redis.set(key, value, opts),
    del: (key) => redis.del(key),
    incr: (key) => redis.incr(key),
    expire: (key, seconds) => redis.expire(key, seconds),
    zadd: (key, entry) => redis.zadd(key, entry),
    zrem: (key, member) => redis.zrem(key, member),
    zrange: (key, start, stop, opts) => redis.zrange(key, start, stop, opts),
  };
}

let store;
function getStore() {
  if (store) return store;
  if (url && token) {
    store = redisStore();
  } else if (process.env.VERCEL) {
    throw Object.assign(new Error('Upstash Redis is not connected. Add it from the Vercel Marketplace (see docs/studio-setup.md, step 6).'), { status: 503 });
  } else {
    store = memoryStore();
  }
  return store;
}

// Tests swap in a fresh memory store between cases.
function resetStoreForTests() {
  store = memoryStore();
  return store;
}

module.exports = { getStore, resetStoreForTests };
