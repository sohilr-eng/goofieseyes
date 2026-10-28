/**
 * The caption desk's door into the studio. `/captions` in Claude Code (see
 * .claude/skills/captions/) runs on the owner's Claude subscription, reads the
 * posts waiting for captions here, looks at their photos, and posts captions
 * back. No Anthropic API key is involved anywhere in the studio.
 *
 * GET  /api/agent          → { posts, recentEndings } — scheduled posts marked "needs captions",
 *                            soonest first, plus how recent Facebook/Threads captions ended
 *                            so the desk doesn't repeat an invitation
 * POST /api/agent?id=…     { captions: { facebook?, threads?, instagram? } } → writes them;
 *                            a post that was held for captions goes out straight away
 *
 * Env: STUDIO_AGENT_TOKEN — sent as `Authorization: Bearer …`. Separate from the
 * login password so it can be rotated without signing every device out.
 */

const crypto = require('crypto');
const { handler, readJson, send, query, httpError } = require('../lib/http');
const { listPosts, applyCaptions } = require('../lib/posts');

function requireAgent(req) {
  const expected = process.env.STUDIO_AGENT_TOKEN;
  if (!expected) throw httpError(503, 'STUDIO_AGENT_TOKEN is not set.');
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw httpError(401, 'Bad agent token');
}

// The last paragraph of a caption is where the invitation lives.
function ending(text) {
  const paras = String(text || '').trim().split(/\n\s*\n/);
  return paras[paras.length - 1].trim().slice(0, 300);
}

module.exports = handler(async (req, res) => {
  requireAgent(req);

  if (req.method === 'GET') {
    const all = await listPosts(500);
    const posts = all
      .filter((p) => p.status === 'scheduled' && p.needsCaptions)
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
      .map((p) => ({
        id: p.id,
        scheduledAt: new Date(p.scheduledAt).toISOString(),
        held: Boolean(p.held),
        platforms: p.platforms,
        notes: p.caption,
        captions: p.captions,
        media: p.media.map((m) => ({ type: m.type, url: m.url })),
        instagram: p.source?.permalink || null,
      }));
    const recentEndings = all
      .filter((p) => !p.needsCaptions && ['scheduled', 'publishing', 'published', 'partial'].includes(p.status))
      .sort((a, b) => b.scheduledAt - a.scheduledAt)
      .slice(0, 10)
      .flatMap((p) => ['facebook', 'threads'].map((pl) => p.captions?.[pl]).filter(Boolean).map(ending));
    return send(res, 200, { posts, recentEndings });
  }

  if (req.method === 'POST') {
    const id = query(req).get('id');
    if (!id) throw httpError(400, 'Which post? Add ?id=');
    const { captions } = await readJson(req);
    const post = await applyCaptions(id, captions);
    return send(res, 200, { id: post.id, scheduledAt: new Date(post.scheduledAt).toISOString(), queued: post.queued });
  }

  throw httpError(405, 'Method not allowed');
});
