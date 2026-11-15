/**
 * The audit of goofieseyes's own posts, for the Growth tab.
 *
 * GET  /api/post-audit                                        → { updatedAt, report, sample, summary, findings }   page or desk
 * POST /api/post-audit  { report?, sample?, summary?, findings: [...] } → the new audit                          desk only
 *
 * (/api/audit is already the public audit-request form, hence the name.)
 */

const { handler, readJson, send, httpError } = require('../http');
const { requireAgent, requireOwnerOrAgent } = require('../auth');
const { getAudit, publishAudit } = require('../post-audit');

module.exports = handler(async (req, res) => {
  if (req.method === 'GET') {
    requireOwnerOrAgent(req);
    return send(res, 200, await getAudit());
  }
  if (req.method === 'POST') {
    requireAgent(req);
    return send(res, 200, await publishAudit(await readJson(req)));
  }
  throw httpError(405, 'Method not allowed');
});
