/**
 * Tips from the watch list, for the Growth tab.
 *
 * GET  /api/tips                          → { updatedAt, report, tips }   page or desk
 * POST /api/tips  { report?, tips: [...] } → the new list                 desk only
 * POST /api/tips?id=…  { status?, result? } → { tip }                     page or desk
 *
 * Only the growth desk (agent token) replaces the list; the page marks tips.
 */

const { handler, readJson, send, query, httpError } = require('../http');
const { requireAgent, requireOwnerOrAgent } = require('../auth');
const { getTips, publishTips, updateTip } = require('../tips');

module.exports = handler(async (req, res) => {
  const id = query(req).get('id');

  if (req.method === 'GET') {
    requireOwnerOrAgent(req);
    return send(res, 200, await getTips());
  }
  if (req.method === 'POST' && id) {
    requireOwnerOrAgent(req);
    return send(res, 200, { tip: await updateTip(id, await readJson(req)) });
  }
  if (req.method === 'POST') {
    requireAgent(req);
    return send(res, 200, await publishTips(await readJson(req)));
  }
  throw httpError(405, 'Method not allowed');
});
