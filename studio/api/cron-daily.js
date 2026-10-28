/**
 * GET /api/cron-daily — Vercel's once-a-day cron (vercel.json).
 *
 *  1. Queue scheduled posts that are now close enough for QStash to hold.
 *  2. Refresh the Threads token (it lives 60 days; refreshing daily keeps it
 *     from ever getting near that).
 *  3. Delete uploaded media from Blob two days after every platform it was
 *     for has published, keeping well inside Hobby's 1 GB. Failed posts keep
 *     their media so Retry still works.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set;
 * anything else is refused.
 */

const { del } = require('@vercel/blob');
const { handler, send, httpError } = require('../lib/http');
const { queueDuePosts, listPosts } = require('../lib/posts');
const { refreshThreadsToken } = require('../lib/accounts');
const { getStore } = require('../lib/store');

const MEDIA_KEEP_MS = 2 * 86400e3;

module.exports = handler(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw httpError(401, 'Unauthorized');

  const report = {};
  report.queued = await queueDuePosts();

  try {
    const t = await refreshThreadsToken();
    report.threads = `refreshed, expires ${new Date(t.expiresAt).toISOString()}`;
  } catch (err) {
    report.threads = `not refreshed: ${err.message}`;
  }

  let cleaned = 0;
  const now = Date.now();
  for (const post of await listPosts(1000)) {
    if (post.status !== 'published' || post.mediaCleaned || now - post.updatedAt < MEDIA_KEEP_MS) continue;
    const urls = (post.media || []).map((m) => m.url).filter((u) => u.includes('.blob.vercel-storage.com'));
    if (urls.length) await del(urls);
    post.mediaCleaned = true;
    await getStore().set(`post:${post.id}`, post);
    cleaned += 1;
  }
  report.mediaCleaned = cleaned;

  console.log('[cron-daily]', report);
  send(res, 200, report);
});
