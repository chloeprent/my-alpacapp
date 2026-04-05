-- Weekly payroll summary — Mondays at 9:15 AM Central
-- Calls the weekly-payroll-summary edge function which generates
-- per-associate payroll summaries and sends them for admin approval.
SELECT cron.schedule(
  'weekly-payroll-summary',
  '15 14 * * 1',  -- 14:15 UTC = 9:15 AM Central (CDT)
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/weekly-payroll-summary',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
