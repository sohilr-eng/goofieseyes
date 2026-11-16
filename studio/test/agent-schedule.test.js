const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');

process.env.META_SYSTEM_USER_TOKEN = 'SYSTEM_TOKEN';
process.env.THREADS_ACCESS_TOKEN = 'THREADS_TOKEN';
process.env.STUDIO_AGENT_TOKEN = 'agent-secret';
delete process.env.VERCEL;
delete process.env.QSTASH_TOKEN;

const { installFakeMeta } = require('./fake-meta');
const { resetStoreForTests, getStore } = require('../lib/store');
const { resetAccountCacheForTests } = require('../lib/accounts');
const posts = require('../lib/posts');

const IMG = { url: 'https://x.public.blob.vercel-storage.com/media/a.jpg', type: 'image' };
const DAY = 86400e3;

let fake;
test.beforeEach(() => {
  resetStoreForTests();
  resetAccountCacheForTests();
  fake = installFakeMeta();
});
test.afterEach(() => fake.restore());

function call(method, url, { headers = {}, body } = {}) {
  const req = new PassThrough();
  Object.assign(req, { method, url, headers, socket: { remoteAddress: '1.2.3.4' } });
  req.end(body ? JSON.stringify(body) : undefined);
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (chunk) => { res.body = chunk ? String(chunk) : ''; };
  return require('../api/agent')(req, res).then(() => ({ status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }));
}
const AUTH = { authorization: 'Bearer agent-secret' };
const SCHEDULE = '/api/agent?view=schedule';

// Writes a post record straight into the store, the way lib/posts.js keeps them,
// so posts can sit in the past and carry publish results.
let seq = 0;
async function put(fields) {
  const now = Date.now();
  const post = {
    id: `t${++seq}`, rev: 1, createdAt: now, updatedAt: now, queued: true, status: 'scheduled',
    caption: 'notes', captions: {}, media: [IMG], platforms: ['facebook'], needsCaptions: false, targets: {},
    ...fields,
  };
  await getStore().set(`post:${post.id}`, post);
  await getStore().zadd('posts', { score: post.createdAt, member: post.id });
  return post;
}

test('the schedule view needs the agent token', async () => {
  assert.equal((await call('GET', SCHEDULE)).status, 401);
  assert.equal((await call('GET', SCHEDULE, { headers: { authorization: 'Bearer nope-nope-nop' } })).status, 401);
  const r = await call('GET', SCHEDULE, { headers: AUTH });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.posts, []);
  assert.ok(!Number.isNaN(Date.parse(r.json.generatedAt)));
});

test('window: 14 days back onward, no upper limit, any status', async () => {
  const now = Date.now();
  await put({ id: 'old15', scheduledAt: now - 15 * DAY, status: 'published' });
  await put({ id: 'old13', scheduledAt: now - 13 * DAY, status: 'published' });
  await put({ id: 'future', scheduledAt: now + 90 * DAY });
  await put({ id: 'gone', scheduledAt: now + DAY, status: 'cancelled' });
  const { json } = await call('GET', SCHEDULE, { headers: AUTH });
  assert.deepEqual(json.posts.map((p) => p.id), ['old13', 'gone', 'future']);
  assert.equal(json.posts[1].status, 'cancelled');
});

test('soonest first, capped at 200', async () => {
  const now = Date.now();
  for (let i = 0; i < 205; i += 1) {
    // created in an order unrelated to schedule order
    await put({ id: `p${i}`, scheduledAt: now + ((i * 37) % 205) * 3600e3, createdAt: now - i });
  }
  const { json } = await call('GET', SCHEDULE, { headers: AUTH });
  assert.equal(json.posts.length, 200);
  const times = json.posts.map((p) => Date.parse(p.scheduledAt));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(times[0], now);
});

test('caption preview: best caption, whitespace collapsed, max 140 chars', async () => {
  const now = Date.now();
  const long = `First line\n\n  second   line ${'x'.repeat(300)}`;
  await put({ id: 'ig', scheduledAt: now + 1, captions: { instagram: long, facebook: 'fb', threads: 'th' } });
  await put({ id: 'fb', scheduledAt: now + 2, captions: { facebook: 'fb\ttext', threads: 'th' } });
  await put({ id: 'th', scheduledAt: now + 3, captions: { threads: 'only threads' } });
  await put({ id: 'notes', scheduledAt: now + 4, caption: '  just\nnotes ' });
  await put({ id: 'none', scheduledAt: now + 5, caption: '' });
  const { json } = await call('GET', SCHEDULE, { headers: AUTH });
  const byId = Object.fromEntries(json.posts.map((p) => [p.id, p.caption]));
  assert.ok(byId.ig.length <= 140);
  assert.ok(byId.ig.startsWith('First line second line xxx'));
  assert.ok(!/\s{2}|\n/.test(byId.ig));
  assert.equal(byId.fb, 'fb text');
  assert.equal(byId.th, 'only threads');
  assert.equal(byId.notes, 'just notes');
  assert.equal(byId.none, '');
});

test('per-platform state and permalink come from targets; no media or full captions', async () => {
  const now = Date.now();
  await put({
    id: 'mixed', scheduledAt: now - DAY, status: 'partial', held: 'captions', needsCaptions: true,
    platforms: ['facebook', 'instagram', 'threads'],
    captions: { instagram: 'ig caption' },
    targets: {
      facebook: { state: 'published', permalink: 'https://www.facebook.com/p/1', attempts: 1 },
      instagram: { state: 'failed', error: 'boom', containerId: 'C1', attempts: 3 },
    },
  });
  const { json } = await call('GET', SCHEDULE, { headers: AUTH });
  const [p] = json.posts;
  assert.equal(p.status, 'partial');
  assert.equal(p.held, true);
  assert.equal(p.needsCaptions, true);
  assert.deepEqual(p.platforms, ['facebook', 'instagram', 'threads']);
  assert.deepEqual(p.platformState, {
    facebook: { state: 'published', permalink: 'https://www.facebook.com/p/1' },
    instagram: { state: 'failed', permalink: null },
    threads: { state: null, permalink: null },
  });
  assert.deepEqual(Object.keys(p).sort(), ['caption', 'held', 'id', 'needsCaptions', 'platformState', 'platforms', 'scheduledAt', 'status']);
  assert.ok(!JSON.stringify(json).includes('blob.vercel-storage.com'));
});

test('the schedule view changes nothing in storage', async () => {
  const now = Date.now();
  await put({ id: 'a', scheduledAt: now + DAY, needsCaptions: true });
  await put({ id: 'b', scheduledAt: now - DAY, status: 'published' });
  const before = JSON.stringify([await getStore().get('post:a'), await getStore().get('post:b'), await getStore().zrange('posts', 0, -1)]);
  await call('GET', SCHEDULE, { headers: AUTH });
  const after = JSON.stringify([await getStore().get('post:a'), await getStore().get('post:b'), await getStore().zrange('posts', 0, -1)]);
  assert.equal(after, before);
});

test('unknown view is a 400; a view on POST is refused', async () => {
  const r = await call('GET', '/api/agent?view=everything', { headers: AUTH });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /view/i);
  assert.equal((await call('POST', '/api/agent?view=schedule&id=x', { headers: AUTH, body: {} })).status, 405);
});

test('plain GET still lists only posts waiting on captions, in its old shape', async () => {
  const now = Date.now();
  await posts.createPost({ caption: 'macaws', media: [IMG], platforms: ['facebook'], needsCaptions: true, scheduledAt: new Date(now + DAY).toISOString() }, now);
  await posts.createPost({ caption: 'done', media: [IMG], platforms: ['facebook'], scheduledAt: new Date(now + DAY).toISOString() }, now);
  const { status, json } = await call('GET', '/api/agent', { headers: AUTH });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(json).sort(), ['posts', 'recentEndings']);
  assert.equal(json.posts.length, 1);
  assert.equal(json.posts[0].notes, 'macaws');
  assert.deepEqual(json.posts[0].media, [{ type: 'image', url: IMG.url }]);
});
