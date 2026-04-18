# Shared Reminders & Task Delegation — Design Spec

**Date:** 2026-04-18
**Status:** Draft
**Author:** Yash + Claude

---

## Problem

RemindKar is currently single-player. Users can only create tasks for themselves. Two real-world patterns are unsupported:

1. **Delegation:** "Remind Ameet to send the invoice by Friday" — a task that appears in someone else's list.
2. **Fan-out:** "Remind me and Ameet about tonight's call at 8 PM" — the same reminder fires for multiple people independently.

Both require identity linking, consent management, and per-participant state tracking.

## Decisions

| Aspect | Decision |
|---|---|
| Scope | Delegation + fan-out together, in one unified model |
| Identity linking | Phone number via Telegram Share Contact |
| Contacts | Per-user private address book, nickname-based lookup, disambiguate duplicates |
| Recipient consent | One-time approval per sender + block/mute anytime |
| Non-user recipients | Queue task, send invite deep link, expire after 7 days with fallback |
| Recipient control | Full (done/snooze/delete), tagged "from {sender}" |
| Creator visibility | Notified when recipient marks done |
| Existing features | 100% additive. Solo tasks untouched. |

## Data Model

### Modified tables

**`users`** — add column:

| Column | Type | Purpose |
|---|---|---|
| phone_number | text UNIQUE (nullable) | Collected via Telegram Share Contact for future self-identification |

**`memories`** — add column:

| Column | Type | Default | Purpose |
|---|---|---|---|
| is_shared | boolean | false | Quick filter: when true, per-person state lives in `memory_participants` |

### New table: `contacts`

Per-user private address book. Each user maintains their own contacts independently.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| owner_telegram_id | bigint NOT NULL | The person who added this contact (FK → users.telegram_id) |
| contact_telegram_id | bigint (nullable) | Null if contact not on RemindKar yet |
| contact_phone | text NOT NULL | From Telegram Share Contact message |
| nickname | text NOT NULL | First name extracted from shared contact, used for natural language matching |
| first_name | text | Full first name from Telegram contact data |
| status | text DEFAULT 'pending' | Recipient's consent state (see below) |
| created_at | timestamptz | |
| updated_at | timestamptz | |
| UNIQUE | (owner_telegram_id, contact_phone) | One entry per phone per owner |

**`contacts.status` values** (represents the recipient's consent decision):

| Status | Meaning |
|---|---|
| `pending` | Consent request sent, awaiting response |
| `approved` | Recipient accepted. Sender can assign freely with zero friction. |
| `blocked` | Recipient blocked this sender |
| `declined` | Recipient declined the consent request |

### New table: `memory_participants`

Per-person state for shared tasks. Only exists for shared tasks (`memories.is_shared = true`). Solo tasks have zero rows here.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| memory_id | uuid NOT NULL | FK → memories.id ON DELETE CASCADE |
| participant_telegram_id | bigint NOT NULL | Who this row is for |
| role | text NOT NULL | `creator` (fan-out, creator is also a participant) or `assignee` (delegation) |
| status | text DEFAULT 'pending_invite' | Per-participant lifecycle state (see below) |
| is_reminded | boolean DEFAULT false | Per-participant reminder tracking |
| is_pre_reminded | boolean DEFAULT false | Per-participant pre-reminder tracking |
| snooze_count | integer DEFAULT 0 | Per-participant snooze count |
| completed_at | timestamptz | When this participant marked done |
| created_at | timestamptz | |
| UNIQUE | (memory_id, participant_telegram_id) | |

**`memory_participants.status` values:**

| Status | Meaning |
|---|---|
| `pending_invite` | Recipient not on RemindKar, task queued waiting for them to join |
| `pending_consent` | Recipient is on RemindKar but hasn't approved this sender yet |
| `active` | Task is live in recipient's /pending list |
| `done` | Recipient marked it done |
| `snoozed` | Recipient snoozed it |
| `declined` | Recipient dismissed/declined this task |
| `expired` | Invite expired (recipient never joined within 7 days) |

### Indexes

```sql
CREATE INDEX idx_participants_recipient ON memory_participants(participant_telegram_id, status);
CREATE INDEX idx_participants_memory ON memory_participants(memory_id);
CREATE INDEX idx_contacts_owner ON contacts(owner_telegram_id);
CREATE INDEX idx_contacts_recipient ON contacts(contact_telegram_id);
CREATE INDEX idx_users_phone ON users(phone_number) WHERE phone_number IS NOT NULL;
```

### Archive tables

Following the existing audit pattern (migration 006):

- `archived_contacts` — BEFORE DELETE trigger on `contacts`
- `archived_memory_participants` — BEFORE DELETE trigger on `memory_participants`

## Gemini Prompt Changes

### New field in `GeminiParsedResponse`

```typescript
target_people: string[]    // people names extracted from message
include_creator: boolean   // true if creator is also a participant (fan-out vs delegation)
```

### Parsing rules

| User message | target_people | Behavior |
|---|---|---|
| "remind me to buy milk" | `[]` | Solo task (current flow, unchanged) |
| "remind Ameet to send invoice" | `["Ameet"]` | Delegation: creator NOT participant |
| "remind me and Ameet about tonight's call" | `["Ameet"]` | Fan-out: creator IS participant (detected from "me and" phrasing) |
| "tell Priya and Raj about the meeting" | `["Priya", "Raj"]` | Fan-out: creator NOT participant, two assignees |
| "remind me, Yash, and Ameet about the call" | `["Yash", "Ameet"]` | Fan-out: creator IS participant |

To disambiguate delegation vs fan-out, add a second field:

```typescript
include_creator: boolean   // true if creator is also a participant
```

Rules for Gemini:
- "remind Ameet to..." → `include_creator: false` (delegation)
- "remind me and Ameet about..." → `include_creator: true` (fan-out)
- "remind us about..." → `include_creator: true` (fan-out)
- "tell Priya and Raj about..." → `include_creator: false` (delegation to multiple)

The bot code uses `include_creator` to decide whether to add a `role = 'creator'` row in `memory_participants`.

Gemini prompt addition teaches the model to extract people names into `target_people` and set `include_creator`. Hindi/Marathi equivalents included ("Ameet ko yaad dila do", "mujhe aur Ameet ko remind kar", "hum sabko yaad dila").

## Flows

### Flow 1: Contact Linking

When bot encounters a name in `target_people` that isn't in the sender's contacts:

```
User:  "remind Ameet to send the invoice by Friday"
Bot:   "I don't know Ameet yet. Share their contact so I can link them."

User taps Share Contact → Telegram sends contact message with:
  - contact.phone_number
  - contact.first_name
  - contact.user_id (telegram_id, if available)

Bot:
  1. Creates contacts row (owner = sender, phone, nickname, contact_telegram_id)
  2. Checks if contact_telegram_id exists in users table
     - Yes → proceed to consent check
     - No → proceed to non-user flow
  3. Re-processes the original task with the now-known contact
```

**Session state for pending contact share:** When bot asks "share their contact", it sets `session.last_intent = 'awaiting_contact:<original_message>'` so the next contact message can resume the original task.

**Disambiguation (multiple matches for same name):**

```
Bot:  "Which Ameet?
       1) Ameet Kulkarni (+91 98xxx)
       2) Ameet Shah (+91 97xxx)"

User picks → task proceeds with selected contact
```

The picker uses `contact_phone` (last 4 digits shown) and `first_name` for disambiguation. Callback format: `pick_contact:<contact_id>`.

### Flow 2: One-Time Consent

When Yash first assigns a task to Ameet (Ameet is on RemindKar, status = `pending`):

```
→ Ameet receives:
  "Yash wants to send you tasks and reminders via RemindKar.
   [Allow]  [Decline]"

Allow  → contacts.status = 'approved'
       → All queued memory_participants with pending_consent → active
       → Future tasks from Yash flow through with zero friction

Decline → contacts.status = 'declined'
        → Queued participants → declined
        → Yash notified: "Ameet declined your request."
```

Callback format: `consent_allow:<contact_id>` / `consent_decline:<contact_id>`

**After approval:** No further consent prompts. Yash can assign unlimited tasks to Ameet.

### Flow 3: Delegation

```
Yash: "remind Ameet to send the invoice by Friday"

1. Gemini parses → target_people: ["Ameet"], due_date: Friday
2. Lookup "Ameet" in Yash's contacts:
   - Not found → contact linking flow (Flow 1)
   - Found, status = blocked → "Ameet is not accepting tasks right now."
   - Found, status = declined → "Ameet is not accepting tasks right now."
   - Found, status = pending → create task, participant status = pending_consent
   - Found, status = approved → proceed
3. Create memory:
   - telegram_id = Yash (creator)
   - is_shared = true
   - description, due_date, type, entities, etc.
4. Create memory_participants:
   - participant_telegram_id = Ameet
   - role = 'assignee'
   - status = 'active' (if approved) or 'pending_consent' (if pending)
5. If active: Notify Ameet immediately:
   "📥 Yash assigned you: Send the invoice (due Friday)"
6. Confirm to Yash:
   "✅ Assigned to Ameet: Send the invoice (due Friday)"
```

### Flow 4: Fan-Out

```
Yash: "remind me and Ameet about tonight's call at 8 PM"

1. Gemini parses → target_people: ["Ameet"], self-included
2. Create memory (telegram_id = Yash, is_shared = true, reminder_at = 8 PM UTC)
3. Create memory_participants:
   - Yash: role = 'creator', status = 'active'
   - Ameet: role = 'assignee', status = 'active' (if approved)
4. At 8 PM, send-reminders fires for both participants independently
5. Each can done/snooze independently — participant rows are independent
```

### Flow 5: Non-User Recipient

```
Yash: "remind Priya to call the vendor"
→ Yash shares Priya's contact (Priya not on RemindKar)

1. Contact created:
   - owner_telegram_id = Yash
   - contact_telegram_id = Priya's TG id (from contact share)
   - contact_phone = Priya's phone
   - status = 'pending'

2. Memory created (is_shared = true)
   memory_participants: status = 'pending_invite'

3. Bot sends Priya (via her telegram_id):
   "Yash wants to share a task with you on RemindKar!
    [Join RemindKar]"
   Deep link: /start invite_<contact_id>

4. Yash sees:
   "✅ Task saved. Priya isn't on RemindKar yet — I've sent her an invite."
```

**On Priya joining (/start invite_\<contact_id\>):**

1. Deep link payload parsed → contact row found
2. `contact.contact_telegram_id` confirmed (matches Priya's telegram_id)
3. `contact.status = 'approved'` (clicking invite link = implicit consent)
4. All `memory_participants` with `pending_invite` for Priya from this sender → `active`
5. Priya sees queued tasks in `/pending`
6. Yash notified: "Priya joined RemindKar! Your task has been delivered."

**7-day expiry (if Priya never joins):**

- Checked lazily (on next interaction from Yash) or via periodic cron
- `memory_participants.status` → `expired`
- Yash notified: "Priya hasn't joined yet. Want me to remind just you instead?"
  - `[Remind me instead]` → creates a solo copy for Yash
  - `[Keep waiting]` → extends expiry by 7 more days

### Flow 6: Recipient Experience

**`/pending` for Ameet shows:**

```
Your pending items:

1. Buy groceries (due today)
2. 📥 Send the invoice (due Fri) — from Yash
3. Call dentist
```

Received tasks are interleaved with own tasks, sorted by due date, tagged with sender name.

**Actions on received tasks:**

| Action | Effect |
|---|---|
| Done (button/text) | `memory_participants.status = 'done'`, `completed_at` set. Creator notified. |
| Snooze | Updates participant row only. Independent of other participants. |
| Delete/Dismiss | `memory_participants.status = 'declined'`. Memory itself unaffected. Creator NOT notified (no guilt-tripping). |

### Flow 7: Creator Done-Notification

When Ameet marks a delegated task as done:

1. `memory_participants.status = 'done'`, `completed_at = now()`
2. Look up creator: `memories.telegram_id` where `memories.id = memory_id`
3. Send creator: "Ameet completed: Send the invoice"
4. Non-fatal: if creator has blocked the bot, notification silently fails

Only fires on **done**. No notifications for snooze, dismiss, or ignore.

### Flow 8: Block/Mute

Ameet can block any sender:

```
/block
→ "Who would you like to block?
   1) Yash
   2) Priya"

Pick Yash →
  - contacts.status = 'blocked' (on all of Yash's contact rows pointing to Ameet)
  - All active memory_participants from Yash → declined
  - Future assignments from Yash auto-rejected
```

Yash sees a generic message on future attempts: "Ameet is not accepting tasks right now." (No explicit "blocked" — privacy.)

`/unblock` reverses: `contacts.status = 'approved'`.

## send-reminders Changes

Current logic queries `memories` directly. New logic is additive:

**Solo reminders (unchanged):**
```sql
SELECT * FROM memories
WHERE status = 'pending' AND is_reminded = false AND is_shared = false
  AND reminder_at <= now() AND reminder_at IS NOT NULL;
```

**Shared reminders (new):**
```sql
SELECT m.*, mp.participant_telegram_id, mp.is_reminded AS mp_is_reminded
FROM memory_participants mp
JOIN memories m ON m.id = mp.memory_id
WHERE mp.status = 'active' AND mp.is_reminded = false
  AND m.reminder_at <= now() AND m.reminder_at IS NOT NULL;
```

Each participant's `is_reminded` and `is_pre_reminded` are tracked on their own `memory_participants` row. Same pattern for pre-reminders.

## send-digest Changes

For each user, the digest includes:
- Solo pending tasks (existing query, add `AND is_shared = false`)
- Received active tasks (new query on `memory_participants WHERE participant_telegram_id = user AND status = 'active'`)

Received tasks appear in a separate "Assigned to you" section in the digest.

## New Commands

| Command | Purpose |
|---|---|
| `/contacts` | List your contacts and their approval status |
| `/block` | Block a sender from assigning you tasks |
| `/unblock` | Unblock a previously blocked sender |
| `/assigned` | Show tasks you've assigned to others and their status (pending/done) |

## Telegram Message Types

This feature introduces handling of a new Telegram message type: `contact`. The `TelegramMessage` interface needs a `contact` field:

```typescript
interface TelegramContact {
  phone_number: string;
  first_name: string;
  last_name?: string;
  user_id?: number;  // telegram_id, present if contact is a Telegram user
}
```

The `handleUpdate` function routes `message.contact` to a new `handleContactShare` handler.

## Edge Cases

| Edge Case | Handling |
|---|---|
| Self-assignment ("remind me to...") | Solo task. `target_people = []`. Current flow, unchanged. |
| Creator edits shared task (description/due_date) | Update propagates to all participants — single source of truth on `memories` row. |
| Creator deletes shared task | `ON DELETE CASCADE` removes all participant rows. Participants notified: "Yash cancelled: {task description}". |
| Mixed known/unknown contacts | "remind Ameet and Priya..." — Ameet known, Priya unknown. Task created for Ameet immediately. Bot prompts to share Priya's contact. Priya added as participant when contact shared. |
| Due date passes while pending invite | Task still delivered on join with "overdue" tag. Recipient can dismiss. |
| Multiple queued tasks for non-user | All activate on join. Delivered as batch: "Yash has 3 tasks waiting for you." |
| Voice notes with people names | Transcription → parse → same `target_people` extraction. No change to voice pipeline. |
| Blocked sender tries to assign | Auto-rejected. "Ameet is not accepting tasks right now." |
| Contact shared without telegram user_id | Store phone only. Match on `/start` if user shares own contact during onboarding. Fallback: manual linking. |
| Recipient not on Telegram at all | Phone stored but no telegram_id available. Bot cannot message them. Sender informed: "I can only reach Telegram users for now." |
| Sender assigns to themselves by name | "remind Yash to..." where Yash is the sender. Detected by matching `target_people` name against sender's own first_name. Treated as solo task. |

## Migration Summary

Single migration file: `012_shared_reminders.sql`

```sql
-- 1. users: add phone_number
ALTER TABLE public.users ADD COLUMN phone_number text UNIQUE;

-- 2. memories: add is_shared flag
ALTER TABLE public.memories ADD COLUMN is_shared boolean DEFAULT false;

-- 3. contacts table
CREATE TABLE public.contacts ( ... );
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

-- 4. memory_participants table
CREATE TABLE public.memory_participants ( ... );
ALTER TABLE public.memory_participants ENABLE ROW LEVEL SECURITY;

-- 5. Indexes

-- 6. Archive tables + BEFORE DELETE triggers (following 006 pattern)

-- 7. Archive schema for new columns on users/memories
```

## What This Does NOT Change

- Solo task creation, editing, deletion — unchanged
- Existing Gemini prompt behavior for solo tasks — additive only
- Session context, number references ("delete 2") — unchanged for solo tasks
- Streaks, feedback, referrals — unchanged
- Voice pipeline — unchanged (transcribe → parse, target_people extracted from parse)
- All existing commands — unchanged behavior
- Database queries for solo tasks — add `is_shared = false` filter where needed, but solo tasks default to `is_shared = false` so existing data is unaffected
