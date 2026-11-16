/**
 * The caption desk's door into the studio. `/captions` in Claude Code (see
 * .claude/skills/captions/) runs on the owner's Claude subscription, reads the
 * posts waiting for captions here, looks at their photos, and posts captions
 * back. No Anthropic API key is involved anywhere in the studio.
 *
 * GET  /api/agent          → { posts, recentEndings } — scheduled posts marked "needs captions",
 *                            soonest first, plus how recent Facebook/Threads captions ended
 *                            so the desk doesn't repeat an invitation
 * GET  /api/agent?view=schedule
 *                          → { generatedAt, posts } — read-only snapshot of the queue for a desk:
 *                            every post scheduled from 14 days ago onward (any status), soonest
 *                            first, max 200. Each has id, scheduledAt, platforms, status, held,
 *                            needsCaptions, a 140-char caption preview, and platformState
 *                            { <platform>: { state, permalink } } from post.targets. No media
 *                            URLs, no full captions. Changes nothing in storage.
 *                          Any other `view` → 400.
 * POST /api/agent?id=…     { captions: { facebook?, threads?, instagram? } } → writes them;
 *                            a post that was held for captions goes out straight away
 *
 * Env: STUDIO_AGENT_TOKEN — sent as `Authorization: Bearer …`. Separate from the
 * login password so it can be rotated without signing every device out.
 */

const { handler, readJson, send, query, httpError } = require('../lib/http');
const { requireAgent } = require('../lib/auth');
const { listPosts, applyCaptions } = require('../lib/posts');

const DAY = 86400e3;
const SCHEDULE_LOOKBACK = 14 * DAY;
const SCHEDULE_MAX = 200;
const PREVIEW_CHARS = 140;

// The last paragraph of a caption is where the invitation lives.
function ending(text) {
  const paras = String(text || '').trim().split(/\n\s*\n/);
  return paras[paras.length - 1].trim().slice(0, 300);
}

function preview(p) {
  const text = [p.captions?.instagram, p.captions?.facebook, p.captions?.threads, p.caption]
    .find((t) => typeof t === 'string' && t.trim()) || '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

// Read-only: listPosts only reads, and nothing here writes back.
async function scheduleView(now = Date.now()) {
  const from = now - SCHEDULE_LOOKBACK;
  const posts = (await listPosts(1000))
    .filter((p) => Number(p.scheduledAt) >= from)
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
    .slice(0, SCHEDULE_MAX)
    .map((p) => ({
      id: p.id,
      scheduledAt: new Date(p.scheduledAt).toISOString(),
      platforms: p.platforms || [],
      status: p.status,
      held: Boolean(p.held),
      needsCaptions: Boolean(p.needsCaptions),
      caption: preview(p),
      platformState: Object.fromEntries((p.platforms || []).map((pl) => [pl, {
        state: p.targets?.[pl]?.state || null,
        permalink: p.targets?.[pl]?.permalink || null,
      }])),
    }));
  return { generatedAt: new Date(now).toISOString(), posts };
}

module.exports = handler(async (req, res) => {
  requireAgent(req);

  const view = query(req).get('view');
  if (view != null) {
    if (req.method !== 'GET') throw httpError(405, 'Method not allowed');
    if (view !== 'schedule') throw httpError(400, 'Unknown view. Use ?view=schedule');
    return send(res, 200, await scheduleView());
  }

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
