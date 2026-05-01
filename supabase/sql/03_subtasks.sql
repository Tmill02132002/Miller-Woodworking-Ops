-- Subtasks: a subtask is just a task with parent_id set to its parent task's id.
-- Same columns, same RLS, same downstream behavior. ON DELETE CASCADE so
-- removing a parent task removes its subtasks automatically.
--
-- Run this in Supabase SQL Editor before deploying the frontend changes.
-- Idempotent — safe to re-run.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS parent_id text;

-- Add the foreign key only if it doesn't exist yet
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'tasks_parent_id_fkey'
      AND table_name = 'tasks'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_parent_id_fkey
      FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Index so filtering subtasks by parent is fast
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id);
