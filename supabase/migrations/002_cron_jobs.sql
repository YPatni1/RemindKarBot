-- =============================================================
-- RemindKar: Cron Jobs
-- Run AFTER Edge Functions are deployed (needs their URLs)
-- Replace SUPABASE_URL_PLACEHOLDER and SERVICE_ROLE_KEY_PLACEHOLDER
-- with your actual values before running in SQL Editor.
-- =============================================================

-- Enable required extensions
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Daily digest at 9:00 AM IST (3:30 AM UTC)
select cron.schedule(
  'daily-digest',
  '30 3 * * *',
  $$select net.http_post(
    url := 'SUPABASE_URL_PLACEHOLDER/functions/v1/send-digest',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY_PLACEHOLDER", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  )$$
);

-- Reminder check every 5 minutes
select cron.schedule(
  'check-reminders',
  '*/5 * * * *',
  $$select net.http_post(
    url := 'SUPABASE_URL_PLACEHOLDER/functions/v1/send-reminders',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY_PLACEHOLDER", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  )$$
);
