/**
 * Tips from the watch list: the plays the growth desk (`/growth` in Claude
 * Code) takes from the accounts it studies, shown on the studio's Growth tab.
 *
 * Stored as one record, `growth:tips` → { updatedAt, report, tips }. Each run of
 * the desk replaces the list, but a tip the owner already marked (tried, skip,
 * and how it went) keeps that mark when the desk sends it again under the same
 * title.
 *
 * A tip: { id, title, why, idea, kind, from: [{ username, permalink? }],
 *          script?, status: 'to-try' | 'tried' | 'skip', result?, addedAt }
 *
 * `kind: 'talk'` is a talk-to-camera video idea and carries a script outline to
 * film from: { hook, beats: [...], length? } (the opening line, 2–5 points,
 * and roughly how long, e.g. "30–45 s").
 */

const { getStore } = require('./store');
const { httpError } = require('./http');
const { cleanUsername } = require('./discovery');

const KEY = 'growth:tips';
const KINDS = ['talk', 'post', 'habit', 'offer', 'profile'];
const STATUSES = ['to-try', 'tried', 'skip'];
const MAX_TIPS = 20;
const LIMITS = { title: 120, why: 800, idea: 800, result: 500, report: 40, hook: 200, beat: 300, length: 40 };
const MAX_BEATS = 5;

function text(value, field, required) {
  const v = String(value ?? '').trim();
  if (required && !v) throw httpError(400, `Each tip needs a ${field}`);
  if (v.length > LIMITS[field]) throw httpError(400, `A tip's ${field} is too long (${LIMITS[field]} characters max)`);
  return v;
}

// An outline, not a teleprompter: an opening line and a few points to hit.
function script(raw) {
  if (!raw) return undefined;
  const hook = text(raw.hook, 'hook');
  const beats = (Array.isArray(raw.beats) ? raw.beats : []).slice(0, MAX_BEATS).map((b) => text(b, 'beat')).filter(Boolean);
  if (!hook && !beats.length) return undefined;
  const length = text(raw.length, 'length');
  return { hook, beats, ...(length ? { length } : {}) };
}

const idFor = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'tip';

// Only links to Instagram posts are kept, so the page never shows an odd link.
function permalink(raw) {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' && /(^|\.)instagram\.com$/.test(u.hostname)) return u.href;
  } catch { /* dropped below */ }
  return undefined;
}

function source(entry) {
  const username = cleanUsername(typeof entry === 'string' ? entry : entry?.username);
  if (!username) throw httpError(400, 'Each "from" needs an Instagram username');
  return { username, permalink: permalink(entry?.permalink) };
}

async function getTips() {
  return (await getStore().get(KEY)) || { updatedAt: null, report: null, tips: [] };
}

async function publishTips(input) {
  const list = Array.isArray(input?.tips) ? input.tips : null;
  if (!list || !list.length) throw httpError(400, 'Send { tips: [...] } with at least one tip');
  if (list.length > MAX_TIPS) throw httpError(400, `${MAX_TIPS} tips at most; keep the best ones`);

  const before = new Map((await getTips()).tips.map((t) => [t.id, t]));
  const seen = new Set();
  const tips = list.map((raw) => {
    const title = text(raw.title, 'title', true);
    const id = idFor(title);
    if (seen.has(id)) throw httpError(400, `Two tips are called "${title}"`);
    seen.add(id);
    const kind = KINDS.includes(raw.kind) ? raw.kind : 'post';
    const from = (Array.isArray(raw.from) ? raw.from : []).slice(0, 5).map(source);
    const old = before.get(id);
    const outline = script(raw.script);
    return {
      id, title, kind, from,
      ...(outline ? { script: outline } : {}),
      why: text(raw.why, 'why', true),
      idea: text(raw.idea, 'idea', true),
      status: old?.status || 'to-try',
      ...(old?.result ? { result: old.result } : {}),
      addedAt: old?.addedAt || Date.now(),
    };
  });

  const record = { updatedAt: Date.now(), report: text(input.report, 'report') || null, tips };
  await getStore().set(KEY, record);
  return record;
}

async function updateTip(id, { status, result }) {
  const record = await getTips();
  const tip = record.tips.find((t) => t.id === id);
  if (!tip) throw httpError(404, 'No such tip');
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw httpError(400, `Status must be one of: ${STATUSES.join(', ')}`);
    tip.status = status;
  }
  if (result !== undefined) {
    const r = text(result, 'result');
    if (r) tip.result = r; else delete tip.result;
  }
  await getStore().set(KEY, record);
  return tip;
}

module.exports = { getTips, publishTips, updateTip, KINDS, STATUSES };
