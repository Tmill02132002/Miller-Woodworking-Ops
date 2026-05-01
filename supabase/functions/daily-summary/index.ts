// supabase/functions/daily-summary/index.ts
//
// Phase 5 — Edge Function invoked by pg_cron weekday mornings.
// Counts each user's overdue and due-today tasks and sends a single Pushover
// summary if either count is non-zero.
//
// Idempotency: only sends once per Pacific calendar day. The cron is scheduled
// to fire at both 14:00 and 15:00 UTC weekdays so that across DST boundaries
// (PDT vs PST) we always have a fire that lands at exactly 7 AM Pacific. The
// function bails early when the current Pacific hour is < 7, and skips when
// `last_daily_summary_at` is already today in Pacific.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const DEFAULT_TIMEZONE = 'America/Los_Angeles';
const SUMMARY_HOUR = 7; // 7 AM Pacific

// "YYYY-MM-DD" in the given timezone.
function todayInTz(tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function dateInTz(when: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(when);
  const get = (t: string) => parts.find(p => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function hourInTz(tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  return h === 24 ? 0 : h;
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

async function logEntry(userId: string, status: 'sent' | 'failed', errorMessage: string | null) {
  await supabase.from('notification_log').insert({
    user_id: userId,
    task_id: null,
    kind: 'summary',
    status,
    error_message: errorMessage,
  });
}

interface SummaryUser {
  user_id: string;
  pushover_user_key: string;
  pushover_app_token: string;
  timezone: string | null;
  daily_summary_enabled: boolean | null;
  last_daily_summary_at: string | null;
}

async function processUser(s: SummaryUser) {
  if (s.daily_summary_enabled === false) return { skipped: 'disabled' };
  const tz = s.timezone || DEFAULT_TIMEZONE;
  const today = todayInTz(tz);

  // Don't send before 7 AM Pacific (DST guard — see file header).
  if (hourInTz(tz) < SUMMARY_HOUR) return { skipped: 'too-early' };

  // Already sent today?
  if (s.last_daily_summary_at) {
    const lastDate = dateInTz(new Date(s.last_daily_summary_at), tz);
    if (lastDate === today) return { skipped: 'already-sent' };
  }

  // Tally
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('deadline')
    .eq('user_id', s.user_id)
    .eq('done', false);

  if (error) throw error;

  let overdue = 0, dueToday = 0;
  for (const t of tasks || []) {
    if (!t.deadline) continue;
    if (t.deadline < today) overdue++;
    else if (t.deadline === today) dueToday++;
  }

  // No work? Stamp last_daily_summary_at anyway so we don't re-poll all day.
  if (overdue === 0 && dueToday === 0) {
    await supabase
      .from('user_settings')
      .update({ last_daily_summary_at: new Date().toISOString() })
      .eq('user_id', s.user_id);
    return { skipped: 'nothing-due' };
  }

  const parts: string[] = [];
  if (overdue > 0)  parts.push(`${overdue} overdue`);
  if (dueToday > 0) parts.push(`${dueToday} due today`);
  const message = parts.join(' · ');

  try {
    const r = await sendPushover(s.pushover_app_token, s.pushover_user_key, 'Miller Ops', message);
    if (r.ok) {
      await supabase
        .from('user_settings')
        .update({ last_daily_summary_at: new Date().toISOString() })
        .eq('user_id', s.user_id);
      await logEntry(s.user_id, 'sent', null);
      return { sent: true, message };
    } else {
      await logEntry(s.user_id, 'failed', r.error || 'unknown');
      return { sent: false, error: r.error };
    }
  } catch (e) {
    await logEntry(s.user_id, 'failed', String(e));
    return { sent: false, error: String(e) };
  }
}

Deno.serve(async (_req) => {
  try {
    const { data: settings, error } = await supabase
      .from('user_settings')
      .select('user_id, pushover_user_key, pushover_app_token, timezone, daily_summary_enabled, last_daily_summary_at')
      .not('pushover_user_key', 'is', null)
      .not('pushover_app_token', 'is', null);

    if (error) throw error;

    const results: any[] = [];
    for (const s of (settings as SummaryUser[]) || []) {
      try {
        const r = await processUser(s);
        results.push({ user: s.user_id, ...r });
      } catch (e) {
        console.error(`User ${s.user_id} failed:`, e);
        await logEntry(s.user_id, 'failed', String(e));
        results.push({ user: s.user_id, error: String(e) });
      }
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('daily-summary crashed:', e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
