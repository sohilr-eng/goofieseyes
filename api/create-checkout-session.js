const Stripe = require('stripe');

const PRODUCTS = {
  'morning-mist': {
    name: 'The Morning Mist',
    description: 'Limited Edition Fine Art Print · Tobago Collection · Hahnemühle Photo Rag Baryta 315gsm',
    image: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400',
    prices: { '8x10': 12000, '11x14': 14500, '16x20': 18000 }
  },
  'northern-washout': {
    name: 'Northern Washout',
    description: "Limited Edition Fine Art Print · Trinidad's Northern Range · Deep shadows and rich greens",
    image: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=400',
    prices: { '8x10': 12000, '11x14': 14500, '16x20': 18000 }
  },
  'yellow-flash': {
    name: 'Yellow Flash',
    description: 'Limited Edition Fine Art Print · NYC Street Life · Cinematic capture of a rushing cab in rain',
    image: 'https://images.unsplash.com/photo-1534430480872-3498386e7856?w=400',
    prices: { '8x10': 14500, '11x14': 17000, '16x20': 21000 }
  },
  'silent-sentinel': {
    name: 'Silent Sentinel',
    description: 'Limited Edition Fine Art Print · Caribbean Twilight · A lone tree in high contrast',
    image: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=400',
    prices: { '8x10': 9000, '11x14': 11000, '16x20': 14500 }
  },
  'urban-shadows': {
    name: 'Urban Shadows',
    description: 'Limited Edition Fine Art Print · Black and white street photograph · Brooklyn, NYC',
    image: 'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=400',
    prices: { '8x10': 11000, '11x14': 13500, '16x20': 17000 }
  },
  'hidden-falls': {
    name: 'The Hidden Falls',
    description: 'Limited Edition Fine Art Print · Long-exposure shot deep within the Northern Range',
    image: 'https://images.unsplash.com/photo-1433086966358-54859d0ed716?w=400',
    prices: { '8x10': 15000, '11x14': 18000, '16x20': 22000 }
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

  const { productId, size, customerEmail, shippingName } = req.body;

  const product = PRODUCTS[productId];
  if (!product) return res.status(400).json({ error: 'Invalid product' });

  const unitAmount = product.prices[size];
  if (!unitAmount) return res.status(400).json({ error: 'Invalid size' });

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Stripe is not configured' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-12-18.acacia'
  });

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = `${protocol}://${host}`;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: product.name,
              description: `${SIZE_LABELS[size]} · ${product.description}`,
              images: [product.image]
            },
            unit_amount: unitAmount
          },
          quantity: 1
        }
      ],
      mode: 'payment',
      customer_email: customerEmail || undefined,
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'AU', 'NZ', 'TT']
      },
      metadata: {
        product_id: productId,
        size,
        customer_name: shippingName || ''
      },
      success_url: `${origin}/order-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/print-checkout.html?product=${productId}`
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
