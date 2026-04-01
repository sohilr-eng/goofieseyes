const PRODUCTS = {
  'morning-mist': {
    name: 'The Morning Mist',
    description: 'Limited Edition Fine Art Print · Tobago Collection · Hahnemühle Photo Rag Baryta 315gsm',
    image: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400',
    prices: { '8x10': 12000, '11x14': 14500, '16x20': 18000 },
    digitalPrice: 3500
  },
  'northern-washout': {
    name: 'Northern Washout',
    description: "Limited Edition Fine Art Print · Trinidad's Northern Range · Deep shadows and rich greens",
    image: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=400',
    prices: { '8x10': 12000, '11x14': 14500, '16x20': 18000 },
    digitalPrice: 3500
  },
  'yellow-flash': {
    name: 'Yellow Flash',
    description: 'Limited Edition Fine Art Print · NYC Street Life · Cinematic capture of a rushing cab in rain',
    image: 'https://images.unsplash.com/photo-1534430480872-3498386e7856?w=400',
    prices: { '8x10': 14500, '11x14': 17000, '16x20': 21000 },
    digitalPrice: 4500
  },
  'silent-sentinel': {
    name: 'Silent Sentinel',
    description: 'Limited Edition Fine Art Print · Caribbean Twilight · A lone tree in high contrast',
    image: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=400',
    prices: { '8x10': 9000, '11x14': 11000, '16x20': 14500 },
    digitalPrice: 2500
  },
  'urban-shadows': {
    name: 'Urban Shadows',
    description: 'Limited Edition Fine Art Print · Black and white street photograph · Brooklyn, NYC',
    image: 'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=400',
    prices: { '8x10': 11000, '11x14': 13500, '16x20': 17000 },
    digitalPrice: 3000
  },
  'hidden-falls': {
    name: 'The Hidden Falls',
    description: 'Limited Edition Fine Art Print · Long-exposure shot deep within the Northern Range',
    image: 'https://images.unsplash.com/photo-1433086966358-54859d0ed716?w=400',
    prices: { '8x10': 15000, '11x14': 18000, '16x20': 22000 },
    digitalPrice: 4000
  }
};

const SIZE_LABELS = {
  '8x10': '8" × 10"',
  '11x14': '11" × 14"',
  '16x20': '16" × 20"'
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { productId, type, size, customerEmail, shippingName } = req.body;
  const isDigital = type === 'digital';

  const product = PRODUCTS[productId];
  if (!product) return res.status(400).json({ error: 'Invalid product' });

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'Stripe is not configured' });

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host     = req.headers['x-forwarded-host'] || req.headers.host;
  const origin   = `${protocol}://${host}`;

  let unitAmount, lineItemDescription;

  if (isDigital) {
    unitAmount = product.digitalPrice;
    lineItemDescription = 'High-Resolution Digital File · Delivered to your email';
  } else {
    if (!size || !product.prices[size]) {
      return res.status(400).json({ error: 'Invalid size' });
    }
    unitAmount = product.prices[size];
    lineItemDescription = `${SIZE_LABELS[size]} · ${product.description}`;
  }

  const params = new URLSearchParams({
    'payment_method_types[]': 'card',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': product.name,
    'line_items[0][price_data][product_data][description]': lineItemDescription,
    'line_items[0][price_data][product_data][images][0]': product.image,
    'line_items[0][price_data][unit_amount]': String(unitAmount),
    'line_items[0][quantity]': '1',
    'mode': 'payment',
    'metadata[product_id]': productId,
    'metadata[type]': type || 'physical',
    'metadata[customer_name]': shippingName || '',
    'success_url': `${origin}/order-success.html?session_id={CHECKOUT_SESSION_ID}&type=${isDigital ? 'digital' : 'physical'}`,
    'cancel_url': `${origin}/print-checkout.html?product=${productId}&type=${isDigital ? 'digital' : 'physical'}`
  });

  if (customerEmail) params.set('customer_email', customerEmail);

  // Physical prints need shipping address; digital prints do not
  if (!isDigital) {
    params.append('shipping_address_collection[allowed_countries][0]', 'US');
    params.append('shipping_address_collection[allowed_countries][1]', 'CA');
    params.append('shipping_address_collection[allowed_countries][2]', 'GB');
    params.append('shipping_address_collection[allowed_countries][3]', 'AU');
    params.append('shipping_address_collection[allowed_countries][4]', 'NZ');
    params.append('shipping_address_collection[allowed_countries][5]', 'TT');
    if (size) params.set('metadata[size]', size);
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
