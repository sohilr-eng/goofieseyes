/**
 * Post records and the run loop the worker drives.
 *
 * Shape:
 *   { id, rev, createdAt, updatedAt, scheduledAt, queued, status,
 *     caption, captions: { facebook?, instagram?, threads? },
 *     media: [{ url, pathname, type: 'image'|'video', width?, height? }],
 *     platforms: ['facebook', 'instagram', 'threads'],
 *     source?: { type: 'instagram', id, permalink } — set when it was brought over from an Instagram post,
 *     targets: { <platform>: { state, containerId?, children?, mediaId?, permalink?, error?, attempts } } }
 *
 * Status: scheduled → publishing → published | partial | failed, or cancelled.
 * `queued` is false while a post is too far ahead for QStash to hold; the daily
 * cron queues it later.
 */

const crypto = require('crypto');
const { getStore } = require('./store');
const { enqueue } = require('./queue');
const { validatePost, advancePost, resetFailed, PLATFORMS } = require('./publish');
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
  };
}

function cleanSource(source) {
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

async function createPost(input, now = Date.now()) {
  const post = {
    id: `${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    rev: 1,
    createdAt: now,
    updatedAt: now,
    ...clean(input),
    source: cleanSource(input.source),
    scheduledAt: parseWhen(input, now),
    status: 'scheduled',
    targets: {},
  };
  const errors = validatePost(post);
  if (errors.length) throw httpError(400, errors.join(' '));

  await savePost(post);
  await getStore().zadd(INDEX, { score: post.createdAt, member: post.id });
  if (post.source) await markShared(post.source.id, post.id);
  await schedule(post);
  await savePost(post);
  return post;
}

async function updatePost(id, input, now = Date.now()) {
  const post = await getPost(id);
  if (!post) throw httpError(404, 'No such post');
  if (post.status !== 'scheduled') throw httpError(409, `This post is ${post.status}; only scheduled posts can be edited.`);

  Object.assign(post, clean(input), { scheduledAt: parseWhen(input, now), rev: post.rev + 1, updatedAt: now });
  const errors = validatePost(post);
  if (errors.length) throw httpError(400, errors.join(' '));

  await savePost(post);
  await schedule(post);
  await savePost(post);
  return post;
}

async function cancelPost(id) {
  const post = await getPost(id);
  if (!post) throw httpError(404, 'No such post');
  if (post.status !== 'scheduled') throw httpError(409, `This post is ${post.status} and can't be cancelled.`);
  post.status = 'cancelled';
  post.rev += 1; // strands the queued message
  await savePost(post);
  if (post.source) await releaseShared(post.source.id, post.id);
  return post;
}

async function deletePost(id) {
  const post = await getPost(id);
  if (!post) return;
  if (post.status === 'publishing') throw httpError(409, 'This post is publishing right now.');
  await getStore().del(key(id));
  await getStore().zrem(INDEX, id);
  if (post.source) await releaseShared(post.source.id, post.id);
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

module.exports = { createPost, updatePost, cancelPost, deletePost, retryPost, getPost, listPosts, runPost, queueDuePosts };
