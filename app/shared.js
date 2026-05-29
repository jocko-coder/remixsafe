// RemixSafe shared client helpers
// In production these come from a build step or window-injected config.
// For now we use placeholders — replace via .env when deployed.
window.REMIXSAFE_CONFIG = {
  SUPABASE_URL: 'https://your-project.supabase.co',
  SUPABASE_ANON_KEY: 'your-anon-key-here',
  FUNCTIONS_BASE: '/.netlify/functions',
};

const cfg = window.REMIXSAFE_CONFIG;

// Initialize Supabase client (loaded from CDN before this script)
window.sb = window.supabase
  ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
  : null;

// ---------- Auth helpers ----------
window.requireAuth = async function requireAuth() {
  if (!window.sb) return null;
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) {
    window.location.href = '/app/login.html';
    return null;
  }
  return session;
};

window.signOut = async function signOut() {
  if (!window.sb) return;
  await window.sb.auth.signOut();
  window.location.href = '/app/login.html';
};

// ---------- Toast ----------
window.toast = function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(20px)'; el.style.transition = 'all .3s'; }, 3200);
  setTimeout(() => el.remove(), 3600);
};

// ---------- API wrapper ----------
window.api = async function api(path, opts = {}) {
  const session = window.sb ? (await window.sb.auth.getSession()).data.session : null;
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    session ? { Authorization: `Bearer ${session.access_token}` } : {},
    opts.headers || {}
  );
  const res = await fetch(cfg.FUNCTIONS_BASE + path, { ...opts, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
};

// ---------- Formatting ----------
window.fmtDate = function (iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

window.fmtBytes = function (n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
};

// ---------- Nav builder ----------
window.renderNav = function (activePage, balance) {
  return `
  <nav class="nav">
    <div class="container nav-inner">
      <a href="/" class="brand">
        <span class="dot"></span>RemixSafe<span class="chev">/ app</span>
      </a>
      <div class="nav-links">
        <a href="/app/index.html" class="${activePage==='dash'?'active':''}">Dashboard</a>
        <a href="/app/billing.html" class="${activePage==='billing'?'active':''}">Billing</a>
        <a href="/" class="dim">Home</a>
      </div>
      <div class="nav-cta">
        ${typeof balance === 'number' ? `<span class="pill pill-lime"><span class="dot-lime"></span>${balance} remixes</span>` : ''}
        <button class="btn btn-sm btn-ghost" onclick="signOut()">Sign out</button>
      </div>
    </div>
  </nav>`;
};

// ---------- Balance fetch ----------
window.fetchBalance = async function () {
  if (!window.sb) return 0;
  const { data, error } = await window.sb
    .from('remix_balance')
    .select('balance')
    .maybeSingle();
  if (error) { console.warn(error); return 0; }
  return data?.balance ?? 0;
};
