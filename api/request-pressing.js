/**
 * "Request a pressing" — the order slip on the landing page.
 *
 * Forwards enquiries as email. Follows the same shape as
 * create-checkout-session.js: plain CommonJS, and the provider is called over
 * its REST API with fetch rather than pulling in an SDK, so this endpoint adds
 * no dependency and package.json is untouched.
 *
 * Env vars:
 *   RESEND_API_KEY  (required) — from resend.com
 *   PRESSING_TO     (optional) — where enquiries land
 *   PRESSING_FROM   (optional) — verified sender; the resend.dev default only
 *                                delivers to the address owning the account,
 *                                which is fine until goofieseyes.live is verified
 */

const KINDS = {
  print: 'A print',
  commission: 'A shoot',
  motion: 'Motion work',
  other: 'Something else'
};

const DEFAULT_TO = 'goofiesfotos@gmail.com';
const DEFAULT_FROM = 'GoofiesEyes <onboarding@resend.dev>';

function clean(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const body = req.body || {};

  // Honeypot. Report success so the bot has nothing to learn from the response.
  if (clean(body.website, 100)) return res.status(200).json({ ok: true });

  const name = clean(body.name, 120);
  const email = clean(body.email, 200);
  const message = clean(body.message, 2000);
  const kind = Object.prototype.hasOwnProperty.call(KINDS, body.kind) ? body.kind : 'other';

  if (!name) return res.status(400).json({ ok: false, error: 'Name is required' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'A valid email is required' });
  }
  if (!message) return res.status(400).json({ ok: false, error: 'Details are required' });

  const key = process.env.RESEND_API_KEY;
  if (!key) return res.status(500).json({ ok: false, error: 'Email is not configured' });

  const to = process.env.PRESSING_TO || DEFAULT_TO;
  const from = process.env.PRESSING_FROM || DEFAULT_FROM;

  const html = `
    <h2 style="font-family:Georgia,serif">Order slip — ${escapeHtml(KINDS[kind])}</h2>
    <p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>
    <p style="white-space:pre-wrap">${escapeHtml(message)}</p>
  `;

  const text = `Order slip — ${KINDS[kind]}\nFrom: ${name} <${email}>\n\n${message}\n`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: email,
        subject: `Pressing request — ${KINDS[kind]} — ${name}`,
        html,
        text
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('Resend API error:', data);
      return res.status(502).json({ ok: false, error: data.message || 'Could not send' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Fetch error:', err.message);
    return res.status(500).json({ ok: false, error: 'Could not reach the email service' });
  }
};
