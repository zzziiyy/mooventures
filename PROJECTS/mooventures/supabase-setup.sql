-- ─────────────────────────────────────────────
-- MOOVENTURES — Supabase Database Setup
-- Run this entire file in Supabase SQL Editor
-- ─────────────────────────────────────────────

-- 1. PROFILES (one per user)
create table profiles (
  id uuid references auth.users on delete cascade primary key,
  name text,
  email text,
  moo_code text unique,
  created_at timestamptz default now()
);
alter table profiles enable row level security;
create policy "Users can read own profile" on profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);
create policy "Users can insert own profile" on profiles for insert with check (auth.uid() = id);
create policy "Users can read other profiles for buddy search" on profiles for select using (true);

-- 2. TRIPS
create table trips (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references profiles(id) on delete cascade,
  city text not null,
  country text,
  flag text,
  lat float,
  lon float,
  from_city text,
  from_lat  float,
  from_lon  float,
  date_from date,
  date_to date,
  transport text,
  distance_km int default 0,
  buddies text[] default '{}',
  notes text,
  created_at timestamptz default now()
);
alter table trips enable row level security;
-- Explicit per-operation policies: FOR ALL USING without WITH CHECK silently drops
-- INSERTs instead of returning an error in some Supabase versions.
create policy "Users can select own trips"  on trips for select using      (auth.uid() = user_id);
create policy "Users can insert own trips"  on trips for insert with check  (auth.uid() = user_id);
create policy "Users can update own trips"  on trips for update using       (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete own trips"  on trips for delete using       (auth.uid() = user_id);

-- 3. MESSAGES (herd chat)
create table messages (
  id uuid default gen_random_uuid() primary key,
  trip_id uuid references trips(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  user_name text,
  content text,
  image_url text,
  created_at timestamptz default now()
);
alter table messages enable row level security;
create policy "Trip members can read messages" on messages for select using (
  exists (select 1 from trips where trips.id = messages.trip_id and trips.user_id = auth.uid())
);
create policy "Users can insert messages" on messages for insert with check (auth.uid() = user_id);

-- 4. BUDDIES (mutual connections)
create table buddies (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references profiles(id) on delete cascade,
  buddy_id uuid references profiles(id) on delete cascade,
  created_at timestamptz default now(),
  unique(user_id, buddy_id)
);
alter table buddies enable row level security;
create policy "Users can select own buddies" on buddies for select using      (auth.uid() = user_id);
create policy "Users can insert own buddies" on buddies for insert with check  (auth.uid() = user_id);
create policy "Users can delete own buddies" on buddies for delete using       (auth.uid() = user_id);

-- 5. ROUTES (city routes)
create table routes (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references profiles(id) on delete cascade,
  name text,
  waypoints text[] default '{}',
  distance_km text,
  created_at timestamptz default now()
);
alter table routes enable row level security;
create policy "Users can select own routes" on routes for select using      (auth.uid() = user_id);
create policy "Users can insert own routes" on routes for insert with check  (auth.uid() = user_id);
create policy "Users can update own routes" on routes for update using       (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete own routes" on routes for delete using       (auth.uid() = user_id);

-- 6. SERENDIPITY connections
create table serendipity (
  id uuid default gen_random_uuid() primary key,
  from_id uuid references profiles(id) on delete cascade,
  to_id uuid references profiles(id) on delete cascade,
  status text default 'pending', -- pending, accepted, declined
  shared_fields text[] default '{"name"}',
  created_at timestamptz default now(),
  unique(from_id, to_id)
);
alter table serendipity enable row level security;
create policy "Users see own serendipity" on serendipity for select using (auth.uid() = from_id or auth.uid() = to_id);
create policy "Users create serendipity" on serendipity for insert with check (auth.uid() = from_id);
create policy "Users update serendipity" on serendipity for update using (auth.uid() = to_id);

-- 7. Enable realtime for chat
alter publication supabase_realtime add table messages;

-- 8. TRIGGER — auto-create a profile row on every new signup.
-- Runs server-side so it fires even if the client-side upsert fails.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, email, moo_code)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email,
    'MOO-' || upper(substr(md5(gen_random_uuid()::text), 1, 4))
           || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 2))
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 9. GRANTS — allow the authenticated role to read/write every table.
-- RLS policies control which rows; grants control whether the role can
-- touch the table at all. Without these, every query returns 403.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on table trips       to authenticated;
grant select, insert, update, delete on table profiles    to authenticated;
grant select, insert, update, delete on table messages    to authenticated;
grant select, insert, update, delete on table buddies     to authenticated;
grant select, insert, update, delete on table routes      to authenticated;
grant select, insert, update, delete on table serendipity to authenticated;
grant select on table profiles to anon;

-- ─────────────────────────────────────────────
-- MIGRATION — run this block if you already ran
-- the setup above and the trip save is broken.
-- In Supabase SQL Editor → New query → paste & Run.
-- ─────────────────────────────────────────────

-- Fix trips: drop the broken FOR ALL USING policy and replace with
-- explicit INSERT/WITH CHECK so Supabase doesn't silently drop inserts.
drop policy if exists "Users manage own trips"  on trips;
drop policy if exists "Users can select own trips" on trips;
drop policy if exists "Users can insert own trips" on trips;
drop policy if exists "Users can update own trips" on trips;
drop policy if exists "Users can delete own trips" on trips;
create policy "Users can select own trips"  on trips for select using      (auth.uid() = user_id);
create policy "Users can insert own trips"  on trips for insert with check  (auth.uid() = user_id);
create policy "Users can update own trips"  on trips for update using       (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete own trips"  on trips for delete using       (auth.uid() = user_id);

-- Fix buddies
drop policy if exists "Users manage own buddies"    on buddies;
drop policy if exists "Users can select own buddies" on buddies;
drop policy if exists "Users can insert own buddies" on buddies;
drop policy if exists "Users can delete own buddies" on buddies;
create policy "Users can select own buddies" on buddies for select using      (auth.uid() = user_id);
create policy "Users can insert own buddies" on buddies for insert with check  (auth.uid() = user_id);
create policy "Users can delete own buddies" on buddies for delete using       (auth.uid() = user_id);

-- Fix routes
drop policy if exists "Users manage own routes"    on routes;
drop policy if exists "Users can select own routes" on routes;
drop policy if exists "Users can insert own routes" on routes;
drop policy if exists "Users can update own routes" on routes;
drop policy if exists "Users can delete own routes" on routes;
create policy "Users can select own routes" on routes for select using      (auth.uid() = user_id);
create policy "Users can insert own routes" on routes for insert with check  (auth.uid() = user_id);
create policy "Users can update own routes" on routes for update using       (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete own routes" on routes for delete using       (auth.uid() = user_id);

-- Add departure city columns to trips
alter table trips add column if not exists from_city text;
alter table trips add column if not exists from_lat  float;
alter table trips add column if not exists from_lon  float;
