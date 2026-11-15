/**
 * goofieseyes's own recent posts with their insights, for the growth desk's audit.
 *
 * GET /api/own?posts=30
 *   → { username, followers, mediaCount, posts: [{ type, caption, likes, comments, timestamp, permalink, insights }], fetchedAt }
 *
 * Signed-in studio page or the agent token (see lib/auth.js). Read-only.
 */

const { handler, send, query, httpError } = require('../http');
const { requireOwnerOrAgent } = require('../auth');
const { ownPosts } = require('../own-posts');

module.exports = handler(async (req, res) => {
  requireOwnerOrAgent(req);
  if (req.method !== 'GET') throw httpError(405, 'Method not allowed');
  send(res, 200, await ownPosts({ posts: query(req).get('posts') }));
});
