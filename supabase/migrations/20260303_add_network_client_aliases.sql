-- Friendly aliases for router-discovered clients (Alexa/Amazon section).
create table if not exists public.network_client_aliases (
  hostname text primary key,
  friendly_name text not null,
  location text,
  device_type text,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.network_client_aliases enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'network_client_aliases'
      and policyname = 'network_client_aliases_authenticated_read'
  ) then
    create policy network_client_aliases_authenticated_read
      on public.network_client_aliases
      for select
      to authenticated
      using (is_active = true);
  end if;
end $$;

insert into public.network_client_aliases (hostname, friendly_name, device_type, notes)
values
  ('amazon-67f77a339', 'Echo Dot (67f77a339)', 'echo', 'Rename with room when confirmed'),
  ('amazon-7c33ec9c38900cc0', 'Echo Dot (7c33ec9c38900cc0)', 'echo', 'Rename with room when confirmed'),
  ('amazon-14ea528bd', 'Echo Dot (14ea528bd)', 'echo', 'Rename with room when confirmed'),
  ('amazon-20cb70679', 'Echo Dot (20cb70679)', 'echo', 'Rename with room when confirmed'),
  ('amazon-080d0e2f9', 'Echo Dot (080d0e2f9)', 'echo', 'Rename with room when confirmed'),
  ('echoshow-3bf32cb7f1ef46a6', 'Echo Show (3bf32cb7f1ef46a6)', 'echo_show', 'Rename with room when confirmed'),
  ('echoshow-9f2eb6d9d752aab3', 'Echo Show (9f2eb6d9d752aab3)', 'echo_show', 'Rename with room when confirmed'),
  ('amazonplug13a2', 'Amazon Smart Plug', 'smart_plug', null),
  ('blink-device', 'Blink Camera', 'camera', null)
on conflict (hostname) do update
set friendly_name = excluded.friendly_name,
    device_type = excluded.device_type,
    notes = excluded.notes,
    updated_at = now();
