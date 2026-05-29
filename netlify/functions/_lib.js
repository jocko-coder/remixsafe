// Shared helpers for Netlify Functions
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

function adminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function userClient(jwt) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

async function getUser(event) {
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return { error: 'missing auth', user: null, token: null };
  const admin = adminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return { error: 'invalid token', user: null, token };
  return { user: data.user, token, admin };
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body)
  };
}

const PLAN_CREDITS = { solo: 100, operator: 500, agency: 2000 };

const PRICE_IDS = {
  solo: process.env.STRIPE_PRICE_SOLO,
  operator: process.env.STRIPE_PRICE_OPERATOR,
  agency: process.env.STRIPE_PRICE_AGENCY,
  topup: process.env.STRIPE_PRICE_TOPUP,
};

module.exports = { adminClient, userClient, getUser, json, PLAN_CREDITS, PRICE_IDS };
