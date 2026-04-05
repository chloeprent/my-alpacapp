-- Event notification subscriptions
-- Generic system: subscribe email recipients to arbitrary database events.
-- Triggers call the event-notify edge function which matches subscriptions and sends emails.

-- ─── Table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What event to watch: '<table>.<operation>' e.g. 'time_entries.insert', 'time_entries.update'
  event text NOT NULL,
  -- Optional JSONB filters — matched against the NEW record's columns
  -- e.g. {"associate_id": "04b48bfc-..."} to only fire for a specific associate
  filters jsonb NOT NULL DEFAULT '{}',
  -- Who to notify
  notify_emails text[] NOT NULL,
  -- Human-readable label
  label text,
  -- Optional: only fire when specific columns change (UPDATE only)
  -- e.g. ["status", "clock_out"] — null means fire on any change
  watch_columns text[],
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS: admin-only
ALTER TABLE notification_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access on notification_subscriptions"
  ON notification_subscriptions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM app_users au
      WHERE au.id = auth.uid()
        AND au.role IN ('admin', 'owner')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM app_users au
      WHERE au.id = auth.uid()
        AND au.role IN ('admin', 'owner')
    )
  );

-- Service role bypass
CREATE POLICY "Service role bypass on notification_subscriptions"
  ON notification_subscriptions
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── Trigger function ──────────────────────────────────────────────────
-- Generic: attach to any table. Sends event payload to edge function.
CREATE OR REPLACE FUNCTION notify_event_subscribers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  payload jsonb;
BEGIN
  payload := jsonb_build_object(
    'event', TG_TABLE_NAME || '.' || lower(TG_OP),
    'table', TG_TABLE_NAME,
    'operation', lower(TG_OP),
    'record', to_jsonb(NEW),
    'old_record', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
    'fired_at', now()
  );

  -- Fire-and-forget HTTP call to the event-notify edge function
  PERFORM net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/event-notify',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := payload
  );

  RETURN NEW;
END;
$$;

-- ─── Attach to time_entries ────────────────────────────────────────────
CREATE TRIGGER time_entries_notify_event
  AFTER INSERT OR UPDATE ON time_entries
  FOR EACH ROW
  EXECUTE FUNCTION notify_event_subscribers();

-- ─── Seed: Justin Gilbertson hours → Jon Sheppard + Rahul Sonnad ──────
INSERT INTO notification_subscriptions (event, filters, notify_emails, label, watch_columns)
VALUES
  -- Notify on clock-in (new time entry)
  (
    'time_entries.insert',
    '{"associate_id": "04b48bfc-07d8-4628-90ba-655120e07eaf"}'::jsonb,
    ARRAY['sheppardsustainable@gmail.com', 'rahulioson@gmail.com'],
    'Justin Gilbertson clock-in → Jon & Rahul',
    NULL
  ),
  -- Notify on clock-out (status changes to completed) or edits
  (
    'time_entries.update',
    '{"associate_id": "04b48bfc-07d8-4628-90ba-655120e07eaf"}'::jsonb,
    ARRAY['sheppardsustainable@gmail.com', 'rahulioson@gmail.com'],
    'Justin Gilbertson clock-out/edit → Jon & Rahul',
    ARRAY['status', 'clock_out', 'duration_minutes']
  );
