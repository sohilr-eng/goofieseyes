/**
 * The Growth tab's routes in one function, since Vercel's Hobby plan allows 12.
 *
 * /api/leads, /api/lookup and /api/tips are rewritten here (vercel.json, and
 * dev-server.js locally) with ?part=; each part lives in lib/growth-routes/.
 */

const { handler, query, httpError } = require('../lib/http');

const PARTS = {
  leads: require('../lib/growth-routes/leads'),
  lookup: require('../lib/growth-routes/lookup'),
  tips: require('../lib/growth-routes/tips'),
};

module.exports = handler(async (req, res) => {
  const part = PARTS[query(req).get('part')];
  if (!part) throw httpError(404, 'Not found');
  return part(req, res);
});
