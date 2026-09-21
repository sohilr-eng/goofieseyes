/**
 * Stripe webhook — the only place an order is actually fulfilled.
 *
 * The success page cannot do this job: a buyer can pay and then close the tab
 * or lose signal before order-success.html ever loads, and with delayed payment
 * methods the money lands hours later. Both cases silently dropped the order
 * before this endpoint existed — including the digital download the success
 * page promises is "on its way to your email".
 *
 * Env vars:
 *   STRIPE_SECRET_KEY            (required) — restricted key (rk_)
 *   STRIPE_WEBHOOK_SECRET        (required) — whsec_… signing secret
 *   RESEND_API_KEY               (required) — reused from request-pressing.js
 *   PRESSING_TO / PRESSING_FROM  (optional) — same defaults as request-pressing.js
 *
 * Digital files are sent by hand, not linked. The site only holds the 1200px
 * web copies the admin portal makes on upload, not the originals a buyer pays
 * for, so the buyer gets a confirmation with a 24-hour promise and the owner
 * notice says which original to send — replying to it reaches the buyer.
 */

const Stripe = require('stripe');

const DEFAULT_TO   = 'goofiesfotos@gmail.com';
const DEFAULT_FROM = 'GoofiesEyes <onboarding@resend.dev>';

// Signature verification needs the exact bytes Stripe signed. Vercel's Node
// runtime reads the whole body before the handler runs, then replays those raw
// bytes on the request's 'data'/'end' events, so reading the stream here gets
// them intact.
//
// Never touch req.body in this file: on Vercel it is a lazy getter that
// JSON-parses on first access, and a re-serialised object never matches the
// signature. There is no switch to turn that off — Vercel ignores Next.js's
// `config.api.bodyParser` export. (Checked against @vercel/node 5.6.15,
// addHelpers/restoreBody.)
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function money(amount, currency) {
  if (amount == null) return '—';
  return `${(amount / 100).toFixed(2)} ${String(currency || 'usd').toUpperCase()}`;
}

function orderRef(sessionId) {
  return sessionId.replace(/^cs_(live|test)_/, '').substring(0, 16).toUpperCase();
}

// Throws rather than returning quietly. The handler turns a throw into a 500,
// and a 500 is what makes Stripe retry the event. A quiet failure would
// acknowledge the event and the order would be gone with nothing to show for
// it — which is exactly what happens when the resend.dev test sender refuses
// to deliver to anyone but the Resend account owner.
async function sendEmail({ to, replyTo, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error(`RESEND_API_KEY missing — cannot send: ${subject}`);

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.PRESSING_FROM || DEFAULT_FROM,
      to: [to],
      ...(replyTo ? { reply_to: replyTo } : {}),
      subject,
      html,
      text
    })
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(`Resend rejected "${subject}": ${detail.message || response.status}`);
  }
}

/* ── Fulfilment ─────────────────────────────────────────────────────────── */

async function confirmDigital(session) {
  const meta = session.metadata || {};
  const title = meta.product_title || meta.product_id;
  const buyer = (session.customer_details && session.customer_details.email) || session.customer_email;

  if (!buyer) {
    console.error('Digital order with no buyer email:', session.id);
    return;
  }

  const html = `
    <h2 style="font-family:Georgia,serif">Thank you for your order</h2>
    <p>You bought the full-resolution digital file of <strong>${escapeHtml(title)}</strong>.</p>
    <p>It will be emailed to this address within 24 hours. Any questions in the
       meantime, just reply to this email.</p>
    <p style="color:#666">Order ref: ${escapeHtml(orderRef(session.id))}</p>
  `;
  const text = `Thank you for your order.\n\nYou bought the full-resolution digital file of ${title}.\n` +
    `It will be emailed to this address within 24 hours. Any questions, just reply to this email.\n\n` +
    `Order ref: ${orderRef(session.id)}\n`;

  // orders@goofieseyes.live has no inbox (the domain has no MX record), so
  // replies are pointed at the owner.
  await sendEmail({
    to: buyer,
    replyTo: process.env.PRESSING_TO || DEFAULT_TO,
    subject: 'Your GoofiesEyes order',
    html,
    text
  });
}

async function notifyOwner(session, kind) {
  const details = session.customer_details || {};
  const address = (session.shipping_details && session.shipping_details.address) || details.address || {};
  const addressLines = [address.line1, address.line2, address.city, address.state, address.postal_code, address.country]
    .filter(Boolean).map(escapeHtml).join('<br>');

  const meta = session.metadata || {};
  const totals = session.total_details || {};
  const isDigital = kind === 'digital';

  // Replying goes to the buyer (reply_to below), so for a digital order the
  // whole job is: hit reply, attach the original, send.
  const todo = isDigital
    ? `<p style="background:#FFF4D6;padding:10px 12px"><strong>To do:</strong> send the
         full-resolution original of <strong>${escapeHtml(meta.product_id)}</strong> within
         24 hours. Reply to this email with it attached — the reply goes to the buyer.</p>`
    : '';

  const html = `
    <h2 style="font-family:Georgia,serif">New ${escapeHtml(kind)} order</h2>
    ${todo}
    <p><strong>Item:</strong> ${escapeHtml(meta.product_id)}${meta.size ? ' · ' + escapeHtml(meta.size) : ''}</p>
    <p><strong>Paid:</strong> ${escapeHtml(money(session.amount_total, session.currency))}
       (tax ${escapeHtml(money(totals.amount_tax, session.currency))})</p>
    <p><strong>Buyer:</strong> ${escapeHtml(details.name || meta.customer_name || '')}
       &lt;${escapeHtml(details.email || '')}&gt;</p>
    ${addressLines ? `<p><strong>Ship to:</strong><br>${addressLines}</p>` : ''}
    <p style="color:#666">Session: ${escapeHtml(session.id)}</p>
  `;

  await sendEmail({
    to: process.env.PRESSING_TO || DEFAULT_TO,
    replyTo: details.email || undefined,
    subject: isDigital
      ? `Send file: ${meta.product_title || meta.product_id} — new digital order`
      : `New print order — ${meta.product_id || 'print'}`,
    html,
    text: html.replace(/<[^>]+>/g, ' ')
  });
}

/* ── Handler ────────────────────────────────────────────────────────────── */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key    = process.env.STRIPE_SECRET_KEY;
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!key || !secret) {
    console.error('Stripe webhook is not configured');
    return res.status(500).json({ error: 'Not configured' });
  }

  const stripe = new Stripe(key, { apiVersion: '2026-08-26.dahlia' });

  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], secret);
  } catch (err) {
    // Never process an unverified payload — anyone can POST here.
    console.error('Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    switch (event.type) {
      // `completed` fires as soon as checkout finishes, which for a delayed
      // payment method is before the money arrives; `async_payment_succeeded`
      // is the one that fires later. Both funnel here and both are gated on
      // payment_status, so exactly one of them fulfils.
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;

        if (session.payment_status === 'unpaid') {
          console.log('Session not paid yet, awaiting async payment:', session.id);
          break;
        }

        const isDigital = session.metadata && session.metadata.type === 'digital';
        if (isDigital) await confirmDigital(session);
        await notifyOwner(session, isDigital ? 'digital' : 'print');
        break;
      }

      case 'checkout.session.async_payment_failed': {
        const session = event.data.object;
        console.error('Async payment failed:', session.id);
        await sendEmail({
          to: process.env.PRESSING_TO || DEFAULT_TO,
          subject: `Payment failed — ${(session.metadata && session.metadata.product_id) || 'print'}`,
          html: `<p>A delayed payment failed for session ${escapeHtml(session.id)}. Nothing was fulfilled.</p>`,
          text: `A delayed payment failed for session ${session.id}. Nothing was fulfilled.`
        });
        break;
      }

      default:
        // Everything else is acknowledged so Stripe stops retrying it.
        break;
    }
  } catch (err) {
    // 500 makes Stripe retry with backoff, which is what we want for a
    // transient email failure.
    console.error('Fulfilment error:', err.message);
    return res.status(500).json({ error: 'Fulfilment failed' });
  }

  res.status(200).json({ received: true });
};
