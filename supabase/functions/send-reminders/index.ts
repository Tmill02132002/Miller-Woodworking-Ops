// supabase/functions/send-reminders/index.ts
//
// Phase 5 — Edge Function invoked by pg_cron every 5 minutes.
// Walks tasks that have a reminder set, checks whether the reminder time has
// passed in the user's timezone, and if so sends a Pushover notification and
// stamps notified_at so we don't double-fire.
//
// Reminder offset semantics (chosen 2026-04-30):
//   '1h' — 1 hour before deadline+time. Requires deadline_time. If no time, skip.
//   '1d' — 1 day before. If deadline_time set, fire at that time the day prior.
//          If not set, fire at 7 AM Pacific the day prior.
//   '1w' — 1 week before, same rules as '1d'.
//
// The function is idempotent: a task whose notified_at is non-null is skipped.
// Resetting reminder_offset, deadline, or deadline_time clears notified_at on
// the client so the reminder will re-fire if the user re-arms it.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const DEFAULT_TIMEZONE = 'America/Los_Angeles';
const DEFAULT_MORNING_HOUR = 7; // for tasks with no deadline_time

// Get current Y/M/D/H/M as observed in a given timezone.
function nowInTz(tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value, 10);
  let h = get('hour');
  if (h === 24) h = 0; // some platforms emit 24 instead of 00
  return { y: get('year'), m: get('month'), d: get('day'), h, mi: get('minute') };
}

// Compare a target wall-clock time against "now in tz". Returns true if target <= now.
function targetHasPast(target: { date: string; hour: number; minute: number }, tz: string) {
  const now = nowInTz(tz);
  const [ty, tm, td] = target.date.split('-').map(Number);
  if (ty !== now.y) return ty < now.y;
  if (tm !== now.m) return tm < now.m;
  if (td !== now.d) return td < now.d;
  if (target.hour !== now.h) return target.hour < now.h;
  return target.minute <= now.mi;
}

// Add `days` to a YYYY-MM-DD string. Uses UTC math which is safe for date-only.
function shiftDate(iso: string, days: number) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface Task {
  id: string;
  text: string;
  deadline: string;
  deadline_time: string | null;
  reminder_offset: string;
  job_id: string;
}

function reminderTarget(task: Task): { date: string; hour: number; minute: number } | null {
  const off = task.reminder_offset;
  if (!off) return null;

  const time = task.deadline_time || '';
  const [hh, mm] = time.split(':').map(Number);
  const hasTime = !isNaN(hh);

  if (off === '1h') {
    if (!hasTime) return null;
    let h = hh - 1;
    let date = task.deadline;
    if (h < 0) { h += 24; date = shiftDate(task.deadline, -1); }
    return { date, hour: h, minute: mm };
  }
  if (off === '1d') {
    const date = shiftDate(task.deadline, -1);
    return hasTime
      ? { date, hour: hh, minute: mm }
      : { date, hour: DEFAULT_MORNING_HOUR, minute: 0 };
  }
  if (off === '1w') {
    const date = shiftDate(task.deadline, -7);
    return hasTime
      ? { date, hour: hh, minute: mm }
      : { date, hour: DEFAULT_MORNING_HOUR, minute: 0 };
  }
  return null;
}

async function sendPushover(token: string, user: string, title: string, message: string) {
  const body = new URLSearchParams({ token, user, title, message });
  const resp = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await resp.json().catch(() => ({} as any));
  if (resp.ok && json.status === 1) return { ok: true as const };
  const errMsg = (json.errors || []).join('; ') || `HTTP ${resp.status}`;
  return { ok: false as const, error: errMsg };
}

async function logEntry(userId: string, taskId: string | null, status: 'sent' | 'failed', errorMessage: string | null) {
  await supabase.from('notification_log').insert({
    user_id: userId,
    task_id: taskId,
    kind: 'reminder',
    status,
    error_message: errorMessage,
  });
}

interface UserSettingsRow {
  user_id: string;
  pushover_user_key: string;
  pushover_app_token: string;
  timezone: string | null;
}

async function processUser(s: UserSettingsRow) {
  const tz = s.timezone || DEFAULT_TIMEZONE;

  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('id, text, deadline, deadline_time, reminder_offset, notified_at, job_id')
    .eq('user_id', s.user_id)
    .eq('done', false)
    .neq('reminder_offset', '')
    .is('notified_at', null);

  if (error) throw error;
  if (!tasks || tasks.length === 0) return { sent: 0, skipped: 0 };

  const jobIds = [...new Set(tasks.map(t => t.job_id))];
  const { data: jobs } = await supabase.from('jobs').select('id, name').in('id', jobIds);
  const jobMap = new Map((jobs || []).map(j => [j.id as string, j.name as string]));

  let sent = 0;
  let skipped = 0;

  for (const task of tasks as Task[]) {
    if (!task.deadline) { skipped++; continue; }
    const target = reminderTarget(task);
    if (!target) { skipped++; continue; }
    if (!targetHasPast(target, tz)) { skipped++; continue; }

    const jobName = jobMap.get(task.job_id) || 'Unknown job';
    const message = `${task.text} · ${jobName}`;

    try {
      const r = await sendPushover(s.pushover_app_token, s.pushover_user_key, 'Miller Ops', message);
      if (r.ok) {
        await supabase
          .from('tasks')
          .update({ notified_at: new Date().toISOString() })
          .eq('id', task.id);
        await logEntry(s.user_id, task.id, 'sent', null);
        sent++;
      } else {
        await logEntry(s.user_id, task.id, 'failed', r.error || 'unknown');
      }
    } catch (e) {
      await logEntry(s.user_id, task.id, 'failed', String(e));
    }
  }

  return { sent, skipped };
}

Deno.serve(async (_req) => {
  try {
    const { data: settings, error } = await supabase
      .from('user_settings')
      .select('user_id, pushover_user_key, pushover_app_token, timezone')
      .not('pushover_user_key', 'is', null)
      .not('pushover_app_token', 'is', null);

    if (error) throw error;

    let totalSent = 0;
    let totalSkipped = 0;

    for (const s of (settings as UserSettingsRow[]) || []) {
      try {
        const r = await processUser(s);
        totalSent += r.sent;
        totalSkipped += r.skipped;
      } catch (e) {
        console.error(`User ${s.user_id} failed:`, e);
        await logEntry(s.user_id, null, 'failed', String(e));
      }
    }

    return new Response(
      JSON.stringify({ ok: true, users: (settings || []).length, sent: totalSent, skipped: totalSkipped }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    console.error('send-reminders crashed:', e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
