/**
 * GET /api/status — which accounts are connected, for the Connections panel.
 * Each check fails on its own, so one missing token doesn't hide the others.
 */

const { handler, send } = require('../lib/http');
const { requireAuth } = require('../lib/auth');
const { metaAccount, threadsAccount } = require('../lib/accounts');

function settle(promise) {
  return promise.then((value) => ({ ok: true, ...value }), (err) => ({ ok: false, error: err.message }));
}

module.exports = handler(async (req, res) => {
  requireAuth(req);
  const [meta, thr] = await Promise.all([
    settle(metaAccount().then((a) => ({ pageId: a.pageId, pageName: a.pageName, igUserId: a.igUserId, igUsername: a.igUsername }))),
    settle(threadsAccount().then((a) => ({ userId: a.userId, username: a.username, expiresAt: a.expiresAt }))),
  ]);
  const onVercel = Boolean(process.env.VERCEL);
  send(res, 200, {
    facebook: meta.ok ? { ok: true, name: meta.pageName, id: meta.pageId } : meta,
    instagram: meta.ok
      ? (meta.igUserId ? { ok: true, name: `@${meta.igUsername}`, id: meta.igUserId } : { ok: false, error: 'No Instagram account is linked to the Page.' })
      : meta,
    threads: thr.ok ? { ok: true, name: `@${thr.username}`, id: thr.userId, expiresAt: thr.expiresAt } : thr,
    services: {
      scheduler: Boolean(process.env.QSTASH_TOKEN) || !onVercel,
      storage: Boolean(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) || !onVercel,
      uploads: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    },
    // dev-server.js only: uploads go to its in-memory /api/dev-upload instead of Blob.
    devUploads: Boolean(process.env.STUDIO_DEV) && !process.env.VERCEL && !process.env.BLOB_READ_WRITE_TOKEN,
  });
});
