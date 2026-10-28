/**
 * POST /api/login  { password }  → sets the session cookie
 * POST /api/login?logout         → clears it
 * GET  /api/login                → { authed } so pages know where to send you
 */

const { handler, readJson, send, query, httpError } = require('../lib/http');
const { login, logout, isAuthed } = require('../lib/auth');

module.exports = handler(async (req, res) => {
  if (req.method === 'GET') return send(res, 200, { authed: isAuthed(req) });
  if (req.method !== 'POST') throw httpError(405, 'Method not allowed');

  if (query(req).has('logout')) {
    logout(res);
    return send(res, 200, { ok: true });
  }
  const { password } = await readJson(req);
  await login(req, res, password);
  send(res, 200, { ok: true });
});
