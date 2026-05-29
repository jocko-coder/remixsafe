# RemixSafe

Turn one source video into N platform-unique variants. Each output gets perturbed audio,
shifted visual hash, and fresh metadata so TikTok, YouTube Shorts, and Instagram Reels
each see a "new" file.

Stack:
- **Frontend** — vanilla HTML/CSS/JS (deploys as static files)
- **Auth + DB + Storage** — Supabase
- **Billing** — Stripe (subscriptions + one-time top-ups)
- **API** — Netlify Functions (Node.js)
- **Video worker** — Node.js + ffmpeg (runs locally or on Fly.io)

---

## Repo layout

```
/                          landing page (index.html)
/app/                      authenticated app (dashboard, login, billing, job)
/netlify/functions/        Netlify Functions (create-job, checkout, webhook, status)
/worker/                   Node.js ffmpeg worker
/supabase/migrations/      SQL schema + RLS policies
.env.example               environment template
netlify.toml               Netlify build / routing config
```

---

## Setup

### 1. Supabase
1. Create a new project at <https://supabase.com>.
2. Open SQL editor, paste contents of `supabase/migrations/0001_init.sql`, run.
3. Storage → confirm two buckets exist: `sources` (private), `variants` (public).
4. Project Settings → API → copy:
   - `Project URL` → `SUPABASE_URL`
   - `anon public` key → `SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_KEY` (server-only, never ship to client)

### 2. Stripe
1. <https://dashboard.stripe.com> → Products → create three recurring products:
   - **Solo** $29/mo → copy price ID into `STRIPE_PRICE_SOLO`
   - **Operator** $89/mo → `STRIPE_PRICE_OPERATOR`
   - **Agency** $249/mo → `STRIPE_PRICE_AGENCY`
2. Create one **one-time** price for top-ups at $1.50 → `STRIPE_PRICE_TOPUP`
3. Copy your secret key into `STRIPE_SECRET_KEY`.
4. Webhooks → add endpoint `https://<your-site>.netlify.app/.netlify/functions/stripe-webhook`
   for events: `checkout.session.completed`, `invoice.payment_succeeded`,
   `customer.subscription.deleted`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

### 3. Environment
```bash
cp .env.example .env
# fill in the values from steps 1 & 2
```
Also paste the same values into Netlify's site settings → Environment variables.

### 4. Client config
Edit `app/shared.js` and replace the `SUPABASE_URL` / `SUPABASE_ANON_KEY` placeholders
with your real values. (These are public — safe to ship.)

---

## Run locally

### Frontend + functions
```bash
npm install -g netlify-cli
cd netlify/functions && npm install && cd ../..
netlify dev
# → http://localhost:8888
```

### Worker
```bash
brew install ffmpeg            # macOS — or apt-get on Linux
cd worker
npm install
npm start
# polls Supabase every 5s for queued jobs
```

---

## Deploy

### Frontend → Netlify
- Drag the project folder into <https://app.netlify.com/drop>, **or**
- `netlify deploy --prod`

### Worker → Fly.io
```bash
cd worker
fly launch --no-deploy
fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_KEY=...
fly deploy
```
The worker is stateless and only needs outbound HTTPS to Supabase.

---

## How a job flows

1. User picks a video, preset, and variant count → `POST /create-job`.
2. Function checks balance, inserts a `jobs` row (`status=queued`), debits the
   ledger, returns a signed Supabase upload URL.
3. Browser uploads the source video directly to the `sources` bucket.
4. Worker polls → claims the job (`status=processing`) → downloads source →
   runs N ffmpeg passes (zoom, hue, pitch, noise, trim, strip metadata) →
   uploads each variant to the `variants` bucket → marks job `done`.
5. Frontend polls `/job-status` every 3s; when done, shows download links.
6. On failure the worker marks `status=failed` and refunds the remixes to the ledger.

---

## Notes

- All `app/*` pages check auth on load and redirect to `/app/login.html` if
  there's no session.
- The `remix_balance` view sums the ledger — never let users write to the
  ledger directly (RLS only allows SELECT for the owner).
- The worker uses optimistic claim (`UPDATE … WHERE status='queued'`) so
  multiple workers can run safely.
- Source videos are private. Variant MP4s live in a public bucket so the
  ZIP download / direct links work without signed URLs.
