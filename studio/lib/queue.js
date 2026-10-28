/**
 * Wakes the worker at a given time, even with every laptop closed.
 *
 * Vercel Hobby only runs crons once a day, so the timing comes from Upstash
 * QStash (Vercel Marketplace): it holds a message until `notBefore`, then POSTs
 * it to /api/worker with a signature the worker checks.
 *
 * QStash's free plan caps how far ahead a message can be held (7 days at the
 * time of writing), so anything further out is only stored; the daily cron
 * hands it to QStash once it's inside HOLD_DAYS.
 *
 * Env vars (all set by the Marketplace integration):
 *   QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY,
 *   QSTASH_URL (optional; region endpoint)
 *   STUDIO_URL (optional) — public base URL; defaults to the production domain
 *                           Vercel reports in VERCEL_PROJECT_PRODUCTION_URL.
 *
 * Without QSTASH_TOKEN off Vercel (`npm run dev`), messages run in-process
 * with setTimeout so the whole flow can be clicked through locally.
 */

const HOLD_DAYS = 6;

let devRunner = null; // set by dev-server.js

function workerUrl() {
  const base = process.env.STUDIO_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  if (!base) throw new Error('Set STUDIO_URL to the studio\'s public address so QStash knows where to deliver.');
  return `${base.replace(/\/$/, '')}/api/worker`;
}

function withinHold(at, now = Date.now()) {
  return at - now <= HOLD_DAYS * 86400e3;
}

/**
 * Queues a run of `postId` at `at` (ms). `rev` is the post's revision when it
 * was queued; the worker drops messages whose rev is stale, which is how an
 * edited or cancelled post's old message gets ignored without deleting it.
 * Returns false when `at` is too far out to queue yet.
 */
async function enqueue({ postId, rev, at = Date.now(), kind = 'run' }) {
  if (!withinHold(at)) return false;
  const body = { postId, rev, kind };

  if (!process.env.QSTASH_TOKEN) {
    if (process.env.VERCEL) throw new Error('QStash is not connected. Add it from the Vercel Marketplace (docs/studio-setup.md, step 6).');
    if (devRunner) setTimeout(() => devRunner(body), Math.max(0, at - Date.now()));
    return true;
  }

  const { Client } = require('@upstash/qstash');
  const client = new Client({ token: process.env.QSTASH_TOKEN, baseUrl: process.env.QSTASH_URL });
  await client.publishJSON({
    url: workerUrl(),
    body,
    notBefore: Math.floor(at / 1000),
    // Same post, revision and kind at the same second is the same job.
    deduplicationId: `${postId}-${rev}-${kind}-${Math.floor(at / 1000)}`,
    retries: 3,
  });
  return true;
}

async function verifySignature(req, rawBody) {
  const { Receiver } = require('@upstash/qstash');
  const receiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
  });
  const signature = req.headers['upstash-signature'];
  if (!signature) return false;
  try {
    return await receiver.verify({ signature, body: rawBody.toString('utf8') });
  } catch {
    return false;
  }
}

function setDevRunner(fn) {
  devRunner = fn;
}

module.exports = { enqueue, verifySignature, withinHold, setDevRunner, HOLD_DAYS };
