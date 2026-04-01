const fs   = require('fs');
const path = require('path');

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

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host     = req.headers['x-forwarded-host'] || req.headers.host;
  const origin   = `${protocol}://${host}`;

  // Price in cents
  const unitAmount = Math.round(Number(print.price) * 100);
  if (!unitAmount || unitAmount <= 0) {
    return res.status(400).json({ error: 'Invalid product price' });
  }

  const productName = print.title || print.filename;
  const lineItemDescription = isDigital
    ? 'High-Resolution Digital File · Delivered to your email'
    : `${size} · Limited Edition Fine Art Print${print.portfolioName ? ' · ' + print.portfolioName : ''}`;

  const imageUrl = `${origin}/content/photos/${print.filename}`;

  const params = new URLSearchParams({
    'payment_method_types[]': 'card',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': productName,
    'line_items[0][price_data][product_data][description]': lineItemDescription,
    'line_items[0][price_data][product_data][images][0]': imageUrl,
    'line_items[0][price_data][unit_amount]': String(unitAmount),
    'line_items[0][quantity]': '1',
    'mode': 'payment',
    'metadata[product_id]': productId,
    'metadata[type]': type || 'physical',
    'metadata[customer_name]': shippingName || '',
    'success_url': `${origin}/order-success.html?session_id={CHECKOUT_SESSION_ID}&type=${isDigital ? 'digital' : 'physical'}`,
    'cancel_url': `${origin}/print-checkout.html?product=${encodeURIComponent(productId)}&type=${isDigital ? 'digital' : 'physical'}`
  });

  if (customerEmail) params.set('customer_email', customerEmail);

  if (!isDigital) {
    params.append('shipping_address_collection[allowed_countries][0]', 'US');
    params.append('shipping_address_collection[allowed_countries][1]', 'CA');
    params.append('shipping_address_collection[allowed_countries][2]', 'GB');
    params.append('shipping_address_collection[allowed_countries][3]', 'AU');
    params.append('shipping_address_collection[allowed_countries][4]', 'NZ');
    params.append('shipping_address_collection[allowed_countries][5]', 'TT');
    params.set('metadata[size]', size);
  }

  try {
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Stripe API error:', data.error);
      return res.status(502).json({ error: data.error?.message || 'Stripe error' });
    }

    res.status(200).json({ url: data.url });
  } catch (err) {
    console.error('Fetch error:', err.message);
    res.status(500).json({ error: 'Failed to connect to Stripe: ' + err.message });
  }
};
