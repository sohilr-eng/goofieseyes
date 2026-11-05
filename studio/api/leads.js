/**
 * The growth desk's view of audit requests.
 *
 * GET  /api/leads?status=new      → { leads }
 * POST /api/leads?id=…  { status?, note? } → { lead }
 *
 * Signed-in studio page or the agent token (see lib/auth.js).
 */

const { handler, readJson, send, query, httpError } = require('../lib/http');
const { requireOwnerOrAgent } = require('../lib/auth');
const { listLeads, updateLead } = require('../lib/leads');

module.exports = handler(async (req, res) => {
  requireOwnerOrAgent(req);
  const q = query(req);

  if (req.method === 'GET') {
    return send(res, 200, { leads: await listLeads({ status: q.get('status') || undefined }) });
  }
  if (req.method === 'POST') {
    const id = q.get('id');
    if (!id) throw httpError(400, 'Which lead? Add ?id=');
    return send(res, 200, { lead: await updateLead(id, await readJson(req)) });
  }
  throw httpError(405, 'Method not allowed');
});
