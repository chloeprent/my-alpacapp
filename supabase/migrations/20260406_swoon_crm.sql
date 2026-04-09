-- Swoon CRM: Track Instagram leads from first DM to paying client
-- Integrates with ManyChat for auto-capturing new leads

-- ── Main contacts table ──
create table if not exists swoon_crm_contacts (
  id            bigint primary key generated always as identity,

  -- Identity
  ig_username   text,                          -- Instagram handle (e.g. @janedoe)
  full_name     text,                          -- Their real name if known
  email         text,                          -- Email if collected
  phone         text,                          -- Phone if collected

  -- Pipeline stage
  stage         text not null default 'new_lead'
                check (stage in (
                  'new_lead',          -- Just followed or DMed
                  'lead_magnet_sent',  -- ManyChat delivered the freebie
                  'in_conversation',   -- Chatting in DMs
                  'call_booked',       -- Scheduled a discovery call
                  'client',            -- Signed up for coaching
                  'cold'               -- Went quiet or said not now
                )),

  -- Source & context
  source        text default 'instagram'       -- instagram, manychat, reddit, referral, other
                check (source in ('instagram', 'manychat', 'reddit', 'referral', 'other')),
  manychat_id   text,                          -- ManyChat subscriber ID
  keyword_used  text,                          -- What keyword they sent (e.g. "GUIDE")

  -- Lead magnet
  lead_magnet_sent    boolean default false,
  lead_magnet_sent_at timestamptz,

  -- Call tracking
  call_booked_at      timestamptz,
  call_completed_at   timestamptz,
  call_notes          text,

  -- Outcome
  became_client_at    timestamptz,
  package_name        text,                    -- e.g. "Swoon Coaching Package"
  package_value       numeric(10,2),           -- e.g. 900.00

  -- Notes & follow-up
  notes               text,                    -- Free-form notes about this person
  next_follow_up      date,                    -- When to follow up next
  is_warm             boolean default true,    -- Still a warm lead?

  -- Timestamps
  first_contact_at    timestamptz default now(),
  last_activity_at    timestamptz default now(),
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- ── Activity log: track every touchpoint ──
create table if not exists swoon_crm_activity (
  id            bigint primary key generated always as identity,
  contact_id    bigint references swoon_crm_contacts(id) on delete cascade,
  activity_type text not null
                check (activity_type in (
                  'dm_received',       -- They DMed you
                  'dm_sent',           -- You DMed them
                  'lead_magnet',       -- Lead magnet delivered
                  'keyword_trigger',   -- ManyChat keyword triggered
                  'call_booked',       -- Call scheduled
                  'call_completed',    -- Call happened
                  'became_client',     -- Converted!
                  'follow_up',         -- You followed up
                  'stage_change',      -- Pipeline stage changed
                  'note'               -- Manual note added
                )),
  description   text,                          -- What happened
  metadata      jsonb default '{}',            -- Extra data (manychat payload, etc.)
  created_at    timestamptz default now()
);

-- Indexes
create index if not exists idx_swoon_crm_stage on swoon_crm_contacts (stage);
create index if not exists idx_swoon_crm_ig on swoon_crm_contacts (ig_username);
create index if not exists idx_swoon_crm_activity_contact on swoon_crm_activity (contact_id);
create index if not exists idx_swoon_crm_follow_up on swoon_crm_contacts (next_follow_up) where next_follow_up is not null;

-- RLS: only authenticated users can access
alter table swoon_crm_contacts enable row level security;
alter table swoon_crm_activity enable row level security;

-- Allow authenticated users full access (you're the only admin)
create policy "Authenticated users can manage CRM contacts"
  on swoon_crm_contacts for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

create policy "Authenticated users can manage CRM activity"
  on swoon_crm_activity for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
