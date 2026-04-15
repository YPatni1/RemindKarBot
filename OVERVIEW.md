# RemindKar — Technical Overview

> Personal AI memory + commitment tracker via Telegram. Users send text/voice in English, Hindi, Hinglish, or Marathi. Bot parses intent, stores structured entries, and proactively follows up.

---

## Stack

| Layer | Tool | Notes |
|---|---|---|
| Runtime | Supabase Edge Functions (Deno/TypeScript) | Serverless, no always-on server |
| AI — NLU | Gemini 2.5 Flash | Parse intent, extract dates, entities |
| AI — Speech | Gemini 2.5 Flash (multimodal) | Transcribe OGG voice messages |
| AI — Search | Gemini text-embedding-004 | 768-dim vector embeddings |
| Database | Supabase PostgreSQL + pgvector | Memories, users, sessions |
| Bot channel | Telegram Bot API (webhooks) | Push, not polling |
| Cron | pg_cron + pg_net | Runs inside Postgres |

---

## System Architecture

```
┌─────────────┐        webhook POST        ┌──────────────────────────┐
│  Telegram   │ ─────────────────────────► │  telegram-webhook        │
│  User       │ ◄───────────────────────── │  (Edge Function)         │
└─────────────┘        sendMessage         └──────────┬───────────────┘
                                                      │
                          ┌───────────────────────────┼────────────────────────┐
                          ▼                           ▼                        ▼
               ┌──────────────────┐     ┌─────────────────────┐    ┌──────────────────┐
               │  Gemini 2.5 Flash│     │  Supabase DB         │    │  user_sessions   │
               │  - parseMessage  │     │  - memories          │    │  - last_shown_ids│
               │  - transcribeAudio│    │  - users             │    │  - conv_history  │
               │  - generateEmbed │     │  - pgvector search   │    │  - last_intent   │
               └──────────────────┘     └─────────────────────┘    └──────────────────┘

                         pg_cron (every 5 min)              pg_cron (3:30 UTC daily)
                                  │                                    │
                    ┌─────────────▼──────────┐          ┌─────────────▼───────────┐
                    │  send-reminders        │          │  send-digest            │
                    │  (Edge Function)       │          │  (Edge Function)        │
                    └────────────────────────┘          └─────────────────────────┘
```

---

## Message Processing Flow

```
Incoming Update
      │
      ├── callback_query? ──► handleCallback (done/delete/snooze/page navigation)
      │
      └── message
            │
            ├── Not consented? ──► Block (except /start, /help)
            │
            ├── /command? ──► handleCommand
            │     (/start, /help, /status, /pending, /done, /delete, /feedback, /tz, /search)
            │
            ├── Voice message? ──► transcribeAudio() ──► text ──┐
            │                                                    │
            ├── Forwarded message? ──────────────────────────────┤
            │                                                    │
            └── Text message? ────────────────────────────────── ▼
                                                         Load session context
                                                                 │
                                                   awaiting_date intent?
                                                         │          │
                                                        YES         NO
                                                         │          │
                                               Try date  │          │
                                               follow-up │          │
                                                         └──────────┘
                                                                 │
                                                    parseMessage (Gemini)
                                                    + conversation history
                                                                 │
                                                    Array of parsed items
                                                                 │
                                                    Loop each item ──► handleIntent()
                                                                 │
                                                         saveSession()
                                                    (non-fatal, always last)
```

---

## Supported Intents

| Intent | Trigger Example | Action |
|---|---|---|
| `task` | "remind me to call mom" | Save memory, ask for date if missing |
| `reminder` | "remind me at 5pm to take meds" | Save with `reminder_at` |
| `event` | "team meeting Friday 3pm" | Save with `due_date` |
| `birthday` | "sister's bday 14 May, remind 2 days before" | Save with `recurrence: yearly` |
| `note` | "note: password is abc123" | Save without date |
| `query` | "what did I add this week?" | Semantic search + date range filter |
| `done` | "done with meeting prep" | Mark memory complete |
| `reschedule` | "move the 5pm meeting to 7" | Update `due_date` |
| `delete` | "delete 2" | Remove by session index |
| `edit` | "1 is birthday not task" | Update specific field |
| `status` | "how am I doing?" | Summary: overdue/today/week counts |
| `greeting` | "hey", "good morning" | Friendly response |
| `casual` | "I'm off today", "nothing for now" | Acknowledge, no storage |

---

## AI Pipeline Detail

### Text Input
```
User text
    │
    ▼
Gemini 2.5 Flash
  System prompt includes:
  - Current datetime in user's timezone
  - Last 3 conversation turns (for pronoun resolution)
  - Hindi/Marathi date rules ("kal" = tomorrow, "parson" = day after)
  - Multi-task detection (returns JSON array)
    │
    ▼
GeminiParsedResponse[]
  Fields: intent, description, due_date, reminder_at,
          entities {people, projects, locations},
          recurrence, priority, target_index,
          ambiguous_date + date_options,
          query_date_start/end, edit_field/value
```

### Voice Input (2-step)
```
OGG audio bytes
    │
    ▼
Gemini 2.5 Flash (multimodal)
  - inline_data: base64(OGG)
  - "Transcribe in EN/HI/Hinglish/Marathi"
    │
    ▼
Transcription text ──► same text pipeline above
```

### Semantic Search
```
User query text
    │
    ▼
generateEmbedding() → 768-dim vector
    │
    ▼
match_memories() RPC (pgvector cosine similarity, threshold 0.7)
    │ (no embeddings found?)
    ▼
ILIKE fallback (text search)
```

---

## Database Schema

### `users`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| telegram_id | bigint unique | |
| first_name, telegram_username | text | |
| consent_given | boolean | Gate for all interactions |
| timezone | text | IANA tz string, default `Asia/Kolkata` |
| is_active, last_active_at | bool / timestamptz | |
| current_streak, longest_streak | integer | Completion streak tracking |
| last_streak_date | date | Last date a task was completed |

### `memories`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| telegram_id | bigint | Denormalized for fast queries |
| type | text | task / reminder / note / event / birthday |
| description | text | Cleaned by Gemini |
| raw_input | text | Original user message |
| due_date, reminder_at | timestamptz | Nullable |
| recurrence | text | daily / weekly / yearly |
| status | text | pending / done / snoozed / expired |
| is_reminded, is_pre_reminded | boolean | Prevent duplicate sends |
| source | text | text / voice / forwarded |
| entities | jsonb | {people, projects, locations} |
| description_embedding | vector(768) | pgvector semantic search |
| snooze_count | integer | Times this item has been snoozed |

### `user_sessions`
| Column | Type | Notes |
|---|---|---|
| telegram_id | bigint PK | |
| last_shown_ids | uuid[] | IDs from last list shown (enables "delete 2") |
| last_intent | text | e.g. `awaiting_date` for progressive clarification |
| conversation_history | jsonb | Last 3 user+bot pairs for Gemini context |
| session_id | uuid | Auto-generated on insert, reused within TTL, links to conversation_logs |
| updated_at | timestamptz | 30-min TTL logic applied in app |

### `conversation_logs`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| telegram_id | bigint | |
| user_message | text | Raw input (prefixed `[voice]`/`[forwarded]` for those types) |
| message_type | text | text / voice / command / callback / forward / unsupported |
| parsed_intents | jsonb | Gemini parsed response array (text/voice/forward only) |
| primary_intent | text | Main intent extracted (populated for ALL message types incl. callbacks) |
| bot_action | text | Brief summary of what the bot did |
| bot_response | text | Actual message text sent to user (text/voice/forward only) |
| session_id | uuid | Links to user_sessions.session_id for conversation grouping |
| processing_time_ms | integer | End-to-end request processing time |
| error | text | Error string if interaction failed |
| user_timezone | text | User's timezone at time of interaction |
| created_at | timestamptz | |

### `feedback`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| telegram_id | bigint | |
| username | text | Telegram username at time of feedback |
| first_name | text | |
| category | text | `bug`, `feature`, or `general` |
| feedback_text | text | Free-form user feedback |
| created_at | timestamptz | |

### Audit Archive Tables
| Table | Mirrors | Trigger | Notes |
|---|---|---|---|
| `archived_users` | users | `trg_archive_user` (BEFORE DELETE) | `deletion_type = 'account_delete'` |
| `archived_memories` | memories | `trg_archive_memory` (BEFORE DELETE) | `account_cascade` vs `direct` via `pg_trigger_depth()` |
| `archived_user_sessions` | user_sessions | `trg_archive_session` (BEFORE DELETE) | Same depth logic |
| `archived_conversation_logs` | conversation_logs | `trg_archive_logs_on_user_delete` (BEFORE DELETE on users) | Archives + deletes logs for the deleted user's telegram_id |

---

## Cron Jobs

| Job | Schedule | What it does |
|---|---|---|
| `send-reminders` | Every 5 min (pg_cron + pg_net) | Checks `reminder_at ≤ now`, sends pre-reminder (30 min before) then due reminder |
| `send-digest` | 3:30 UTC daily | Sends morning summary to each active user: overdue + today + tomorrow + someday count |

---

## Key Features & Logic

| Feature | How It Works |
|---|---|
| **Multi-task parsing** | Gemini returns JSON array; webhook loops and saves each item separately |
| **Conversation context** | Last 3 user+bot turns passed to Gemini; enables "move it to Friday", pronoun resolution |
| **Progressive clarification** | If task saved without date, session `last_intent = awaiting_date`; next message is tried as a date first |
| **Timezone-aware** | User picks timezone in onboarding; all dates formatted, digest timed, and Gemini prompted in their local time |
| **Semantic search** | pgvector cosine similarity; ILIKE fallback for pre-embedding data |
| **Session index refs** | "delete 2" resolves against `last_shown_ids` — works on any list, not just pending |
| **Pagination** | Pending list paginated (10/page); "Show more" edits message in-place via `editMessageWithButtons` |
| **Two delete flows** | "delete all" → confirm → wipe memories only (keep account); `/delete` → confirm → full account cascade |
| **Pre-reminders** | 30 min before `reminder_at`, separate flag `is_pre_reminded` to avoid double sends |
| **Resilience order** | Save memory → generate embedding → save session. Embedding/session failures never block memory storage |
| **Consent gate** | All non-command messages blocked until user accepts via /start |
| **Unsupported inputs** | Photos, stickers, docs → helpful "I can only handle text/voice" message |
| **Low-confidence gate** | Storage intents with confidence < 0.6 get "Not what you meant?" hint appended |
| **Voice guards** | Voice notes < 1s rejected, > 120s warned before processing |
| **Completion celebrations** | Context-aware done messages: "First one today!", "5 tasks done!", "All caught up!" |
| **Extended NLU** | Hindi/Marathi temporal vocabulary (subah, sham, agle hafte, udya, parva) + date disambiguation rules |
| **Conversation logging** | Every interaction logged with user message, parsed intents, bot response text, session_id, processing time. Never crashes main flow |
| **Session grouping** | `session_id` links related interactions; persists in `user_sessions` within 30-min TTL, regenerated on expiry |
| **Audit archive** | BEFORE DELETE triggers on users/memories/sessions/conversation_logs auto-archive data. Full cascade tracking via `deletion_type` |
| **Feedback collection** | `/feedback` command shows category buttons (Bug/Feature/General); user picks, then types feedback. `/feedback <text>` saves directly. Stored in `feedback` table |
| **Smart snooze** | Time-aware snooze picker: shows morning/afternoon/evening/tomorrow options based on current local hour |
| **Undo done** | 30-second undo window after marking task done; reverts to pending via `undo_done:` callback |
| **Snooze escalation** | Tracks `snooze_count` per memory; after 3 snoozes, suggests done/delete/reschedule |
| **Entity linking** | After saving, runs semantic search for related pending items; shows up to 2 in confirmation |
| **Wrong? correction** | "Wrong?" button on confirmations; lets user fix type, date, or description inline |
| **Browse by type** | `/pending` shows filter buttons (Tasks/Notes/Events/Overdue); filters edit message in place |
| **Streak tracking** | Tracks completion streaks per user; shown in daily digest with personal-best indicator |

---

## Onboarding Flow

```
/start
  │
  ├── New user ──► Show consent message + Accept button
  │                     │
  │               User clicks Accept
  │                     │
  │               Show timezone picker (9 options)
  │                     │
  │               User picks timezone ──► Welcome message + feature overview
  │
  └── Returning user ──► "Welcome back" message
```

---

## Deployment

```bash
# Deploy functions
npx supabase functions deploy telegram-webhook
npx supabase functions deploy send-reminders
npx supabase functions deploy send-digest

# Apply DB migrations
npx supabase db push --linked

# Set secrets
npx supabase secrets set TELEGRAM_BOT_TOKEN=... GEMINI_API_KEY=...
```

**Important:**
- `verify_jwt = false` on `telegram-webhook` (Telegram sends unauthenticated POSTs)
- Always return HTTP 200 from webhook (non-200 causes Telegram retries)
- Service role key used for all DB ops (bypasses RLS — server-side only)
- Use `npx supabase` not global install (brew fails on macOS 26)
