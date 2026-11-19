/**
 * Checkout for the store: one Stripe Checkout Session for a whole cart of
 * prints (physical or digital), digital products and merch.
 *
 * Request body (store cart):
 *   { items: [{ productId, type: 'physical'|'digital', size?, quantity? }], customerEmail? }
 * Legacy single-item body, still accepted so an open old tab keeps working:
 *   { productId, type, size, customerEmail, shippingName }
 *
 * Nothing the browser sends is trusted for money: every line is looked up in
 * content/data/prints.json or content/data/store.json and priced from there.
 * Free (price 0) and coming-soon products are refused here; they never go
 * through Stripe.
 *
 * Each line carries product_data.metadata { product_id, format, size } so the
 * webhook can read back exactly what was bought from the session's line items.
 *
 * Env vars:
 *   STRIPE_SECRET_KEY        (required) restricted key (rk_). Write on Checkout Sessions.
 *   STRIPE_PRINT_TAX_CODE    (optional) tax code for physical goods (prints, merch)
 *   STRIPE_DIGITAL_TAX_CODE  (optional) tax code for digital files
 *                            Both fall back to the account preset tax code.
 */

const fs     = require('fs');
const path   = require('path');
const Stripe = require('stripe');

// Tags these sessions in the Dashboard so this flow can be compared against
// any other checkout surface added later.
const INTEGRATION_IDENTIFIER = 'goofieseyes_prints_kqmxbtwz';

const SHIPPING_COUNTRIES = ['US', 'CA', 'GB', 'AU', 'NZ', 'TT'];
const MAX_LINES = 20;
const MAX_QTY = 10;

function readCatalogue(file, key) {
  const p = path.join(__dirname, '..', 'content', 'data', file);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))[key] || [];
  } catch (e) {
    if (file === 'store.json' && e.code === 'ENOENT') return [];
    throw e;
  }
}

/* Turn one requested line into a priced line, or throw a message the buyer
 * can read. `catalogue` holds both files. */
function priceLine(req, catalogue) {
  const productId = String(req.productId || '');
  const format = req.type === 'digital' ? 'digital' : 'physical';
  const quantity = format === 'digital'
    ? 1
    : Math.max(1, Math.min(MAX_QTY, parseInt(req.quantity, 10) || 1));

  const print = catalogue.prints.find(p => p.filename === productId);
  if (print) {
    let size = null;
    if (format === 'physical') {
      size = req.size;
      if (!size) throw new Error('Size is required for physical prints');
      if (!print.sizes || !print.sizes.includes(size)) throw new Error('Invalid size for this product');
    }
    const raw = format === 'digital'
      ? (print.digitalPrice ?? print.price ?? 0)
      : (print.physicalPrice ?? print.price ?? 0);
    const name = print.title || print.filename;
    return {
      productId, format, size, quantity,
      unitAmount: Math.round(Number(raw) * 100),
      name,
      description: format === 'digital'
        ? 'High-Resolution Digital File · Emailed within 24 hours'
        : `${size} · Limited Edition Fine Art Print${print.portfolioName ? ' · ' + print.portfolioName : ''}`,
      image: `/content/photos/${print.filename}`
    };
  }

  const item = catalogue.products.find(p => p.id === productId);
  if (!item) throw new Error('Product not found');
  if ((item.status || 'live') !== 'live') throw new Error(`${item.title} is not available yet`);

  const itemFormat = item.kind === 'merch' ? 'physical' : 'digital';
  if (format !== itemFormat) throw new Error('Invalid format for this product');

  let size = null;
  if (item.sizes && item.sizes.length) {
    size = req.size;
    if (!item.sizes.includes(size)) throw new Error('Invalid size for this product');
  }

  return {
    productId, format, size, quantity,
    unitAmount: Math.round(Number(item.price || 0) * 100),
    name: item.title,
    description: [item.subtitle, size, itemFormat === 'digital' ? 'Digital download' : null]
      .filter(Boolean).join(' · ') || undefined,
    image: item.image
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const requested = Array.isArray(body.items)
    ? body.items
    : [{ productId: body.productId, type: body.type, size: body.size, quantity: 1 }];

  if (!requested.length) return res.status(400).json({ error: 'Your cart is empty' });
  if (requested.length > MAX_LINES) return res.status(400).json({ error: `At most ${MAX_LINES} items per order` });

  // ── Load both catalogues (prices are validated server-side) ─────────────
  let catalogue;
  try {
    catalogue = {
      prints: readCatalogue('prints.json', 'prints'),
      products: readCatalogue('store.json', 'products')
    };
  } catch (e) {
    return res.status(500).json({ error: 'Could not load product catalog' });
  }

  let lines;
  try {
    lines = requested.map(r => priceLine(r || {}, catalogue));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  if (lines.some(l => !l.unitAmount || l.unitAmount <= 0)) {
    return res.status(400).json({ error: 'Invalid product price' });
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'Stripe is not configured' });

  const stripe = new Stripe(key, { apiVersion: '2026-08-26.dahlia' });

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host     = req.headers['x-forwarded-host'] || req.headers.host;
  const origin   = `${protocol}://${host}`;

  const anyPhysical = lines.some(l => l.format === 'physical');
  const anyDigital  = lines.some(l => l.format === 'digital');
  const orderType   = anyPhysical && anyDigital ? 'mixed' : (anyPhysical ? 'physical' : 'digital');

  const lineItems = lines.map(l => {
    // A physical good and a digital file are taxed differently in most US
    // states, so they carry separate codes. Unset falls back to the account
    // preset; neither is guessed here.
    const taxCode = l.format === 'digital'
      ? process.env.STRIPE_DIGITAL_TAX_CODE
      : process.env.STRIPE_PRINT_TAX_CODE;

    const productData = {
      name: l.name,
      images: [`${origin}${l.image}`],
      metadata: { product_id: l.productId, format: l.format, size: l.size || '' }
    };
    if (l.description) productData.description = l.description;
    if (taxCode) productData.tax_code = taxCode;

    return {
      price_data: {
        currency: 'usd',
        product_data: productData,
        unit_amount: l.unitAmount,
        // Sales tax is added on top of the listed price rather than carved out
        // of it. Switch to 'inclusive' if prices are ever advertised tax-in.
        tax_behavior: 'exclusive'
      },
      quantity: l.quantity
    };
  });

  // Session metadata is a readable summary for the Dashboard (500-char cap per
  // value); the webhook reads the line items, not this.
  const summary = lines
    .map(l => `${l.quantity}x ${l.productId} ${l.format}${l.size ? ' ' + l.size : ''}`)
    .join('; ')
    .slice(0, 500);

  const params = {
    // payment_method_types is deliberately omitted: that enables dynamic
    // payment methods, so Link, wallets and buy-now-pay-later show up based on
    // the buyer's country and cart, configured from the Dashboard with no
    // code change here.
    mode: 'payment',
    line_items: lineItems,
    automatic_tax: { enabled: true },
    integration_identifier: INTEGRATION_IDENTIFIER,
    metadata: {
      type: orderType,
      items: summary,
      // Kept for single-item orders so older Dashboard views and the webhook's
      // fallback path still read naturally.
      product_id: lines.length === 1 ? lines[0].productId : 'cart',
      product_title: lines.length === 1 ? lines[0].name : `${lines.length} items`,
      customer_name: String(body.shippingName || '').slice(0, 120)
    },
    success_url: `${origin}/order-success.html?session_id={CHECKOUT_SESSION_ID}&type=${orderType}`,
    cancel_url: Array.isArray(body.items)
      ? `${origin}/cart.html`
      : `${origin}/product.html?id=${encodeURIComponent(lines[0].productId)}&format=${lines[0].format}`
  };

  if (lines.length === 1 && lines[0].size) params.metadata.size = lines[0].size;

  // Machine-readable cart for the webhook, in line-item order:
  // [[productId, format, size], ...] as JSON, split into l0, l1, ... because a
  // metadata value holds at most 500 characters. The webhook needs only read
  // access to Checkout Sessions to get this back, unlike product metadata,
  // which would also need the restricted key to read Products.
  const packed = JSON.stringify(lines.map(l => [l.productId, l.format, l.size || '']));
  for (let i = 0; i * 490 < packed.length; i++) {
    params.metadata[`l${i}`] = packed.slice(i * 490, (i + 1) * 490);
  }

  const email = String(body.customerEmail || '').trim();
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) params.customer_email = email;

  if (anyPhysical) {
    params.shipping_address_collection = { allowed_countries: SHIPPING_COUNTRIES };
  } else {
    // No shipping address to tax against, so Checkout needs a billing address
    // to place the buyer in a jurisdiction.
    params.billing_address_collection = 'required';
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

// Exposed for tests.
module.exports.priceLine = priceLine;
