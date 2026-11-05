/**
 * The growth desk's account lookup.
 *
 * GET /api/lookup?username=jade.got.curious&posts=25
 *   → { username, name, biography, website, followers, following, mediaCount, posts, fetchedAt }
 *
 * Signed-in studio page or the agent token (see lib/auth.js). Read-only: nothing is posted, followed or liked.
 */

const { handler, send, query, httpError } = require('../http');
const { requireOwnerOrAgent } = require('../auth');
const { lookupAccount } = require('../discovery');

module.exports = handler(async (req, res) => {
  requireOwnerOrAgent(req);
  if (req.method !== 'GET') throw httpError(405, 'Method not allowed');
  const q = query(req);
  send(res, 200, await lookupAccount(q.get('username'), { posts: q.get('posts') }));
});
