# RemindKar

**Your AI-powered personal memory and commitment tracker on Telegram.**

Send tasks, reminders, notes, and events in natural language (English, Hindi, Hinglish, or Marathi) via text or voice. RemindKar parses your intent, stores structured entries, sends time-based reminders, and delivers a daily morning digest. You can also delegate tasks to friends and get notified when they're done.

**Try it:** [@RemindKarBot](https://t.me/RemindKarBot)

---

## What It Does

- **Natural language input** -- "remind me to call Aman tomorrow at 5 PM", "kal subah gym jaana hai"
- **Voice messages** -- speak instead of typing, in any supported language
- **Multi-task parsing** -- "buy milk and call dentist" creates two separate entries
- **Smart reminders** -- 30-minute heads-up + on-time reminder with snooze/done buttons
- **Morning digest** -- daily briefing with overdue, today, tomorrow, streaks
- **Semantic search** -- "what did I save about the project?" uses vector similarity
- **Task delegation** -- "remind Ameet to send the invoice" assigns tasks to contacts
- **Shared reminders** -- "remind me and Priya about the call" fans out to both
- **Number references** -- "delete 2", "mark 1 done" against any displayed list
- **Streaks** -- tracks consecutive days of completing tasks

---

## Architecture

```
Telegram User
    |
    |  webhook POST
    v
telegram-webhook (Supabase Edge Function)
    |
    +---> Gemini 2.5 Flash (parse intent, transcribe voice, generate embeddings)
    +---> Supabase PostgreSQL + pgvector (memories, users, contacts, sessions)
    +---> Telegram Bot API (send messages, buttons, inline queries)

pg_cron (every 5 min)  -----> send-reminders (Edge Function)
pg_cron (3:30 UTC)     -----> send-digest (Edge Function)
```

| Layer | Tool |
|---|---|
| Runtime | Supabase Edge Functions (Deno/TypeScript) |
| AI -- NLU | Gemini 2.5 Flash |
| AI -- Embeddings | Gemini text-embedding-004 (768-dim vectors) |
| Database | Supabase PostgreSQL + pgvector |
| Bot API | Telegram Bot API via webhooks |
| Cron | pg_cron + pg_net (runs inside Postgres) |

---

## Project Structure

```
supabase/
  functions/
    telegram-webhook/index.ts    # All user interactions (commands, text, voice, callbacks)
    send-reminders/index.ts      # Cron: check + send due reminders (solo + shared)
    send-digest/index.ts         # Cron: morning digest per user
    _shared/
      types.ts                   # TypeScript interfaces
      constants.ts               # Timezone offsets, bot handle
      telegram.ts                # Telegram Bot API helpers
      database.ts                # Supabase client, CRUD, semantic search, sessions
      gemini.ts                  # Gemini REST API (parse, transcribe, embeddings)
      formatters.ts              # Message formatting (confirmations, lists, digest)
  migrations/
    001_initial_schema.sql       # Core tables, indexes, RLS
    002_cron_jobs.sql            # pg_cron schedules
    003_pgvector_sessions.sql    # pgvector, embeddings, match_memories RPC, sessions
    004_conversation_history.sql # Conversation history on sessions
    005_conversation_logs.sql    # Interaction logging table
    006_audit_tables.sql         # Archive tables + BEFORE DELETE triggers
    007_logging_improvements.sql # Enhanced logging columns
    008_feedback.sql             # User feedback collection
    009_phase2_snooze_streaks.sql # Snooze counts, streak fields
    010_referrals.sql            # Referral tracking
    011_archive_schema_sync.sql  # Sync archive tables with newer columns
    012_shared_reminders.sql     # Contacts, memory_participants, shared tasks
```

---

## Features

### Core -- Task Management

| Feature | How It Works |
|---|---|
| Save tasks/reminders/events/notes/birthdays | Gemini parses intent, type, description, date, entities |
| Voice messages | Two-step: transcribe audio via Gemini, then parse transcription |
| Multi-task messages | "buy milk and call dentist" creates two entries |
| Time-based reminders | 30-min pre-reminder + on-time reminder via pg_cron |
| Morning digest | Overdue, today, tomorrow, no-deadline items, streaks |
| Semantic search | pgvector cosine similarity with ILIKE fallback |
| Number references | "delete 2" resolves against last shown list via session context |
| Progressive clarification | Save task without date, bot asks "when?" as follow-up |

### Smart Features

| Feature | How It Works |
|---|---|
| Conversation context | Last 3 message pairs stored in session, enables follow-ups |
| Smart snooze | Time-aware options (morning/afternoon/evening) based on local hour |
| Snooze escalation | After 3 snoozes, suggests done/delete/reschedule |
| Streaks | Tracks consecutive completion days, personal best in digest |
| Completion celebrations | Context-aware messages (first of day, 5th task, all caught up) |
| Related memories | After saving, shows up to 2 semantically similar pending items |
| Undo done | 30-second undo window after marking task complete |

### Shared Tasks & Delegation

| Feature | How It Works |
|---|---|
| Task delegation | "remind Ameet to send the invoice" assigns to a contact |
| Fan-out reminders | "remind me and Priya about the call" sends to both |
| Contact linking | Share a Telegram contact to link a nickname |
| One-time consent | Recipient approves sender once, future tasks flow automatically |
| Per-participant state | Each person tracks their own done/snooze/decline independently |
| Creator notifications | Get notified when someone completes a task you assigned |
| Block/unblock | Recipients can block senders from assigning tasks |
| Invite non-users | Deep link invite sent to contacts not yet on RemindKar |

### Commands

| Command | Description |
|---|---|
| `/start` | Onboarding with consent and timezone selection |
| `/pending` | View all pending tasks with type filters |
| `/status` | Weekly progress summary |
| `/share` | Invite friends via inline chat picker |
| `/contacts` | View your linked contacts |
| `/assigned` | See tasks you've assigned to others |
| `/block` | Block someone from sending you tasks |
| `/unblock` | Unblock a blocked sender |
| `/feedback` | Share feedback (Bug/Feature/General) |
| `/privacy` | Privacy information |
| `/delete` | Delete your account and all data |
| `/help` | List all commands |

---

## Setup

### Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli)
- A Supabase project
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- A Gemini API key (from [Google AI Studio](https://aistudio.google.com))

### 1. Clone and configure

```bash
git clone https://github.com/YPatni1/RemindKarBot.git
cd RemindKarBot
```

Create a `.env` file at the project root:

```
TELEGRAM_BOT_TOKEN=your_bot_token
GEMINI_API_KEY=your_gemini_key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

### 2. Link Supabase project and apply migrations

```bash
npx supabase login
npx supabase link --project-ref your-project-ref
npx supabase db push --linked
```

### 3. Set secrets

```bash
npx supabase secrets set TELEGRAM_BOT_TOKEN=your_bot_token
npx supabase secrets set GEMINI_API_KEY=your_gemini_key
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-available in Edge Functions.

### 4. Deploy functions

```bash
npx supabase functions deploy telegram-webhook
npx supabase functions deploy send-reminders
npx supabase functions deploy send-digest
```

### 5. Set Telegram webhook

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/telegram-webhook"}'
```

### 6. Configure BotFather

- `/setinline` -- enable inline mode for the share/referral feature
- `/setcommands` -- set the command list

---

## Database Schema

### Core Tables

| Table | Purpose |
|---|---|
| `users` | User profiles, timezone, consent, streaks, phone number |
| `memories` | Tasks, reminders, notes, events with embeddings |
| `user_sessions` | Session context (last shown list, conversation history, 30-min TTL) |
| `conversation_logs` | Every interaction logged for observability |
| `feedback` | User feedback by category |
| `referrals` | Share and conversion tracking |
| `contacts` | Per-user private address book with consent status |
| `memory_participants` | Per-person state for shared/delegated tasks |

### Archive Tables

BEFORE DELETE triggers auto-copy data to `archived_*` tables before deletion. Preserves audit trail while respecting user deletion requests.

`archived_users`, `archived_memories`, `archived_user_sessions`, `archived_conversation_logs`, `archived_contacts`, `archived_memory_participants`

---

## How It Works

### Intent Parsing

Every user message goes through Gemini 2.5 Flash with a structured prompt. Gemini returns JSON with:

- `intent` -- task, reminder, event, birthday, note, query, done, delete, edit, reschedule, status, greeting, casual, unknown
- `description` -- cleaned task description
- `due_date` / `reminder_at` -- UTC timestamps
- `entities` -- extracted people, places, projects
- `target_people` -- names for task delegation
- `include_creator` -- whether sender is also a participant
- `confidence` -- 0-1 score (low confidence triggers hint)

### Embedding Pipeline

```
User message --> Gemini Flash (parse intent)
             --> Gemini text-embedding-004 (embed description)
             --> Supabase INSERT with 768-dim vector
```

### Reminder Flow

```
pg_cron (every 5 min)
  --> getDuePreReminders (due_date in 25-35 min window)
  --> getDueReminders (reminder_at <= now)
  --> getDueSharedPreReminders (participants)
  --> getDueSharedReminders (participants)
  --> sendMessageWithButtons per user/participant
```

### Delegation Flow

```
"remind Ameet to send invoice"
  --> Gemini extracts target_people: ["Ameet"]
  --> resolveTargetPeople: nickname lookup in contacts table
    --> Known + approved: create memory + participant (active), notify recipient
    --> Known + pending: create participant (pending_consent), await approval
    --> Unknown: prompt sender to share contact
  --> Recipient gets notification with Done/Snooze buttons
  --> Done notifies creator
```

---

## Languages

RemindKar understands input in:

- **English** -- "remind me to buy milk tomorrow"
- **Hindi** -- "kal subah gym jaana hai"
- **Hinglish** -- "Aman ko call kar at 5 PM"
- **Marathi** -- "udya savakashi doctor la bhet"

The Gemini prompt includes temporal vocabulary for all four (subah, dopahar, sham, raat, agle hafte, udya, parva, etc.).

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for shipped features and planned work.

---

## License

This project is private. All rights reserved.
