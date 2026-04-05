-- Weekly email compliance audit — Mondays at 9 AM Central
-- Calls the audit-email-compliance edge function which checks all 7 compliance rules
SELECT cron.schedule(
  'audit-email-compliance',
  '0 14 * * 1',  -- 14:00 UTC = 9:00 AM Central (CDT)
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/audit-email-compliance',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
