/**
 * Looking up other Instagram accounts, for the growth desk (`/growth` in Claude Code).
 *
 * Uses Business Discovery: goofieseyes asks Meta for another professional
 * account's public profile and recent posts. Needs only instagram_basic and
 * pages_read_engagement, which the system user token already has. It only
 * works for business and creator accounts; a personal account answers as not
 * found. Meta leaves out like counts the owner has hidden, and doesn't return
 * views for other people's posts, so engagement here is likes + comments.
 */

const { facebook, GraphError } = require('./graph');
const { metaAccount } = require('./accounts');
const { httpError } = require('./http');

const MAX_POSTS = 50;
const USERNAME = /^[a-z0-9._]{1,30}$/;
const PROFILE = 'username,name,biography,website,followers_count,follows_count,media_count';
const MEDIA = 'caption,media_type,media_product_type,like_count,comments_count,timestamp,permalink';

function cleanUsername(raw) {
  const username = String(raw || '').trim().replace(/^@/, '').replace(/\/+$/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').toLowerCase();
  if (!USERNAME.test(username)) throw httpError(400, `"${raw}" isn't an Instagram username`);
  return username;
}

function post(m) {
  const likes = typeof m.like_count === 'number' ? m.like_count : null;
  const comments = m.comments_count || 0;
  return {
    type: m.media_product_type === 'REELS' ? 'reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : m.media_type === 'VIDEO' ? 'video' : 'photo',
    caption: m.caption || '',
    likes,
    comments,
    engagement: (likes || 0) + comments,
    timestamp: m.timestamp,
    permalink: m.permalink,
  };
}

async function lookupAccount(raw, { posts = 25 } = {}) {
  const username = cleanUsername(raw);
  const limit = Math.min(Math.max(Number(posts) || 25, 1), MAX_POSTS);
  const { token, igUserId } = await metaAccount();
  if (!igUserId) throw httpError(503, 'The GoofiesEyes Page has no Instagram account linked.');

  let data;
  try {
    data = await facebook.get(`/${igUserId}`, {
      fields: `business_discovery.username(${username}){${PROFILE},media.limit(${limit}){${MEDIA}}}`,
    }, token);
  } catch (err) {
    // 110/2207013: no such account, or it's personal rather than business/creator.
    if (err instanceof GraphError && (err.code === 110 || err.subcode === 2207013)) {
      throw httpError(404, `@${username} wasn't found, or it's a personal account (only business and creator accounts can be looked up)`);
    }
    throw err;
  }

  const a = data.business_discovery || {};
  return {
    username: a.username || username,
    name: a.name || null,
    biography: a.biography || '',
    website: a.website || null,
    followers: a.followers_count ?? null,
    following: a.follows_count ?? null,
    mediaCount: a.media_count ?? null,
    posts: (a.media?.data || []).map(post),
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { lookupAccount, cleanUsername };
