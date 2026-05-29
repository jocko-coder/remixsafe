// POST /checkout
// Body: { plan: 'solo'|'operator'|'agency' } | { plan: 'topup', quantity: N } | { portal: true }
// Returns: { url }
const Stripe = require('stripe');
const { getUser, json, PRICE_IDS } = require('./_lib');

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
  : null;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });
  if (!stripe) return json(500, { error: 'Stripe not configured (set STRIPE_SECRET_KEY)' });

  const { user, admin, error } = await getUser(event);
  if (error) return json(401, { error });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid json' }); }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:8888';

  // Find or create Stripe customer
  let { data: profile } = await admin
    .from('billing_profiles')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  let customerId = profile?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { supabase_user_id: user.id }
    });
    customerId = customer.id;
    await admin.from('billing_profiles').upsert({
      user_id: user.id,
      stripe_customer_id: customerId,
    });
  }

  // Customer portal
  if (body.portal) {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${siteUrl}/app/billing.html`,
    });
    return json(200, { url: session.url });
  }

  const plan = body.plan;
  if (!plan) return json(400, { error: 'missing plan' });

  // Top-up: one-time charge, quantity = remix count
  if (plan === 'topup') {
    const qty = parseInt(body.quantity, 10);
    if (!qty || qty < 1 || qty > 5000) return json(400, { error: 'invalid quantity' });
    if (!PRICE_IDS.topup) return json(500, { error: 'STRIPE_PRICE_TOPUP not set' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [{ price: PRICE_IDS.topup, quantity: qty }],
      success_url: `${siteUrl}/app/billing.html?success=topup&qty=${qty}`,
      cancel_url: `${siteUrl}/app/billing.html?canceled=1`,
      metadata: { kind: 'topup', user_id: user.id, quantity: String(qty) },
    });
    return json(200, { url: session.url });
  }

  // Subscription plans
  const priceId = PRICE_IDS[plan];
  if (!priceId) return json(400, { error: `unknown plan: ${plan}` });

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${siteUrl}/app/billing.html?success=${plan}`,
    cancel_url: `${siteUrl}/app/billing.html?canceled=1`,
    metadata: { kind: 'plan', plan, user_id: user.id },
    subscription_data: {
      metadata: { plan, user_id: user.id }
    }
  });
  return json(200, { url: session.url });
};
