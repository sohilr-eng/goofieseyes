const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');

process.env.META_SYSTEM_USER_TOKEN = 'SYSTEM_TOKEN';
process.env.STUDIO_AGENT_TOKEN = 'agent-secret';
process.env.STUDIO_PASSWORD = 'pw';
process.env.SESSION_SECRET = 'test-secret';
delete process.env.VERCEL;
delete process.env.RESEND_API_KEY;

const { installFakeMeta } = require('./fake-meta');
const { resetStoreForTests } = require('../lib/store');
const { resetAccountCacheForTests } = require('../lib/accounts');

let fake;
test.beforeEach(() => {
  resetStoreForTests();
  resetAccountCacheForTests();
  fake = installFakeMeta();
});
test.afterEach(() => fake.restore());

async function call(route, { method = 'GET', url = '/', headers = {}, body, ip = '1.2.3.4' } = {}) {
  const req = new PassThrough();
  Object.assign(req, { method, url, headers, socket: { remoteAddress: ip } });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (chunk) => { res.body = chunk ? String(chunk) : ''; };
  // leads, lookup and tips share api/growth.js (rewritten with ?part= on Vercel).
  if (['leads', 'lookup', 'tips'].includes(route)) {
    req.url += `${req.url.includes('?') ? '&' : '?'}part=${route}`;
    route = 'growth';
  }
  await require(`../api/${route}`)(req, res);
  return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : null };
}
const AUTH = { authorization: 'Bearer agent-secret' };
const REQUEST = {
  name: 'Sam Rivera', business: 'Rivera Physio', email: 'Sam@RiveraPhysio.com',
  instagram: 'https://www.instagram.com/rivera.physio/', website: 'riverapysio.com', goal: 'more bookings',
};

test('lookups and leads need the agent token or a signed-in page', async () => {
  for (const route of ['lookup', 'leads']) {
    assert.equal((await call(route, { url: '/?username=creative.studio' })).status, 401, route);
    assert.equal((await call(route, { url: '/?username=creative.studio', headers: { authorization: 'Bearer wrong' } })).status, 401, route);
  }
});

test('a lookup returns the profile and posts, read-only', async () => {
  const r = await call('lookup', { url: '/?username=@Creative.Studio&posts=10', headers: AUTH });
  assert.equal(r.status, 200);
  assert.equal(r.json.username, 'creative.studio');
  assert.equal(r.json.followers, 131000);
  assert.equal(r.json.posts.length, 10);
  assert.equal(r.json.posts[3].engagement, 9600);
  assert.equal(r.json.posts[3].type, 'reel');
  assert.equal(r.json.posts[0].type, 'photo');
  assert.equal(r.json.posts[7].likes, null, 'hidden likes stay unknown, not zero');

  const meta = fake.calls.filter((c) => c.path === '/IG1');
  assert.equal(meta.length, 1);
  assert.match(meta[0].params.fields, /^business_discovery\.username\(creative\.studio\)/);
  assert.ok(fake.calls.every((c) => c.method === 'GET'), 'nothing is posted');
});

test('a personal or missing account is a clear 404, and junk is refused', async () => {
  const missing = await call('lookup', { url: '/?username=someone.personal', headers: AUTH });
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /personal account/);

  const before = fake.calls.length;
  const junk = await call('lookup', { url: '/?username=no%20spaces){injected}', headers: AUTH });
  assert.equal(junk.status, 400);
  assert.equal(fake.calls.length, before, 'bad input never reaches Meta');
});

test('an audit request is saved, cleaned and listed for the desk', async () => {
  const r = await call('audit', { method: 'POST', body: REQUEST, headers: { origin: 'https://goofieseyes.live' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], 'https://goofieseyes.live');

  const { json } = await call('leads', { url: '/?status=new', headers: AUTH });
  assert.equal(json.leads.length, 1);
  const lead = json.leads[0];
  assert.equal(lead.instagram, 'rivera.physio');
  assert.equal(lead.email, 'sam@riveraphysio.com');
  assert.equal(lead.website, 'https://riverapysio.com/');
  assert.equal(lead.status, 'new');

  const moved = await call('leads', { method: 'POST', url: `/?id=${lead.id}`, headers: AUTH, body: { status: 'researched', note: 'posts weekly, no reels' } });
  assert.equal(moved.json.lead.status, 'researched');
  assert.equal(moved.json.lead.notes[0].text, 'posts weekly, no reels');
  assert.equal((await call('leads', { url: '/?status=new', headers: AUTH })).json.leads.length, 0);
  assert.equal((await call('leads', { method: 'POST', url: `/?id=${lead.id}`, headers: AUTH, body: { status: 'won' } })).status, 400);
});

test('the audit form only answers the site, and refuses bad requests', async () => {
  const other = await call('audit', { method: 'POST', body: REQUEST, headers: { origin: 'https://evil.example' } });
  assert.equal(other.headers['access-control-allow-origin'], undefined);

  const preflight = await call('audit', { method: 'OPTIONS', headers: { origin: 'https://www.goofieseyes.live' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'https://www.goofieseyes.live');

  assert.equal((await call('audit', { method: 'POST', body: { ...REQUEST, email: 'nope' } })).status, 400);
  assert.equal((await call('audit', { method: 'POST', body: { ...REQUEST, instagram: '' } })).status, 400);
  assert.equal((await call('audit', { method: 'POST', body: { ...REQUEST, website: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await call('audit', { method: 'GET' })).status, 405);
});

test('bots are dropped quietly and floods are cut off', async () => {
  const bot = await call('audit', { method: 'POST', body: { ...REQUEST, company_site: 'http://spam' }, ip: '9.9.9.9' });
  assert.equal(bot.status, 200);
  assert.equal((await call('leads', { headers: AUTH })).json.leads.length, 0);

  for (let i = 0; i < 5; i++) assert.equal((await call('audit', { method: 'POST', body: REQUEST, ip: '5.5.5.5' })).status, 200);
  assert.equal((await call('audit', { method: 'POST', body: REQUEST, ip: '5.5.5.5' })).status, 429);
  assert.equal((await call('audit', { method: 'POST', body: REQUEST, ip: '6.6.6.6' })).status, 200, 'other visitors are unaffected');
});

test('the owner gets an email alert when Resend is set up', async () => {
  Object.assign(process.env, { RESEND_API_KEY: 're_test', LEAD_ALERT_TO: 'owner@example.com', LEAD_ALERT_FROM: 'studio@goofieseyes.live' });
  const sent = [];
  const metaFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith('https://api.resend.com')) { sent.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
    return metaFetch(input, init);
  };
  try {
    assert.equal((await call('audit', { method: 'POST', body: REQUEST })).status, 200);
  } finally {
    globalThis.fetch = metaFetch;
    for (const k of ['RESEND_API_KEY', 'LEAD_ALERT_TO', 'LEAD_ALERT_FROM']) delete process.env[k];
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Audit request: Rivera Physio');
  assert.equal(sent[0].reply_to, 'sam@riveraphysio.com');
  assert.match(sent[0].text, /@rivera\.physio/);
});

test('the signed-in studio page can read and update leads and run lookups', async () => {
  const login = await call('login', { method: 'POST', body: { password: 'pw' } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  await call('audit', { method: 'POST', body: REQUEST, headers: { origin: 'https://goofieseyes.live' } });

  const list = await call('leads', { headers: { cookie } });
  assert.equal(list.status, 200);
  assert.equal(list.json.leads.length, 1);
  const json = list.json.leads[0];

  const moved = await call('leads', { method: 'POST', url: `/?id=${json.id}`, headers: { cookie }, body: { status: 'sent', note: 'walkthrough recorded' } });
  assert.equal(moved.json.lead.status, 'sent');
  assert.equal(moved.json.lead.notes[0].text, 'walkthrough recorded');

  assert.equal((await call('lookup', { url: '/?username=creative.studio&posts=5', headers: { cookie } })).json.posts.length, 5);

  // A wrong Bearer token isn't rescued by a good cookie.
  assert.equal((await call('leads', { headers: { cookie, authorization: 'Bearer wrong' } })).status, 401);
});

const TIPS = {
  report: '2026-11-05',
  tips: [
    { title: 'Open reels on your face', why: 'Their breakouts open on a person.', idea: 'Talk to camera for 5 seconds first.', kind: 'post',
      from: [{ username: '@Creative.Studio', permalink: 'https://www.instagram.com/p/abc/' }] },
    { title: 'One offer post in six', why: 'They sell rarely.', idea: 'Keep invitations light.', kind: 'offer',
      from: [{ username: 'creative.studio', permalink: 'javascript:alert(1)' }] },
  ],
};

test('only the desk sends tips; the page reads and marks them', async () => {
  const login = await call('login', { method: 'POST', body: { password: 'pw' } });
  const cookie = login.headers['set-cookie'].split(';')[0];

  assert.equal((await call('tips', { method: 'POST', body: TIPS, headers: { cookie } })).status, 401, 'the page cannot replace the list');
  assert.equal((await call('tips', { method: 'POST', body: TIPS })).status, 401);
  const sent = await call('tips', { method: 'POST', body: TIPS, headers: AUTH });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.tips.length, 2);
  assert.equal(sent.json.tips[0].from[0].username, 'creative.studio');
  assert.equal(sent.json.tips[1].from[0].permalink, undefined, 'non-Instagram links are dropped');

  const read = await call('tips', { headers: { cookie } });
  assert.equal(read.json.report, '2026-11-05');
  const id = read.json.tips[0].id;
  const marked = await call('tips', { method: 'POST', url: `/?id=${id}`, headers: { cookie }, body: { status: 'tried', result: '2x my usual likes' } });
  assert.equal(marked.json.tip.status, 'tried');

  // The next run keeps the owner's mark on a tip with the same title.
  const again = await call('tips', { method: 'POST', body: { tips: [TIPS.tips[0], { ...TIPS.tips[1], title: 'Something new' }] }, headers: AUTH });
  assert.equal(again.json.tips[0].status, 'tried');
  assert.equal(again.json.tips[0].result, '2x my usual likes');
  assert.equal(again.json.tips[1].status, 'to-try');

  assert.equal((await call('tips', { method: 'POST', url: `/?id=${id}`, headers: { cookie }, body: { status: 'done' } })).status, 400);
  assert.equal((await call('tips', { method: 'POST', body: { tips: [{ title: 'x' }] }, headers: AUTH })).status, 400, 'a tip needs why and idea');
});

test('talk-to-camera tips keep a short outline to film from', async () => {
  const talk = {
    title: 'Why I shot the tiger wide', kind: 'talk', why: 'Their talking reels open with a claim.', idea: 'Stand by the print and talk.',
    from: ['creative.studio'],
    script: { hook: 'Everyone crops in. I went wide.', beats: ['what I saw', 'why wide', 'what it cost me', '', 'x', 'y', 'z'], length: '30–45 s' },
  };
  const r = await call('tips', { method: 'POST', body: { tips: [talk, TIPS.tips[0]] }, headers: AUTH });
  assert.equal(r.status, 200);
  assert.equal(r.json.tips[0].kind, 'talk');
  assert.equal(r.json.tips[0].script.hook, 'Everyone crops in. I went wide.');
  assert.deepEqual(r.json.tips[0].script.beats, ['what I saw', 'why wide', 'what it cost me', 'x'], 'empty beats dropped, five at most');
  assert.equal(r.json.tips[1].script, undefined);
  const long = { ...talk, script: { hook: 'h'.repeat(201) } };
  assert.equal((await call('tips', { method: 'POST', body: { tips: [long] }, headers: AUTH })).status, 400);
});
