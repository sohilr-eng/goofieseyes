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
 *   node studio/scripts/growth-desk.js own [--posts 30]
 *     goofieseyes's own recent posts with their insights (reach, views, saves,
 *     shares, follows, watch time), each ranked against the account's own normal.
 *   node studio/scripts/growth-desk.js audit <file.json>
 *     Sends an audit of those posts to the Growth tab ("What your own posts say").
 *     The file is { "report", "sample", "summary", "findings": [{ title, verdict,
 *     confidence, evidence, advice, posts }] }; it replaces the last audit.
 *   node studio/scripts/growth-desk.js audit
 *     Shows the audit on the Growth tab now.
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

// ── Our own posts ──
// Reach is the yardstick: it's the one number every format has, and unlike
// views it isn't inflated by one person looping a reel. Everything else is read
// per 1,000 people reached, so a small post and a big one can be compared.
const per1k = (n, reach) => (typeof n === 'number' && reach ? (n / reach) * 1000 : null);
const num = (n, digits = 0) => (n === null || n === undefined ? '–' : n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }));

function ownStats(account) {
  const measured = account.posts.filter((p) => p.insights && p.insights.reach);
  const medReach = median(measured.map((p) => p.insights.reach));
  const rows = measured.map((p) => {
    const i = p.insights;
    return {
      ...p,
      multiple: medReach ? i.reach / medReach : null,
      sharesPer1k: per1k(i.shares, i.reach),
      savesPer1k: per1k(i.saves, i.reach),
      followsPer1k: per1k(i.follows, i.reach),
      ageDays: (Date.parse(account.fetchedAt) - Date.parse(p.timestamp)) / 86400e3,
    };
  });
  const byType = {};
  for (const r of rows) (byType[r.type] = byType[r.type] || []).push(r);
  return {
    rows,
    medReach,
    medShares: median(rows.map((r) => r.sharesPer1k ?? 0)),
    medSaves: median(rows.map((r) => r.savesPer1k ?? 0)),
    unmeasured: account.posts.length - measured.length,
    fresh: rows.filter((r) => r.ageDays < 2).length,
    byType: Object.entries(byType).map(([type, list]) => ({
      type,
      count: list.length,
      reach: median(list.map((r) => r.insights.reach)),
      shares: median(list.map((r) => r.sharesPer1k ?? 0)),
      saves: median(list.map((r) => r.savesPer1k ?? 0)),
    })).sort((a, b) => b.reach - a.reach),
  };
}

function ownLine(r) {
  const i = r.insights;
  const extra = r.type === 'reel'
    ? (typeof i.avgWatchMs === 'number' ? `watch ${(i.avgWatchMs / 1000).toFixed(1)}s` : '')
    : (typeof i.follows === 'number' ? `follows ${i.follows} (${num(r.followsPer1k, 1)}/1k)` : '');
  return `     ${r.multiple.toFixed(1)}x  ${r.type.padEnd(8)} ${r.timestamp.slice(0, 10)}  reach ${num(i.reach)} · views ${num(i.views)} · shares ${num(i.shares)} (${num(r.sharesPer1k, 1)}/1k) · saves ${num(i.saves)} (${num(r.savesPer1k, 1)}/1k)${extra ? ` · ${extra}` : ''}${r.ageDays < 2 ? ' · under 2 days old' : ''}\n         ${firstLine(r.caption)}  ${r.permalink}`;
}

async function own(args) {
  const account = await call('GET', `/api/own?posts=${encodeURIComponent(flag(args, 'posts', 30))}`);
  const s = ownStats(account);
  const n = s.rows.length;
  const dates = s.rows.map((r) => r.timestamp.slice(0, 10)).sort();
  console.log(`── @${account.username}: your own last ${account.posts.length} posts${n ? `, ${dates[0]} to ${dates[n - 1]}` : ''}`);
  console.log(`   followers ${account.followers ?? '?'} · ${account.mediaCount ?? '?'} posts all time`);
  if (!n) {
    console.log('   Meta returned no insights for any of them, so there is nothing to rank yet.');
  } else {
    console.log(`   typical reach ${num(s.medReach)} · typical shares ${num(s.medShares, 1)} and saves ${num(s.medSaves, 1)} per 1,000 reached`);
    if (s.unmeasured) console.log(`   ${s.unmeasured} post(s) have no insights from Meta and are left out`);
    if (s.fresh) console.log(`   ${s.fresh} post(s) are under two days old; Meta's numbers can lag 48 hours, so they read low`);
    console.log(`   ${n < 12 ? `only ${n} posts measured: enough to describe them, not to call a pattern` : n < 25 ? `${n} posts measured: a pattern has to show up several times to count` : `${n} posts measured`}`);

    console.log('\n   by format (typical reach · shares and saves per 1,000 reached):');
    for (const t of s.byType) console.log(`     ${String(t.count).padStart(2)} ${t.type.padEnd(8)} reach ${num(t.reach)} · shares ${num(t.shares, 1)} · saves ${num(t.saves, 1)}${t.count < 4 ? '  (too few to judge)' : ''}`);

    const byReach = [...s.rows].sort((a, b) => b.multiple - a.multiple);
    const k = Math.min(5, Math.floor(n / 2)) || 1;
    console.log('\n   travelled furthest (reach against your typical post):');
    for (const r of byReach.slice(0, k)) console.log(ownLine(r));
    if (n > k) {
      console.log('\n   travelled least:');
      for (const r of byReach.slice(-k).reverse()) console.log(ownLine(r));
    }
    console.log('\n   most passed on (shares per 1,000 reached):');
    for (const r of [...s.rows].sort((a, b) => (b.sharesPer1k ?? 0) - (a.sharesPer1k ?? 0)).slice(0, Math.min(3, n))) console.log(ownLine(r));

    // Reached well past the usual crowd but brought nobody in: that points at
    // the profile, not the post. Only feed posts report follows.
    const leaky = s.rows.filter((r) => r.multiple >= 1.5 && typeof r.insights.follows === 'number' && r.followsPer1k < 1);
    if (leaky.length) {
      console.log('\n   reached new people but brought under 1 follow per 1,000 (a profile question, not a post one):');
      for (const r of leaky) console.log(ownLine(r));
    }
  }
  const dir = path.join(GROWTH_DIR, 'data', account.username || 'goofieseyes');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `own-${account.fetchedAt.slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(account, null, 2));
  console.log(`\n   saved: ${file}\n`);
}

const VERDICT = { more: 'do more', stop: 'stop', fix: 'fix', watch: 'keep watching' };

async function audit(file) {
  if (!file) {
    const a = await call('GET', '/api/post-audit');
    if (!a.findings.length) { console.log('No audit on the Growth tab yet.'); return; }
    console.log(`Audit${a.report ? ` from the ${a.report} run` : ''}, sent ${new Date(a.updatedAt).toISOString().slice(0, 10)}${a.sample ? ` (${a.sample})` : ''}:`);
    if (a.summary) console.log(`  ${a.summary}`);
    console.log('');
    for (const f of a.findings) console.log(`── [${VERDICT[f.verdict]}, ${f.confidence}] ${f.title}\n   ${f.advice}`);
    return;
  }
  const saved = await call('POST', '/api/post-audit', JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
  console.log(`✓ ${saved.findings.length} finding(s) on the Growth tab, under "What your own posts say".`);
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
  own: () => own(args),
  audit: () => audit(args[0]),
}[cmd];

(run ? run() : Promise.reject(new Error('Use: watch | lookup <username> | leads [status] | lead <id> <status> [note] | tips [file.json] | own [--posts 30] | audit [file.json]')))
  .catch((err) => { console.error(err.message); process.exitCode = 1; });
