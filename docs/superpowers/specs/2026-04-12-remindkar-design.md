# RemindKar — Design Spec

**Date**: 2026-04-12
**Deadline**: 2026-04-15, 10 PM IST
**Status**: Approved for implementation
**Author**: Yash Patni + Claude

---

## 1. What It Is

A Telegram bot that acts as a personal AI memory and commitment tracker. Users send text or voice notes in English, Hindi, Hinglish, or Marathi. The bot parses intent, extracts tasks/reminders/notes with dates and entities, stores them, and sends reminders and daily digests.

**Bot name**: RemindKar
**Target**: 100+ real users (LinkedIn peers) by April 15

---

## 2. MVP Scope

### In Scope

| # | Feature | Description |
|---|---------|-------------|
| 1 | Text capture | NL message → Gemini parses intent/date/entities → store → confirm with inline buttons |
| 2 | Voice capture | Voice note → Gemini transcribes → Gemini parses → store → confirm |
| 3 | Daily digest | 9 AM IST cron: due today, tomorrow preview, overdue items |
| 4 | Time-specific reminders | 30 min pre-alert + exact-time alert via cron every 5 min |
| 5 | Memory queries | "what did I save about X?" / "show pending" / "when is Y's birthday?" |
| 6 | Forward-to-bot | Forward any message → extract actionable items → create tasks |
| 7 | Onboarding | /start → consent (DPDP Act) → demo prompt → wow moment |
| 8 | Privacy | /privacy shows data policy, /delete wipes all user data |

### Explicitly Out

- Google Calendar sync
- Shared/collaborative features
- Recurring tasks beyond daily/weekly/yearly
- Semantic/vector search (ILIKE for MVP)
- Web dashboard
- Multi-timezone (hardcode IST)
- Image/screenshot processing
- WhatsApp integration
- Payment/subscription logic

---

## 3. Architecture

```
Telegram User
    | (webhook POST)
    v
Edge Function: telegram-webhook
    |-- /start, /help, /privacy, /delete, /done, /pending --> command handlers
    |-- callback_query --> button tap handler (Done/Snooze/Delete/Consent/Date)
    |-- voice message --> download OGG --> Gemini transcribe --> Gemini parse --> store
    |-- forwarded message --> extract text --> Gemini parse --> store
    |-- regular text --> Gemini parse --> store or query
    |
    v
Supabase PostgreSQL (users, memories)
    ^
    |
pg_cron (*/5 * * * *) --> Edge Function: send-reminders
pg_cron (30 3 * * *)  --> Edge Function: send-digest
```

### Edge Functions

| Function | Trigger | Purpose |
|----------|---------|---------|
| `telegram-webhook` | Telegram webhook POST | All user interactions: commands, text, voice, forwards, button taps |
| `send-reminders` | pg_cron every 5 min via pg_net | Query due reminders, send alerts, mark as reminded |
| `send-digest` | pg_cron daily 3:30 AM UTC via pg_net | Query each user's tasks, format and send morning digest |

### File Structure

```
supabase/
  functions/
    telegram-webhook/
      index.ts              # Webhook receiver, update routing
    send-reminders/
      index.ts              # Reminder check and send
    send-digest/
      index.ts              # Daily digest formatter and send
    _shared/
      telegram.ts           # sendMessage, sendMessageWithButtons, answerCallbackQuery, getFile, downloadFile
      gemini.ts             # parseMessage, transcribeAudio
      database.ts           # User and memory CRUD (upsertUser, createMemory, updateMemory, queryMemories, deleteUserData)
      formatters.ts         # Digest formatting, confirmation formatting, query result formatting
  migrations/
    001_initial_schema.sql  # Tables, indexes, RLS, pg_cron jobs
  config.toml
```

---

## 4. Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Bot framework | Telegram Bot API via webhooks | NOT polling |
| Webhook handler | Supabase Edge Function (Deno/TypeScript) | Single function for all updates |
| AI — text parsing | Gemini 2.0 Flash | Structured JSON output, direct REST API |
| AI — voice transcription | Gemini 2.0 Flash | Native OGG audio input, two-step: transcribe then parse |
| Database | Supabase PostgreSQL | Two tables: users, memories |
| Scheduled jobs | pg_cron + pg_net | Triggers Edge Functions for digest and reminders |
| Auth | Gemini API key + Supabase service role key | No end-user auth needed (Telegram ID is identity) |

---

## 5. Database Schema

### users

```sql
create table public.users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique not null,
  telegram_username text,
  first_name text,
  consent_given boolean default false,
  consent_given_at timestamptz,
  created_at timestamptz default now(),
  timezone text default 'Asia/Kolkata',
  is_active boolean default true,
  last_active_at timestamptz default now()
);

alter table public.users enable row level security;
-- No anon policies needed; all access via service role key
```

### memories

```sql
create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  telegram_id bigint not null,
  type text not null check (type in ('task', 'reminder', 'note', 'event', 'birthday')),
  description text not null,
  raw_input text not null,
  due_date timestamptz,
  reminder_at timestamptz,
  entities jsonb default '{}',
  recurrence text check (recurrence in ('daily', 'weekly', 'yearly')),
  status text default 'pending' check (status in ('pending', 'done', 'snoozed', 'expired')),
  is_reminded boolean default false,
  is_pre_reminded boolean default false,
  source text default 'text' check (source in ('text', 'voice', 'forwarded')),
  created_at timestamptz default now(),
  completed_at timestamptz
);

alter table public.memories enable row level security;
-- No anon policies needed; all access via service role key
```

### Indexes

```sql
create index idx_memories_telegram_status on public.memories(telegram_id, status);
create index idx_memories_reminder on public.memories(reminder_at, is_reminded) where status = 'pending';
create index idx_memories_due_date on public.memories(due_date) where status = 'pending';
create index idx_memories_pre_reminder on public.memories(reminder_at, is_pre_reminded) where status = 'pending';
```

---

## 6. Webhook Handler — Routing Logic

### Update type detection (in order)

```
1. update.callback_query exists?     --> handleCallbackQuery()
2. update.message.voice exists?      --> handleVoice()
3. update.message.forward_date exists? --> handleForward()
4. update.message.text starts with /? --> handleCommand()
5. update.message.text exists?       --> handleText()
6. else                              --> ignore (photos, stickers, etc.)
```

### Command handlers

| Command | Action |
|---------|--------|
| `/start` | Upsert user — on INSERT set consent_given=false; on UPDATE (returning user) do NOT reset consent. If consent already given, skip consent keyboard and send "Welcome back!" |
| `/help` | Send help text with example commands |
| `/privacy` | Send privacy policy text |
| `/delete` | Delete all user data (cascade), confirm |
| `/done` | If followed by text, search pending memories by ILIKE match on description. If 1 match → mark done. If multiple → show numbered list with inline buttons to pick. If 0 → "No matching task found." |
| `/pending` | Query pending memories for user, format and send list |

### Callback query routing

| Callback data pattern | Action |
|----------------------|--------|
| `consent_yes` | Update user `consent_given=true`, `consent_given_at=now()`, send onboarding message 2 |
| `consent_no` | Send "no problem" message |
| `done:{memory_id}` | Update memory `status='done'`, `completed_at=now()`, edit original message to show completion |
| `snooze:{memory_id}` | Update memory `reminder_at += 1 hour`, `is_reminded=false`, confirm snooze |
| `delete:{memory_id}` | Delete memory row, edit original message to confirm deletion |
| `date:{memory_id}:{iso_date}` | Update memory `due_date` and recalculate `reminder_at`, confirm date selection |

---

## 7. Gemini Integration

### API

Direct REST calls — no SDK dependency.

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={GEMINI_API_KEY}
```

### Text Parsing Prompt

```
You are a personal memory assistant that extracts structured information from user messages. The user may write in English, Hindi, Hinglish (mixed Hindi-English), or Marathi.

Current date and time: {current_datetime_ist}
User's timezone: Asia/Kolkata

Analyze the user's message and respond with ONLY a JSON object (no markdown, no explanation):

{
  "intent": "task" | "reminder" | "event" | "birthday" | "note" | "query" | "greeting" | "done" | "unknown",
  "description": "Clean, concise description of the task/note/event",
  "due_date": "ISO 8601 datetime string or null",
  "reminder_at": "ISO 8601 datetime for when to send reminder, or null. If user specifies a time, set reminder 30 minutes before that time. If only date is given, set reminder to 9:00 AM on that date.",
  "entities": {
    "people": ["list of people mentioned"],
    "projects": ["list of projects/topics"],
    "locations": ["list of locations"]
  },
  "recurrence": "daily" | "weekly" | "yearly" | null,
  "priority": "high" | "medium" | "low",
  "query_text": "If intent is 'query', the search terms to look for. null otherwise.",
  "confidence": 0.0-1.0,
  "ambiguous_date": true | false,
  "date_options": ["If ambiguous_date is true, list possible date interpretations as ISO 8601 strings"]
}

Rules:
- "kal" means tomorrow, "parson" means day after tomorrow, "aaj" means today
- "next Friday" when today is Thursday means the Friday of NEXT week, not tomorrow
- "EOD" means 6:00 PM IST, "EOW" means Friday 6:00 PM IST
- If no date/time is mentioned for a task, set due_date to null (it's a someday task)
- If the user is asking a question about their stored data, set intent to "query"
- If the user says something like "done with X" or "finished X", set intent to "done"
- Birthday: extract the person's name and the date. Set recurrence to "yearly"
- For voice transcriptions, clean up filler words but preserve the core meaning
```

### Voice Pipeline (Two-Step)

**Step 1 — Transcription:**
- Download OGG from Telegram via `getFile` + file download URL
- Base64 encode the audio
- Send to Gemini with inline audio part and prompt:
  `"Transcribe this audio accurately. The speaker may use English, Hindi, Hinglish, or Marathi. Output only the transcription, nothing else."`
- Store transcription as `raw_input`

**Step 2 — Parsing:**
- Feed transcription text into the same parsing prompt as regular text messages
- Process parsed JSON identically to text flow

**Fallback:** If transcription returns empty or Gemini fails, respond: "I couldn't process your voice note — could you type it instead?"

---

## 8. Confirmation Messages

### Task/reminder/event created

```
Got it! Here's what I saved:

{type_emoji} {type}: {description}
{calendar_emoji} Due: {formatted_date} (or "No deadline")
{bell_emoji} Reminder: {formatted_reminder_time} (or "None set")
{people_emoji} People: {entities.people} (if any)

[Done] [Snooze 1hr] [Delete]
```

### Query response

Search memories table using `ILIKE '%{query_text}%'` on `description` column. If entities are present in the query, also search the `entities` JSONB field.

Format results as a numbered list with type, description, due date, and status.

### Ambiguous date

```
I'm not sure which date you mean. Which one?

[Option 1: Mon, Apr 13] [Option 2: Mon, Apr 20]
```

---

## 9. Scheduled Jobs

### Daily Digest (9:00 AM IST / 3:30 AM UTC)

**Trigger:** pg_cron → pg_net HTTP POST → `send-digest` Edge Function

**Logic:**
1. Query all users where `is_active = true` and `consent_given = true`
2. For each user, query memories:
   - `status = 'pending'` AND `due_date` is today (IST) → "Due Today" section
   - `status = 'pending'` AND `due_date` is tomorrow (IST) → "Coming Tomorrow" section
   - `status = 'pending'` AND `due_date < today` AND `due_date IS NOT NULL` → "Overdue" section
   - `status = 'pending'` AND `due_date IS NULL` → count for "Someday" note
3. Skip users with zero pending items (no "all clear" spam)
4. Send formatted message via Telegram API

**Format:**
```
Good morning, {first_name}!

OVERDUE (if any):
  - {description} (was due {date})

DUE TODAY (if any):
  - {description} at {time}

COMING TOMORROW (if any):
  - {description}

+ {n} items with no deadline
```

### Reminder Check (Every 5 Minutes)

**Trigger:** pg_cron → pg_net HTTP POST → `send-reminders` Edge Function

**Logic:**
1. Query memories where `reminder_at <= now()` AND `is_reminded = false` AND `status = 'pending'`
2. For each: send message with Done/Snooze buttons, set `is_reminded = true`
3. Query memories where `(reminder_at - interval '30 minutes') <= now()` AND `is_pre_reminded = false` AND `status = 'pending'` AND `reminder_at > now()`
4. For each: send pre-alert message, set `is_pre_reminded = true`

**Reminder message:**
```
Reminder: {description}
Due: {formatted_time}

[Done] [Snooze 1hr]
```

**Pre-reminder message:**
```
Heads up — in 30 minutes:
{description}

[Done] [Snooze 1hr]
```

### Cron SQL Setup

```sql
-- Enable extensions (run once in Supabase SQL editor)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Daily digest
select cron.schedule(
  'daily-digest',
  '30 3 * * *',
  $$select net.http_post(
    url := '<SUPABASE_URL>/functions/v1/send-digest',
    headers := '{"Authorization": "Bearer <SERVICE_ROLE_KEY>", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  )$$
);

-- Reminder check every 5 minutes
select cron.schedule(
  'check-reminders',
  '*/5 * * * *',
  $$select net.http_post(
    url := '<SUPABASE_URL>/functions/v1/send-reminders',
    headers := '{"Authorization": "Bearer <SERVICE_ROLE_KEY>", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  )$$
);
```

---

## 10. Onboarding Flow

### /start → Message 1 (consent request)

```
Hey {first_name}!

I'm RemindKar — your personal AI memory. Tell me anything you want to remember, and I'll make sure you never forget it.

Tasks, deadlines, birthdays, meeting notes, random ideas — just text or voice note me. I'll organize everything and remind you when it matters.

Before we start, I need your consent to store your messages so I can help you. Your data is private, never shared, and you can delete everything anytime with /delete.
```

**Inline keyboard:** `[I consent] [No thanks]`

### Consent given → Message 2

```
Let's try it out! Send me something — a task, a reminder, anything:

"Remind me to call Aman tomorrow at 5 PM"
"Mom's birthday is on 15th August"
"Send the quarterly report to Priya by Friday EOD"

Or just send a voice note — I understand Hindi, English, and Hinglish!
```

### Consent declined → Message 3

```
No problem! I can't store memories without your consent, but feel free to come back anytime. Just send /start to begin again.
```

### Consent gate

All non-command messages check `consent_given` before processing. If false, respond:
```
Please send /start first and give consent before I can save your memories.
```

---

## 11. Privacy & Data Deletion

### /privacy

```
RemindKar Privacy Info:

What I store:
- Your Telegram ID and first name
- Messages you send me (text and voice transcriptions)
- Tasks, reminders, and notes I extract from your messages

What I DON'T do:
- Share your data with anyone
- Use your data for training
- Store data beyond what you send me

Your controls:
- /delete — permanently erase all your data
- Every task has a Delete button

Data is stored on Supabase (hosted on AWS). For questions, contact @{YASH_TELEGRAM_USERNAME}.
```

### /delete

1. Delete all memories for the user (`on delete cascade` handles this)
2. Delete the user record
3. Send confirmation:
```
All your data has been permanently deleted. Send /start if you ever want to use RemindKar again.
```

---

## 12. Error Handling

| Scenario | Response to user |
|----------|-----------------|
| Gemini API fails | "I couldn't process that, please try again in a moment." |
| Voice download fails | "I couldn't download your voice note, please try again." |
| Gemini returns invalid JSON | Retry once. If still fails, "I had trouble understanding that. Could you rephrase?" |
| Database write fails | "Something went wrong saving that. Please try again." |
| Unknown update type | Silently ignore (photos, stickers, etc.) |
| User without consent sends message | "Please send /start first and give consent before I can save your memories." |

All errors logged to console (Supabase Edge Function logs). No separate logs table for MVP — Edge Function logs are sufficient for debugging with <100 users.

---

## 13. Environment Variables

```
TELEGRAM_BOT_TOKEN         # From @BotFather
GEMINI_API_KEY             # From Google AI Studio or GCP console
SUPABASE_URL               # Project URL from Supabase dashboard
SUPABASE_SERVICE_ROLE_KEY  # From Settings > API (bypasses RLS)
```

---

## 14. Pre-requisites Checklist

| # | Item | How to get it |
|---|------|---------------|
| 1 | Telegram Bot Token | @BotFather → /newbot → name "RemindKar" → username e.g. `RemindKarBot` → copy token |
| 2 | Gemini API Key | Google AI Studio (aistudio.google.com) → Get API Key → Create |
| 3 | Supabase project | Create project → Settings > API → copy URL and service_role key |
| 4 | Supabase CLI | `brew install supabase/tap/supabase` or `npx supabase` |
| 5 | Webhook registration | `curl https://api.telegram.org/bot<TOKEN>/setWebhook?url=<SUPABASE_URL>/functions/v1/telegram-webhook` |

---

## 15. Test Cases

| # | Test | Expected |
|---|------|----------|
| 1 | Text task with explicit date | Parsed, stored, confirmed with buttons |
| 2 | Text task without date | Stored as someday (due_date=null) |
| 3 | Voice note in English | Transcribed, parsed, stored |
| 4 | Voice note in Hinglish | Transcribed, parsed, stored |
| 5 | "Show my pending tasks" | Returns list of pending items |
| 6 | "When is Aman's birthday?" | Returns matching birthday entry |
| 7 | Forward a message | Task extracted and stored |
| 8 | Ambiguous date | Inline keyboard with date options |
| 9 | Tap Done button | Task marked complete, message updated |
| 10 | Tap Snooze button | Reminder pushed 1 hour |
| 11 | Tap Delete button | Task removed, message updated |
| 12 | Daily digest fires | Correct format, correct data per user |
| 13 | Reminder fires at due time | Message sent with buttons |
| 14 | Pre-reminder 30 min before | Heads-up message sent |
| 15 | /privacy | Privacy info displayed |
| 16 | /delete | All user data wiped, confirmed |
| 17 | /start without consent | Blocks storage |
| 18 | Two rapid messages | Both processed correctly |
