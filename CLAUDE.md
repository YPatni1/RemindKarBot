# RemindKar — Project CLAUDE.md

## What This Is
Telegram bot (RemindKar) — personal AI memory and commitment tracker. Users send text/voice in English, Hindi, Hinglish, or Marathi. Bot parses intent, stores tasks/reminders/notes, sends daily digests and time-based reminders. Supports multi-task messages (voice or text with multiple items parsed into separate entries).

## Stack
- **Runtime:** Supabase Edge Functions (Deno/TypeScript)
- **AI:** Gemini 2.5 Flash for NLU parsing, text-embedding-004 for vector embeddings (NOT 2.0 — deprecated)
- **DB:** Supabase PostgreSQL + pgvector (tables: `users`, `memories`, `user_sessions`, `conversation_logs`, `feedback`, `archived_users`, `archived_memories`, `archived_user_sessions`, `archived_conversation_logs`)
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
      database.ts               # Supabase client + CRUD + semantic search + sessions
      gemini.ts                 # Gemini REST API (parse + transcribe + embeddings)
      formatters.ts             # Message formatting
  migrations/
    001_initial_schema.sql      # Tables, indexes, RLS
    002_cron_jobs.sql           # pg_cron schedules
    003_pgvector_sessions.sql   # pgvector extension, embeddings column, match_memories RPC, user_sessions table
    004_conversation_history.sql # conversation_history column on user_sessions
    005_conversation_logs.sql    # conversation_logs table for observability
    006_audit_tables.sql         # Archive tables + BEFORE DELETE triggers for buildathon data retention
    007_logging_improvements.sql  # bot_response, session_id, archived_conversation_logs, callback intents
    008_feedback.sql               # User feedback collection table
```

## Supported Intents
task, reminder, event, birthday, note, query, greeting, done, reschedule, delete, edit, status, casual, unknown

## Deployment
```bash
npx supabase functions deploy telegram-webhook
npx supabase functions deploy send-reminders
npx supabase functions deploy send-digest
npx supabase db push --linked   # Apply migrations to remote DB
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
- Multi-task: parseMessage returns GeminiParsedResponse[] — all handlers loop over the array
- Resilience order: save task > generate embedding > save session. Embedding/session failures must never crash task storage.
- Session context (`user_sessions`) tracks last shown list IDs — enables number references ("delete 2") against any list, not just pending. 30-min TTL.
- Semantic search: `findPendingByDescription` / `findMemories` try pgvector cosine similarity first, ILIKE fallback for pre-embedding data.
- `saveSession` wrapper (not raw `upsertSession`) must be used in index.ts — it catches errors silently.
- Conversation context: `parseMessage` accepts conversation history (last 3 user+bot pairs from session). Enables follow-ups, pronoun resolution, and progressive date clarification.
- Progressive clarification: tasks saved without due_date set session intent to `awaiting_date`. Next message is first tried as a date follow-up before normal parsing.
- HTML parse mode: all Telegram messages use `parse_mode: "HTML"` (NOT Markdown). Use `escapeHtml()` for user-generated content.
- Unsupported inputs (photos, stickers, documents) get a helpful response instead of silent ignore.
- "delete everything/all" triggers a safety confirmation — deletes memories only, keeps user account (`deleteAllMemories`). `/delete` command triggers full account deletion with confirmation.
- Two delete flows: `confirm_delete_all` = memories only (keeps account), `confirm_account_delete` = full user deletion (cascade). `cancel_delete` callback used for both cancel actions.
- Per-user timezone: captured during onboarding (9 timezone options), stored in `users.timezone`, threaded through Gemini prompt, formatters, digest, reminders, and status. Fallback: `Asia/Kolkata`.
- `TZ_OFFSETS` map duplicated in index.ts, gemini.ts, database.ts — kept in sync manually. Covers India, US, UK, Europe, Asia-Pacific.
- Gemini timezone prompt: `getCurrentDatetime` provides BOTH UTC ISO and local time. Prompt instructs Gemini to add relative offsets ("in 10 min") to UTC directly, and convert absolute local times to UTC by subtracting offset. Prevents the "local time treated as UTC" bug.
- `localHourToUtcDate(year, month, day, localHour, timezone)` helper in index.ts — handles fractional timezone offsets correctly (Date.UTC truncates fractional hours, so we use Math.floor + modulo for minutes).
- Date-filtered queries: Gemini extracts `query_date_start`/`query_date_end` for time-scoped queries ("this week", "last Tuesday"). `getMemoriesByDateRange` filters by `due_date` or `created_at` depending on phrasing. Display uses rawInput, not Gemini's extracted query_text.
- Pending list pagination: `formatPendingList` returns paginated output (10 per page) with "Show more" button. `page:` callback edits existing message in place via `editMessageWithButtons`.
- `editMessageWithButtons` in telegram.ts — edits a message with new text AND inline keyboard (used by pagination).
- send-reminders: looks up user timezone via `getUser` (cached per-invocation) and passes to `formatReminder`/`formatPreReminder`.
- Onboarding digest time: computed from user's selected timezone + pg_cron schedule (3:30 UTC), not hardcoded "9 AM".
- Forward handler saves conversation history (prefixed with `[forwarded]`).
- Conversation logging: `conversation_logs` table captures every interaction (user message, Gemini parsed intents JSON, primary intent, bot action summary, bot response text, session_id, processing time ms, errors, user timezone). `logInteraction` wrapper in index.ts never crashes the main flow. Indexed by telegram_id, intent, errors, time, and session_id.
- `bot_response` column stores the actual message text sent back to the user (populated for text/voice/forward; null for commands/callbacks).
- `session_id` (uuid) groups interactions into conversation sessions. Stored in `user_sessions` (auto-generated on first insert). Text/voice/forward handlers read from session; reused within 30-min TTL, regenerated on expiry.
- Callback `primary_intent` is populated from callback data prefix (e.g., `done`, `snooze`, `tz`, `page`, `consent_yes`). Enables intent analytics across all message types.
- Date-filtered queries run BEFORE pending pattern matching in `handleQuery` — prevents "my tasks for today" from returning all pending items.
- Pre-reminders (`getDuePreReminders`) check `due_date` in a 25-35 min window, NOT `reminder_at` — ensures "Heads up in 30 min" is accurate.
- Audit archive tables: BEFORE DELETE triggers on `users`, `memories`, `user_sessions` auto-copy data to `archived_*` tables. `pg_trigger_depth()` distinguishes CASCADE (`account_cascade`) from direct deletes (`direct`). No app code changes — purely database-level. Preserves evidence of user activity for buildathon demos.
- `archived_conversation_logs`: On user account deletion, a BEFORE DELETE trigger on `users` archives all conversation_logs for that telegram_id, then deletes originals. Ensures full data cleanup on /delete while preserving audit trail.
- `routeParsedIntent` returns `{ summary, response }` — summary is a brief action label (for conversation history), response is the actual bot message text (for logging).
- Feedback collection: `/feedback` command shows category buttons (Bug, Feature, General). User picks category → session intent set to `awaiting_feedback:<category>` → next text message saved to `feedback` table. `/feedback <text>` saves directly as "general". Category stored in `last_intent` string (not `last_shown_ids` which is `uuid[]`).
- `createFeedback` in database.ts inserts to `feedback` table (telegram_id, username, first_name, category, feedback_text).

## Testing
Simulate Telegram webhooks with curl POST to the Edge Function URL. Use fake telegram_id (e.g., 999999999) for test users. Clean up test data after.
