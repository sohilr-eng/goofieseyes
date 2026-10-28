/**
 * Bringing existing Instagram posts over to Facebook and Threads.
 *
 * Listing reads the account's own media with the system user token
 * (instagram_basic). Importing copies the photos/videos into our Blob store
 * rather than reusing Instagram's links: those are signed CDN URLs that stop
 * working after a while, and a post scheduled for next week would fail when
 * Facebook or Threads finally tried to fetch it.
 *
 * Which Instagram posts have already been brought over is kept as
 * `ig-source:<instagram media id>` → studio post id, so the picker can mark
 * them and nobody posts the same frame twice by accident. Cancelling or
 * removing the studio post frees it again (see lib/posts.js).
 */

const { facebook } = require('./graph');
const { metaAccount } = require('./accounts');
const { getStore } = require('./store');
const { httpError } = require('./http');

const PAGE_SIZE = 24;
const THREADS_LIMIT = 500;
const FIELDS = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,children{id,media_type,media_url,thumbnail_url}';

const sourceKey = (igId) => `ig-source:${igId}`;

// One entry per photo/video, in carousel order.
function mediaItems(m) {
  const parts = m.media_type === 'CAROUSEL_ALBUM' ? (m.children?.data || []) : [m];
  return parts
    .filter((p) => p.media_url)
    .map((p) => ({ type: p.media_type === 'VIDEO' ? 'video' : 'image', url: p.media_url }));
}

function summarise(m) {
  const items = mediaItems(m);
  return {
    id: m.id,
    caption: m.caption || '',
    kind: m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : m.media_product_type === 'REELS' ? 'reel' : m.media_type === 'VIDEO' ? 'video' : 'photo',
    count: items.length,
    thumb: m.thumbnail_url || m.media_url || m.children?.data?.[0]?.thumbnail_url || m.children?.data?.[0]?.media_url || null,
    permalink: m.permalink,
    timestamp: m.timestamp,
  };
}

/**
 * Threads allows 500 characters and isn't a hashtag platform, so the
 * suggestion drops a trailing block of hashtags and, if it's still too long,
 * cuts at the last sentence or word that fits. Returns null when the original
 * already works on Threads as-is.
 */
function threadsCaptionFrom(caption) {
  const text = String(caption || '').trim();
  const withoutTags = text.replace(/(\s*(^|\s)#[^\s#]+)+\s*$/u, '').trim();
  if (withoutTags === text && text.length <= THREADS_LIMIT) return null;
  if (withoutTags.length <= THREADS_LIMIT) return withoutTags;

  // Prefer ending on a full sentence, as long as that keeps most of the text.
  const room = withoutTags.slice(0, THREADS_LIMIT);
  const sentence = room.match(/^[\s\S]*[.!?](?=\s)/);
  if (sentence && sentence[0].length > THREADS_LIMIT * 0.6) return sentence[0];
  return `${withoutTags.slice(0, THREADS_LIMIT - 1).replace(/\s+\S*$/, '')}…`;
}

async function sharedStatus(ids) {
  const store = getStore();
  const postIds = await Promise.all(ids.map((id) => store.get(sourceKey(id))));
  const posts = await Promise.all(postIds.map((pid) => (pid ? store.get(`post:${pid}`) : null)));
  return posts.map((p) => (p ? { postId: p.id, status: p.status, scheduledAt: p.scheduledAt } : null));
}

async function listInstagram(after) {
  const { igUserId, token } = await metaAccount();
  if (!igUserId) throw httpError(409, 'No Instagram account is linked to the Facebook Page.');
  const page = await facebook.get(`/${igUserId}/media`, { fields: FIELDS, limit: PAGE_SIZE, after: after || undefined }, token);
  const items = (page.data || []).map(summarise);
  const shared = await sharedStatus(items.map((i) => i.id));
  items.forEach((item, i) => { item.shared = shared[i]; });
  return { items, next: page.paging?.next ? page.paging.cursors?.after || null : null };
}

// Copies one photo/video to Blob. Off Vercel without a Blob token (npm run
// dev) the original link is used, which is fine for a click-through.
async function copyToBlob(item, igId, index) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { ...item, pathname: null };
  const res = await fetch(item.url);
  if (!res.ok) throw httpError(502, `Instagram wouldn't hand over the media (HTTP ${res.status}). Try again in a minute.`);
  const isVideo = item.type === 'video';
  const { put } = require('@vercel/blob');
  const blob = await put(`media/ig-${igId}-${index + 1}.${isVideo ? 'mp4' : 'jpg'}`, res.body, {
    access: 'public',
    contentType: isVideo ? 'video/mp4' : 'image/jpeg',
    addRandomSuffix: true,
    multipart: isVideo,
  });
  return { type: item.type, url: blob.url, pathname: blob.pathname };
}

/**
 * Turns one Instagram post into a ready-to-edit draft for the composer:
 * media copied, caption carried over, a Threads-length caption suggested.
 * One post per request keeps each function call short even for a Reel.
 */
async function importInstagram(igId) {
  if (!/^\d+$/.test(String(igId))) throw httpError(400, 'Not an Instagram media id');
  const { token } = await metaAccount();
  const m = await facebook.get(`/${igId}`, { fields: FIELDS }, token);
  const items = mediaItems(m);
  if (!items.length) throw httpError(422, 'That Instagram post has no media the API can read.');

  const media = [];
  for (const [i, item] of items.entries()) media.push(await copyToBlob(item, igId, i));

  const caption = m.caption || '';
  const threads = threadsCaptionFrom(caption);
  return {
    caption,
    captions: threads ? { threads } : {},
    media,
    source: { type: 'instagram', id: m.id, permalink: m.permalink, timestamp: m.timestamp },
    shared: (await sharedStatus([m.id]))[0],
  };
}

async function markShared(igId, postId) {
  await getStore().set(sourceKey(igId), postId);
}

async function releaseShared(igId, postId) {
  const store = getStore();
  if ((await store.get(sourceKey(igId))) === postId) await store.del(sourceKey(igId));
}

module.exports = { listInstagram, importInstagram, threadsCaptionFrom, markShared, releaseShared };
