-- RemixSafe initial schema
-- Run this in the Supabase SQL editor after creating a new project.
-- Users are handled by the built-in `auth.users` table.

create extension if not exists pgcrypto;

-- ---------- JOBS ----------
create table if not exists jobs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade not null,
  source_url      text,
  source_path     text,           -- storage path inside the `sources` bucket
  preset          text not null check (preset in ('tiktok','shorts','reels')),
  variant_count   integer not null check (variant_count between 1 and 10),
  status          text not null default 'queued' check (status in ('queued','processing','done','failed')),
  variant_urls    jsonb default '[]'::jsonb,
  error_message   text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists jobs_user_idx on jobs(user_id, created_at desc);
create index if not exists jobs_status_idx on jobs(status) where status in ('queued','processing');

-- ---------- LEDGER (remix balance via deltas) ----------
create table if not exists ledger (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  delta       integer not null,            -- positive = credit, negative = debit
  reason      text,                        -- 'plan_solo', 'topup', 'job:<id>', 'refund:<id>'
  stripe_ref  text,
  created_at  timestamptz default now()
);

create index if not exists ledger_user_idx on ledger(user_id, created_at desc);

-- ---------- BALANCE VIEW ----------
create or replace view remix_balance as
  select user_id, coalesce(sum(delta), 0)::integer as balance
  from ledger
  group by user_id;

-- ---------- BILLING PROFILE (Stripe linkage) ----------
create table if not exists billing_profiles (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id   text unique,
  current_plan         text,                -- 'solo' | 'operator' | 'agency' | null
  updated_at           timestamptz default now()
);

-- ---------- ROW LEVEL SECURITY ----------
alter table jobs              enable row level security;
alter table ledger            enable row level security;
alter table billing_profiles  enable row level security;

-- Jobs: owner read/insert/update
create policy "jobs_select_own"  on jobs  for select using (auth.uid() = user_id);
create policy "jobs_insert_own"  on jobs  for insert with check (auth.uid() = user_id);
create policy "jobs_update_own"  on jobs  for update using (auth.uid() = user_id);

-- Ledger: owner read only (writes via service role)
create policy "ledger_select_own" on ledger for select using (auth.uid() = user_id);

-- Billing profiles: owner read only
create policy "billing_select_own" on billing_profiles for select using (auth.uid() = user_id);

-- The view inherits RLS from the underlying ledger table.
grant select on remix_balance to authenticated;

-- ---------- WAITLIST ----------
create table if not exists waitlist (
  id         uuid primary key default gen_random_uuid(),
  name       text,
  email      text not null,
  plan       text,
  created_at timestamptz default now()
);

-- Public insert (unauthenticated users can join waitlist)
alter table waitlist enable row level security;
create policy "waitlist_insert_public" on waitlist for insert with check (true);

-- ---------- STORAGE BUCKETS ----------
-- Run these in the Storage section of the Supabase dashboard, or via SQL:
insert into storage.buckets (id, name, public)
  values ('sources', 'sources', false)
  on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
  values ('variants', 'variants', true)
  on conflict (id) do nothing;

-- Source uploads: users can write into their own folder (path begins with their uid)
create policy "sources_insert_own" on storage.objects for insert
  with check (bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "sources_select_own" on storage.objects for select
  using (bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text);

-- Variants: read by anyone (public bucket); writes via service role
create policy "variants_public_read" on storage.objects for select
  using (bucket_id = 'variants');
