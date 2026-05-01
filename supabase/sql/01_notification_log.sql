-- Phase 5: notification_log table
-- Audit trail for every push attempt (sent or failed) so we can debug
-- why something didn't fire without re-reading function logs.
--
-- Run this in Supabase SQL Editor before deploying the Edge Functions.

CREATE TABLE IF NOT EXISTS notification_log (
  id            bigserial PRIMARY KEY,
  user_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id       text,
  kind          text NOT NULL,         -- 'reminder' or 'summary'
  status        text NOT NULL,         -- 'sent' or 'failed'
  error_message text,
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

-- Users can read their own log rows (for an in-app history panel later).
CREATE POLICY "Users view own log"
  ON notification_log
  FOR SELECT
  USING (auth.uid() = user_id);

-- The Edge Functions run with the service_role key, which bypasses RLS,
-- so no INSERT policy is required for writes.

CREATE INDEX IF NOT EXISTS idx_notification_log_user_created
  ON notification_log(user_id, created_at DESC);
