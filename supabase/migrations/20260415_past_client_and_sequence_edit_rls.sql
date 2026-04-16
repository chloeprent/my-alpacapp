-- Allow the new "past_client" pipeline stage on swoon_crm_contacts
-- (the original CHECK constraint only allowed new_lead, lead_magnet_sent,
-- in_conversation, call_booked, client, cold)
ALTER TABLE swoon_crm_contacts DROP CONSTRAINT IF EXISTS swoon_crm_contacts_stage_check;
ALTER TABLE swoon_crm_contacts ADD CONSTRAINT swoon_crm_contacts_stage_check
  CHECK (stage = ANY (ARRAY[
    'new_lead'::text,
    'lead_magnet_sent'::text,
    'in_conversation'::text,
    'call_booked'::text,
    'client'::text,
    'past_client'::text,
    'cold'::text
  ]));

-- Allow editing follow-up sequence message templates from the browser (via anon key)
-- The previous migration restricted swoon_follow_up_sequences to authenticated users only;
-- a public SELECT policy was added later. This adds the matching UPDATE/INSERT/DELETE
-- so the "Edit Sequences" button in crm.html can save changes without a login.

DROP POLICY IF EXISTS "Public manage sequences" ON swoon_follow_up_sequences;
CREATE POLICY "Public manage sequences"
  ON swoon_follow_up_sequences
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Seed the past_client_nurture sequence if it doesn't already exist
-- (idempotent via ON CONFLICT on the unique name column)
INSERT INTO swoon_follow_up_sequences (name, stage, description, steps, is_active)
VALUES (
  'past_client_nurture',
  'past_client',
  'Stay in touch with past clients, ask for testimonials & referrals',
  '[
    {"day": 14, "type": "dm", "template": "Hey {name}! 💛 Just checking in — it''s been a couple weeks since we wrapped up and I''ve been thinking about you. How are things going? Any wins or curly moments you want to share? No agenda, just genuinely curious how you''re doing."},
    {"day": 30, "type": "dm", "template": "Hey {name}! One month in — how are things landing? If any of our work has made a real difference for you, I''d LOVE to hear about it. And if you''d ever be open to sharing a short testimonial (even just a sentence or two), it would mean the world. No pressure at all 💛"},
    {"day": 60, "type": "dm", "template": "Hi {name}! Thinking of you today. If you know anyone who''s where you were a few months ago — wondering, questioning, scared to open up the conversation with their partner — I''d be so grateful if you pointed them my way. Here''s my booking link if helpful: {booking_link} 💛"},
    {"day": 120, "type": "dm", "template": "Hey {name}! It''s been a few months — how''s life? Still holding space for everything you built during our time together? I love hearing from past clients, so if anything''s come up, good or hard, feel free to reach out anytime."},
    {"day": 180, "type": "email", "subject": "Thinking of you, {name} — a 6-month check-in", "template": "Hi {name},\n\nIt''s been about six months since we worked together, and I wanted to check in properly. Relationships shift in seasons — sometimes what you learned 6 months ago lands completely differently now.\n\nA few things I''d love to hear:\n• What''s working beautifully right now?\n• What still feels tender or unresolved?\n• Is there anyone in your life right now who''d benefit from this work?\n\nIf you ever want a tune-up session or just a conversation, my calendar is always open: {booking_link}\n\nWith love,\nChloe 💛"},
    {"day": 365, "type": "dm", "template": "Hey {name}! A year on from our work together — that''s wild 💛 I hope you''re proud of how far you''ve come. Would love to hear a quick update if you''re up for it. And if this work would help anyone in your circle, I''d be honoured by a referral."}
  ]'::jsonb,
  true
)
ON CONFLICT (name) DO NOTHING;
