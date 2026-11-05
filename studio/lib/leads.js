/**
 * Audit requests: businesses asking for a free content audit through the form
 * on goofieseyes.live/audit. The growth desk reads them, researches each one
 * and drafts the audit; the owner sends it.
 *
 * Stored as `lead:<id>` → record, with `leads` a sorted set by creation time.
 * Statuses: new → researched → sent → call → client, or closed.
 *
 * Optional email alert on each request: set RESEND_API_KEY, LEAD_ALERT_TO (where
 * it goes) and LEAD_ALERT_FROM (a sender on a domain verified in Resend). With
 * any of them missing the request is still saved, just without the email.
 */

const crypto = require('crypto');
const { getStore } = require('./store');
const { httpError } = require('./http');
const { cleanUsername } = require('./discovery');

const STATUSES = ['new', 'researched', 'sent', 'call', 'client', 'closed'];
const MAX_PER_HOUR = 5;   // per IP; a real business asks once
const LIMITS = { name: 100, business: 120, email: 200, website: 300, goal: 1000 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const key = (id) => `lead:${id}`;

function text(value, field) {
  const v = String(value ?? '').trim();
  if (v.length > LIMITS[field]) throw httpError(400, `${field} is too long`);
  return v;
}

function website(raw) {
  const v = text(raw, 'website');
  if (!v) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) throw new Error();
    return url.href;
  } catch {
    throw httpError(400, "That website address doesn't look right");
  }
}

async function alertOwner(lead) {
  const { RESEND_API_KEY: apiKey, LEAD_ALERT_TO: to, LEAD_ALERT_FROM: from } = process.env;
  if (!apiKey || !to || !from) return;
  const lines = [
    `${lead.name} at ${lead.business} asked for an audit.`,
    `Instagram: @${lead.instagram}`,
    lead.website ? `Website: ${lead.website}` : null,
    `Email: ${lead.email}`,
    lead.goal ? `What they want: ${lead.goal}` : null,
    '',
    'Run /growth leads in Claude Code to research it.',
  ].filter((l) => l !== null);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], reply_to: lead.email, subject: `Audit request: ${lead.business}`, text: lines.join('\n') }),
    });
    if (!res.ok) console.error('[leads] alert email failed', res.status);
  } catch (err) {
    // The request is already saved; a failed alert shouldn't fail the form.
    console.error('[leads] alert email failed', err.message);
  }
}

async function createAuditRequest(input, ip) {
  // Bots fill every field; people never see this one.
  if (input.company_site) return { id: null };

  const store = getStore();
  const rate = `audit-rate:${ip}`;
  const count = await store.incr(rate);
  if (count === 1) await store.expire(rate, 3600);
  if (count > MAX_PER_HOUR) throw httpError(429, 'Too many requests. Try again in an hour.');

  const lead = {
    id: crypto.randomBytes(6).toString('hex'),
    name: text(input.name, 'name'),
    business: text(input.business, 'business'),
    email: text(input.email, 'email').toLowerCase(),
    instagram: input.instagram ? cleanUsername(input.instagram) : '',
    website: website(input.website),
    goal: text(input.goal, 'goal'),
    status: 'new',
    notes: [],
    createdAt: Date.now(),
  };
  if (!lead.name || !lead.business) throw httpError(400, 'Add your name and your business');
  if (!EMAIL.test(lead.email)) throw httpError(400, 'Add an email address I can send the audit to');
  if (!lead.instagram) throw httpError(400, "Add your business's Instagram so I can look at it");

  await store.set(key(lead.id), lead);
  await store.zadd('leads', { score: lead.createdAt, member: lead.id });
  await alertOwner(lead);
  return { id: lead.id };
}

async function listLeads({ status } = {}) {
  const store = getStore();
  const ids = await store.zrange('leads', 0, -1, { rev: true });
  const leads = (await Promise.all(ids.map((id) => store.get(key(id))))).filter(Boolean);
  return status ? leads.filter((l) => l.status === status) : leads;
}

async function updateLead(id, { status, note }) {
  const store = getStore();
  const lead = await store.get(key(id));
  if (!lead) throw httpError(404, 'No such lead');
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw httpError(400, `Status must be one of: ${STATUSES.join(', ')}`);
    lead.status = status;
  }
  if (note) lead.notes.push({ at: Date.now(), text: String(note).slice(0, 2000) });
  lead.updatedAt = Date.now();
  await store.set(key(id), lead);
  return lead;
}

module.exports = { createAuditRequest, listLeads, updateLead, STATUSES };
