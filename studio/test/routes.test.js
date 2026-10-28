const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');

process.env.STUDIO_PASSWORD = 'correct horse';
process.env.SESSION_SECRET = 'test-secret';
process.env.QSTASH_CURRENT_SIGNING_KEY = 'sig_current';
process.env.QSTASH_NEXT_SIGNING_KEY = 'sig_next';
delete process.env.VERCEL;

const { resetStoreForTests } = require('../lib/store');

// A request shaped like Vercel's: the body is only on the stream, never on
// req.body, so a handler that reads req.body gets nothing.
function request({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = new PassThrough();
  Object.assign(req, { method, url, headers, socket: { remoteAddress: '1.2.3.4' } });
  req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  return req;
}
function response() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (chunk) => { res.body = chunk ? String(chunk) : ''; res.done = true; };
  return res;
}
async function call(route, opts) {
  const res = response();
  await require(`../api/${route}`)(request(opts), res);
  return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : null };
}

test.beforeEach(() => resetStoreForTests());

test('the API is closed until you sign in', async () => {
  for (const route of ['posts', 'status', 'site', 'blob-upload']) {
    const r = await call(route, { method: route === 'blob-upload' ? 'POST' : 'GET', body: route === 'blob-upload' ? {} : undefined });
    assert.equal(r.status, 401, route);
  }
});

test('signing in sets a cookie that opens the API', async () => {
  const bad = await call('login', { method: 'POST', body: { password: 'nope' } });
  assert.equal(bad.status, 401);

  const ok = await call('login', { method: 'POST', body: { password: 'correct horse' } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers['set-cookie'];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const list = await call('posts', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.posts, []);

  // A tampered cookie is rejected.
  const forged = cookie.split(';')[0].replace(/\.[^.]+$/, '.AAAA');
  assert.equal((await call('posts', { headers: { cookie: forged } })).status, 401);
});

test('password guessing is cut off', async () => {
  for (let i = 0; i < 8; i++) await call('login', { method: 'POST', body: { password: `guess${i}` } });
  const blocked = await call('login', { method: 'POST', body: { password: 'correct horse' } });
  assert.equal(blocked.status, 429);
});

test('the worker refuses unsigned or forged deliveries', async () => {
  const body = { postId: 'x', rev: 1, kind: 'run' };
  assert.equal((await call('worker', { method: 'POST', body })).status, 401);
  assert.equal((await call('worker', { method: 'POST', body, headers: { 'upstash-signature': 'eyJhbGciOiJIUzI1NiJ9.e30.bad' } })).status, 401);
});

test('a correctly signed QStash delivery reaches the post runner', async () => {
  const crypto = require('crypto');
  const raw = JSON.stringify({ postId: 'missing-post', rev: 1, kind: 'run' });
  const b64 = (v) => Buffer.from(v).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = b64(JSON.stringify({
    iss: 'Upstash', sub: 'https://studio.example/api/worker', iat: now, nbf: now, exp: now + 300, jti: 'j1',
    body: crypto.createHash('sha256').update(raw).digest('base64url'),
  }));
  const sig = crypto.createHmac('sha256', 'sig_current').update(`${head}.${claims}`).digest('base64url');

  const r = await call('worker', { method: 'POST', body: raw, headers: { 'upstash-signature': `${head}.${claims}.${sig}` } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { skipped: 'missing' });

  // Same signature, different bytes: refused.
  const tampered = await call('worker', { method: 'POST', body: raw.replace('missing-post', 'other'), headers: { 'upstash-signature': `${head}.${claims}.${sig}` } });
  assert.equal(tampered.status, 401);
});

test('the daily cron needs the cron secret', async () => {
  process.env.CRON_SECRET = 'cron-secret';
  assert.equal((await call('cron-daily', { headers: {} })).status, 401);
  assert.equal((await call('cron-daily', { headers: { authorization: 'Bearer wrong' } })).status, 401);
});

test('the site reader only fetches photo filenames', async () => {
  const ok = await call('login', { method: 'POST', body: { password: 'correct horse' } });
  const cookie = ok.headers['set-cookie'].split(';')[0];
  for (const bad of ['../.env', 'a/b.webp', 'x.html', '%2e%2e%2fsecret.webp']) {
    const r = await call('site', { url: `/api/site?photo=${encodeURIComponent(bad)}`, headers: { cookie } });
    assert.equal(r.status, 400, bad);
  }
});
