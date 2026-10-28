/**
 * GET  /api/instagram[?after=<cursor>]  → { items, next } — your Instagram posts, newest first,
 *                                          each with `shared` when already brought over
 * POST /api/instagram  { id }           → a composer draft for that post, media copied to Blob
 *
 * Import is one post per request so even a long Reel copies inside one short
 * function call; the browser loops over a multi-select.
 */

const { handler, readJson, send, query, httpError } = require('../lib/http');
const { requireAuth } = require('../lib/auth');
const { listInstagram, importInstagram } = require('../lib/instagram');

module.exports = handler(async (req, res) => {
  requireAuth(req);
  if (req.method === 'GET') return send(res, 200, await listInstagram(query(req).get('after')));
  if (req.method === 'POST') {
    const { id } = await readJson(req);
    return send(res, 200, { draft: await importInstagram(id) });
  }
  throw httpError(405, 'Method not allowed');
});
