-- Phase milestones: mark a phase as a single-date checkpoint that renders
-- as a bullseye marker instead of a bar.  end_date is kept in sync with
-- start_date by the client when is_milestone is true.
alter table schedule_phases
  add column if not exists is_milestone boolean not null default false;
