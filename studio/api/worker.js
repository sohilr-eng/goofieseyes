/**
 * POST /api/worker — called by QStash, never by a browser.
 *
 * Body { postId, rev, kind } is signed by QStash; anything unsigned is refused.
 * Answering 200 for a skipped (stale/cancelled) message is deliberate: a non-2xx
 * would make QStash retry something that should simply be dropped.
 */

const { handler, readRawBody, send, httpError } = require('../lib/http');
const { verifySignature } = require('../lib/queue');
const { runPost } = require('../lib/posts');

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
  const raw = await readRawBody(req);
  if (!(await verifySignature(req, raw))) throw httpError(401, 'Bad signature');

  const message = JSON.parse(raw.toString('utf8'));
  const result = await runPost(message);
  send(res, 200, result);
});
