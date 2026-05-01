# Phase 5 deploy — five steps, all in the Supabase dashboard

You don't need the Supabase CLI. Everything below is paste-and-click in the web UI.

Total time: ~10 minutes if Pushover keys are already saved.

---

## 1. Create the `notification_log` table

1. Open [Supabase Dashboard](https://supabase.com/dashboard) → your project (`iddxhxcdxxbeepqcrvap`).
2. Left sidebar → **SQL Editor** → **+ New query**.
3. Open `supabase/sql/01_notification_log.sql` from this repo, copy the whole file, paste into the editor.
4. Click **Run** (or press Ctrl+Enter).
5. You should see "Success. No rows returned." in the results pane.

**Verify:** left sidebar → **Table Editor** → you should now see a `notification_log` table.

---

## 2. Deploy the `send-reminders` Edge Function

1. Left sidebar → **Edge Functions** → **Deploy a new function**.
2. Function name: **`send-reminders`** (exact spelling, lowercase, with the hyphen).
3. Verify JWT: **on** (default) is fine — the cron job sends the anon key in the Authorization header.
4. In the editor that opens, **delete** the boilerplate code.
5. Open `supabase/functions/send-reminders/index.ts` from this repo, copy the whole file, paste into the editor.
6. Click **Deploy function**.
7. Wait for the green "deployed successfully" toast.

**Verify:** the function appears in your list with a green dot. Click it → "Test" tab → click **Send request** with the default empty body. You should get a `200` response with body like `{"ok":true,"users":1,"sent":0,"skipped":0}`. (sent=0 is expected — nothing has fired yet because the cron isn't running.)

---

## 3. Deploy the `daily-summary` Edge Function

Same steps as above, but:

- Function name: **`daily-summary`**
- Paste from `supabase/functions/daily-summary/index.ts`

**Verify:** test request returns `{"ok":true,"results":[...]}`. The result for your user will say `skipped: "too-early"` if it's before 7 AM Pacific when you test, or `skipped: "nothing-due"` if you have nothing overdue or due today.

---

## 4. Schedule the cron jobs

1. Get your **anon key**: Dashboard → **Settings** (gear, bottom of sidebar) → **API** → copy the value labeled **"anon public"**. It's a long JWT starting with `eyJ...`.
2. Open `supabase/sql/02_cron.sql` from this repo.
3. **Replace all three** `<ANON_KEY>` placeholders with the actual key you just copied.
4. Paste the modified SQL into the Supabase **SQL Editor** and **Run** it.
5. You should see three success rows (one per `cron.schedule` call).

**Verify:**

```sql
SELECT jobname, schedule, active FROM cron.job;
```

…should show three rows: `send-reminders`, `daily-summary-pdt`, `daily-summary-pst`, all active.

---

## 5. Smoke-test live delivery

1. In the app, create a tiny test task with **today's date + a time about 10 minutes from now**, set the bell to **"1 hour before"**.
   - Wait — that won't fire for 50 minutes. For a faster smoke test, instead:
2. Create a task with **yesterday's date + any time**, set the bell to **"1 day before"**.
   - Reasoning: "1 day before" of yesterday's deadline = the day-before-yesterday. That target time has long since passed, so the cron's next run (within 5 minutes) will fire it.
3. Wait up to 5 minutes. Your phone should buzz with `"<task name> · <job name>"`.
4. Mark the test task done or delete it after.

**If nothing buzzes after 10 minutes:**

```sql
SELECT * FROM cron.job_run_details
WHERE jobname = 'send-reminders'
ORDER BY start_time DESC LIMIT 5;
```

…shows whether the cron actually ran. Then:

```sql
SELECT * FROM notification_log
WHERE user_id = auth.uid()
ORDER BY created_at DESC LIMIT 20;
```

…shows whether the function tried to send and what failed. The `error_message` column will tell you why (most likely: missing keys, expired Pushover application, or a CORS-style network issue from inside the Edge Function — none common).

---

## When something needs to change later

- **Different summary time** (not 7 AM): edit `SUMMARY_HOUR` in `daily-summary/index.ts`, redeploy. Update the cron crons too if you want the function to be invoked at a different UTC time.
- **Different cadence for reminders** (not every 5 min): `SELECT cron.unschedule('send-reminders');` then re-schedule with a new cron expression.
- **Pause everything**: `UPDATE cron.job SET active = false WHERE jobname IN ('send-reminders','daily-summary-pdt','daily-summary-pst');` and reverse with `active = true`.

That's it. The bells in the app now actually ring your phone.
