/**
 * A stand-in for graph.facebook.com and graph.threads.net, swapped in for
 * global fetch. Used by the tests, and by `npm run dev` with STUDIO_FAKE_META=1
 * so the whole studio can be clicked through without real accounts.
 *
 * Video containers report IN_PROGRESS on their first status check and FINISHED
 * after, which exercises the publisher's re-check path. `fake.failNext(match,
 * error)` makes the next call whose path includes `match` answer with a Graph
 * error.
 */

// A small Instagram back catalogue for the picker. Media links point at real
// photos on the live site so `npm run dev` shows thumbnails.
const PHOTO = (f) => `https://goofieseyes.live/content/photos/${f}`;
const LONG = 'Three days in the Caroni swamp before sunrise, waiting on the scarlet ibis to come home. '.repeat(6).trim();
const IG_LIBRARY = [
  { id: '17900000000000001', media_type: 'IMAGE', media_product_type: 'FEED', media_url: PHOTO('img-2428.webp'), caption: 'tobago, late light. #tobago #caribbean #photography', permalink: 'https://www.instagram.com/p/AAA1/', timestamp: '2026-10-20T18:00:00+0000' },
  { id: '17900000000000002', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', media_url: PHOTO('img-2438.webp'), caption: `${LONG} #caroni #scarletibis #trinidad #birdphotography`, permalink: 'https://www.instagram.com/p/AAA2/', timestamp: '2026-10-12T18:00:00+0000',
    children: { data: [{ id: '17900000000000021', media_type: 'IMAGE', media_url: PHOTO('img-2438.webp') }, { id: '17900000000000022', media_type: 'IMAGE', media_url: PHOTO('img-2428.webp') }] } },
  { id: '17900000000000003', media_type: 'VIDEO', media_product_type: 'REELS', media_url: 'https://goofieseyes.live/assets/film/hero.mp4', thumbnail_url: PHOTO('img-2428.webp'), caption: 'nyfw, backstage in motion.', permalink: 'https://www.instagram.com/reel/AAA3/', timestamp: '2026-09-15T18:00:00+0000' },
];

function installFakeMeta({ passthrough = globalThis.fetch } = {}) {
  const calls = [];
  const containers = new Map();
  const failures = [];
  let seq = 1000;
  const id = () => String(seq++);

  const fake = {
    calls,
    failNext(match, error) { failures.push({ match, error }); },
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
      const page = IG_LIBRARY.slice(start, start + Number(params.limit || 24));
      const more = start + page.length < IG_LIBRARY.length;
      return json(200, { data: page, paging: more ? { cursors: { after: String(start + page.length) }, next: 'more' } : { cursors: {} } });
    }
    const libraryItem = method === 'GET' && IG_LIBRARY.find((m) => `/${m.id}` === path);
    if (libraryItem) return json(200, libraryItem);

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
