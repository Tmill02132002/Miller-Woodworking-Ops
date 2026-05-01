-- Phase 5: pg_cron schedules that invoke the Edge Functions.
--
-- Run this in Supabase SQL Editor AFTER:
--   1. Running 01_notification_log.sql
--   2. Deploying both Edge Functions (send-reminders, daily-summary)
--   3. Replacing the two eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlkZHhoeGNkeHhiZWVwcWNydmFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5MDY5MzUsImV4cCI6MjA5MjQ4MjkzNX0.zVQs9X8iVtXAGvh7_cpQ8h3BZZosGkl7d6XGgyy34j0 placeholders below with your project's
--      anon key (Supabase Dashboard -> Settings -> API -> "anon public").
--
-- The anon key is *intentionally public* (it's already shipped in the
-- frontend's index.html). The Edge Functions themselves use the
-- service_role key from their environment to bypass RLS — the anon key
-- is just used here to authorize pg_cron's call into the function HTTP
-- endpoint.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------------------
-- send-reminders: every 5 minutes
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'send-reminders',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://iddxhxcdxxbeepqcrvap.supabase.co/functions/v1/send-reminders',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlkZHhoeGNkeHhiZWVwcWNydmFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5MDY5MzUsImV4cCI6MjA5MjQ4MjkzNX0.zVQs9X8iVtXAGvh7_cpQ8h3BZZosGkl7d6XGgyy34j0"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ---------------------------------------------------------------------------
-- daily-summary: 7 AM Pacific, weekdays only
--
-- 7 AM Pacific moves between 14:00 UTC (PDT, summer) and 15:00 UTC (PST,
-- winter). We schedule both. The function bails before 7 AM Pacific and
-- bails when last_daily_summary_at is already today, so only one push goes
-- out per Pacific day.
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'daily-summary-pdt',  -- 7 AM Pacific Daylight Time (Mar–Nov)
  '0 14 * * 1-5',
  $$
  SELECT net.http_post(
    url := 'https://iddxhxcdxxbeepqcrvap.supabase.co/functions/v1/daily-summary',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlkZHhoeGNkeHhiZWVwcWNydmFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5MDY5MzUsImV4cCI6MjA5MjQ4MjkzNX0.zVQs9X8iVtXAGvh7_cpQ8h3BZZosGkl7d6XGgyy34j0"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'daily-summary-pst',  -- 7 AM Pacific Standard Time (Nov–Mar)
  '0 15 * * 1-5',
  $$
  SELECT net.http_post(
    url := 'https://iddxhxcdxxbeepqcrvap.supabase.co/functions/v1/daily-summary',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlkZHhoeGNkeHhiZWVwcWNydmFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5MDY5MzUsImV4cCI6MjA5MjQ4MjkzNX0.zVQs9X8iVtXAGvh7_cpQ8h3BZZosGkl7d6XGgyy34j0"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ---------------------------------------------------------------------------
-- To remove later (e.g. while debugging):
--   SELECT cron.unschedule('send-reminders');
--   SELECT cron.unschedule('daily-summary-pdt');
--   SELECT cron.unschedule('daily-summary-pst');
--
-- To check what's scheduled:
--   SELECT * FROM cron.job;
--
-- To check recent runs:
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
-- ---------------------------------------------------------------------------
