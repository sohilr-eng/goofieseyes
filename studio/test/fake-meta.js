/**
 * A stand-in for graph.facebook.com and graph.threads.net, swapped in for
 * global fetch. Used by the tests, and by `npm run dev` with STUDIO_FAKE_META=1
 * so the whole studio can be clicked through without real accounts.
 *
 * Video containers report IN_PROGRESS on their first status check and FINISHED
 * after, which exercises the publisher's re-check path. `fake.failNext(match,
 * error)` makes the next call whose path includes `match` answer with a Graph
 * error. `fake.withholdMedia(id)` leaves `media_url` off that Instagram post, as
 * Meta does for a Reel with licensed music.
 */

// A small Instagram back catalogue for the picker. Media links point at real
// photos on the live site so `npm run dev` shows thumbnails.
const PHOTO = (f) => `https://goofieseyes.live/content/photos/${f}`;
const LONG = 'Three days in the Caroni swamp before sunrise, waiting on the scarlet ibis to come home. '.repeat(6).trim();
const IG_LIBRARY = [
  { id: '17900000000000001', media_type: 'IMAGE', media_product_type: 'FEED', media_url: PHOTO('img-2428.webp'), caption: 'tobago, late light. #tobago #caribbean #photography', like_count: 140, comments_count: 6, permalink: 'https://www.instagram.com/p/AAA1/', timestamp: '2026-10-20T18:00:00+0000' },
  { id: '17900000000000002', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', media_url: PHOTO('img-2438.webp'), caption: `${LONG} #caroni #scarletibis #trinidad #birdphotography`, like_count: 310, comments_count: 22, permalink: 'https://www.instagram.com/p/AAA2/', timestamp: '2026-10-12T18:00:00+0000',
    children: { data: [{ id: '17900000000000021', media_type: 'IMAGE', media_url: PHOTO('img-2438.webp') }, { id: '17900000000000022', media_type: 'IMAGE', media_url: PHOTO('img-2428.webp') }] } },
  { id: '17900000000000003', media_type: 'VIDEO', media_product_type: 'REELS', media_url: 'https://goofieseyes.live/assets/film/film-01-720.mp4', thumbnail_url: PHOTO('img-2428.webp'), caption: 'nyfw, backstage in motion.', like_count: 95, comments_count: 3, permalink: 'https://www.instagram.com/reel/AAA3/', timestamp: '2026-09-15T18:00:00+0000' },
];

// What Meta reports for our own posts. Feed posts have follows and profile
// visits, reels have watch time; asking a post for the other kind's metric
// fails the call, as it does on the real API.
const IG_INSIGHTS = {
  '17900000000000001': { reach: 1800, views: 2400, saved: 12, shares: 4, total_interactions: 162, follows: 3, profile_visits: 40 },
  '17900000000000002': { reach: 9600, views: 15200, saved: 210, shares: 96, total_interactions: 638, follows: 41, profile_visits: 380 },
  '17900000000000003': { reach: 2100, views: 3900, saved: 8, shares: 2, total_interactions: 108, ig_reels_avg_watch_time: 4200 },
};

// Accounts Business Discovery can see. Anything else answers like a personal
// or missing account does. One reel hides its likes, which Meta allows.
const DISCOVERY = {
  'creative.studio': {
    username: 'creative.studio', name: 'A Creative Studio', biography: 'Creative Director | NJ',
    website: 'https://example.com', followers_count: 131000, follows_count: 0, media_count: 412,
    media: Array.from({ length: 30 }, (_, i) => ({
      id: `D${i}`,
      caption: i === 3 ? 'start stupid. comment IDEAS for the list' : `day ${i} of making things`,
      media_type: i % 5 === 0 ? 'IMAGE' : 'VIDEO',
      media_product_type: i % 5 === 0 ? 'FEED' : 'REELS',
      ...(i === 7 ? {} : { like_count: i === 3 ? 9000 : 800 + i }),
      comments_count: i === 3 ? 600 : 20,
      timestamp: new Date(Date.UTC(2026, 10, 1) - i * 3 * 86400e3).toISOString(),
      permalink: `https://www.instagram.com/reel/D${i}/`,
    })),
  },
};

function installFakeMeta({ passthrough = globalThis.fetch } = {}) {
  const calls = [];
  const containers = new Map();
  const failures = [];
  const withheld = new Set();
  const visible = (m) => { if (!withheld.has(m.id)) return m; const { media_url, ...rest } = m; return rest; };
  let seq = 1000;
  const id = () => String(seq++);

  const fake = {
    calls,
    failNext(match, error) { failures.push({ match, error }); },
    withholdMedia(igId) { withheld.add(String(igId)); },
    restore() { globalThis.fetch = passthrough; },
  };

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (url.hostname !== 'graph.facebook.com' && url.hostname !== 'graph.threads.net') return passthrough(input, init);

    const method = (init.method || 'GET').toUpperCase();
    const params = Object.fromEntries(method === 'GET' ? url.searchParams : new URLSearchParams(init.body?.toString() || ''));
    const path = url.pathname.replace(/^\/v[\d.]+/, '');
    calls.push({ host: url.hostname, method, path, params });

    const failure = failures.findIndex((f) => path.includes(f.match));
    if (failure >= 0) {
      const [{ error }] = failures.splice(failure, 1);
      return json(400, { error });
    }

    // ── Accounts ──
    if (path === '/me/accounts') {
      return json(200, { data: [{ id: 'PAGE1', name: 'GoofiesEyes', access_token: 'PAGE_TOKEN', instagram_business_account: { id: 'IG1', username: 'goofieseyes' } }] });
    }
    if (path === '/me' && url.hostname === 'graph.threads.net') return json(200, { id: 'TH1', username: 'goofieseyes' });
    if (path === '/refresh_access_token') return json(200, { access_token: 'THREADS_REFRESHED', token_type: 'bearer', expires_in: 5184000 });

    // ── Instagram media library ──
    if (path === '/IG1/media' && method === 'GET') {
      const start = params.after ? Number(params.after) : 0;
      const page = IG_LIBRARY.slice(start, start + Number(params.limit || 24)).map(visible);
      const more = start + page.length < IG_LIBRARY.length;
      return json(200, { data: page, paging: more ? { cursors: { after: String(start + page.length) }, next: 'more' } : { cursors: {} } });
    }
    const insightsOf = method === 'GET' && /^\/(\d+)\/insights$/.exec(path);
    if (insightsOf) {
      const numbers = IG_INSIGHTS[insightsOf[1]];
      if (!numbers) return json(400, { error: { message: 'Unsupported get request.', code: 100, error_subcode: 33 } });
      const wanted = String(params.metric || '').split(',');
      const unknown = wanted.find((name) => !(name in numbers));
      if (unknown) return json(400, { error: { message: `(#100) The Media Insights API does not support the ${unknown} metric for this media product type.`, code: 100 } });
      return json(200, { data: wanted.map((name) => ({ name, period: 'lifetime', values: [{ value: numbers[name] }], id: `${insightsOf[1]}/insights/${name}/lifetime` })) });
    }
    if (path === '/IG1' && method === 'GET' && String(params.fields).startsWith('username')) {
      return json(200, { id: 'IG1', username: 'goofieseyes', name: 'goofieseyes', biography: 'photographer and creative director', website: 'https://goofieseyes.live/', followers_count: 5200, follows_count: 410, media_count: IG_LIBRARY.length });
    }
    const libraryItem = method === 'GET' && IG_LIBRARY.find((m) => `/${m.id}` === path);
    if (libraryItem) return json(200, visible(libraryItem));

    // ── Facebook ──
    if (/^\/PAGE1\/(feed|photos|videos)$/.test(path) && method === 'POST') {
      const newId = id();
      return json(200, path.endsWith('photos') && params.published !== 'false' ? { id: newId, post_id: `PAGE1_${newId}` } : { id: path.endsWith('feed') ? `PAGE1_${newId}` : newId });
    }

    // ── Instagram / Threads containers ──
    if ((path === '/IG1/media' || path === '/TH1/threads') && method === 'POST') {
      const cid = id();
      const isVideo = params.media_type === 'VIDEO' || params.media_type === 'REELS';
      containers.set(cid, { checks: 0, isVideo, published: false });
      return json(200, { id: cid });
    }
    if ((path === '/IG1/media_publish' || path === '/TH1/threads_publish') && method === 'POST') {
      const c = containers.get(params.creation_id);
      if (!c) return json(400, { error: { message: 'Invalid creation_id', code: 100 } });
      c.published = true;
      return json(200, { id: `M${params.creation_id}` });
    }

    // ── Business Discovery (growth desk lookups) ──
    if (path === '/IG1' && method === 'GET' && String(params.fields).startsWith('business_discovery')) {
      const username = /username\(([^)]+)\)/.exec(params.fields)[1];
      const limit = Number(/media\.limit\((\d+)\)/.exec(params.fields)?.[1] || 25);
      const account = DISCOVERY[username];
      if (!account) return json(400, { error: { message: 'Invalid user id', code: 110, error_subcode: 2207013 } });
      return json(200, { business_discovery: { ...account, media: { data: account.media.slice(0, limit) } }, id: 'IG1' });
    }

    // ── Field reads ──
    const objectId = path.slice(1);
    if (method === 'GET' && containers.has(objectId)) {
      const c = containers.get(objectId);
      c.checks += 1;
      const code = c.published ? 'PUBLISHED' : c.isVideo && c.checks === 1 ? 'IN_PROGRESS' : 'FINISHED';
      return json(200, url.hostname === 'graph.threads.net' ? { status: code, id: objectId } : { status_code: code, id: objectId });
    }
    if (method === 'GET' && params.fields === 'permalink_url') return json(200, { permalink_url: `https://www.facebook.com/${objectId}` });
    if (method === 'GET' && params.fields === 'permalink') {
      return json(200, { permalink: url.hostname === 'graph.threads.net' ? `https://www.threads.net/@goofieseyes/post/${objectId}` : `https://www.instagram.com/p/${objectId}/` });
    }

    return json(404, { error: { message: `fake-meta has no route for ${method} ${path}`, code: 100 } });
  };

  return fake;
}

module.exports = { installFakeMeta };
