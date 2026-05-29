// POST /stripe-webhook
// Stripe webhook handler — credits remixes on successful payment.
const Stripe = require('stripe');
const { adminClient, PLAN_CREDITS } = require('./_lib');

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
  : null;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'method not allowed' };
  if (!stripe || !WEBHOOK_SECRET) return { statusCode: 500, body: 'stripe not configured' };

  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  let stripeEvent;
  try {
    // Netlify gives us a string body; Stripe needs the raw body
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : event.body;
    stripeEvent = stripe.webhooks.constructEvent(raw, sig, WEBHOOK_SECRET);
  } catch (err) {
    return { statusCode: 400, body: `webhook signature failed: ${err.message}` };
  }

  const admin = adminClient();

  try {
    switch (stripeEvent.type) {

      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const customerId = session.customer;
        const meta = session.metadata || {};
        const userId = meta.user_id || await lookupUserByCustomer(admin, customerId);
        if (!userId) break;

        if (meta.kind === 'topup') {
          const qty = parseInt(meta.quantity, 10) || 0;
          await admin.from('ledger').insert({
            user_id: userId, delta: qty,
            reason: 'topup', stripe_ref: session.id,
          });
        } else if (meta.kind === 'plan') {
          const credits = PLAN_CREDITS[meta.plan] || 0;
          await admin.from('ledger').insert({
            user_id: userId, delta: credits,
            reason: `plan_${meta.plan}`, stripe_ref: session.id,
          });
          await admin.from('billing_profiles').upsert({
            user_id: userId,
            stripe_customer_id: customerId,
            current_plan: meta.plan,
            updated_at: new Date().toISOString(),
          });
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        // Monthly renewal — re-credit the plan amount
        const inv = stripeEvent.data.object;
        if (inv.billing_reason !== 'subscription_cycle') break;
        const customerId = inv.customer;
        const userId = await lookupUserByCustomer(admin, customerId);
        if (!userId) break;
        const subId = inv.subscription;
        if (!subId) break;
        const sub = await stripe.subscriptions.retrieve(subId);
        const plan = sub.metadata?.plan;
        const credits = PLAN_CREDITS[plan] || 0;
        if (credits) {
          await admin.from('ledger').insert({
            user_id: userId, delta: credits,
            reason: `renew_${plan}`, stripe_ref: inv.id,
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        const customerId = sub.customer;
        const userId = await lookupUserByCustomer(admin, customerId);
        if (!userId) break;
        await admin.from('billing_profiles').update({
          current_plan: null,
          updated_at: new Date().toISOString(),
        }).eq('user_id', userId);
        break;
      }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('webhook handler error:', err);
    return { statusCode: 500, body: `handler error: ${err.message}` };
  }
};

async function lookupUserByCustomer(admin, customerId) {
  const { data } = await admin
    .from('billing_profiles')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  return data?.user_id || null;
}
