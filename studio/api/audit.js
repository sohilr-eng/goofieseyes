/**
 * The public end of the funnel: the audit request form on goofieseyes.live/audit
 * posts here. The only studio route open without a password or token, so it
 * accepts one thing (a new request), from the site's own origins, rate-limited
 * per IP (lib/leads.js).
 *
 * POST /api/audit  { name, business, email, instagram, website?, goal? } → { ok: true }
 */

const { handler, readJson, send, httpError } = require('../lib/http');
const { clientIp } = require('../lib/auth');
const { createAuditRequest } = require('../lib/leads');

const ORIGINS = new Set(['https://goofieseyes.live', 'https://www.goofieseyes.live']);

function allowOrigin(req, res) {
  const origin = req.headers.origin;
  const local = !process.env.VERCEL && /^http:\/\/localhost:\d+$/.test(origin || '');
  if (origin && (ORIGINS.has(origin) || local)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

module.exports = handler(async (req, res) => {
  allowOrigin(req, res);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
  await createAuditRequest(await readJson(req), clientIp(req));
  send(res, 200, { ok: true });
});
