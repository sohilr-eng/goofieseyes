const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');

// Fake values only: none of these is a real credential.
process.env.META_SYSTEM_USER_TOKEN = 'SYSTEM_TOKEN';
process.env.THREADS_ACCESS_TOKEN = 'THREADS_TOKEN';
process.env.STUDIO_AGENT_TOKEN = 'agent-secret';
process.env.STUDIO_PASSWORD = 'correct horse';
process.env.SESSION_SECRET = 'test-secret';
delete process.env.VERCEL;
delete process.env.QSTASH_TOKEN;

const { installFakeMeta } = require('./fake-meta');
const { resetStoreForTests } = require('../lib/store');
const { resetAccountCacheForTests } = require('../lib/accounts');
const posts = require('../lib/posts');

const IMG = { url: 'https://abc123.public.blob.vercel-storage.com/media/a.jpg', type: 'image' };
const DAY = 86400e3;

let fake;
test.beforeEach(() => {
  resetStoreForTests();
  resetAccountCacheForTests();
  fake = installFakeMeta();
});
test.afterEach(() => fake.restore());

function call(route, method, url, { headers = {}, body } = {}) {
  const req = new PassThrough();
  Object.assign(req, { method, url, headers, socket: { remoteAddress: '1.2.3.4' } });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (chunk) => { res.body = chunk ? String(chunk) : ''; };
  return require(`../api/${route}`)(req, res).then(() => ({ status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : null }));
}
const AUTH = { authorization: 'Bearer agent-secret' };
const agent = (method, url, opts = {}) => call('agent', method, url, { ...opts, headers: { ...AUTH, ...opts.headers } });
const published = () => fake.calls.filter((c) => c.method === 'POST');
const iso = (ms) => new Date(ms).toISOString();

async function browserCookie() {
  const r = await call('login', 'POST', '/api/login', { body: { password: 'correct horse' } });
  return r.headers['set-cookie'].split(';')[0];
}

const draft = (fields = {}) => posts.createPost({
  caption: 'desk notes', media: [IMG], platforms: ['facebook'], scheduledAt: iso(Date.now() + DAY), ...fields,
}, Date.now(), { by: 'agent' });
const setTime = (id, scheduledAt) => agent('POST', `/api/agent?action=set-time&id=${id}`, { body: { scheduledAt } });

// ─── set-time ────────────────────────────────────────────────────────────────

test('set-time moves a waiting draft, bumps rev and strands the old message', async () => {
  const d = await draft();
  const at = iso(Date.now() + 2 * DAY);
  const r = await setTime(d.id, at);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { id: d.id, scheduledAt: at, approval: 'waiting' });

  const saved = await posts.getPost(d.id);
  assert.equal(saved.scheduledAt, Date.parse(at));
  assert.equal(saved.approval, 'waiting');
  assert.equal(saved.scheduledBy, 'agent');
  assert.ok(saved.scheduledByAt > 0);
  assert.ok(saved.rev > d.rev);
  assert.equal(saved.queued, true);
  assert.deepEqual(await posts.runPost({ postId: d.id, rev: d.rev, kind: 'run' }, Date.now() + DAY), { skipped: 'stale' });
  // At the new time it is still held for approval: set-time is not approval.
  assert.deepEqual(await posts.runPost({ postId: d.id, rev: saved.rev, kind: 'run' }, Date.parse(at)), { skipped: 'awaiting-approval' });
  assert.equal(published().length, 0);
});

test('set-time on a held draft clears the hold, keeps it waiting', async () => {
  const d = await draft({ scheduledAt: iso(Date.now() + 60e3) });
  await posts.runPost({ postId: d.id, rev: d.rev, kind: 'run' }, Date.now() + 60e3);
  assert.equal((await posts.getPost(d.id)).held, 'approval');
  const r = await setTime(d.id, iso(Date.now() + DAY));
  assert.equal(r.status, 200);
  const saved = await posts.getPost(d.id);
  assert.equal(saved.held, null);
  assert.equal(saved.approval, 'waiting');
  assert.deepEqual(await posts.runPost({ postId: d.id, rev: saved.rev, kind: 'run' }, Date.now() + DAY), { skipped: 'awaiting-approval' });
});

test('set-time refuses approved, cancelled and browser posts', async () => {
  const d = await draft();
  await posts.approvePost(d.id, {});
  const r = await setTime(d.id, iso(Date.now() + 2 * DAY));
  assert.equal(r.status, 409);
  assert.match(r.json.error, /Already approved: only Sohil can move it now/);

  const own = await posts.createPost({ caption: 'mine', media: [IMG], platforms: ['facebook'], scheduledAt: iso(Date.now() + DAY) });
  assert.equal((await setTime(own.id, iso(Date.now() + 2 * DAY))).status, 409);
  assert.equal((await posts.getPost(own.id)).scheduledAt, own.scheduledAt);

  const gone = await draft();
  await posts.rejectPost(gone.id);
  assert.equal((await setTime(gone.id, iso(Date.now() + 2 * DAY))).status, 409);
  assert.equal((await setTime('nope', iso(Date.now() + 2 * DAY))).status, 404);
});

test('set-time refuses past, far-off and non-dates; needs an id and the agent token', async () => {
  const d = await draft();
  assert.equal((await setTime(d.id, iso(Date.now() - 60e3))).status, 400);
  assert.equal((await setTime(d.id, iso(Date.now() + 400 * DAY))).status, 400);
  assert.equal((await setTime(d.id, 'next tuesday')).status, 400);
  assert.equal((await setTime(d.id, undefined)).status, 400);
  assert.equal((await agent('POST', '/api/agent?action=set-time', { body: { scheduledAt: iso(Date.now() + DAY) } })).status, 400);
  assert.equal((await agent('GET', `/api/agent?action=set-time&id=${d.id}`)).status, 405);
  assert.equal((await call('agent', 'POST', `/api/agent?action=set-time&id=${d.id}`, { body: { scheduledAt: iso(Date.now() + 2 * DAY) } })).status, 401);
  const saved = await posts.getPost(d.id);
  assert.equal(saved.rev, d.rev);
  assert.equal(saved.scheduledAt, d.scheduledAt);
});

test('set-time cannot approve, even when asked to', async () => {
  const d = await draft();
  const r = await agent('POST', `/api/agent?action=set-time&id=${d.id}`, { body: { scheduledAt: iso(Date.now() + 2 * DAY), approval: 'approved' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.approval, 'waiting');
  assert.equal((await posts.getPost(d.id)).approval, 'waiting');
});

test('the owner moving the time clears "set by the scheduler"', async () => {
  const d = await draft();
  await setTime(d.id, iso(Date.now() + 2 * DAY));
  const approved = await posts.approvePost(d.id, { scheduledAt: iso(Date.now() + 3 * DAY) });
  assert.equal(approved.scheduledBy, null);
  const kept = await draft();
  await setTime(kept.id, iso(Date.now() + 2 * DAY));
  assert.equal((await posts.approvePost(kept.id, {})).scheduledBy, 'agent');
});

// ─── Instagram captions are the owner's ──────────────────────────────────────

test('the desk endpoint refuses an Instagram caption outright', async () => {
  const p = await posts.createPost({ caption: 'notes', media: [IMG], platforms: ['facebook', 'instagram'], needsCaptions: true, scheduledAt: iso(Date.now() + DAY) });
  const r = await agent('POST', `/api/agent?id=${p.id}`, { body: { captions: { facebook: 'fb', instagram: 'ig from the desk' } } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Instagram captions are Sohil's to write/);
  const saved = await posts.getPost(p.id);
  assert.equal(saved.needsCaptions, true);
  assert.deepEqual(saved.captions, {});
  assert.equal(saved.captionsOwner, undefined);

  // The list tells the desk what it may write.
  const list = await agent('GET', '/api/agent');
  assert.deepEqual(list.json.posts[0].writablePlatforms, ['facebook']);
});

test('lib applyCaptions never writes Instagram either', async () => {
  const p = await posts.createPost({ caption: 'notes', media: [IMG], platforms: ['facebook', 'instagram'], needsCaptions: true, scheduledAt: iso(Date.now() + DAY) });
  const saved = await posts.applyCaptions(p.id, { facebook: 'fb', instagram: 'sneaky' });
  assert.equal(saved.captions.instagram, undefined);
  assert.equal(saved.captionsOwner, undefined);
});

test('approve is blocked until the owner writes the Instagram caption in the browser', async () => {
  const d = await draft({ platforms: ['facebook', 'instagram'], needsCaptions: true });
  assert.equal((await agent('POST', `/api/agent?id=${d.id}`, { body: { captions: { facebook: 'fb' } } })).status, 200);
  const waiting = await posts.getPost(d.id);
  assert.equal(waiting.needsCaptions, false);
  assert.equal(posts.needsOwnerInstagram(waiting), true);

  const cookie = await browserCookie();
  const no = await call('posts', 'POST', `/api/posts?id=${d.id}&action=approve`, { headers: { cookie }, body: {} });
  assert.equal(no.status, 409);
  assert.match(no.json.error, /Write the Instagram caption yourself first/);

  // The owner edits it in the browser and adds his Instagram caption.
  const edit = await call('posts', 'PUT', `/api/posts?id=${d.id}`, {
    headers: { cookie },
    body: { caption: 'desk notes', captions: { facebook: 'fb', instagram: 'my own words' }, media: [IMG], platforms: ['facebook', 'instagram'], scheduledAt: iso(waiting.scheduledAt) },
  });
  assert.equal(edit.status, 200);
  assert.deepEqual(edit.json.post.captionsOwner, { instagram: 'owner' });
  assert.equal(edit.json.post.approval, 'waiting');

  const ok = await call('posts', 'POST', `/api/posts?id=${d.id}&action=approve`, { headers: { cookie }, body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.post.approval, 'approved');

  // The desk can't sneak a new Instagram caption in afterwards.
  assert.equal((await agent('POST', `/api/agent?id=${d.id}`, { body: { captions: { instagram: 'x' } } })).status, 400);
});

test('desk captions keep the owner\'s Instagram caption, and he can approve', async () => {
  const p = await posts.createPost({
    caption: 'notes', captions: { instagram: 'mine' }, media: [IMG], platforms: ['facebook', 'threads', 'instagram'], needsCaptions: true, scheduledAt: iso(Date.now() + DAY),
  });
  assert.deepEqual(p.captionsOwner, { instagram: 'owner' });
  const captioned = await posts.applyCaptions(p.id, { facebook: 'fb', threads: 'th' });
  assert.equal(captioned.captions.instagram, 'mine');
  assert.equal(captioned.approval, 'waiting');
  assert.equal((await posts.approvePost(p.id, {})).approval, 'approved');
});

test('an Instagram import counts as the owner\'s caption', async () => {
  const p = await posts.createPost({
    caption: 'from my own IG post', media: [IMG], platforms: ['facebook', 'instagram'], scheduledAt: iso(Date.now() + DAY),
    source: { type: 'instagram', id: '123', permalink: 'https://www.instagram.com/p/abc/' },
  });
  assert.deepEqual(p.captionsOwner, { instagram: 'owner' });
  assert.equal(posts.needsOwnerInstagram(p), false);
});

test('Facebook and Threads only posts are unaffected', async () => {
  const d = await draft({ platforms: ['facebook', 'threads'], needsCaptions: true });
  assert.equal((await agent('POST', `/api/agent?id=${d.id}`, { body: { captions: { facebook: 'fb', threads: 'th' } } })).status, 200);
  const list = await agent('GET', '/api/agent');
  assert.deepEqual(list.json.posts, []);
  const approved = await posts.approvePost(d.id, {});
  assert.equal(approved.approval, 'approved');
  assert.equal(approved.captionsOwner, undefined);
});
