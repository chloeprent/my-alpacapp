-- Unified lighting model for Home Assistant primary control plane.
-- Adds logical lighting groups + backend targets and HA entity cache.

begin;

create table if not exists public.home_assistant_config (
  id integer primary key default 1 check (id = 1),
  is_active boolean not null default true,
  test_mode boolean not null default false,
  use_fallbacks boolean not null default true,
  last_synced_at timestamptz,
  last_error text,
  notes text,
  updated_at timestamptz not null default now()
);

insert into public.home_assistant_config (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.lighting_groups (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  area text,
  display_order integer not null default 0,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lighting_group_targets (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.lighting_groups(id) on delete cascade,
  backend text not null check (backend in ('home_assistant', 'wiz_proxy', 'govee_cloud')),
  target_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, backend, target_id)
);

create table if not exists public.home_assistant_entities (
  entity_id text primary key,
  domain text,
  friendly_name text,
  area_name text,
  capabilities jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  last_seen_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.home_assistant_config enable row level security;
alter table public.lighting_groups enable row level security;
alter table public.lighting_group_targets enable row level security;
alter table public.home_assistant_entities enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'home_assistant_config'
      and policyname = 'home_assistant_config_authenticated_read'
  ) then
    create policy home_assistant_config_authenticated_read
      on public.home_assistant_config
      for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'lighting_groups'
      and policyname = 'lighting_groups_authenticated_read'
  ) then
    create policy lighting_groups_authenticated_read
      on public.lighting_groups
      for select
      to authenticated
      using (is_active = true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'lighting_group_targets'
      and policyname = 'lighting_group_targets_authenticated_read'
  ) then
    create policy lighting_group_targets_authenticated_read
      on public.lighting_group_targets
      for select
      to authenticated
      using (is_active = true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'home_assistant_entities'
      and policyname = 'home_assistant_entities_authenticated_read'
  ) then
    create policy home_assistant_entities_authenticated_read
      on public.home_assistant_entities
      for select
      to authenticated
      using (is_active = true);
  end if;
end $$;

-- Seed logical groups from alexa_room_targets when available.
insert into public.lighting_groups (key, name, area, display_order, is_active, notes)
select
  art.room_key as key,
  coalesce(nullif(art.room_name, ''), initcap(replace(art.room_key, '_', ' '))) as name,
  initcap(replace(art.room_key, '_', ' ')) as area,
  row_number() over (order by art.room_key) as display_order,
  art.is_active,
  'Seeded from alexa_room_targets'
from public.alexa_room_targets art
on conflict (key) do update
set
  name = excluded.name,
  is_active = excluded.is_active,
  updated_at = now();

-- Seed WiZ fallback targets from existing room mappings.
insert into public.lighting_group_targets (group_id, backend, target_id, metadata, is_active)
select
  lg.id,
  'wiz_proxy',
  wiz_ip,
  '{}'::jsonb,
  true
from public.alexa_room_targets art
join public.lighting_groups lg on lg.key = art.room_key
cross join lateral unnest(coalesce(art.wiz_ips, '{}'::text[])) as wiz_ip
on conflict (group_id, backend, target_id) do nothing;

-- Seed Govee fallback targets from existing room mappings.
insert into public.lighting_group_targets (group_id, backend, target_id, metadata, is_active)
select
  lg.id,
  'govee_cloud',
  govee_group_id,
  jsonb_build_object('sku', 'SameModeGroup'),
  true
from public.alexa_room_targets art
join public.lighting_groups lg on lg.key = art.room_key
cross join lateral unnest(coalesce(art.govee_group_ids, '{}'::text[])) as govee_group_id
on conflict (group_id, backend, target_id) do nothing;

commit;
