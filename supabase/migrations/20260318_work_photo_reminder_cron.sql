-- Work photo reminder batch scan — every 15 minutes
-- Catches entries where the client-side setTimeout didn't fire (tab closed)
-- Checks clock-in entries 15min+ old without "before" photos
-- Checks clock-out entries without "after" photos
SELECT cron.schedule(
  'work-photo-reminder-scan',
  '*/15 * * * *',  -- every 15 minutes
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/work-photo-reminder',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
