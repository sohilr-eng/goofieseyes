const test = require('node:test');
const assert = require('node:assert/strict');

process.env.META_SYSTEM_USER_TOKEN = 'SYSTEM_TOKEN';
process.env.THREADS_ACCESS_TOKEN = 'THREADS_TOKEN';
delete process.env.VERCEL;
delete process.env.QSTASH_TOKEN;
delete process.env.BLOB_READ_WRITE_TOKEN;

const { installFakeMeta } = require('./fake-meta');
const { resetStoreForTests } = require('../lib/store');
const { resetAccountCacheForTests } = require('../lib/accounts');
const { listInstagram, importInstagram, threadsCaptionFrom } = require('../lib/instagram');
const posts = require('../lib/posts');

const T0 = Date.UTC(2026, 10, 1, 12);
let fake;
test.beforeEach(() => {
  resetStoreForTests();
  resetAccountCacheForTests();
  fake = installFakeMeta();
});
test.afterEach(() => fake.restore());

test('lists Instagram posts newest first with their kind and size', async () => {
  const { items } = await listInstagram();
  assert.deepEqual(items.map((i) => [i.kind, i.count]), [['photo', 1], ['carousel', 2], ['reel', 1]]);
  assert.ok(items.every((i) => i.thumb && i.permalink && i.shared === null));
});

test('a carousel imports as a Facebook + Threads draft with every frame in order', async () => {
  const { draft } = { draft: await importInstagram('17900000000000002') };
  assert.equal(draft.media.length, 2);
  assert.match(draft.media[0].url, /img-2438/);
  assert.equal(draft.source.permalink, 'https://www.instagram.com/p/AAA2/');
  // The long caption gets a Threads version: hashtags gone, under 500.
  assert.ok(draft.captions.threads.length <= 500);
  assert.doesNotMatch(draft.captions.threads, /#/);
});

test('a Reel imports as one video', async () => {
  const draft = await importInstagram('17900000000000003');
  assert.deepEqual(draft.media.map((m) => m.type), ['video']);
  assert.deepEqual(draft.captions, {}); // short caption already fits Threads
});

test('once posted it shows as shared; cancelling frees it again', async () => {
  const draft = await importInstagram('17900000000000001');
  const post = await posts.createPost({ ...draft, platforms: ['facebook', 'threads'], scheduledAt: new Date(T0 + 86400e3).toISOString() }, T0);
  assert.deepEqual(post.source, { type: 'instagram', id: '17900000000000001', permalink: 'https://www.instagram.com/p/AAA1/' });

  let { items } = await listInstagram();
  assert.deepEqual(items[0].shared, { postId: post.id, status: 'scheduled', scheduledAt: post.scheduledAt });

  await posts.cancelPost(post.id);
  ({ items } = await listInstagram());
  assert.equal(items[0].shared, null);
});

test('the Threads caption suggestion', () => {
  assert.equal(threadsCaptionFrom('short and sweet'), null);
  assert.equal(threadsCaptionFrom('short #one #two'), 'short');
  const sentences = `${'A complete sentence about the light. '.repeat(15)}`.trim();
  const cut = threadsCaptionFrom(sentences);
  assert.ok(cut.length <= 500 && cut.endsWith('.'));
  const words = 'word '.repeat(150).trim();
  const cutWords = threadsCaptionFrom(words);
  assert.ok(cutWords.length <= 500 && cutWords.endsWith('…'));
});

test('import refuses anything that is not an Instagram media id', async () => {
  await assert.rejects(importInstagram('../me'), /Not an Instagram media id/);
});
