-- Event RSVPs (e.g. AI Ninja workshop signups)
-- Anon can insert (public form); staff/admin can select (admin list page)

CREATE TABLE IF NOT EXISTS event_rsvps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  goals TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'waitlist')),
  submitted_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_rsvps_event ON event_rsvps(event);
CREATE INDEX IF NOT EXISTS idx_event_rsvps_submitted_at ON event_rsvps(submitted_at DESC);

ALTER TABLE event_rsvps ENABLE ROW LEVEL SECURITY;

-- Public form: anyone can insert
CREATE POLICY "event_rsvps_anon_insert" ON event_rsvps
  FOR INSERT WITH CHECK (true);

-- Staff/admin can view (for ninja-signups admin page)
CREATE POLICY "event_rsvps_staff_select" ON event_rsvps
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM app_users WHERE auth_user_id = auth.uid() AND role IN ('admin','staff')));

-- If table already existed without status column (e.g. from earlier manual create):
ALTER TABLE event_rsvps ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'confirmed';
