#!/usr/bin/env node
/**
 * Plumbing for the growth desk (`/growth` in Claude Code). Claude does the
 * studying and writing; this fetches accounts and leads and does the arithmetic.
 *
 *   node studio/scripts/growth-desk.js watch [--posts 25]
 *     Looks up every account on the watch list and prints a summary of each.
 *   node studio/scripts/growth-desk.js lookup <username> [--posts 25]
 *     The same for one account (a lead, or one you're thinking of watching).
 *   node studio/scripts/growth-desk.js leads [status]
 *     Audit requests from goofieseyes.live/audit, newest first (default: new).
 *   node studio/scripts/growth-desk.js lead <id> <status> [note]
 *     Moves a lead along: new, researched, sent, call, client or closed.
 *   node studio/scripts/growth-desk.js tips <file.json>
 *     Sends the plays from a run to the studio's Growth tab. The file is
 *     { "report": "2026-11-05", "tips": [{ title, why, idea, kind, from }] };
 *     tips the owner already marked keep their mark if the title is unchanged.
 *   node studio/scripts/growth-desk.js tips
 *     Shows the tips on the Growth tab now, with what the owner marked.
 *
 * The watch list, raw data and reports live in GROWTH_DIR (default: the
 * "goofieseyes growth" folder in Sorian Systems, where goofieseyes business
 * work goes). Lookups are saved to <GROWTH_DIR>/data/<username>/<date>.json, so
 * later runs can compare against earlier ones.
 *
 * Needs the studio's agent token, found the same way as the caption desk's
 * (STUDIO_AGENT_TOKEN, ~/.goofieseyes-studio/agent-token, or a cloud network secret).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = (process.env.STUDIO_URL || 'https://studio.goofieseyes.live').replace(/\/$/, '');
const GROWTH_DIR = process.env.GROWTH_DIR
  || path.join(os.homedir(), 'claude-workspace', 'Sorian Systems', 'goofieseyes growth');
const WATCH_LIST = path.join(GROWTH_DIR, 'watch-list.md');
const TOKEN_FILE = path.join(os.homedir(), '.goofieseyes-studio', 'agent-token');
const OUTLIER = 2;   // a post this many times the account's median engagement is a breakout

// Words that mean a post is doing business: an offer, a call to action, a client.
const BUSINESS = /\b(comment|link in (my )?bio|dm me|book(ing)?|client|agency|work with|hire|inquir|enquir|available|offer|free|download|sign ?up|waitlist|spots?|course|guide|template|preset|lut)\b/i;

function token() {
  if (process.env.STUDIO_AGENT_TOKEN) return process.env.STUDIO_AGENT_TOKEN.trim();
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  return null;
}

async function call(method, route, body) {
  const t = token();
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !t) {
    throw new Error(`The studio refused: no agent token. Set STUDIO_AGENT_TOKEN, put it in ${TOKEN_FILE}, or (in a cloud session) add a network secret for studio.goofieseyes.live.`);
  }
  if (!res.ok) throw new Error(data.error || `Studio answered HTTP ${res.status}`);
  return data;
}

// "- @jade.got.curious — creative director, Chicago" → { username, note }
function readWatchList() {
  if (!fs.existsSync(WATCH_LIST)) throw new Error(`No watch list at ${WATCH_LIST}`);
  return fs.readFileSync(WATCH_LIST, 'utf8').split(/\r?\n/)
    .map((line) => /^\s*[-*]\s*@([A-Za-z0-9._]{1,30})\s*(?:[—–-]\s*(.*))?$/.exec(line))
    .filter(Boolean)
    .map(([, username, note]) => ({ username: username.toLowerCase(), note: (note || '').trim() }));
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');
const firstLine = (caption) => (caption.split(/\r?\n/).find((l) => l.trim()) || '(no caption)').trim().slice(0, 90);

function stats(account) {
  const posts = account.posts;
  const med = median(posts.map((p) => p.engagement));
  const times = posts.map((p) => Date.parse(p.timestamp)).filter(Number.isFinite);
  const weeks = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / (7 * 86400e3) : 0;
  const types = {};
  for (const p of posts) types[p.type] = (types[p.type] || 0) + 1;
  return {
    median: med,
    rate: account.followers ? med / account.followers : null,
    perWeek: weeks ? posts.length / weeks : null,
    types,
    business: posts.filter((p) => BUSINESS.test(p.caption)),
    outliers: posts.filter((p) => med && p.engagement >= med * OUTLIER).sort((a, b) => b.engagement - a.engagement),
    hiddenLikes: posts.filter((p) => p.likes === null).length,
  };
}

function save(account) {
  const dir = path.join(GROWTH_DIR, 'data', account.username);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${account.fetchedAt.slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(account, null, 2));
  return file;
}

function report(account, note) {
  const s = stats(account);
  const n = account.posts.length;
  console.log(`── @${account.username}${account.name ? ` (${account.name})` : ''}${note ? `  · ${note}` : ''}`);
  console.log(`   followers ${account.followers ?? '?'} · following ${account.following ?? '?'} · ${account.mediaCount ?? '?'} posts all time`);
  console.log(`   bio: ${JSON.stringify(account.biography)}`);
  if (account.website) console.log(`   link: ${account.website}`);
  console.log(`   last ${n} posts: ${s.perWeek ? `${s.perWeek.toFixed(1)} a week` : 'pace unknown'} · ${Object.entries(s.types).map(([t, c]) => `${c} ${t}${c > 1 ? 's' : ''}`).join(', ')}`);
  console.log(`   median engagement ${Math.round(s.median)} (likes + comments)${s.rate !== null ? ` · ${(s.rate * 100).toFixed(2)}% of followers` : ''}${s.hiddenLikes ? ` · ${s.hiddenLikes} hide likes` : ''}`);
  console.log(`   doing business in ${s.business.length}/${n} captions (${pct(s.business.length, n)})`);
  for (const p of s.business.slice(0, 5)) console.log(`     $ ${firstLine(p.caption)}  ${p.permalink}`);
  console.log(`   breakouts (${OUTLIER}x median or more): ${s.outliers.length}`);
  for (const p of s.outliers.slice(0, 5)) {
    console.log(`     ↑ ${(p.engagement / s.median).toFixed(1)}x  ${p.type}  ${p.timestamp.slice(0, 10)}  ${firstLine(p.caption)}  ${p.permalink}`);
  }
  console.log(`   saved: ${save(account)}\n`);
}

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

async function lookup(username, posts) {
  return call('GET', `/api/lookup?username=${encodeURIComponent(username)}&posts=${encodeURIComponent(posts)}`);
}

async function watch(args) {
  const list = readWatchList();
  if (!list.length) { console.log(`The watch list is empty. Add lines like "- @username — why" to ${WATCH_LIST}`); return; }
  const posts = flag(args, 'posts', 25);
  console.log(`Watch list: ${list.length} account(s), last ${posts} posts each.\n`);
  for (const { username, note } of list) {
    try {
      report(await lookup(username, posts), note);
    } catch (err) {
      console.log(`── @${username}: ${err.message}\n`);
      process.exitCode = 1;
    }
  }
}

async function leads(status = 'new') {
  const { leads: list } = await call('GET', `/api/leads?status=${encodeURIComponent(status)}`);
  if (!list.length) { console.log(`No ${status} audit requests.`); return; }
  console.log(`${list.length} ${status} audit request(s):\n`);
  for (const l of list) {
    console.log(`── ${l.id}  ${l.business} (${l.name})  asked ${new Date(l.createdAt).toISOString().slice(0, 10)}`);
    console.log(`   instagram: @${l.instagram}${l.website ? ` · website: ${l.website}` : ''}`);
    console.log(`   email: ${l.email}`);
    if (l.goal) console.log(`   wants: ${l.goal}`);
    for (const n of l.notes) console.log(`   note ${new Date(n.at).toISOString().slice(0, 10)}: ${n.text}`);
    console.log('');
  }
}

async function tips(file) {
  if (!file) {
    const { tips: list, report: from, updatedAt } = await call('GET', '/api/tips');
    if (!list.length) { console.log('No tips on the Growth tab yet.'); return; }
    console.log(`${list.length} tip(s)${from ? ` from the ${from} report` : ''}, sent ${new Date(updatedAt).toISOString().slice(0, 10)}:\n`);
    for (const t of list) {
      console.log(`── [${t.status}] ${t.title}  (${t.kind}; from ${t.from.map((f) => `@${f.username}`).join(', ') || 'no one in particular'})`);
      if (t.result) console.log(`   how it went: ${t.result}`);
    }
    return;
  }
  const body = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const saved = await call('POST', '/api/tips', body);
  const marked = saved.tips.filter((t) => t.status !== 'to-try').length;
  console.log(`✓ ${saved.tips.length} tip(s) on the Growth tab${marked ? ` (${marked} kept the owner's mark)` : ''}.`);
}

const [cmd, ...args] = process.argv.slice(2);
const run = {
  watch: () => watch(args),
  lookup: () => (args[0] ? lookup(args[0], flag(args, 'posts', 25)).then((a) => report(a)) : Promise.reject(new Error('Usage: lookup <username>'))),
  leads: () => leads(args[0]),
  lead: () => (args[0] && args[1]
    ? call('POST', `/api/leads?id=${encodeURIComponent(args[0])}`, { status: args[1], note: args.slice(2).join(' ') || undefined })
      .then(({ lead }) => console.log(`✓ ${lead.business}: ${lead.status}`))
    : Promise.reject(new Error('Usage: lead <id> <status> [note]'))),
  tips: () => tips(args[0]),
}[cmd];

(run ? run() : Promise.reject(new Error('Use: watch | lookup <username> | leads [status] | lead <id> <status> [note] | tips [file.json]')))
  .catch((err) => { console.error(err.message); process.exitCode = 1; });
