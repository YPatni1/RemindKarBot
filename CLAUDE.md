# RemindKar — Project CLAUDE.md

## What This Is
Telegram bot (RemindKar) — personal AI memory and commitment tracker. Users send text/voice in English, Hindi, Hinglish, or Marathi. Bot parses intent, stores tasks/reminders/notes, sends daily digests and time-based reminders.

## Stack
- **Runtime:** Supabase Edge Functions (Deno/TypeScript)
- **AI:** Gemini 2.5 Flash via REST API (NOT 2.0 — deprecated)
- **DB:** Supabase PostgreSQL (tables: `users`, `memories`)
- **Cron:** pg_cron + pg_net (digest at 3:30 UTC, reminders every 5 min)
- **Bot API:** Telegram Bot API via webhooks (NOT polling)

## Project Structure
```
supabase/
  functions/
    telegram-webhook/index.ts   # All user interactions
    send-reminders/index.ts     # Cron: check + send due reminders
    send-digest/index.ts        # Cron: morning digest per user
    _shared/
      types.ts                  # TypeScript interfaces
      telegram.ts               # Telegram Bot API helpers
      database.ts               # Supabase client + CRUD
      gemini.ts                 # Gemini REST API (parse + transcribe)
      formatters.ts             # Message formatting
  migrations/
    001_initial_schema.sql      # Tables, indexes, RLS
    002_cron_jobs.sql           # pg_cron schedules
```

## Deployment
```bash
npx supabase functions deploy telegram-webhook
npx supabase functions deploy send-reminders
npx supabase functions deploy send-digest
```
Use `npx supabase` (not global install — brew fails on macOS 26).

## Env Vars (set via `npx supabase secrets set`)
- TELEGRAM_BOT_TOKEN
- GEMINI_API_KEY
- SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-available in Edge Functions)

## Key Rules
- Always return HTTP 200 from webhook (prevents Telegram retries)
- `verify_jwt = false` for telegram-webhook (Telegram sends unauthenticated POSTs)
- Service role key bypasses RLS — all DB access is server-side
- Gemini model: `gemini-2.5-flash` — do NOT use `gemini-2.0-flash` (404 for new keys)
- Voice pipeline is two-step: transcribe audio → parse transcription text
- Consent gate: block all non-command messages until user consents via /start

## Testing
Simulate Telegram webhooks with curl POST to the Edge Function URL. Use fake telegram_id (e.g., 999999999) for test users. Clean up test data after.
