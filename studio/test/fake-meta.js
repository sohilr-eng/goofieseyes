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
