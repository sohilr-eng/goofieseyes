/**
 * Post records and the run loop the worker drives.
 *
 * Shape:
 *   { id, rev, createdAt, updatedAt, scheduledAt, queued, status,
 *     caption, captions: { facebook?, instagram?, threads? },
 *     media: [{ url, pathname, type: 'image'|'video', width?, height? }],
 *     platforms: ['facebook', 'instagram', 'threads'],
 *     source?: { type: 'instagram', id, permalink } — set when it was brought over from an Instagram post,
 *     needsCaptions — the caption desk (/captions in Claude Code) should write them,
 *     held?: 'captions' — its time came while it still needed captions, so it waited,
 *     captionsBy?: 'claude', captionsAt — set when the desk wrote them, so the Queue can flag them for review,
 *     createdBy?: 'agent' — pushed in by a desk (POST /api/agent?action=create-draft),
 *     source?: { type: 'desk', desk, file } — which desk and file an agent draft came from,
 *     approval?: 'waiting' | 'approved' | 'rejected' — the owner's sign-off. Missing (older
 *       posts) counts as approved. Agent drafts start waiting, and so does any post the
 *       caption desk writes captions for; a waiting post never publishes.
 *     held?: 'approval' — its time came while it still waited for approval,
 *     captionsOwner?: { instagram: 'owner' } — the Instagram caption is the owner's own words,
 *       saved through the browser (composer, edit, or carried over from his Instagram post).
 *       Instagram captions are always his: the caption desk never writes them, and a
 *       waiting post that goes to Instagram can't be approved without one.
 *     scheduledBy?: 'agent', scheduledByAt — the scheduling agent picked the time of a
 *       waiting draft (POST /api/agent?action=set-time); cleared when the owner moves it,
 *     targets: { <platform>: { state, containerId?, children?, mediaId?, permalink?, error?, attempts } } }
 *
 * Status: scheduled → publishing → published | partial | failed, or cancelled.
 * `queued` is false while a post is too far ahead for QStash to hold; the daily
 * cron queues it later.
 */

const crypto = require('crypto');
const { getStore } = require('./store');
const { enqueue } = require('./queue');
const { validatePost, advancePost, resetFailed, captionFor, PLATFORMS } = require('./publish');
const { httpError } = require('./http');
const { markShared, releaseShared } = require('./instagram');

const INDEX = 'posts';
const key = (id) => `post:${id}`;
const LOCK_SECONDS = 120;

function clean(input) {
  const captions = {};
  for (const p of PLATFORMS) {
    if (typeof input.captions?.[p] === 'string' && input.captions[p].trim()) captions[p] = input.captions[p];
  }
  return {
    caption: String(input.caption || ''),
    captions,
    media: (Array.isArray(input.media) ? input.media : []).map((m) => ({
      url: String(m.url || ''),
      pathname: m.pathname ? String(m.pathname) : null,
      type: m.type === 'video' ? 'video' : 'image',
      width: Number(m.width) || null,
      height: Number(m.height) || null,
    })),
    platforms: (Array.isArray(input.platforms) ? input.platforms : []).filter((p) => PLATFORMS.includes(p)),
    needsCaptions: Boolean(input.needsCaptions),
  };
}

function cleanSource(source) {
  if (source?.type === 'desk') {
    const text = (v, max) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) || null;
    return { type: 'desk', desk: text(source.desk, 80), file: text(source.file, 200) };
  }
  if (!source || source.type !== 'instagram' || !/^\d+$/.test(String(source.id))) return null;
  const permalink = /^https:\/\/(www\.)?instagram\.com\//.test(source.permalink || '') ? source.permalink : null;
  return { type: 'instagram', id: String(source.id), permalink };
}

function parseWhen(input, now) {
  if (input.publishNow || !input.scheduledAt) return now;
  const at = new Date(input.scheduledAt).getTime();
  if (Number.isNaN(at)) throw httpError(400, 'scheduledAt is not a date');
  if (at < now - 60e3) throw httpError(400, 'That time has already passed.');
  return Math.max(at, now);
}

async function schedule(post) {
  post.queued = await enqueue({ postId: post.id, rev: post.rev, at: post.scheduledAt });
}

async function getPost(id) {
  return getStore().get(key(id));
}

async function savePost(post) {
  await getStore().set(key(post.id), post);
}

async function listPosts(limit = 200) {
  const store = getStore();
  const ids = await store.zrange(INDEX, 0, limit - 1, { rev: true });
  const posts = await Promise.all(ids.map((id) => store.get(key(id))));
  return posts.filter(Boolean);
}

// Old posts have no `approval`; they were all the owner's own, so approved.
const approvalOf = (post) => post.approval || 'approved';
const fromInstagram = (post) => post.source?.type === 'instagram';

// The platforms the caption desk may write for. Instagram is the owner's own voice.
const DESK_PLATFORMS = PLATFORMS.filter((p) => p !== 'instagram');

// Only called on saves from the browser (the owner's session): an Instagram
// caption he typed, or the one carried over from his own Instagram post.
function ownerCaptions(post) {
  const ig = (post.captions?.instagram || '').trim() || (fromInstagram(post) ? String(post.caption || '').trim() : '');
  return ig ? { instagram: 'owner' } : null;
}

// True while a post going to Instagram has no Instagram caption of the owner's.
function needsOwnerInstagram(post) {
  if (!post.platforms?.includes('instagram')) return false;
  return !(post.captionsOwner?.instagram === 'owner' && captionFor(post, 'instagram').trim());
}

/**
 * `by: 'agent'` marks a desk's draft: it waits for the owner's approval.
 * Anything composed in the browser is the owner's own and starts approved.
 */
async function createPost(input, now = Date.now(), { by } = {}) {
  const agent = by === 'agent';
  const post = {
    id: `${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    rev: 1,
    createdAt: now,
    updatedAt: now,
    ...clean(input),
    source: cleanSource(input.source),
    scheduledAt: parseWhen(input, now),
    status: 'scheduled',
    approval: agent ? 'waiting' : 'approved',
    ...(agent ? { createdBy: 'agent' } : {}),
    targets: {},
  };
  if (!agent) {
    const owner = ownerCaptions(post);
    if (owner) post.captionsOwner = owner;
  }
  const errors = validatePost(post);
  if (errors.length) throw httpError(400, errors.join(' '));

  await savePost(post);
  await getStore().zadd(INDEX, { score: post.createdAt, member: post.id });
  if (fromInstagram(post)) await markShared(post.source.id, post.id);
  await schedule(post);
  await savePost(post);
  return post;
}

async function updatePost(id, input, now = Date.now()) {
  const post = await getPost(id);
  if (!post) throw httpError(404, 'No such post');
  if (post.status !== 'scheduled') throw httpError(409, `This post is ${post.status}; only scheduled posts can be edited.`);

  // `approval` is deliberately left as it is: editing a draft is not approving it.
  const scheduledAt = parseWhen(input, now);
  if (scheduledAt !== post.scheduledAt) post.scheduledBy = null;
  Object.assign(post, clean(input), { scheduledAt, rev: post.rev + 1, updatedAt: now, held: null, captionsBy: null });
  // Edits only come from the browser, so whatever Instagram caption is there now is his.
  post.captionsOwner = ownerCaptions(post);
  const errors = validatePost(post);
  if (errors.length) throw httpError(400, errors.join(' '));

  await savePost(post);
  await schedule(post);
  await savePost(post);
  return post;
}

async function cancelPost(id, { approval } = {}) {
  const post = await getPost(id);
  if (!post) throw httpError(404, 'No such post');
  if (post.status !== 'scheduled') throw httpError(409, `This post is ${post.status} and can't be cancelled.`);
  post.status = 'cancelled';
  if (approval) post.approval = approval;
  post.held = null;
  post.rev += 1; // strands the queued message
  await savePost(post);
  if (fromInstagram(post)) await releaseShared(post.source.id, post.id);
  return post;
}

// The owner turns a draft down: it's cancelled, so it never publishes.
async function rejectPost(id) {
  return cancelPost(id, { approval: 'rejected' });
}

async function deletePost(id) {
  const post = await getPost(id);
  if (!post) return;
  if (post.status === 'publishing') throw httpError(409, 'This post is publishing right now.');
  await getStore().del(key(id));
  await getStore().zrem(INDEX, id);
  if (fromInstagram(post)) await releaseShared(post.source.id, post.id);
}

async function retryPost(id, now = Date.now()) {
  const post = await getPost(id);
  if (!post) throw httpError(404, 'No such post');
  if (!['failed', 'partial'].includes(post.status)) throw httpError(409, 'Only failed platforms can be retried.');
  resetFailed(post);
  post.status = 'publishing';
  post.rev += 1;
  post.updatedAt = now;
  await savePost(post);
  await enqueue({ postId: post.id, rev: post.rev, at: now, kind: 'check' });
  return post;
}

// Sends a held post out now, or a waiting one at its original time.
async function requeue(post, now) {
  post.rev += 1;
  post.updatedAt = now;
  if (post.held) {
    post.held = null;
    post.scheduledAt = Math.max(post.scheduledAt, now);
  }
  await savePost(post);
  await schedule(post);
  await savePost(post);
  return post;
}

// "Post as is": drop the caption-desk request and go with what's there.
async function releasePost(id, now = Date.now()) {
  const post = await getPost(id);
  if (!post) throw httpError(404, 'No such post');
  if (post.status !== 'scheduled') throw httpError(409, `This post is ${post.status}.`);
  const errors = validatePost(post);
  if (errors.length) throw httpError(400, errors.join(' '));
  post.needsCaptions = false;
  // A post still waiting for approval keeps waiting (and stays held if it was).
  if (approvalOf(post) === 'waiting') return holdForApproval(post, now);
  return requeue(post, now);
}

// Saves a post that has to wait for the owner. If its time already came it
// stays held; otherwise the message already queued for its time is left alone
// and the worker holds the post when it arrives.
async function holdForApproval(post, now) {
  post.approval = 'waiting';
  if (post.held) post.held = 'approval';
  post.updatedAt = now;
  await savePost(post);
  return post;
}

/**
 * The owner signs a waiting post off in the Queue. `when` can move it:
 * { publishNow: true } or { scheduledAt: ISO }. If its time has passed (or it
 * was held waiting) it goes out now; otherwise it keeps its slot.
 */
async function approvePost(id, when = {}, now = Date.now()) {
  const post = await getPost(id);
  if (!post) throw httpError(404, 'No such post');
  if (post.status !== 'scheduled') throw httpError(409, `This post is ${post.status}.`);
  if (approvalOf(post) !== 'waiting') throw httpError(409, `This post is already ${approvalOf(post)}.`);
  if (post.needsCaptions) throw httpError(409, 'It still needs captions: write or release captions first.');
  if (needsOwnerInstagram(post)) throw httpError(409, 'Write the Instagram caption yourself first.');
  const errors = validatePost(post);
  if (errors.length) throw httpError(400, errors.join(' '));

  if (when.publishNow || when.scheduledAt) post.scheduledBy = null;
  if (when.publishNow) post.scheduledAt = now;
  else if (when.scheduledAt) post.scheduledAt = parseWhen({ scheduledAt: when.scheduledAt }, now);
  post.scheduledAt = Math.max(post.scheduledAt, now);
  post.approval = 'approved';
  post.approvedAt = now;
  return requeue(post, now);
}

// The caption desk hands back captions. Only the platforms it wrote for
// change; anything the owner typed for another platform is kept. Instagram is
// never written here (api/agent.js refuses a request that tries).
async function applyCaptions(id, captions, now = Date.now()) {
  const post = await getPost(id);
  if (!post) throw httpError(404, 'No such post');
  if (post.status !== 'scheduled') throw httpError(409, `This post is ${post.status}; captions can only be written for scheduled posts.`);
  for (const p of DESK_PLATFORMS) {
    if (typeof captions?.[p] === 'string' && captions[p].trim() && post.platforms.includes(p)) post.captions[p] = captions[p].trim();
  }
  const errors = validatePost(post);
  if (errors.length) throw httpError(400, errors.join(' '));
  post.needsCaptions = false;
  post.captionsBy = 'claude';
  post.captionsAt = now;
  // Nothing the desk writes goes out until the owner has seen it.
  return holdForApproval(post, now);
}

const MAX_AHEAD = 366 * 86400e3;

/**
 * The scheduling agent picks the time of a draft still waiting for the owner.
 * It never touches `approval`: the post still waits (and the worker holds it
 * when the new time comes) until the owner approves it. The rev bump strands
 * the message queued for the old time.
 */
async function setAgentTime(id, scheduledAt, now = Date.now()) {
  if (typeof scheduledAt !== 'string' || Number.isNaN(Date.parse(scheduledAt))) throw httpError(400, 'scheduledAt must be an ISO date.');
  const at = Date.parse(scheduledAt);
  if (at <= now) throw httpError(400, 'That time has already passed.');
  if (at > now + MAX_AHEAD) throw httpError(400, 'That is more than a year away.');
  const post = await getPost(id);
  if (!post) throw httpError(404, 'No such post');
  if (post.status !== 'scheduled') throw httpError(409, `This post is ${post.status}.`);
  if (approvalOf(post) !== 'waiting') throw httpError(409, 'Already approved: only Sohil can move it now.');
  post.scheduledAt = at;
  post.scheduledBy = 'agent';
  post.scheduledByAt = now;
  // requeue bumps rev, clears any hold (the new time hasn't come) and queues the new time.
  return requeue(post, now);
}

/**
 * One worker delivery. A lock keeps two deliveries of the same post (QStash
 * retries, a check racing a retry) from publishing twice.
 */
async function runPost({ postId, rev, kind }, now = Date.now()) {
  const store = getStore();
  const post = await getPost(postId);
  if (!post) return { skipped: 'missing' };
  if (post.rev !== rev) return { skipped: 'stale' };
  if (kind === 'run' && post.status !== 'scheduled') return { skipped: post.status };
  // Never publish a post that's still waiting on the caption desk with
  // whatever placeholder caption it has. It waits; writing the captions or
  // pressing "Post as is" in the Queue sends it on (releasePost below).
  if (kind === 'run' && post.needsCaptions) {
    post.held = 'captions';
    post.updatedAt = now;
    await savePost(post);
    return { skipped: 'needs-captions' };
  }
  // Nothing publishes without the owner's say-so; approving in the Queue
  // (approvePost above) sends it on. Rejected posts are cancelled anyway.
  if (approvalOf(post) === 'rejected') return { skipped: 'rejected' };
  if (approvalOf(post) === 'waiting') {
    if (kind === 'run') {
      post.held = 'approval';
      post.updatedAt = now;
      await savePost(post);
    }
    return { skipped: 'awaiting-approval' };
  }
  if (kind === 'check' && post.status !== 'publishing') return { skipped: post.status };

  const lock = `lock:${postId}`;
  if (!(await store.set(lock, now, { nx: true, ex: LOCK_SECONDS }))) return { skipped: 'locked' };
  try {
    post.status = 'publishing';
    const { recheckIn } = await advancePost(post, now);
    if (recheckIn != null) {
      post.rev += 1;
      await savePost(post);
      await enqueue({ postId, rev: post.rev, at: now + recheckIn * 1000, kind: 'check' });
    } else {
      await savePost(post);
    }
    return { status: post.status, recheckIn };
  } finally {
    await store.del(lock);
  }
}

// Daily cron: hand QStash anything that has come within reach.
async function queueDuePosts() {
  let queued = 0;
  for (const post of await listPosts(1000)) {
    if (post.status === 'scheduled' && !post.queued) {
      await schedule(post);
      if (post.queued) { await savePost(post); queued += 1; }
    }
  }
  return queued;
}

module.exports = {
  createPost, updatePost, cancelPost, rejectPost, approvePost, deletePost, retryPost, releasePost, applyCaptions,
  getPost, listPosts, runPost, queueDuePosts, approvalOf, setAgentTime, needsOwnerInstagram, DESK_PLATFORMS,
};
