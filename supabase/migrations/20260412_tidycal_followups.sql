-- TidyCal integration + follow-up sequence system for warm leads
-- Adds booking link tracking, follow-up cadence, and sequence state

-- ── Add TidyCal + follow-up columns to contacts ──
alter table swoon_crm_contacts
  add column if not exists tidycal_booking_url  text,              -- Their specific TidyCal booking page URL
  add column if not exists tidycal_event_id     text,              -- TidyCal event/booking ID
  add column if not exists tidycal_event_type   text,              -- e.g. "discovery-call", "follow-up"
  add column if not exists call_scheduled_at     timestamptz,      -- When the call is scheduled for

  -- Follow-up sequence tracking
  add column if not exists follow_up_sequence    text,             -- Which sequence they're in
  add column if not exists follow_up_step        integer default 0,-- Current step in the sequence (0 = not started)
  add column if not exists follow_up_started_at  timestamptz,      -- When sequence began
  add column if not exists follow_up_paused      boolean default false, -- Pause auto follow-ups
  add column if not exists last_follow_up_at     timestamptz,      -- When last follow-up was sent
  add column if not exists follow_up_count       integer default 0;-- Total follow-ups sent

-- Allow 'tidycal' and 'kit' as sources
alter table swoon_crm_contacts drop constraint if exists swoon_crm_contacts_source_check;
alter table swoon_crm_contacts
  add constraint swoon_crm_contacts_source_check
  check (source in ('instagram', 'manychat', 'reddit', 'referral', 'kit', 'tidycal', 'website', 'other'));

-- Add new activity types for TidyCal + follow-ups
alter table swoon_crm_activity drop constraint if exists swoon_crm_activity_activity_type_check;
alter table swoon_crm_activity
  add constraint swoon_crm_activity_activity_type_check
  check (activity_type in (
    'dm_received', 'dm_sent', 'lead_magnet', 'keyword_trigger',
    'call_booked', 'call_completed', 'became_client',
    'follow_up', 'stage_change', 'note',
    -- New types
    'tidycal_booked',    -- Booked via TidyCal
    'tidycal_cancelled', -- Cancelled TidyCal booking
    'tidycal_rescheduled', -- Rescheduled TidyCal booking
    'booking_link_sent', -- Booking link shared with lead
    'follow_up_email',   -- Automated follow-up email sent
    'follow_up_dm'       -- Follow-up DM sent
  ));

-- ── Follow-up sequence templates ──
-- Defines the cadence and messaging for each pipeline stage
create table if not exists swoon_follow_up_sequences (
  id              bigint primary key generated always as identity,
  name            text not null unique,            -- e.g. "post_lead_magnet", "post_conversation", "post_no_show"
  stage           text not null,                   -- Which pipeline stage this applies to
  description     text,                            -- What this sequence does
  steps           jsonb not null default '[]',     -- Array of step objects (see below)
  is_active       boolean default true,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- Steps JSONB structure:
-- [
--   { "day": 1, "type": "dm", "template": "Hey {name}! Did you get a chance to check out the guide?..." },
--   { "day": 3, "type": "dm", "template": "Just wanted to follow up — any questions about..." },
--   { "day": 7, "type": "dm", "template": "I know life gets busy! If you're still thinking about..." },
--   { "day": 14, "type": "email", "template": "...", "subject": "..." }
-- ]

-- RLS
alter table swoon_follow_up_sequences enable row level security;
create policy "Authenticated users can manage follow-up sequences"
  on swoon_follow_up_sequences for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- ── Seed default follow-up sequences ──
insert into swoon_follow_up_sequences (name, stage, description, steps) values
(
  'post_lead_magnet',
  'lead_magnet_sent',
  'Follow up after someone downloads the lead magnet',
  '[
    {"day": 1, "type": "dm", "template": "Hey {name}! Hope you''re enjoying the guide. What stood out to you the most?"},
    {"day": 3, "type": "dm", "template": "Quick question — have you had a chance to try any of the tips from the guide? Would love to hear how it''s going!"},
    {"day": 7, "type": "dm", "template": "Hey {name}, I''ve been thinking about what you might be going through. A lot of people in your situation find it really helpful to talk it through — would you be open to a free discovery call? {booking_link}"},
    {"day": 14, "type": "dm", "template": "Just circling back one more time — no pressure at all! If you ever want to chat about what''s on your mind, my calendar is always open: {booking_link}"}
  ]'::jsonb
),
(
  'post_conversation',
  'in_conversation',
  'Nurture leads who are chatting but haven''t booked yet',
  '[
    {"day": 2, "type": "dm", "template": "Hey {name}! I really enjoyed our conversation. I think I could really help you with this — want to hop on a quick call? {booking_link}"},
    {"day": 5, "type": "dm", "template": "Hey! Just wanted to check in. I know it can feel like a big step, but the call is totally no-pressure — just a chance to see if we''re a good fit. {booking_link}"},
    {"day": 10, "type": "dm", "template": "Thinking of you, {name}! If the timing isn''t right, totally get it. But if anything changes, I''m here: {booking_link}"}
  ]'::jsonb
),
(
  'pre_call_reminder',
  'call_booked',
  'Reminders before a scheduled discovery call',
  '[
    {"day": -1, "type": "dm", "template": "Hey {name}! Just a friendly reminder — we have our call tomorrow. So excited to chat with you!"},
    {"day": 0, "type": "dm", "template": "See you today, {name}! Here''s the link in case you need it: {booking_link}. Can''t wait to connect!"}
  ]'::jsonb
),
(
  'post_no_show',
  'call_booked',
  'Follow up when someone no-shows their call',
  '[
    {"day": 1, "type": "dm", "template": "Hey {name}! Looks like we missed each other today — no worries at all! Life happens. Want to reschedule? {booking_link}"},
    {"day": 4, "type": "dm", "template": "Hey! Just wanted to follow up — I''d still love to chat whenever you''re ready. Here''s my calendar: {booking_link}"},
    {"day": 10, "type": "dm", "template": "Hi {name}, just one last check-in. Totally understand if the timing isn''t right — but if you change your mind, I''m here! {booking_link}"}
  ]'::jsonb
),
(
  'post_call_nurture',
  'call_booked',
  'Follow up after a discovery call if they haven''t signed up',
  '[
    {"day": 1, "type": "dm", "template": "So great chatting with you today, {name}! Let me know if you have any questions about what we discussed."},
    {"day": 3, "type": "dm", "template": "Hey {name}! Have you had a chance to think about what we talked about? Happy to answer any questions."},
    {"day": 7, "type": "dm", "template": "Hi {name}! Just checking in — I know it''s a big decision. No rush, but I did want to mention I only have a few spots open this month."},
    {"day": 14, "type": "email", "subject": "Thinking of you, {name}", "template": "Hey {name},\\n\\nJust wanted to reach out and see how you''re doing. I really enjoyed our conversation and I think we could do great work together.\\n\\nIf you''re ready to take the next step, I have a few spots open this month. Just reply to this email or book a follow-up call: {booking_link}\\n\\nRooting for you!\\nChloe"}
  ]'::jsonb
)
on conflict (name) do nothing;

-- Index for follow-up queries
create index if not exists idx_swoon_crm_follow_up_sequence
  on swoon_crm_contacts (follow_up_sequence, follow_up_step)
  where follow_up_sequence is not null and not follow_up_paused;

create index if not exists idx_swoon_crm_call_scheduled
  on swoon_crm_contacts (call_scheduled_at)
  where call_scheduled_at is not null;
