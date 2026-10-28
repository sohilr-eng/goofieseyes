const test = require('node:test');
const assert = require('node:assert/strict');

process.env.META_SYSTEM_USER_TOKEN = 'SYSTEM_TOKEN';
process.env.THREADS_ACCESS_TOKEN = 'THREADS_TOKEN';
delete process.env.VERCEL;
delete process.env.QSTASH_TOKEN;

const { installFakeMeta } = require('./fake-meta');
const { resetStoreForTests, getStore } = require('../lib/store');
const { resetAccountCacheForTests, refreshThreadsToken, threadsToken } = require('../lib/accounts');
const posts = require('../lib/posts');

const IMG = (n) => ({ url: `https://x.public.blob.vercel-storage.com/media/p${n}.jpg`, type: 'image', width: 1080, height: 1350 });
const VID = { url: 'https://x.public.blob.vercel-storage.com/media/reel.mp4', type: 'video' };
const T0 = Date.UTC(2026, 10, 1, 12);

let fake;
test.beforeEach(() => {
  resetStoreForTests();
  resetAccountCacheForTests();
  fake = installFakeMeta();
});
test.afterEach(() => fake.restore());

// Drives the worker the way QStash would: run once, then keep delivering
// "check" messages after each requested delay until the post settles.
async function drive(post, start = T0) {
  let now = start;
  let msg = { postId: post.id, rev: post.rev, kind: 'run' };
  for (let i = 0; i < 20; i++) {
    const r = await posts.runPost(msg, now);
    const saved = await posts.getPost(post.id);
    if (r.recheckIn == null) return saved;
    now += r.recheckIn * 1000;
    msg = { postId: post.id, rev: saved.rev, kind: 'check' };
  }
  throw new Error('never settled');
}

test('one photo goes live on all three platforms', async () => {
  const post = await posts.createPost({ caption: 'tobago, late light', media: [IMG(1)], platforms: ['facebook', 'instagram', 'threads'], publishNow: true }, T0);
  const done = await drive(post);

  assert.equal(done.status, 'published');
  for (const p of ['facebook', 'instagram', 'threads']) {
    assert.equal(done.targets[p].state, 'published', p);
    assert.match(done.targets[p].permalink, /^https:\/\//, p);
  }
  // Facebook used the Page token, not the system user token.
  const fbPhoto = fake.calls.find((c) => c.path === '/PAGE1/photos');
  assert.equal(fbPhoto.params.url, IMG(1).url);
  // Threads waited the recommended ~30s before publishing.
  const thCreate = fake.calls.findIndex((c) => c.path === '/TH1/threads');
  const thPublish = fake.calls.findIndex((c) => c.path === '/TH1/threads_publish');
  assert.ok(thCreate >= 0 && thPublish > thCreate);
});

test('several photos: Facebook attaches them, Instagram and Threads make carousels', async () => {
  const post = await posts.createPost({ caption: 'macaws', media: [IMG(1), IMG(2), IMG(3)], platforms: ['facebook', 'instagram', 'threads'], publishNow: true }, T0);
  const done = await drive(post);
  assert.equal(done.status, 'published');

  const unpublished = fake.calls.filter((c) => c.path === '/PAGE1/photos');
  assert.equal(unpublished.length, 3);
  assert.ok(unpublished.every((c) => c.params.published === 'false'));
  const feed = fake.calls.find((c) => c.path === '/PAGE1/feed');
  assert.equal(JSON.parse(feed.params.attached_media).length, 3);

  const igParent = fake.calls.find((c) => c.path === '/IG1/media' && c.params.media_type === 'CAROUSEL');
  assert.equal(igParent.params.children.split(',').length, 3);
  assert.equal(igParent.params.caption, 'macaws');
  const thParent = fake.calls.find((c) => c.path === '/TH1/threads' && c.params.media_type === 'CAROUSEL');
  assert.equal(thParent.params.children.split(',').length, 3);
});

test('a Reel waits for Instagram to finish processing before publishing', async () => {
  const post = await posts.createPost({ caption: 'nyfw', media: [VID], platforms: ['instagram'], publishNow: true }, T0);
  const first = await posts.runPost({ postId: post.id, rev: post.rev, kind: 'run' }, T0);
  assert.equal(first.status, 'publishing');
  assert.equal(first.recheckIn, 20);
  assert.ok(!fake.calls.some((c) => c.path === '/IG1/media_publish'));

  const saved = await posts.getPost(post.id);
  const second = await posts.runPost({ postId: post.id, rev: saved.rev, kind: 'check' }, T0 + 20e3);
  assert.equal(second.status, 'published');
  const reel = fake.calls.find((c) => c.path === '/IG1/media');
  assert.equal(reel.params.media_type, 'REELS');
  assert.equal(reel.params.video_url, VID.url);
});

test('per-platform captions override the main caption', async () => {
  const post = await posts.createPost({
    caption: 'long caption '.repeat(60),
    captions: { threads: 'short one for threads' },
    media: [IMG(1)],
    platforms: ['instagram', 'threads'],
    publishNow: true,
  }, T0);
  await drive(post);
  assert.equal(fake.calls.find((c) => c.path === '/TH1/threads').params.text, 'short one for threads');
  assert.match(fake.calls.find((c) => c.path === '/IG1/media').params.caption, /^long caption/);
});

test('rules are enforced before anything is saved', async () => {
  await assert.rejects(posts.createPost({ caption: 'x'.repeat(501), platforms: ['threads'], publishNow: true }, T0), /Threads: text is 501/);
  await assert.rejects(posts.createPost({ caption: 'text only', platforms: ['instagram'], publishNow: true }, T0), /Instagram: needs at least one/);
  await assert.rejects(posts.createPost({ caption: 'mix', media: [IMG(1), VID], platforms: ['facebook'], publishNow: true }, T0), /Facebook: a post is either/);
  await assert.rejects(posts.createPost({ caption: '#a '.repeat(31), media: [IMG(1)], platforms: ['instagram'], publishNow: true }, T0), /hashtags/);
  await assert.rejects(posts.createPost({ caption: 'x', media: [{ url: 'http://evil.example/a.jpg', type: 'image' }], platforms: ['facebook'], publishNow: true }, T0), /https/);
  await assert.rejects(posts.createPost({ caption: 'x', platforms: ['threads'], scheduledAt: new Date(T0 - 3600e3).toISOString() }, T0), /already passed/);
  assert.deepEqual(await posts.listPosts(), []);
});

test('a temporary Meta error is retried; a real one fails just that platform', async () => {
  fake.failNext('/PAGE1/photos', { message: 'Please retry', code: 2, is_transient: true });
  fake.failNext('/TH1/threads', { message: 'Invalid parameter', code: 100 });
  const post = await posts.createPost({ caption: 'swamp', media: [IMG(1)], platforms: ['facebook', 'threads'], publishNow: true }, T0);
  const done = await drive(post);

  assert.equal(done.status, 'partial');
  assert.equal(done.targets.facebook.state, 'published');
  assert.equal(done.targets.facebook.attempts, 1);
  assert.equal(done.targets.threads.state, 'failed');
  assert.equal(done.targets.threads.error, 'Invalid parameter');

  // Retry only re-runs Threads.
  const fbCalls = fake.calls.filter((c) => c.path === '/PAGE1/photos').length;
  const retried = await posts.retryPost(post.id, T0 + 60e3);
  assert.equal(retried.status, 'publishing');
  const again = await posts.runPost({ postId: post.id, rev: retried.rev, kind: 'check' }, T0 + 60e3);
  assert.ok(again.recheckIn > 0); // Threads settle wait
  const saved = await posts.getPost(post.id);
  const final = await posts.runPost({ postId: post.id, rev: saved.rev, kind: 'check' }, T0 + 120e3);
  assert.equal(final.status, 'published');
  assert.equal(fake.calls.filter((c) => c.path === '/PAGE1/photos').length, fbCalls);
});

test('editing or cancelling a scheduled post strands its old queue message', async () => {
  const at = new Date(T0 + 86400e3).toISOString();
  const post = await posts.createPost({ caption: 'first', platforms: ['facebook'], scheduledAt: at }, T0);
  assert.equal(post.queued, true);

  const edited = await posts.updatePost(post.id, { caption: 'second', platforms: ['facebook'], scheduledAt: at }, T0);
  assert.deepEqual(await posts.runPost({ postId: post.id, rev: post.rev, kind: 'run' }, T0 + 86400e3), { skipped: 'stale' });

  await posts.cancelPost(post.id);
  assert.deepEqual(await posts.runPost({ postId: post.id, rev: edited.rev, kind: 'run' }, T0 + 86400e3), { skipped: 'stale' });
  assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 0);
});

test('posts more than six days out wait for the daily cron to queue them', async () => {
  const post = await posts.createPost({ caption: 'later', platforms: ['facebook'], scheduledAt: new Date(Date.now() + 10 * 86400e3).toISOString() });
  assert.equal(post.queued, false);
  assert.equal(await posts.queueDuePosts(), 0);
});

test('two deliveries at once only publish once', async () => {
  const post = await posts.createPost({ caption: 'once', platforms: ['facebook'], publishNow: true }, T0);
  const [a, b] = await Promise.all([
    posts.runPost({ postId: post.id, rev: post.rev, kind: 'run' }, T0),
    posts.runPost({ postId: post.id, rev: post.rev, kind: 'run' }, T0),
  ]);
  assert.deepEqual([a, b].map((r) => r.status || r.skipped).sort(), ['locked', 'published']);
  assert.equal(fake.calls.filter((c) => c.path === '/PAGE1/feed').length, 1);
});

test('the Threads token refresh is stored and used from then on', async () => {
  assert.equal((await threadsToken()).token, 'THREADS_TOKEN');
  const rec = await refreshThreadsToken();
  assert.equal(rec.token, 'THREADS_REFRESHED');
  assert.equal((await threadsToken()).token, 'THREADS_REFRESHED');
  assert.ok(await getStore().get('threads:token'));
});
