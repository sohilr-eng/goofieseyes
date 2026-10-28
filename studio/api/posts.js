/**
 * GET    /api/posts                     → { posts }
 * POST   /api/posts                     → create; body { caption, captions, media, platforms, scheduledAt | publishNow }
 * PUT    /api/posts?id=…                → edit a still-scheduled post
 * POST   /api/posts?id=…&action=retry   → re-run the platforms that failed
 * POST   /api/posts?id=…&action=cancel  → stop a scheduled post going out
 * POST   /api/posts?id=…&action=release → "Post as is": stop waiting for the caption desk
 * DELETE /api/posts?id=…                → remove it from the list (never deletes anything on Meta)
 */

const { handler, readJson, send, query, httpError } = require('../lib/http');
const { requireAuth } = require('../lib/auth');
const posts = require('../lib/posts');

module.exports = handler(async (req, res) => {
  requireAuth(req);
  const q = query(req);
  const id = q.get('id');

  if (req.method === 'GET') return send(res, 200, { posts: await posts.listPosts() });

  if (req.method === 'POST' && !id) return send(res, 201, { post: await posts.createPost(await readJson(req)) });

  if (req.method === 'POST' && q.get('action') === 'retry') return send(res, 200, { post: await posts.retryPost(id) });
  if (req.method === 'POST' && q.get('action') === 'cancel') return send(res, 200, { post: await posts.cancelPost(id) });
  if (req.method === 'POST' && q.get('action') === 'release') return send(res, 200, { post: await posts.releasePost(id) });

  if (req.method === 'PUT' && id) return send(res, 200, { post: await posts.updatePost(id, await readJson(req)) });

  if (req.method === 'DELETE' && id) {
    await posts.deletePost(id);
    return send(res, 200, { ok: true });
  }

  throw httpError(405, 'Method not allowed');
});
