const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');

// Fake values only: none of these is a real credential.
process.env.META_SYSTEM_USER_TOKEN = 'SYSTEM_TOKEN';
process.env.THREADS_ACCESS_TOKEN = 'THREADS_TOKEN';
process.env.STUDIO_AGENT_TOKEN = 'agent-secret';
process.env.STUDIO_PASSWORD = 'correct horse';
process.env.SESSION_SECRET = 'test-secret';
process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_FAKESTORE_notarealsecret';
delete process.env.VERCEL;
delete process.env.QSTASH_TOKEN;

const { getPayloadFromClientToken } = require('@vercel/blob/client');
const { installFakeMeta } = require('./fake-meta');
const { resetStoreForTests, getStore } = require('../lib/store');
const { resetAccountCacheForTests } = require('../lib/accounts');
const posts = require('../lib/posts');
const { placeholderTime } = require('../api/agent');

const VIDEO_URL = 'https://abc123.public.blob.vercel-storage.com/media/trinidad-photos-Xy12.mp4';
const IMG = { url: 'https://abc123.public.blob.vercel-storage.com/media/a.jpg', type: 'image' };
const DAY = 86400e3;
const T0 = Date.UTC(2026, 10, 1, 12);
const MB = 1024 * 1024;

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

async function browserCookie() {
  const r = await call('login', 'POST', '/api/login', { body: { password: 'correct horse' } });
  return r.headers['set-cookie'].split(';')[0];
}

const draftBody = (extra = {}) => ({
  media: [{ type: 'video', url: VIDEO_URL }],
  platforms: ['facebook', 'threads'],
  needsCaptions: true,
  notes: 'trinidad, street portraits',
  source: { desk: 'goofieseyes-desk', file: 'trinidad-photos.mp4' },
  ...extra,
});

// An agent draft created straight through lib/posts, at a fixed clock.
const agentDraft = (fields = {}) => posts.createPost({
  caption: 'notes', media: [IMG], platforms: ['facebook'], scheduledAt: new Date(T0 + DAY).toISOString(), ...fields,
}, T0, { by: 'agent' });

// ─── upload-token ────────────────────────────────────────────────────────────

test('upload-token needs the agent token', async () => {
  const body = { pathname: 'media/a.mp4', contentType: 'video/mp4', size: 10 * MB };
  assert.equal((await call('agent', 'POST', '/api/agent?action=upload-token', { body })).status, 401);
  assert.equal((await call('agent', 'POST', '/api/agent?action=upload-token', { body, headers: { authorization: 'Bearer nope-nope-nop' } })).status, 401);
});

test('upload-token hands out a 15-minute client token with the studio limits', async () => {
  const before = Date.now();
  const r = await agent('POST', '/api/agent?action=upload-token', { body: { pathname: 'media/trinidad-photos.mp4', contentType: 'video/mp4', size: 120 * MB } });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['clientToken', 'expiresAt', 'pathname']);
  assert.equal(r.json.pathname, 'media/trinidad-photos.mp4');
  assert.match(r.json.clientToken, /^vercel_blob_client_FAKESTORE_/);
  assert.ok(!r.json.clientToken.includes('notarealsecret'));

  const payload = getPayloadFromClientToken(r.json.clientToken);
  assert.equal(payload.pathname, 'media/trinidad-photos.mp4');
  assert.deepEqual(payload.allowedContentTypes, ['video/mp4']);
  assert.equal(payload.maximumSizeInBytes, 300 * MB);
  assert.equal(payload.addRandomSuffix, true);
  assert.equal(payload.allowOverwrite, false);
  assert.equal(new Date(r.json.expiresAt).getTime(), payload.validUntil);
  const minutes = (payload.validUntil - before) / 60e3;
  assert.ok(minutes > 14.9 && minutes < 15.1, `valid for ${minutes} minutes`);
});

test('upload-token enforces path, type and size', async () => {
  const ask = (body) => agent('POST', '/api/agent?action=upload-token', { body });
  const ok = { pathname: 'media/a.mp4', contentType: 'video/mp4', size: MB };
  assert.equal((await ask({ ...ok, pathname: 'other/a.mp4' })).status, 400);
  assert.equal((await ask({ ...ok, pathname: 'media/../a.mp4' })).status, 400);
  assert.equal((await ask({ ...ok, pathname: 'media/sub/a.mp4' })).status, 400);
  assert.equal((await ask({ ...ok, contentType: 'image/png' })).status, 400);
  assert.equal((await ask({ ...ok, contentType: 'text/html' })).status, 400);
  assert.equal((await ask({ ...ok, size: undefined })).status, 400);
  assert.equal((await ask({ ...ok, size: -1 })).status, 400);
  const big = await ask({ ...ok, size: 300 * MB + 1 });
  assert.equal(big.status, 413);
  assert.match(big.json.error, /300 MB/);
  assert.equal((await ask({ ...ok, size: 300 * MB })).status, 200);
  for (const contentType of ['image/jpeg', 'video/quicktime']) assert.equal((await ask({ ...ok, contentType })).status, 200, contentType);
});

test('actions: unknown → 400, not POST → 405, and there is no approve', async () => {
  assert.equal((await agent('POST', '/api/agent?action=publish', { body: {} })).status, 400);
  assert.equal((await agent('GET', '/api/agent?action=upload-token')).status, 405);
  assert.equal((await agent('GET', '/api/agent?action=create-draft')).status, 405);

  const draft = await agentDraft();
  for (const action of ['approve', 'release', 'reject']) {
    const r = await agent('POST', `/api/agent?action=${action}&id=${draft.id}`, { body: {} });
    assert.equal(r.status, 400, action);
  }
  const saved = await posts.getPost(draft.id);
  assert.equal(saved.approval, 'waiting');
  assert.equal(saved.status, 'scheduled');
});

// ─── create-draft ────────────────────────────────────────────────────────────

test('create-draft makes a waiting post with a placeholder time', async () => {
  const before = Date.now();
  const r = await agent('POST', '/api/agent?action=create-draft', { body: draftBody() });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.json).sort(), ['approval', 'id', 'scheduledAt']);
  assert.equal(r.json.approval, 'waiting');

  const post = await posts.getPost(r.json.id);
  assert.equal(post.approval, 'waiting');
  assert.equal(post.createdBy, 'agent');
  assert.equal(post.needsCaptions, true);
  assert.equal(post.caption, 'trinidad, street portraits');
  assert.deepEqual(post.platforms, ['facebook', 'threads']);
  assert.deepEqual(post.media.map((m) => [m.type, m.url, m.pathname]), [['video', VIDEO_URL, 'media/trinidad-photos-Xy12.mp4']]);
  assert.deepEqual(post.source, { type: 'desk', desk: 'goofieseyes-desk', file: 'trinidad-photos.mp4' });
  assert.equal(post.scheduledAt, Date.parse(r.json.scheduledAt));
  assert.equal(post.scheduledAt, placeholderTime(before));

  // It shows in the caption desk's list and as waiting in the schedule view.
  const list = await agent('GET', '/api/agent');
  assert.deepEqual(list.json.posts.map((p) => p.id), [post.id]);
  const view = await agent('GET', '/api/agent?view=schedule');
  assert.equal(view.json.posts[0].approval, 'waiting');
});

test('the placeholder is 12:00 in New York, three days out, across DST', () => {
  const ny = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hourCycle: 'h23' });
  assert.equal(new Date(placeholderTime(Date.UTC(2026, 10, 17, 15))).toISOString(), '2026-11-20T17:00:00.000Z');
  assert.equal(new Date(placeholderTime(Date.UTC(2026, 2, 6, 15))).toISOString(), '2026-03-09T16:00:00.000Z');
  assert.match(ny(placeholderTime(Date.UTC(2026, 6, 1, 3))), /^7\/3\/2026, 12:00:00$/);
});

test('create-draft keeps a time it is given', async () => {
  const at = new Date(Date.now() + 2 * DAY).toISOString();
  const r = await agent('POST', '/api/agent?action=create-draft', { body: draftBody({ scheduledAt: at }) });
  assert.equal(r.status, 201);
  assert.equal(r.json.scheduledAt, at);
});

test('create-draft only takes links into a public Blob store', async () => {
  const bad = [
    'http://abc123.public.blob.vercel-storage.com/media/a.mp4',
    'https://evil.example/media/a.mp4',
    'https://abc123.public.blob.vercel-storage.com.evil.example/a.mp4',
    'https://abc123.blob.vercel-storage.com/media/a.mp4',
    'https://user:pw@abc123.public.blob.vercel-storage.com/media/a.mp4',
    'https://abc123.public.blob.vercel-storage.com:8443/media/a.mp4',
    'https://public.blob.vercel-storage.com/a.mp4',
    'not a url',
  ];
  for (const url of bad) {
    const r = await agent('POST', '/api/agent?action=create-draft', { body: draftBody({ media: [{ type: 'video', url }] }) });
    assert.equal(r.status, 400, url);
  }
  assert.deepEqual(await posts.listPosts(), []);
});

test('create-draft validates media, platforms, notes and time', async () => {
  const send = (extra) => agent('POST', '/api/agent?action=create-draft', { body: draftBody(extra) });
  assert.equal((await send({ media: [] })).status, 400);
  assert.equal((await send({ media: [{ type: 'gif', url: VIDEO_URL }] })).status, 400);
  assert.equal((await send({ platforms: [] })).status, 400);
  assert.equal((await send({ platforms: ['facebook', 'tiktok'] })).status, 400);
  assert.equal((await send({ notes: 42 })).status, 400);
  assert.equal((await send({ scheduledAt: 'tomorrow-ish' })).status, 400);
  assert.equal((await send({ scheduledAt: new Date(Date.now() - DAY).toISOString() })).status, 400);
  // Studio rules still apply: Facebook takes one video, not a mix.
  assert.equal((await send({ media: [{ type: 'video', url: VIDEO_URL }, IMG] })).status, 400);
  assert.equal((await agent('POST', '/api/agent?action=create-draft', { body: [] })).status, 400);
  assert.deepEqual(await posts.listPosts(), []);
});

// ─── The approval gate ───────────────────────────────────────────────────────

test('a waiting post never publishes; it is held for approval', async () => {
  const draft = await agentDraft({ needsCaptions: false });
  const r = await posts.runPost({ postId: draft.id, rev: draft.rev, kind: 'run' }, T0 + DAY);
  assert.deepEqual(r, { skipped: 'awaiting-approval' });
  const saved = await posts.getPost(draft.id);
  assert.equal(saved.held, 'approval');
  assert.equal(saved.status, 'scheduled');
  // A stray check message does nothing either.
  assert.deepEqual(await posts.runPost({ postId: draft.id, rev: saved.rev, kind: 'check' }, T0 + DAY), { skipped: 'awaiting-approval' });
  assert.equal(published().length, 0);
});

test('captions from the desk put an approved post back to waiting', async () => {
  // Composed by the owner in the browser, asking the desk for captions.
  const own = await posts.createPost({ caption: 'notes', media: [IMG], platforms: ['facebook'], needsCaptions: true, scheduledAt: new Date(T0 + DAY).toISOString() }, T0);
  assert.equal(own.approval, 'approved');
  const captioned = await posts.applyCaptions(own.id, { facebook: 'desk caption' }, T0 + 3600e3);
  assert.equal(captioned.approval, 'waiting');
  assert.equal(captioned.held, undefined);

  // Its original queue message is still the one that fires; it gets held.
  assert.deepEqual(await posts.runPost({ postId: own.id, rev: captioned.rev, kind: 'run' }, T0 + DAY), { skipped: 'awaiting-approval' });
  assert.equal((await posts.getPost(own.id)).held, 'approval');
  assert.equal(published().length, 0);

  // Via the desk's endpoint too.
  const other = await posts.createPost({ caption: 'n', media: [IMG], platforms: ['facebook'], needsCaptions: true, scheduledAt: new Date(Date.now() + DAY).toISOString() });
  const r = await agent('POST', `/api/agent?id=${other.id}`, { body: { captions: { facebook: 'fb' } } });
  assert.equal(r.status, 200);
  assert.equal(r.json.approval, 'waiting');
});

test('approve refuses while captions are still needed; release keeps it waiting', async () => {
  const draft = await agentDraft({ needsCaptions: true });
  await assert.rejects(posts.approvePost(draft.id, {}, T0), /write or release captions first/);
  const released = await posts.releasePost(draft.id, T0);
  assert.equal(released.needsCaptions, false);
  assert.equal(released.approval, 'waiting');
  assert.deepEqual(await posts.runPost({ postId: draft.id, rev: released.rev, kind: 'run' }, T0 + DAY), { skipped: 'awaiting-approval' });
  assert.equal(published().length, 0);
});

test('approve before its time keeps the slot; it goes out then', async () => {
  const draft = await agentDraft();
  const approved = await posts.approvePost(draft.id, {}, T0 + 3600e3);
  assert.equal(approved.approval, 'approved');
  assert.equal(approved.scheduledAt, T0 + DAY);
  assert.ok(approved.rev > draft.rev);
  assert.deepEqual(await posts.runPost({ postId: draft.id, rev: draft.rev, kind: 'run' }, T0 + DAY), { skipped: 'stale' });
  const r = await posts.runPost({ postId: draft.id, rev: approved.rev, kind: 'run' }, T0 + DAY);
  assert.equal(r.status, 'published');
  await assert.rejects(posts.approvePost(draft.id, {}, T0 + DAY), /published/);
});

test('approve with a new time, or post now', async () => {
  const a = await agentDraft();
  const moved = await posts.approvePost(a.id, { scheduledAt: new Date(T0 + 2 * DAY).toISOString() }, T0);
  assert.equal(moved.scheduledAt, T0 + 2 * DAY);
  await assert.rejects(posts.approvePost((await agentDraft()).id, { scheduledAt: new Date(T0 - DAY).toISOString() }, T0), /already passed/);

  const b = await agentDraft();
  const now = await posts.approvePost(b.id, { publishNow: true }, T0 + 60e3);
  assert.equal(now.scheduledAt, T0 + 60e3);
  assert.equal((await posts.runPost({ postId: b.id, rev: now.rev, kind: 'run' }, T0 + 60e3)).status, 'published');
});

test('approve after its time (held) sends it out now', async () => {
  const draft = await agentDraft();
  await posts.runPost({ postId: draft.id, rev: draft.rev, kind: 'run' }, T0 + DAY); // held
  const later = T0 + 2 * DAY;
  const approved = await posts.approvePost(draft.id, {}, later);
  assert.equal(approved.held, null);
  assert.equal(approved.scheduledAt, later);
  assert.equal((await posts.runPost({ postId: draft.id, rev: approved.rev, kind: 'run' }, later)).status, 'published');
});

test('reject cancels it; nothing publishes', async () => {
  const draft = await agentDraft();
  const rejected = await posts.rejectPost(draft.id);
  assert.equal(rejected.approval, 'rejected');
  assert.equal(rejected.status, 'cancelled');
  assert.deepEqual(await posts.runPost({ postId: draft.id, rev: draft.rev, kind: 'run' }, T0 + DAY), { skipped: 'stale' });
  assert.deepEqual(await posts.runPost({ postId: draft.id, rev: rejected.rev, kind: 'run' }, T0 + DAY), { skipped: 'cancelled' });
  await assert.rejects(posts.approvePost(draft.id, {}, T0), /cancelled/);
  assert.equal(published().length, 0);
});

test('editing a waiting post in the browser does not approve it', async () => {
  const draft = await agentDraft();
  const edited = await posts.updatePost(draft.id, { caption: 'changed', media: [IMG], platforms: ['facebook'], scheduledAt: new Date(T0 + DAY).toISOString(), approval: 'approved' }, T0);
  assert.equal(edited.approval, 'waiting');
  assert.equal(edited.createdBy, 'agent');
  assert.deepEqual(await posts.runPost({ postId: draft.id, rev: edited.rev, kind: 'run' }, T0 + DAY), { skipped: 'awaiting-approval' });
});

test('older posts without an approval field still publish', async () => {
  const legacy = {
    id: 'legacy1', rev: 1, createdAt: T0, updatedAt: T0, queued: true, status: 'scheduled', scheduledAt: T0,
    caption: 'old one', captions: {}, media: [IMG], platforms: ['facebook'], needsCaptions: false, targets: {},
  };
  await getStore().set('post:legacy1', legacy);
  await getStore().zadd('posts', { score: T0, member: 'legacy1' });
  assert.equal((await posts.runPost({ postId: 'legacy1', rev: 1, kind: 'run' }, T0)).status, 'published');
});

test('browser-composed posts start approved and publish on time', async () => {
  const own = await posts.createPost({ caption: 'mine', media: [IMG], platforms: ['facebook'], publishNow: true }, T0);
  assert.equal(own.approval, 'approved');
  assert.equal(own.createdBy, undefined);
  assert.equal((await posts.runPost({ postId: own.id, rev: own.rev, kind: 'run' }, T0)).status, 'published');
});

test('approve and reject in /api/posts need the browser session', async () => {
  const a = await agentDraft();
  const b = await agentDraft();
  // The agent token is no use on the browser routes.
  assert.equal((await call('posts', 'POST', `/api/posts?id=${a.id}&action=approve`, { headers: AUTH, body: {} })).status, 401);
  assert.equal((await posts.getPost(a.id)).approval, 'waiting');

  const cookie = await browserCookie();
  const ok = await call('posts', 'POST', `/api/posts?id=${a.id}&action=approve`, { headers: { cookie }, body: { publishNow: true } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.post.approval, 'approved');
  const no = await call('posts', 'POST', `/api/posts?id=${b.id}&action=reject`, { headers: { cookie } });
  assert.equal(no.status, 200);
  assert.equal(no.json.post.status, 'cancelled');
  assert.equal(no.json.post.approval, 'rejected');
  const again = await call('posts', 'POST', `/api/posts?id=${a.id}&action=approve`, { headers: { cookie }, body: {} });
  assert.equal(again.status, 409);
});
