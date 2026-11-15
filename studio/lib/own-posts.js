/**
 * goofieseyes's own recent posts with their insights, for the growth desk's
 * audit (`/growth audit` in Claude Code).
 *
 * Other people's accounts only give likes and comments (lib/discovery.js). For
 * our own, Meta also gives reach, views, saves, shares and, depending on the
 * format, follows and profile visits (feed posts) or average watch time
 * (reels). That needs instagram_manage_insights on the system user token,
 * which setup step 3 already ticks.
 *
 * Insights are asked for one post at a time: Meta documents only
 * GET /<media id>/insights. A post whose insights can't be read (too new,
 * older than Meta keeps, or a format it doesn't cover) comes back with
 * `insights: null` rather than failing the rest. Numbers can lag by up to 48
 * hours, so the newest posts read low.
 */

const { facebook, GraphError } = require('./graph');
const { metaAccount } = require('./accounts');
const { httpError } = require('./http');

const MAX_POSTS = 50;
const AT_ONCE = 5;
const PROFILE = 'username,name,biography,website,followers_count,follows_count,media_count';
const MEDIA = 'id,caption,media_type,media_product_type,like_count,comments_count,timestamp,permalink';

// What Meta supports differs by format, and asking for one it doesn't support
// fails the whole call, so each format asks only for its own.
const CORE = ['reach', 'views', 'saved', 'shares', 'total_interactions'];
const METRICS = {
  reel: [...CORE, 'ig_reels_avg_watch_time'],
  feed: [...CORE, 'follows', 'profile_visits'],
};
const NAMES = {
  reach: 'reach', views: 'views', saved: 'saves', shares: 'shares', total_interactions: 'interactions',
  follows: 'follows', profile_visits: 'profileVisits', ig_reels_avg_watch_time: 'avgWatchMs',
};

const kind = (m) => (m.media_product_type === 'REELS' ? 'reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : m.media_type === 'VIDEO' ? 'video' : 'photo');

// 10 and 200 are "the app/token isn't allowed to do this"; 190 is a dead token.
const isPermission = (err) => err instanceof GraphError && [10, 190, 200].includes(err.code);

function shape(data) {
  const out = {};
  for (const row of data || []) {
    const value = row.values?.[0]?.value ?? row.total_value?.value;
    if (NAMES[row.name] && typeof value === 'number') out[NAMES[row.name]] = value;
  }
  return Object.keys(out).length ? out : null;
}

async function insightsFor(m, token) {
  const wanted = METRICS[kind(m) === 'reel' ? 'reel' : 'feed'];
  for (const metric of [wanted, CORE]) {
    try {
      const { data } = await facebook.get(`/${m.id}/insights`, { metric: metric.join(',') }, token);
      return shape(data);
    } catch (err) {
      if (isPermission(err)) {
        throw httpError(503, `Meta wouldn't hand over insights (${err.message}). The system user token needs instagram_manage_insights: regenerate it with that ticked (docs/studio-setup.md, step 3) and update META_SYSTEM_USER_TOKEN.`);
      }
      if (!(err instanceof GraphError)) throw err;
      // Otherwise try the smaller set once, then give this post up.
    }
  }
  return null;
}

// Runs `fn` over `items`, a few at a time, keeping order.
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function ownPosts({ posts = 30 } = {}) {
  const limit = Math.min(Math.max(Number(posts) || 30, 1), MAX_POSTS);
  const { token, igUserId } = await metaAccount();
  if (!igUserId) throw httpError(503, 'The GoofiesEyes Page has no Instagram account linked.');

  const [profile, media] = await Promise.all([
    facebook.get(`/${igUserId}`, { fields: PROFILE }, token),
    facebook.get(`/${igUserId}/media`, { fields: MEDIA, limit }, token),
  ]);
  const list = media.data || [];
  const insights = await mapLimited(list, AT_ONCE, (m) => insightsFor(m, token));

  return {
    username: profile.username || null,
    name: profile.name || null,
    biography: profile.biography || '',
    website: profile.website || null,
    followers: profile.followers_count ?? null,
    following: profile.follows_count ?? null,
    mediaCount: profile.media_count ?? null,
    posts: list.map((m, i) => ({
      id: m.id,
      type: kind(m),
      caption: m.caption || '',
      likes: typeof m.like_count === 'number' ? m.like_count : null,
      comments: m.comments_count || 0,
      timestamp: m.timestamp,
      permalink: m.permalink,
      insights: insights[i],
    })),
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { ownPosts };
