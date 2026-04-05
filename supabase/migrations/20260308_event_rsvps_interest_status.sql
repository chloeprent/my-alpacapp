-- Add 'interest' status for AI-interest email signups (notify me of next session)
-- Already applied via Management API

ALTER TABLE event_rsvps DROP CONSTRAINT IF EXISTS event_rsvps_status_check;
ALTER TABLE event_rsvps ADD CONSTRAINT event_rsvps_status_check
  CHECK (status IN ('confirmed', 'waitlist', 'interest'));
