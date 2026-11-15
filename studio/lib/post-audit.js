/**
 * The audit of goofieseyes's own posts: what the growth desk (`/growth audit`
 * in Claude Code) concluded from the account's own numbers, shown on the
 * studio's Growth tab under "What your own posts say".
 *
 * Stored as one record, `growth:post-audit` →
 *   { updatedAt, report, sample, summary, findings }
 * and replaced whole on each run: an audit is a reading of one stretch of
 * posts, so the last one is the one that counts.
 *
 * A finding: { id, title, verdict, confidence, evidence, advice,
 *              posts: [{ permalink, note? }] }
 *   verdict     'more' (do more of this) | 'stop' | 'fix' | 'watch' (too early to say)
 *   confidence  'strong' | 'some' | 'thin': how far the sample supports it
 */

const { getStore } = require('./store');
const { httpError } = require('./http');

const KEY = 'growth:post-audit';
const VERDICTS = ['more', 'stop', 'fix', 'watch'];
const CONFIDENCE = ['strong', 'some', 'thin'];
const MAX_FINDINGS = 8;
const MAX_POSTS = 5;
const LIMITS = { title: 120, evidence: 800, advice: 800, summary: 600, sample: 200, report: 40, note: 160 };

function text(value, field, required) {
  const v = String(value ?? '').trim();
  if (required && !v) throw httpError(400, `Each finding needs ${field === 'evidence' ? 'its evidence' : `a ${field}`}`);
  if (v.length > LIMITS[field]) throw httpError(400, `The ${field} is too long (${LIMITS[field]} characters max)`);
  return v;
}

// Only links to Instagram posts are kept, so the page never shows an odd link.
function permalink(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' && /(^|\.)instagram\.com$/.test(u.hostname)) return u.href;
  } catch { /* dropped below */ }
  return null;
}

function linked(entry) {
  const link = permalink(typeof entry === 'string' ? entry : entry?.permalink);
  if (!link) return null;
  const note = text(entry?.note, 'note');
  return { permalink: link, ...(note ? { note } : {}) };
}

const idFor = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'finding';

async function getAudit() {
  return (await getStore().get(KEY)) || { updatedAt: null, report: null, sample: null, summary: null, findings: [] };
}

async function publishAudit(input) {
  const list = Array.isArray(input?.findings) ? input.findings : null;
  if (!list || !list.length) throw httpError(400, 'Send { findings: [...] } with at least one finding');
  if (list.length > MAX_FINDINGS) throw httpError(400, `${MAX_FINDINGS} findings at most; keep the ones that change what gets made`);

  const seen = new Set();
  const findings = list.map((raw) => {
    const title = text(raw.title, 'title', true);
    const id = idFor(title);
    if (seen.has(id)) throw httpError(400, `Two findings are called "${title}"`);
    seen.add(id);
    if (!VERDICTS.includes(raw.verdict)) throw httpError(400, `"${title}" needs a verdict: ${VERDICTS.join(', ')}`);
    if (!CONFIDENCE.includes(raw.confidence)) throw httpError(400, `"${title}" needs a confidence: ${CONFIDENCE.join(', ')}`);
    return {
      id, title,
      verdict: raw.verdict,
      confidence: raw.confidence,
      evidence: text(raw.evidence, 'evidence', true),
      advice: text(raw.advice, 'advice', true),
      posts: (Array.isArray(raw.posts) ? raw.posts : []).map(linked).filter(Boolean).slice(0, MAX_POSTS),
    };
  });

  const record = {
    updatedAt: Date.now(),
    report: text(input.report, 'report') || null,
    sample: text(input.sample, 'sample') || null,
    summary: text(input.summary, 'summary') || null,
    findings,
  };
  await getStore().set(KEY, record);
  return record;
}

module.exports = { getAudit, publishAudit, VERDICTS, CONFIDENCE };
