-- Phase linking: each schedule phase can chain to one predecessor with an
-- optional gap (link_offset_days). When the predecessor's dates change,
-- the successor auto-shifts so the gap stays constant. Cascade is handled
-- in the client; this migration just adds the columns.

alter table schedule_phases
  add column if not exists linked_to text references schedule_phases(id) on delete set null,
  add column if not exists link_offset_days integer not null default 0;

create index if not exists schedule_phases_linked_to_idx on schedule_phases(linked_to);
