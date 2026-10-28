/**
 * Reads the live site's own photos so they can be posted without re-uploading.
 *
 * GET /api/site?portfolios       → content/data/portfolios.json
 * GET /api/site?photo=<filename> → that photo's bytes
 *
 * This exists because goofieseyes.live sends no CORS headers: the browser can't
 * read those files from another origin, and it has to read them to convert the
 * site's WebP copies into the JPEG Instagram insists on. Only those two kinds
 * of path are fetched, so this can't be turned into a general proxy.
 */

const { handler, send, query, httpError } = require('../lib/http');
const { requireAuth } = require('../lib/auth');

const SITE = process.env.SITE_URL || 'https://goofieseyes.live';
const PHOTO_NAME = /^[a-z0-9][a-z0-9._-]*\.(webp|jpe?g|png)$/i;

module.exports = handler(async (req, res) => {
  requireAuth(req);
  const q = query(req);

  if (q.has('portfolios')) {
    const r = await fetch(`${SITE}/content/data/portfolios.json`);
    if (!r.ok) throw httpError(502, `The site answered HTTP ${r.status}`);
    return send(res, 200, await r.json());
  }

  const name = q.get('photo');
  if (name) {
    if (!PHOTO_NAME.test(name)) throw httpError(400, 'Not a photo filename');
    const r = await fetch(`${SITE}/content/photos/${encodeURIComponent(name)}`);
    if (!r.ok) throw httpError(r.status === 404 ? 404 : 502, `The site answered HTTP ${r.status}`);
    res.statusCode = 200;
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.end(Buffer.from(await r.arrayBuffer()));
  }

  throw httpError(400, 'Ask for ?portfolios or ?photo=<filename>');
});
