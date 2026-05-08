-- Schedule phases: hierarchical Gantt phases linked to existing jobs
create table if not exists schedule_phases (
  id           text primary key default gen_random_uuid()::text,
  user_id      uuid not null references auth.users(id) on delete cascade,
  job_id       text not null references jobs(id) on delete cascade,
  parent_id    text references schedule_phases(id) on delete cascade,
  name         text not null default 'New Phase',
  start_date   date,
  end_date     date,
  color        text,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);

alter table schedule_phases enable row level security;

create policy "Users manage own phases"
  on schedule_phases for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index if not exists schedule_phases_job_id_idx on schedule_phases(job_id);
create index if not exists schedule_phases_parent_id_idx on schedule_phases(parent_id);
