# RemindKar — Project CLAUDE.md

## What This Is
Telegram bot (RemindKar) — personal AI memory and commitment tracker. Users send text/voice in English, Hindi, Hinglish, or Marathi. Bot parses intent, stores tasks/reminders/notes, sends daily digests and time-based reminders. Supports multi-task messages (voice or text with multiple items parsed into separate entries).

## Stack
- **Runtime:** Supabase Edge Functions (Deno/TypeScript)
- **AI:** Gemini 2.5 Flash for NLU parsing, text-embedding-004 for vector embeddings (NOT 2.0 — deprecated)
- **DB:** Supabase PostgreSQL + pgvector (tables: `users`, `memories`, `user_sessions`, `conversation_logs`, `feedback`, `referrals`, `contacts`, `memory_participants`, `archived_users`, `archived_memories`, `archived_user_sessions`, `archived_conversation_logs`, `archived_contacts`, `archived_memory_participants`)
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
      constants.ts              # Shared constants (TZ_OFFSETS, BOT_HANDLE)
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
    009_phase2_snooze_streaks.sql  # snooze_count on memories, streak fields on users
    010_referrals.sql              # referrals table + referral_code/referred_by on users
    011_archive_schema_sync.sql    # Sync archive tables + triggers with columns from 003/007/009/010
    012_shared_reminders.sql        # contacts, memory_participants, is_shared, phone_number, archive tables + triggers
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
- `TZ_OFFSETS` map lives in `_shared/constants.ts` (single source of truth). Imported by index.ts, gemini.ts, database.ts. Covers India, US, UK, Europe, Asia-Pacific.
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
- Gemini prompt includes expanded Hindi/Marathi temporal vocabulary (subah, dopahar, sham, raat, agle hafte, udya, parva, etc.) and date disambiguation rules ("next Friday" = next week, time-of-day defaults: morning=9AM, evening=6PM).
- Low-confidence gate: if `parsed.confidence < 0.6` on storage intents, appends "Not what you meant? Say delete/edit this" hint.
- Voice note length guard: <1s rejected, >120s warned before processing.
- Completion celebrations: `getCelebrationMessage` returns context-aware done messages (first of day, 5th task, all caught up). Used in both `handleDoneIntent` and `done:` callback.
- Smart snooze: `snooze:` callback shows time-aware picker (morning/afternoon/evening/tomorrow based on local hour). `snz_do:` executes the snooze, increments `snooze_count`. After 3 snoozes, escalation message suggests done/delete/reschedule.
- Undo done: `done:` callback shows "Undo" button. `undo_done:` reverts to pending within 30-second window (checked via `completed_at` timestamp).
- Wrong? correction flow: `wrong:` shows fix options (type/date/description). `fix_type:` shows type picker. `set_type:` applies. `fix_date:` sets session to `awaiting_date`. `fix_desc:` sets session to `awaiting_description`, next text updates description.
- Entity linking: after saving a memory, runs semantic search for related pending items. Shows up to 2 related items in confirmation message.
- Browse by type/status: `/pending` includes filter buttons (Tasks, Notes, Events, Overdue). `filter:` callback filters list and edits message in place. `filter:all` returns to unfiltered view.
- Streak tracking: `updateStreak` called on every done action. Compares `last_streak_date` to today/yesterday to continue or reset streak. `formatDigest` shows streak with personal best indicator. `DbUser` includes `current_streak`, `longest_streak`, `last_streak_date`.
- `snooze_count` column on memories (migration 009). Tracks per-item snooze frequency.
- Inline mode: enabled via BotFather (`/setinline`). Bot handles `inline_query` updates in `handleUpdate` before `callback_query`. Non-consented users get empty results.
- Referral tracking: `/share` sends `switch_inline_query_chosen_chat` button. Inline query handler logs share via `createReferral` and responds with invite card containing deep link. `/start ref_<telegram_id>` triggers `convertReferral` in `handleStart`. Referrer notified on conversion (non-fatal if blocked).
- `BOT_HANDLE` constant in `_shared/constants.ts` — must match actual BotFather username for deep links to work.
- Referral code format: `ref_<telegram_id>` (deterministic). Self-referral blocked in `convertReferral`. `users` gets `referral_code` (text unique) and `referred_by` (bigint FK). Migration 010.
- Shared tasks: `target_people` in GeminiParsedResponse triggers shared-task path. Solo tasks (`target_people: []`) are completely unchanged. `memory_participants` tracks per-person state for shared tasks. `contacts` table is per-user private address book.
- Contact linking: Telegram Share Contact → `contacts` row. Session intent `awaiting_contact:<msg>` re-processes original message after contact shared.
- Consent model: one-time approval per sender stored in `contacts.status`. `consent_allow:` / `consent_decline:` callbacks. After approval, all future tasks flow without prompts.
- Delegation vs fan-out: `include_creator: false` = delegation (task for others only), `include_creator: true` = fan-out (creator also a participant).
- Done on received task: updates `memory_participants.status`, NOT `memories.status`. Notifies creator.
- Delete on received task: sets `memory_participants.status = 'declined'`. Does NOT delete the memory. Creator NOT notified.
- Commands: `/contacts` lists address book, `/block` blocks a sender, `/unblock` unblocks, `/assigned` shows tasks delegated to others.
- Shared reminders: `send-reminders` fans out to participants independently. Tags with "Shared by {sender}".
- Digest: `formatDigest` includes "Assigned to you" section for received tasks.

## Local Dev
`.env` file at project root (gitignored) holds: `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Use `source .env` before running curl commands locally.

## Testing
Simulate Telegram webhooks with curl POST to the Edge Function URL. Use fake telegram_id (e.g., 999999999) for test users. Clean up test data after.
