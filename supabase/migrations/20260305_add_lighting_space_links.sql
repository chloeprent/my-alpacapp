begin;

alter table public.lighting_groups
  add column if not exists space_id uuid references public.spaces(id) on delete set null;

create index if not exists idx_lighting_groups_space_id
  on public.lighting_groups(space_id);

create table if not exists public.home_assistant_entity_space_map (
  id uuid primary key default gen_random_uuid(),
  entity_id text not null references public.home_assistant_entities(entity_id) on delete cascade,
  space_id uuid not null references public.spaces(id) on delete cascade,
  is_primary boolean not null default true,
  source text not null default 'manual',
  confidence numeric,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, space_id)
);

create index if not exists idx_ha_entity_space_map_space_id
  on public.home_assistant_entity_space_map(space_id);

create index if not exists idx_ha_entity_space_map_entity_id
  on public.home_assistant_entity_space_map(entity_id);

alter table public.home_assistant_entity_space_map enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'home_assistant_entity_space_map'
      and policyname = 'ha_entity_space_map_authenticated_read'
  ) then
    create policy ha_entity_space_map_authenticated_read
      on public.home_assistant_entity_space_map
      for select
      to authenticated
      using (is_active = true);
  end if;
end $$;

-- Backfill lighting_groups.space_id by matching known names/keys to spaces.
update public.lighting_groups lg
set
  space_id = s.id,
  updated_at = now()
from public.spaces s
where lg.space_id is null
  and (
    lower(trim(coalesce(s.name, ''))) = lower(trim(coalesce(lg.name, '')))
    or lower(trim(coalesce(s.name, ''))) = lower(trim(coalesce(lg.area, '')))
    or regexp_replace(lower(coalesce(s.name, '')), '[^a-z0-9]+', '_', 'g') = lg.key
  );

-- Seed entity->space links from HA area names where we can match a lighting group.
insert into public.home_assistant_entity_space_map (
  entity_id,
  space_id,
  is_primary,
  source,
  confidence,
  is_active
)
select
  hae.entity_id,
  lg.space_id,
  true,
  'area_name_match',
  0.8,
  true
from public.home_assistant_entities hae
join public.lighting_groups lg
  on lg.space_id is not null
 and lower(trim(coalesce(hae.area_name, ''))) in (
   lower(trim(coalesce(lg.area, ''))),
   lower(trim(coalesce(lg.name, ''))),
   lower(trim(coalesce(lg.key, '')))
 )
on conflict (entity_id, space_id) do update
set
  is_primary = excluded.is_primary,
  source = excluded.source,
  confidence = excluded.confidence,
  is_active = true,
  updated_at = now();

commit;
