const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');

process.env.META_SYSTEM_USER_TOKEN = 'SYSTEM_TOKEN';
process.env.THREADS_ACCESS_TOKEN = 'THREADS_TOKEN';
process.env.STUDIO_AGENT_TOKEN = 'agent-secret';
delete process.env.VERCEL;
delete process.env.QSTASH_TOKEN;

const { installFakeMeta } = require('./fake-meta');
const { resetStoreForTests } = require('../lib/store');
const { resetAccountCacheForTests } = require('../lib/accounts');
const posts = require('../lib/posts');

const IMG = { url: 'https://x.public.blob.vercel-storage.com/media/a.jpg', type: 'image' };
const T0 = Date.UTC(2026, 10, 1, 12);
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

const waiting = (at = T0 + DAY) => posts.createPost({
  caption: 'macaws at caroni, sunrise', media: [IMG], platforms: ['facebook', 'threads'],
  needsCaptions: true, scheduledAt: new Date(at).toISOString(),
}, T0);

test('a post still waiting on the desk is held, not published with placeholder text', async () => {
  const post = await waiting();
  const r = await posts.runPost({ postId: post.id, rev: post.rev, kind: 'run' }, T0 + DAY);
  assert.deepEqual(r, { skipped: 'needs-captions' });
  const saved = await posts.getPost(post.id);
  assert.equal(saved.held, 'captions');
  assert.equal(saved.status, 'scheduled');
  assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 0);
});

test('captions from the desk land, and a held post goes straight out', async () => {
  const post = await waiting();
  await posts.runPost({ postId: post.id, rev: post.rev, kind: 'run' }, T0 + DAY); // held
  const later = T0 + DAY + 3600e3;
  const updated = await posts.applyCaptions(post.id, { facebook: 'Long caption…', threads: 'Short one.', instagram: 'ignored, not a platform here' }, later);
  assert.equal(updated.needsCaptions, false);
  assert.equal(updated.held, null);
  assert.equal(updated.captionsBy, 'claude');
  assert.equal(updated.scheduledAt, later);
  assert.deepEqual(updated.captions, { facebook: 'Long caption…', threads: 'Short one.' });

  await posts.runPost({ postId: post.id, rev: updated.rev, kind: 'run' }, later);
  // Facebook is live straight away; Threads is in its ~30s settle wait.
  assert.equal((await posts.getPost(post.id)).targets.facebook.state, 'published');
  assert.equal(fake.calls.find((c) => c.path === '/PAGE1/photos').params.message, 'Long caption…');
});

test('captions written ahead of time keep the original slot', async () => {
  const post = await waiting(T0 + 3 * DAY);
  const updated = await posts.applyCaptions(post.id, { facebook: 'fb', threads: 'th' }, T0 + DAY);
  assert.equal(updated.scheduledAt, T0 + 3 * DAY);
});

test('"Post as is" stops waiting and keeps what is there', async () => {
  const post = await waiting();
  const released = await posts.releasePost(post.id, T0);
  assert.equal(released.needsCaptions, false);
  await posts.runPost({ postId: post.id, rev: released.rev, kind: 'run' }, T0 + DAY);
  const saved = await posts.getPost(post.id);
  assert.equal(saved.targets.facebook.state, 'published');
  assert.equal(fake.calls.find((c) => c.path === '/PAGE1/photos').params.message, 'macaws at caroni, sunrise');
});

test('the desk endpoint needs its own token and lists only waiting posts', async () => {
  await waiting(T0 + 2 * DAY);
  await waiting(T0 + DAY);
  await posts.createPost({ caption: 'already written\n\nIf this belongs on a wall of yours, prints are open.', media: [IMG], platforms: ['facebook'], scheduledAt: new Date(T0 + DAY).toISOString() }, T0);

  assert.equal((await call('GET', '/api/agent')).status, 401);
  assert.equal((await call('GET', '/api/agent', { headers: { authorization: 'Bearer nope-nope-nop' } })).status, 401);

  const { status, json } = await call('GET', '/api/agent', { headers: AUTH });
  assert.equal(status, 200);
  assert.equal(json.posts.length, 2);
  assert.ok(json.posts[0].scheduledAt < json.posts[1].scheduledAt, 'soonest first');
  assert.equal(json.posts[0].notes, 'macaws at caroni, sunrise');
  assert.deepEqual(json.recentEndings, []); // the written post has captions only in the main field
});

test('the desk endpoint writes captions', async () => {
  const post = await waiting();
  const r = await call('POST', `/api/agent?id=${post.id}`, { headers: AUTH, body: { captions: { facebook: 'fb', threads: 'th' } } });
  assert.equal(r.status, 200);
  assert.equal((await posts.getPost(post.id)).captions.facebook, 'fb');
});

test('captions that break the rules are refused', async () => {
  const post = await waiting();
  await assert.rejects(posts.applyCaptions(post.id, { threads: 'x'.repeat(501) }, T0), /Threads: text is 501/);
  assert.equal((await posts.getPost(post.id)).needsCaptions, true);
});
