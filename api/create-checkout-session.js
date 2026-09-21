/**
 * Checkout for prints — physical fine art prints and digital downloads.
 *
 * Unlike request-pressing.js, this endpoint uses the Stripe SDK rather than
 * raw fetch. Two reasons: the sibling webhook needs the SDK's vetted signature
 * verification, and the nested params for tax and shipping are unreadable as
 * hand-built URLSearchParams.
 *
 * Env vars:
 *   STRIPE_SECRET_KEY  (required) — restricted key (rk_), not a secret key.
 *                                   Needs write on Checkout Sessions only.
 *   STRIPE_PRINT_TAX_CODE      (optional) — product tax code for physical prints
 *   STRIPE_DIGITAL_TAX_CODE    (optional) — product tax code for digital files
 *                                Both fall back to the account preset tax code
 *                                set in Dashboard -> Tax -> Settings.
 */

const fs     = require('fs');
const path   = require('path');
const Stripe = require('stripe');

// Tags these sessions in the Dashboard so this flow can be compared against
// any other checkout surface added later.
const INTEGRATION_IDENTIFIER = 'goofieseyes_prints_kqmxbtwz';

const SHIPPING_COUNTRIES = ['US', 'CA', 'GB', 'AU', 'NZ', 'TT'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { productId, type, size, customerEmail, shippingName } = req.body;
  const isDigital = type === 'digital';

  // ── Load prints catalog from static file (price validated server-side) ──
  let prints;
  try {
    const printsPath = path.join(__dirname, '..', 'content', 'data', 'prints.json');
    prints = JSON.parse(fs.readFileSync(printsPath, 'utf8')).prints || [];
  } catch (e) {
    return res.status(500).json({ error: 'Could not load product catalog' });
  }

  const print = prints.find(p => p.filename === productId);
  if (!print) return res.status(400).json({ error: 'Product not found' });

  // ── Validate physical size ───────────────────────────────────────────────
  if (!isDigital) {
    if (!size) return res.status(400).json({ error: 'Size is required for physical prints' });
    if (!print.sizes || !print.sizes.includes(size)) {
      return res.status(400).json({ error: 'Invalid size for this product' });
    }
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'Stripe is not configured' });

  const stripe = new Stripe(key, { apiVersion: '2026-08-26.dahlia' });

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host     = req.headers['x-forwarded-host'] || req.headers.host;
  const origin   = `${protocol}://${host}`;

  // Price in cents — use type-specific price, fall back to legacy `price` field
  const rawPrice = isDigital
    ? (print.digitalPrice ?? print.price ?? 0)
    : (print.physicalPrice ?? print.price ?? 0);
  const unitAmount = Math.round(Number(rawPrice) * 100);
  if (!unitAmount || unitAmount <= 0) {
    return res.status(400).json({ error: 'Invalid product price' });
  }

  const productName = print.title || print.filename;
  const lineItemDescription = isDigital
    ? 'High-Resolution Digital File · Emailed within 24 hours'
    : `${size} · Limited Edition Fine Art Print${print.portfolioName ? ' · ' + print.portfolioName : ''}`;

  const imageUrl = `${origin}/content/photos/${print.filename}`;

  // A physical print and a digital file are taxed differently in most US
  // states, so they carry separate codes. Unset falls back to the account
  // preset; neither is guessed here.
  const taxCode = isDigital
    ? process.env.STRIPE_DIGITAL_TAX_CODE
    : process.env.STRIPE_PRINT_TAX_CODE;

  const productData = {
    name: productName,
    description: lineItemDescription,
    images: [imageUrl]
  };
  if (taxCode) productData.tax_code = taxCode;

  const params = {
    // payment_method_types is deliberately omitted: that enables dynamic
    // payment methods, so Link, wallets and buy-now-pay-later show up based on
    // the buyer's country and cart, configured from the Dashboard with no
    // code change here.
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: productData,
        unit_amount: unitAmount,
        // Sales tax is added on top of the listed price rather than carved out
        // of it. Switch to 'inclusive' if prices are ever advertised tax-in.
        tax_behavior: 'exclusive'
      },
      quantity: 1
    }],
    automatic_tax: { enabled: true },
    integration_identifier: INTEGRATION_IDENTIFIER,
    metadata: {
      product_id: productId,
      product_title: productName,
      type: type || 'physical',
      customer_name: shippingName || ''
    },
    success_url: `${origin}/order-success.html?session_id={CHECKOUT_SESSION_ID}&type=${isDigital ? 'digital' : 'physical'}`,
    cancel_url: `${origin}/print-checkout.html?product=${encodeURIComponent(productId)}&type=${isDigital ? 'digital' : 'physical'}`
  };

  if (customerEmail) params.customer_email = customerEmail;

  if (isDigital) {
    // No shipping address to tax against, so Checkout needs a billing address
    // to place the buyer in a jurisdiction.
    params.billing_address_collection = 'required';
  } else {
    params.shipping_address_collection = { allowed_countries: SHIPPING_COUNTRIES };
    params.metadata.size = size;
  }

  try {
    const session = await stripe.checkout.sessions.create(params);
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    const status = err.statusCode && err.statusCode < 500 ? 400 : 502;
    res.status(status).json({ error: err.message || 'Stripe error' });
  }
};
