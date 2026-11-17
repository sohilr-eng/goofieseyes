/**
 * The desks' door into the studio. `/captions` in Claude Code (see
 * .claude/skills/captions/) runs on the owner's Claude subscription, reads the
 * posts waiting for captions here, looks at their photos, and posts captions
 * back. The goofieseyes desk (a local app) pushes finished videos in as drafts.
 * No Anthropic API key is involved anywhere in the studio.
 *
 * Nothing a desk creates or captions publishes until the owner approves it in
 * the Queue (POST /api/posts?action=approve, browser only). There is no
 * approve action here, on purpose.
 *
 * GET  /api/agent          → { posts, recentEndings } — scheduled posts marked "needs captions",
 *                            soonest first, plus how recent Facebook/Threads captions ended
 *                            so the desk doesn't repeat an invitation. Each post has
 *                            writablePlatforms: its platforms minus Instagram (Instagram
 *                            captions are always the owner's own).
 * GET  /api/agent?view=schedule
 *                          → { generatedAt, posts } — read-only snapshot of the queue for a desk:
 *                            every post scheduled from 14 days ago onward (any status), soonest
 *                            first, max 200. Each has id, scheduledAt, platforms, status, held,
 *                            needsCaptions, approval ('waiting'|'approved'|'rejected'), a 140-char
 *                            caption preview, and platformState
 *                            { <platform>: { state, permalink } } from post.targets. No media
 *                            URLs, no full captions. Changes nothing in storage.
 *                          Any other `view` → 400.
 * POST /api/agent?id=…     { captions: { facebook?, threads? } } → writes them and
 *                            puts the post (back) to waiting for the owner's approval
 *                          → { id, scheduledAt, queued, approval }
 *                            A non-empty `instagram` caption refuses the whole request (400):
 *                            Instagram captions are the owner's to write.
 *
 * POST /api/agent?action=upload-token
 *      { pathname: 'media/<name>.mp4', contentType: 'video/mp4', size: <bytes> }
 *   → { clientToken, pathname, expiresAt } — a 15-minute Vercel Blob client token for that one
 *     file (image/jpeg, video/mp4 or video/quicktime, max 300 MB; 413 over that). The desk then
 *     PUTs the file to Blob itself, so it never holds BLOB_READ_WRITE_TOKEN.
 * POST /api/agent?action=create-draft
 *      { media: [{ type: 'video'|'image', url: 'https://<store>.public.blob.vercel-storage.com/…' }],
 *        platforms: ['facebook', 'threads'], needsCaptions: true, notes?: 'for the caption desk',
 *        scheduledAt?: ISO, source?: { desk, file } }
 *   → 201 { id, scheduledAt, approval: 'waiting' }. Without scheduledAt it gets a placeholder
 *     (3 days out, 12:00 New York) that the owner moves when approving. needsCaptions defaults
 *     to true.
 * POST /api/agent?action=set-time&id=…  { scheduledAt: ISO }
 *   → { id, scheduledAt, approval } — the scheduling agent picks the time of a draft that is
 *     still waiting for approval. 400 if the time isn't a date, has passed or is over a year
 *     away; 404 no such post; 409 if it isn't scheduled or is already approved (only the owner
 *     moves it then). Never changes approval; the old queued message goes stale.
 * Any other action → 400; actions are POST only (405).
 *
 * Env: STUDIO_AGENT_TOKEN — sent as `Authorization: Bearer …`. Separate from the
 * login password so it can be rotated without signing every device out.
 */

const { handler, readJson, send, query, httpError } = require('../lib/http');
const { requireAgent } = require('../lib/auth');
const { listPosts, applyCaptions, createPost, approvalOf, setAgentTime, DESK_PLATFORMS } = require('../lib/posts');
const { PLATFORMS } = require('../lib/publish');
const { deskUploadToken, isBlobUrl } = require('../lib/uploads');

const DAY = 86400e3;
const ACTIONS = ['upload-token', 'create-draft', 'set-time'];
const MAX_MEDIA = 10;
const MAX_NOTES = 5000;
const PLACEHOLDER_DAYS = 3;
const ZONE = 'America/New_York';
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
      approval: approvalOf(p),
      caption: preview(p),
      platformState: Object.fromEntries((p.platforms || []).map((pl) => [pl, {
        state: p.targets?.[pl]?.state || null,
        permalink: p.targets?.[pl]?.permalink || null,
      }])),
    }));
  return { generatedAt: new Date(now).toISOString(), posts };
}

// Wall-clock parts of `ms` in New York.
function zoneParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(ms));
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
}

// 12:00 New York time, `days` days from now: a slot the owner moves when approving.
function placeholderTime(now, days = PLACEHOLDER_DAYS) {
  const { year, month, day } = zoneParts(now + days * DAY);
  const noonUtc = Date.UTC(year, month - 1, day, 12);
  const seen = zoneParts(noonUtc);
  const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - noonUtc;
  return noonUtc - offset;
}

async function createDraft(input, now = Date.now()) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const { media, platforms, notes, scheduledAt, source } = body;
  if (!Array.isArray(media) || media.length === 0) throw httpError(400, 'media must list at least one photo or video.');
  if (media.length > MAX_MEDIA) throw httpError(400, `At most ${MAX_MEDIA} media items.`);
  for (const m of media) {
    if (!m || !['video', 'image'].includes(m.type)) throw httpError(400, 'Each media item needs type "video" or "image".');
    if (!isBlobUrl(m.url)) throw httpError(400, 'Media URLs must be https links on <store>.public.blob.vercel-storage.com.');
  }
  if (!Array.isArray(platforms) || platforms.length === 0) throw httpError(400, 'platforms must list at least one platform.');
  const unknown = platforms.filter((p) => !PLATFORMS.includes(p));
  if (unknown.length) throw httpError(400, `Unknown platform: ${unknown.join(', ')}. Use ${PLATFORMS.join(', ')}.`);
  if (notes != null && typeof notes !== 'string') throw httpError(400, 'notes must be text.');
  if (notes && notes.length > MAX_NOTES) throw httpError(400, `notes is too long (max ${MAX_NOTES} characters).`);
  if (scheduledAt != null && (typeof scheduledAt !== 'string' || Number.isNaN(Date.parse(scheduledAt)))) {
    throw httpError(400, 'scheduledAt must be an ISO date.');
  }

  const post = await createPost({
    caption: notes || '',
    media: media.map((m) => ({ type: m.type, url: m.url, pathname: decodeURIComponent(new URL(m.url).pathname.slice(1)) })),
    platforms: [...new Set(platforms)],
    needsCaptions: body.needsCaptions !== false,
    scheduledAt: scheduledAt || new Date(placeholderTime(now)).toISOString(),
    source: { type: 'desk', desk: source?.desk, file: source?.file },
  }, now, { by: 'agent' });
  return { id: post.id, scheduledAt: new Date(post.scheduledAt).toISOString(), approval: post.approval };
}

module.exports = handler(async (req, res) => {
  requireAgent(req);

  const action = query(req).get('action');
  if (action != null) {
    if (!ACTIONS.includes(action)) throw httpError(400, `Unknown action. Use ?action=${ACTIONS.join(' or ?action=')}`);
    if (req.method !== 'POST') throw httpError(405, 'Method not allowed');
    const body = await readJson(req);
    if (action === 'upload-token') return send(res, 200, await deskUploadToken(body));
    if (action === 'set-time') {
      const id = query(req).get('id');
      if (!id) throw httpError(400, 'Which post? Add &id=');
      const post = await setAgentTime(id, body?.scheduledAt);
      return send(res, 200, { id: post.id, scheduledAt: new Date(post.scheduledAt).toISOString(), approval: approvalOf(post) });
    }
    return send(res, 201, await createDraft(body));
  }

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
        writablePlatforms: p.platforms.filter((pl) => DESK_PLATFORMS.includes(pl)),
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
    if (typeof captions?.instagram === 'string' && captions.instagram.trim()) {
      throw httpError(400, "Instagram captions are Sohil's to write");
    }
    const post = await applyCaptions(id, captions);
    return send(res, 200, { id: post.id, scheduledAt: new Date(post.scheduledAt).toISOString(), queued: post.queued, approval: approvalOf(post) });
  }

  throw httpError(405, 'Method not allowed');
});

module.exports.placeholderTime = placeholderTime;
