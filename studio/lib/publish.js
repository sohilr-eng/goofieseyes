/**
 * Turns a stored post into live posts on Facebook, Instagram and Threads.
 *
 * Instagram and Threads publish in two halves: create a "container" (Meta
 * fetches the media from our Blob URL and processes it), then publish it once
 * it reports FINISHED. Video processing can take minutes, far longer than a
 * function should sit waiting, so this is a resumable step machine: each run
 * does whatever is ready, saves where it got to on `post.targets[platform]`,
 * and returns `recheckIn` seconds when something is still processing. The
 * worker re-queues itself for that long.
 *
 * Target states: pending → processing → published | failed.
 */

const { facebook, threads, GraphError } = require('./graph');
const { metaAccount, threadsAccount } = require('./accounts');

const PLATFORMS = ['facebook', 'instagram', 'threads'];
const LIMITS = {
  instagram: { caption: 2200, hashtags: 30, media: 10 },
  threads: { text: 500, media: 20 },
};
const MAX_TRANSIENT_ATTEMPTS = 6;
// Threads asks apps to wait about 30 seconds between creating a media
// container and publishing it.
const THREADS_SETTLE_MS = 30_000;

function captionFor(post, platform) {
  const own = post.captions && post.captions[platform];
  return (own && own.trim()) || post.caption || '';
}

function countHashtags(text) {
  return (text.match(/(^|\s)#[^\s#]+/g) || []).length;
}

// Same rules the composer shows live; enforced here because the server is the
// last stop before Meta and its errors are far less readable.
function validatePost(post) {
  const errors = [];
  const media = post.media || [];
  const images = media.filter((m) => m.type === 'image');
  const videos = media.filter((m) => m.type === 'video');

  if (!post.platforms || post.platforms.length === 0) errors.push('Pick at least one platform.');
  for (const p of post.platforms || []) {
    if (!PLATFORMS.includes(p)) errors.push(`Unknown platform "${p}".`);
  }
  // `npm run dev` serves uploads from localhost; on Vercel only https will do.
  const linkOk = process.env.VERCEL ? /^https:\/\// : /^(https:\/\/|http:\/\/localhost[:/])/;
  for (const m of media) {
    if (!linkOk.test(m.url || '')) errors.push('Every photo or video needs a public https link.');
    if (!['image', 'video'].includes(m.type)) errors.push('Media must be an image or a video.');
  }

  if (post.platforms?.includes('facebook')) {
    if (!captionFor(post, 'facebook') && media.length === 0) errors.push('Facebook: add a caption or some media.');
    if (videos.length > 1 || (videos.length === 1 && images.length > 0)) {
      errors.push('Facebook: a post is either photos or one video, not a mix.');
    }
  }
  if (post.platforms?.includes('instagram')) {
    const text = captionFor(post, 'instagram');
    if (media.length === 0) errors.push('Instagram: needs at least one photo or video.');
    if (media.length > LIMITS.instagram.media) errors.push(`Instagram: at most ${LIMITS.instagram.media} items in a carousel.`);
    if (text.length > LIMITS.instagram.caption) errors.push(`Instagram: caption is ${text.length} characters (max ${LIMITS.instagram.caption}).`);
    if (countHashtags(text) > LIMITS.instagram.hashtags) errors.push(`Instagram: at most ${LIMITS.instagram.hashtags} hashtags.`);
  }
  if (post.platforms?.includes('threads')) {
    const text = captionFor(post, 'threads');
    if (!text && media.length === 0) errors.push('Threads: add text or some media.');
    if (text.length > LIMITS.threads.text) errors.push(`Threads: text is ${text.length} characters (max ${LIMITS.threads.text}). Give Threads its own shorter caption.`);
    if (media.length > LIMITS.threads.media) errors.push(`Threads: at most ${LIMITS.threads.media} items.`);
  }
  return errors;
}

// ─── Facebook ────────────────────────────────────────────────────────────────
// Facebook takes the whole post in one go, so it has no processing state.

async function stepFacebook(post, target) {
  const { pageId, pageToken } = await metaAccount();
  const message = captionFor(post, 'facebook') || undefined;
  const media = post.media || [];
  let postId;

  if (media.length === 0) {
    ({ id: postId } = await facebook.post(`/${pageId}/feed`, { message }, pageToken));
  } else if (media[0].type === 'video') {
    ({ id: postId } = await facebook.post(`/${pageId}/videos`, { file_url: media[0].url, description: message }, pageToken));
  } else if (media.length === 1) {
    const photo = await facebook.post(`/${pageId}/photos`, { url: media[0].url, message }, pageToken);
    postId = photo.post_id || photo.id;
  } else {
    // Multi-photo posts: upload each photo unpublished, then attach them all.
    const ids = [];
    for (const m of media) {
      const photo = await facebook.post(`/${pageId}/photos`, { url: m.url, published: false }, pageToken);
      ids.push({ media_fbid: photo.id });
    }
    ({ id: postId } = await facebook.post(`/${pageId}/feed`, { message, attached_media: ids }, pageToken));
  }

  target.mediaId = postId;
  target.permalink = await facebook.get(`/${postId}`, { fields: 'permalink_url' }, pageToken)
    .then((r) => r.permalink_url || null)
    .catch(() => `https://www.facebook.com/${postId}`);
  return { done: true };
}

// ─── Instagram ───────────────────────────────────────────────────────────────

function igItem(m, carousel) {
  if (m.type === 'video') {
    return carousel ? { media_type: 'VIDEO', video_url: m.url, is_carousel_item: true } : { media_type: 'REELS', video_url: m.url, share_to_feed: true };
  }
  return carousel ? { image_url: m.url, is_carousel_item: true } : { image_url: m.url };
}

async function igStatus(id, token) {
  const r = await facebook.get(`/${id}`, { fields: 'status_code,status' }, token);
  return { code: r.status_code, detail: r.status };
}

async function stepInstagram(post, target) {
  const { igUserId, token } = await metaAccount();
  if (!igUserId) throw new Error('No Instagram account is linked to the Facebook Page (setup step 1).');
  const media = post.media || [];
  const carousel = media.length > 1;
  const caption = captionFor(post, 'instagram');

  if (carousel && !target.children) {
    target.children = [];
    for (const m of media) {
      const { id } = await facebook.post(`/${igUserId}/media`, igItem(m, true), token);
      target.children.push(id);
    }
  }
  if (carousel && !target.containerId) {
    for (const id of target.children) {
      const s = await igStatus(id, token);
      if (s.code === 'ERROR' || s.code === 'EXPIRED') throw new Error(`Instagram couldn't process a carousel item: ${s.detail || s.code}`);
      if (s.code !== 'FINISHED') return { done: false, recheckIn: 20 };
    }
    ({ id: target.containerId } = await facebook.post(`/${igUserId}/media`, { media_type: 'CAROUSEL', children: target.children.join(','), caption }, token));
  }
  if (!target.containerId) {
    ({ id: target.containerId } = await facebook.post(`/${igUserId}/media`, { ...igItem(media[0], false), caption }, token));
  }

  const s = await igStatus(target.containerId, token);
  if (s.code === 'ERROR' || s.code === 'EXPIRED') throw new Error(`Instagram couldn't process the media: ${s.detail || s.code}`);
  if (s.code !== 'FINISHED') return { done: false, recheckIn: 20 };

  const { id } = await facebook.post(`/${igUserId}/media_publish`, { creation_id: target.containerId }, token);
  target.mediaId = id;
  target.permalink = await facebook.get(`/${id}`, { fields: 'permalink' }, token).then((r) => r.permalink || null).catch(() => null);
  return { done: true };
}

// ─── Threads ─────────────────────────────────────────────────────────────────

function threadsItem(m, carousel) {
  const base = m.type === 'video' ? { media_type: 'VIDEO', video_url: m.url } : { media_type: 'IMAGE', image_url: m.url };
  return carousel ? { ...base, is_carousel_item: true } : base;
}

async function threadsStatus(id, token) {
  const r = await threads.get(`/${id}`, { fields: 'status,error_message' }, token);
  return { code: r.status, detail: r.error_message };
}

async function stepThreads(post, target, now) {
  const { userId, token } = await threadsAccount();
  const media = post.media || [];
  const carousel = media.length > 1;
  const text = captionFor(post, 'threads') || undefined;

  if (carousel && !target.children) {
    target.children = [];
    for (const m of media) {
      const { id } = await threads.post(`/${userId}/threads`, threadsItem(m, true), token);
      target.children.push(id);
    }
  }
  if (carousel && !target.containerId) {
    for (const id of target.children) {
      const s = await threadsStatus(id, token);
      if (s.code === 'ERROR' || s.code === 'EXPIRED') throw new Error(`Threads couldn't process a carousel item: ${s.detail || s.code}`);
      if (s.code !== 'FINISHED') return { done: false, recheckIn: 20 };
    }
    ({ id: target.containerId } = await threads.post(`/${userId}/threads`, { media_type: 'CAROUSEL', children: target.children.join(','), text }, token));
    target.containerAt = now;
  }
  if (!target.containerId) {
    const params = media.length ? { ...threadsItem(media[0], false), text } : { media_type: 'TEXT', text };
    ({ id: target.containerId } = await threads.post(`/${userId}/threads`, params, token));
    target.containerAt = now;
  }

  if (media.length && now - target.containerAt < THREADS_SETTLE_MS) {
    return { done: false, recheckIn: Math.ceil((THREADS_SETTLE_MS - (now - target.containerAt)) / 1000) };
  }
  const s = await threadsStatus(target.containerId, token);
  if (s.code === 'ERROR' || s.code === 'EXPIRED') throw new Error(`Threads couldn't process the post: ${s.detail || s.code}`);
  if (s.code && s.code !== 'FINISHED') return { done: false, recheckIn: 20 };

  const { id } = await threads.post(`/${userId}/threads_publish`, { creation_id: target.containerId }, token);
  target.mediaId = id;
  target.permalink = await threads.get(`/${id}`, { fields: 'permalink' }, token).then((r) => r.permalink || null).catch(() => null);
  return { done: true };
}

const STEPS = { facebook: stepFacebook, instagram: stepInstagram, threads: stepThreads };

// ─── Driver ──────────────────────────────────────────────────────────────────

function overallStatus(post) {
  const states = post.platforms.map((p) => post.targets[p]?.state);
  if (states.every((s) => s === 'published')) return 'published';
  if (states.some((s) => s === 'pending' || s === 'processing')) return 'publishing';
  if (states.some((s) => s === 'published')) return 'partial';
  return 'failed';
}

/**
 * Advances every unfinished platform of `post` as far as it can go right now.
 * Mutates and returns the post; `recheckIn` is the soonest any platform wants
 * another look, or null when every platform has finished one way or the other.
 */
async function advancePost(post, now = Date.now()) {
  post.targets = post.targets || {};
  let recheckIn = null;

  for (const platform of post.platforms) {
    const target = post.targets[platform] || (post.targets[platform] = { state: 'pending', attempts: 0 });
    if (target.state === 'published' || target.state === 'failed') continue;

    try {
      target.state = 'processing';
      const result = await STEPS[platform](post, target, now);
      if (result.done) {
        target.state = 'published';
        target.publishedAt = now;
        target.error = null;
      } else {
        recheckIn = Math.min(recheckIn ?? Infinity, result.recheckIn);
      }
    } catch (err) {
      target.attempts = (target.attempts || 0) + 1;
      if (err instanceof GraphError && err.transient && target.attempts < MAX_TRANSIENT_ATTEMPTS) {
        target.error = `${err.message} (retrying)`;
        recheckIn = Math.min(recheckIn ?? Infinity, Math.min(30 * 2 ** (target.attempts - 1), 600));
      } else {
        target.state = 'failed';
        target.error = err.message;
      }
    }
  }

  post.status = overallStatus(post);
  post.updatedAt = now;
  return { post, recheckIn };
}

// Sends failed platforms back to the start. Half-made containers are dropped:
// whatever made them fail (an expired container, a bad file) would fail again.
function resetFailed(post) {
  for (const platform of post.platforms) {
    const t = post.targets?.[platform];
    if (t && t.state === 'failed') post.targets[platform] = { state: 'pending', attempts: 0 };
  }
}

module.exports = { PLATFORMS, LIMITS, validatePost, captionFor, advancePost, resetFailed, overallStatus };
