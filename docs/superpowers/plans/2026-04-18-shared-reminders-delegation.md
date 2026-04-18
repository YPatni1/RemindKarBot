# Shared Reminders & Task Delegation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable users to delegate tasks to contacts and fan out reminders to multiple people, with a contacts book, one-time consent, and per-participant state tracking.

**Architecture:** Additive to existing solo-task flow. New `contacts` and `memory_participants` tables track shared state. Solo tasks (`is_shared = false`, 95% of usage) are completely untouched. Gemini returns a new `target_people` array; when non-empty, the bot resolves contacts, manages consent, creates participant rows, and fans out reminders independently per participant.

**Tech Stack:** Supabase PostgreSQL (migration), Deno/TypeScript (Edge Functions), Gemini 2.5 Flash (NLU), Telegram Bot API

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `supabase/migrations/012_shared_reminders.sql` | Create | Schema: new tables, columns, indexes, archive tables, triggers |
| `supabase/functions/_shared/types.ts` | Modify | Add `TelegramContact`, `DbContact`, `DbMemoryParticipant`; extend `GeminiParsedResponse` with `target_people`, `include_creator` |
| `supabase/functions/_shared/database.ts` | Modify | Add CRUD for contacts and memory_participants; add shared-reminder queries |
| `supabase/functions/_shared/gemini.ts` | Modify | Add `target_people` and `include_creator` to Gemini system prompt |
| `supabase/functions/_shared/formatters.ts` | Modify | Add `formatAssignedConfirmation`, `formatReceivedPendingList`; modify `formatPendingList` to tag received tasks |
| `supabase/functions/telegram-webhook/index.ts` | Modify | Add contact share handler, consent callbacks, delegation/fan-out routing in `routeParsedIntent`, new commands (`/contacts`, `/block`, `/unblock`, `/assigned`) |
| `supabase/functions/send-reminders/index.ts` | Modify | Add shared-reminder fan-out query alongside existing solo-reminder logic |
| `supabase/functions/send-digest/index.ts` | Modify | Add "Assigned to you" section for received tasks |

---

### Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/012_shared_reminders.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Migration 012: Shared reminders & task delegation
-- Adds: contacts table, memory_participants table, is_shared on memories,
--        phone_number on users, archive tables + triggers

-- =============================================================
-- 1. New columns on existing tables
-- =============================================================

ALTER TABLE public.users ADD COLUMN phone_number text UNIQUE;
ALTER TABLE public.memories ADD COLUMN is_shared boolean DEFAULT false;

-- =============================================================
-- 2. Contacts table (per-user private address book)
-- =============================================================

CREATE TABLE public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_telegram_id bigint NOT NULL,
  contact_telegram_id bigint,
  contact_phone text NOT NULL,
  nickname text NOT NULL,
  first_name text,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'blocked', 'declined')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(owner_telegram_id, contact_phone)
);

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 3. Memory participants table (per-person state for shared tasks)
-- =============================================================

CREATE TABLE public.memory_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
  participant_telegram_id bigint NOT NULL,
  role text NOT NULL CHECK (role IN ('creator', 'assignee')),
  status text DEFAULT 'pending_invite' CHECK (status IN (
    'pending_invite', 'pending_consent', 'active', 'done', 'snoozed', 'declined', 'expired'
  )),
  is_reminded boolean DEFAULT false,
  is_pre_reminded boolean DEFAULT false,
  snooze_count integer DEFAULT 0,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(memory_id, participant_telegram_id)
);

ALTER TABLE public.memory_participants ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 4. Indexes
-- =============================================================

CREATE INDEX idx_participants_recipient ON public.memory_participants(participant_telegram_id, status);
CREATE INDEX idx_participants_memory ON public.memory_participants(memory_id);
CREATE INDEX idx_contacts_owner ON public.contacts(owner_telegram_id);
CREATE INDEX idx_contacts_recipient ON public.contacts(contact_telegram_id);
CREATE INDEX idx_users_phone ON public.users(phone_number) WHERE phone_number IS NOT NULL;
CREATE INDEX idx_memories_shared ON public.memories(is_shared) WHERE is_shared = true;

-- =============================================================
-- 5. Archive tables (following 006 pattern)
-- =============================================================

CREATE TABLE public.archived_contacts (
  archive_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id uuid NOT NULL,
  owner_telegram_id bigint NOT NULL,
  contact_telegram_id bigint,
  contact_phone text,
  nickname text,
  first_name text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz DEFAULT now(),
  deletion_type text NOT NULL DEFAULT 'direct'
);

ALTER TABLE public.archived_contacts ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.archived_memory_participants (
  archive_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id uuid NOT NULL,
  memory_id uuid NOT NULL,
  participant_telegram_id bigint NOT NULL,
  role text,
  status text,
  is_reminded boolean,
  is_pre_reminded boolean,
  snooze_count integer,
  completed_at timestamptz,
  created_at timestamptz,
  deleted_at timestamptz DEFAULT now(),
  deletion_type text NOT NULL DEFAULT 'direct'
);

ALTER TABLE public.archived_memory_participants ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 6. Archive trigger functions
-- =============================================================

CREATE OR REPLACE FUNCTION archive_contact_before_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_deletion_type text;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    v_deletion_type := 'account_cascade';
  ELSE
    v_deletion_type := 'direct';
  END IF;

  INSERT INTO public.archived_contacts (
    id, owner_telegram_id, contact_telegram_id, contact_phone,
    nickname, first_name, status, created_at, updated_at,
    deleted_at, deletion_type
  ) VALUES (
    OLD.id, OLD.owner_telegram_id, OLD.contact_telegram_id, OLD.contact_phone,
    OLD.nickname, OLD.first_name, OLD.status, OLD.created_at, OLD.updated_at,
    now(), v_deletion_type
  );
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION archive_participant_before_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_deletion_type text;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    v_deletion_type := 'account_cascade';
  ELSE
    v_deletion_type := 'direct';
  END IF;

  INSERT INTO public.archived_memory_participants (
    id, memory_id, participant_telegram_id, role, status,
    is_reminded, is_pre_reminded, snooze_count, completed_at, created_at,
    deleted_at, deletion_type
  ) VALUES (
    OLD.id, OLD.memory_id, OLD.participant_telegram_id, OLD.role, OLD.status,
    OLD.is_reminded, OLD.is_pre_reminded, OLD.snooze_count, OLD.completed_at, OLD.created_at,
    now(), v_deletion_type
  );
  RETURN OLD;
END;
$$;

-- =============================================================
-- 7. Bind archive triggers
-- =============================================================

CREATE TRIGGER trg_archive_contact
  BEFORE DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION archive_contact_before_delete();

CREATE TRIGGER trg_archive_participant
  BEFORE DELETE ON public.memory_participants
  FOR EACH ROW EXECUTE FUNCTION archive_participant_before_delete();

-- =============================================================
-- 8. Update archived_users and archived_memories for new columns
-- =============================================================

ALTER TABLE public.archived_users ADD COLUMN IF NOT EXISTS phone_number text;
ALTER TABLE public.archived_memories ADD COLUMN IF NOT EXISTS is_shared boolean DEFAULT false;

-- Rewrite user archive trigger to include phone_number
CREATE OR REPLACE FUNCTION archive_user_before_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.archived_users (
    id, telegram_id, telegram_username, first_name,
    consent_given, consent_given_at, created_at, timezone,
    is_active, last_active_at,
    current_streak, longest_streak, last_streak_date,
    referral_code, referred_by, phone_number,
    deleted_at, deletion_type
  ) VALUES (
    OLD.id, OLD.telegram_id, OLD.telegram_username, OLD.first_name,
    OLD.consent_given, OLD.consent_given_at, OLD.created_at, OLD.timezone,
    OLD.is_active, OLD.last_active_at,
    OLD.current_streak, OLD.longest_streak, OLD.last_streak_date,
    OLD.referral_code, OLD.referred_by, OLD.phone_number,
    now(), 'account_delete'
  );
  RETURN OLD;
END;
$$;

-- Rewrite memory archive trigger to include is_shared
CREATE OR REPLACE FUNCTION archive_memory_before_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_deletion_type text;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    v_deletion_type := 'account_cascade';
  ELSE
    v_deletion_type := 'direct';
  END IF;

  INSERT INTO public.archived_memories (
    id, user_id, telegram_id, type, description, raw_input,
    due_date, reminder_at, entities, recurrence, status,
    is_reminded, is_pre_reminded, source, created_at, completed_at,
    description_embedding, snooze_count, is_shared,
    deleted_at, deletion_type
  ) VALUES (
    OLD.id, OLD.user_id, OLD.telegram_id, OLD.type, OLD.description, OLD.raw_input,
    OLD.due_date, OLD.reminder_at, OLD.entities, OLD.recurrence, OLD.status,
    OLD.is_reminded, OLD.is_pre_reminded, OLD.source, OLD.created_at, OLD.completed_at,
    OLD.description_embedding, OLD.snooze_count, OLD.is_shared,
    now(), v_deletion_type
  );
  RETURN OLD;
END;
$$;
```

- [ ] **Step 2: Apply migration**

Run: `npx supabase db push --linked`

Expected: Migration applies cleanly. Tables `contacts`, `memory_participants`, `archived_contacts`, `archived_memory_participants` created. Columns `users.phone_number`, `memories.is_shared` added.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/012_shared_reminders.sql
git commit -m "feat: add schema for shared reminders and task delegation"
```

---

### Task 2: TypeScript Types

**Files:**
- Modify: `supabase/functions/_shared/types.ts`

- [ ] **Step 1: Add TelegramContact to TelegramMessage**

In `supabase/functions/_shared/types.ts`, add the `TelegramContact` interface after `TelegramVoice`, and add `contact?: TelegramContact` to `TelegramMessage`:

```typescript
export interface TelegramContact {
  phone_number: string;
  first_name: string;
  last_name?: string;
  user_id?: number;
}
```

Add to `TelegramMessage`:
```typescript
contact?: TelegramContact;
```

- [ ] **Step 2: Add target_people and include_creator to GeminiParsedResponse**

Add these two fields to the `GeminiParsedResponse` interface:

```typescript
target_people: string[];
include_creator: boolean;
```

- [ ] **Step 3: Add DbContact and DbMemoryParticipant interfaces**

Add after `DbMemory`:

```typescript
export interface DbContact {
  id: string;
  owner_telegram_id: number;
  contact_telegram_id: number | null;
  contact_phone: string;
  nickname: string;
  first_name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface DbMemory {
  // ... existing fields ...
  is_shared: boolean;
}
```

Add `is_shared` to the existing `DbMemory` interface (after `snooze_count`):

```typescript
  is_shared: boolean;
```

Add after `DbMemory`:

```typescript
export interface DbMemoryParticipant {
  id: string;
  memory_id: string;
  participant_telegram_id: number;
  role: string;
  status: string;
  is_reminded: boolean;
  is_pre_reminded: boolean;
  snooze_count: number;
  completed_at: string | null;
  created_at: string;
}
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/types.ts
git commit -m "feat: add types for contacts, participants, and shared task fields"
```

---

### Task 3: Database Functions for Contacts

**Files:**
- Modify: `supabase/functions/_shared/database.ts`

- [ ] **Step 1: Add imports for new types**

Add `DbContact` and `DbMemoryParticipant` to the import from `./types.ts`:

```typescript
import { DbUser, DbMemory, DbContact, DbMemoryParticipant, ConversationMessage } from "./types.ts";
```

- [ ] **Step 2: Add contacts CRUD functions**

Add after the Referrals section in `database.ts`:

```typescript
// ---- Contacts ----

export async function getContactsByOwner(ownerTelegramId: number): Promise<DbContact[]> {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("owner_telegram_id", ownerTelegramId)
    .order("nickname", { ascending: true });
  if (error) throw error;
  return (data ?? []) as DbContact[];
}

export async function getContactByNickname(
  ownerTelegramId: number,
  nickname: string,
): Promise<DbContact[]> {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("owner_telegram_id", ownerTelegramId)
    .ilike("nickname", nickname);
  if (error) throw error;
  return (data ?? []) as DbContact[];
}

export async function getContactById(contactId: string): Promise<DbContact | null> {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .maybeSingle();
  if (error) throw error;
  return data as DbContact | null;
}

export async function createContact(contact: {
  owner_telegram_id: number;
  contact_telegram_id: number | null;
  contact_phone: string;
  nickname: string;
  first_name: string | null;
  status?: string;
}): Promise<DbContact> {
  const { data, error } = await supabase
    .from("contacts")
    .insert(contact)
    .select()
    .single();
  if (error) throw error;
  return data as DbContact;
}

export async function updateContact(
  contactId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("contacts")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", contactId);
  if (error) throw error;
}

// Get all senders who have approved status for a given recipient
export async function getApprovedSenders(recipientTelegramId: number): Promise<DbContact[]> {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("contact_telegram_id", recipientTelegramId)
    .eq("status", "approved");
  if (error) throw error;
  return (data ?? []) as DbContact[];
}

// Block a sender: update all contact rows where this sender points to this recipient
export async function blockSender(
  senderTelegramId: number,
  recipientTelegramId: number,
): Promise<void> {
  const { error } = await supabase
    .from("contacts")
    .update({ status: "blocked", updated_at: new Date().toISOString() })
    .eq("owner_telegram_id", senderTelegramId)
    .eq("contact_telegram_id", recipientTelegramId);
  if (error) throw error;
}

// Unblock a sender
export async function unblockSender(
  senderTelegramId: number,
  recipientTelegramId: number,
): Promise<void> {
  const { error } = await supabase
    .from("contacts")
    .update({ status: "approved", updated_at: new Date().toISOString() })
    .eq("owner_telegram_id", senderTelegramId)
    .eq("contact_telegram_id", recipientTelegramId);
  if (error) throw error;
}
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/database.ts
git commit -m "feat: add contacts CRUD functions"
```

---

### Task 4: Database Functions for Memory Participants

**Files:**
- Modify: `supabase/functions/_shared/database.ts`

- [ ] **Step 1: Add memory_participants CRUD functions**

Add after the contacts section:

```typescript
// ---- Memory Participants ----

export async function createParticipant(participant: {
  memory_id: string;
  participant_telegram_id: number;
  role: string;
  status: string;
}): Promise<DbMemoryParticipant> {
  const { data, error } = await supabase
    .from("memory_participants")
    .insert(participant)
    .select()
    .single();
  if (error) throw error;
  return data as DbMemoryParticipant;
}

export async function updateParticipant(
  participantId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("memory_participants")
    .update(updates)
    .eq("id", participantId);
  if (error) throw error;
}

// Get active received tasks for a user (for /pending integration)
export async function getReceivedTasks(
  participantTelegramId: number,
): Promise<(DbMemoryParticipant & { memory: DbMemory })[]> {
  const { data, error } = await supabase
    .from("memory_participants")
    .select("*, memory:memories(*)")
    .eq("participant_telegram_id", participantTelegramId)
    .eq("status", "active")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as (DbMemoryParticipant & { memory: DbMemory })[];
}

// Get participant row for a specific memory and user
export async function getParticipant(
  memoryId: string,
  participantTelegramId: number,
): Promise<DbMemoryParticipant | null> {
  const { data, error } = await supabase
    .from("memory_participants")
    .select("*")
    .eq("memory_id", memoryId)
    .eq("participant_telegram_id", participantTelegramId)
    .maybeSingle();
  if (error) throw error;
  return data as DbMemoryParticipant | null;
}

// Get all participants for a memory
export async function getParticipants(
  memoryId: string,
): Promise<DbMemoryParticipant[]> {
  const { data, error } = await supabase
    .from("memory_participants")
    .select("*")
    .eq("memory_id", memoryId);
  if (error) throw error;
  return (data ?? []) as DbMemoryParticipant[];
}

// Get tasks assigned BY a user (for /assigned command)
export async function getAssignedByUser(
  creatorTelegramId: number,
): Promise<(DbMemoryParticipant & { memory: DbMemory })[]> {
  const { data, error } = await supabase
    .from("memory_participants")
    .select("*, memory:memories(*)")
    .eq("role", "assignee")
    .in("status", ["active", "pending_consent", "pending_invite", "done"])
    .order("created_at", { ascending: false });
  if (error) throw error;
  // Filter to only memories created by this user
  const filtered = (data ?? []).filter(
    (d: Record<string, unknown>) => (d.memory as DbMemory)?.telegram_id === creatorTelegramId,
  );
  return filtered as (DbMemoryParticipant & { memory: DbMemory })[];
}

// Activate all pending participants for a contact (on consent approval or invite join)
export async function activateParticipantsForContact(
  senderTelegramId: number,
  recipientTelegramId: number,
  fromStatus: string,
): Promise<DbMemoryParticipant[]> {
  // Find all memories by sender that have participants with the given status for this recipient
  const { data: participants, error: fetchErr } = await supabase
    .from("memory_participants")
    .select("*, memory:memories(*)")
    .eq("participant_telegram_id", recipientTelegramId)
    .eq("status", fromStatus);
  if (fetchErr) throw fetchErr;

  const toActivate = (participants ?? []).filter(
    (p: Record<string, unknown>) => (p.memory as DbMemory)?.telegram_id === senderTelegramId,
  );

  for (const p of toActivate) {
    await updateParticipant((p as DbMemoryParticipant).id, { status: "active" });
  }

  return toActivate as (DbMemoryParticipant & { memory: DbMemory })[];
}

// Decline all pending participants from a sender for a recipient (on consent decline or block)
export async function declineParticipantsFromSender(
  senderTelegramId: number,
  recipientTelegramId: number,
): Promise<void> {
  const { data: participants, error: fetchErr } = await supabase
    .from("memory_participants")
    .select("id, memory:memories(telegram_id)")
    .eq("participant_telegram_id", recipientTelegramId)
    .in("status", ["active", "pending_consent", "pending_invite"]);
  if (fetchErr) throw fetchErr;

  const toDecline = (participants ?? []).filter(
    (p: Record<string, unknown>) => {
      const mem = p.memory as Record<string, unknown> | null;
      return mem?.telegram_id === senderTelegramId;
    },
  );

  for (const p of toDecline) {
    await updateParticipant((p as { id: string }).id, { status: "declined" });
  }
}

// For send-reminders: get shared task reminders due now
export async function getDueSharedReminders(): Promise<
  (DbMemoryParticipant & { memory: DbMemory })[]
> {
  const { data, error } = await supabase
    .from("memory_participants")
    .select("*, memory:memories(*)")
    .eq("status", "active")
    .eq("is_reminded", false);
  if (error) throw error;

  // Filter to memories with reminder_at <= now
  const now = new Date().toISOString();
  return ((data ?? []) as (DbMemoryParticipant & { memory: DbMemory })[]).filter(
    (p) => p.memory?.reminder_at && p.memory.reminder_at <= now,
  );
}

// For send-reminders: get shared task pre-reminders (30 min before due_date)
export async function getDueSharedPreReminders(): Promise<
  (DbMemoryParticipant & { memory: DbMemory })[]
> {
  const now = new Date();
  const min25 = new Date(now.getTime() + 25 * 60 * 1000).toISOString();
  const min35 = new Date(now.getTime() + 35 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("memory_participants")
    .select("*, memory:memories(*)")
    .eq("status", "active")
    .eq("is_pre_reminded", false);
  if (error) throw error;

  return ((data ?? []) as (DbMemoryParticipant & { memory: DbMemory })[]).filter(
    (p) => p.memory?.due_date && p.memory.due_date >= min25 && p.memory.due_date <= min35,
  );
}

// For send-digest: get received active tasks for digest
export async function getReceivedDigestTasks(
  participantTelegramId: number,
): Promise<DbMemory[]> {
  const { data, error } = await supabase
    .from("memory_participants")
    .select("memory:memories(*)")
    .eq("participant_telegram_id", participantTelegramId)
    .eq("status", "active");
  if (error) throw error;
  return ((data ?? []) as { memory: DbMemory }[]).map((d) => d.memory);
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/database.ts
git commit -m "feat: add memory_participants CRUD and shared reminder queries"
```

---

### Task 5: Gemini Prompt Updates

**Files:**
- Modify: `supabase/functions/_shared/gemini.ts`

- [ ] **Step 1: Add target_people and include_creator to the JSON schema in the system prompt**

In `gemini.ts`, find the JSON structure description in `PARSE_SYSTEM_PROMPT`. After the `"query_date_end"` field, add:

```
  "target_people": ["List of people names the task/reminder should be sent TO (not the sender). Empty array if task is for the sender only. Extract names from phrases like 'remind Ameet to...', 'tell Priya and Raj about...'. Do NOT include the sender/user themselves."],
  "include_creator": "true if the sender also wants to be a participant (phrases like 'remind me and Ameet', 'remind us', 'me, Yash, and Ameet'). false if task is only for others ('remind Ameet to...', 'tell Priya about...'). false if target_people is empty."
```

- [ ] **Step 2: Add parsing rules for target_people**

Add to the "General rules" section in the Gemini prompt, after the existing rules:

```
- If the user mentions other people as task recipients ("remind Ameet to...", "tell Priya about..."), extract their names into target_people array. Do NOT include the sender.
- "remind me and Ameet about..." → target_people: ["Ameet"], include_creator: true (user wants to be included)
- "remind Ameet to send invoice" → target_people: ["Ameet"], include_creator: false (task is only for Ameet)
- "remind us about the call" → target_people: [], include_creator: true (if no specific names, treat as solo task for the user)
- "tell Priya and Raj about the meeting" → target_people: ["Priya", "Raj"], include_creator: false
- Hindi/Marathi: "Ameet ko yaad dila do" → target_people: ["Ameet"], include_creator: false
- "mujhe aur Ameet ko remind kar" → target_people: ["Ameet"], include_creator: true
- "hum sabko yaad dila" → target_people: [], include_creator: true (no specific names = solo task)
- If target_people is empty, always set include_creator to false (solo task, default behavior).
```

- [ ] **Step 3: Add few-shot examples for target_people**

Add to the few-shot examples section:

```
User: "remind Ameet to send the invoice by Friday"
→ {"intent":"task","description":"Send the invoice","due_date":"...Friday UTC...","target_people":["Ameet"],"include_creator":false,...}

User: "remind me and Priya about tonight's call at 8 PM"
→ {"intent":"reminder","description":"Tonight's call","due_date":"...8PM UTC...","target_people":["Priya"],"include_creator":true,...}

User: "Ameet ko bol ki report bhej de kal tak"
→ {"intent":"task","description":"Report bhej do","due_date":"...tomorrow UTC...","target_people":["Ameet"],"include_creator":false,...}
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/gemini.ts
git commit -m "feat: add target_people and include_creator to Gemini prompt"
```

---

### Task 6: Contact Share Handler

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`

- [ ] **Step 1: Add imports for new database functions**

Add to the imports from `database.ts` in `index.ts`:

```typescript
import {
  // ... existing imports ...
  getContactByNickname,
  getContactById,
  createContact,
  updateContact,
  getApprovedSenders,
  blockSender,
  unblockSender,
  getContactsByOwner,
  createParticipant,
  updateParticipant,
  getReceivedTasks,
  getParticipant,
  getParticipants,
  getAssignedByUser,
  activateParticipantsForContact,
  declineParticipantsFromSender,
} from "../_shared/database.ts";
```

Also add `DbContact, DbMemoryParticipant` to the imports from `types.ts`.

- [ ] **Step 2: Route contact messages in handleUpdate**

In `handleUpdate`, after the `message.forward_date` check and before the `userText.startsWith("/")` check, add:

```typescript
if (message.contact) {
  await handleContactShare(message, startMs);
  return;
}
```

- [ ] **Step 3: Write handleContactShare function**

Add the `handleContactShare` function (before `handleText`):

```typescript
async function handleContactShare(message: TelegramMessage, startMs = Date.now()): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;
  const contact = message.contact!;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first and give consent.");
    return;
  }

  const session = await getSession(telegramId);
  const sessionId = session?.session_id ?? crypto.randomUUID();

  // Check if we're awaiting a contact share for a pending task
  const awaitingContact = session?.last_intent?.startsWith("awaiting_contact:");
  const originalMessage = awaitingContact
    ? session!.last_intent!.split("awaiting_contact:")[1]
    : null;

  // Create or update contact
  const existingContacts = await getContactByNickname(telegramId, contact.first_name);
  const existingByPhone = existingContacts.find((c) => c.contact_phone === contact.phone_number);

  let dbContact: DbContact;
  if (existingByPhone) {
    // Update existing contact with telegram_id if we didn't have it
    if (!existingByPhone.contact_telegram_id && contact.user_id) {
      await updateContact(existingByPhone.id, { contact_telegram_id: contact.user_id });
    }
    dbContact = { ...existingByPhone, contact_telegram_id: contact.user_id ?? existingByPhone.contact_telegram_id };
  } else {
    dbContact = await createContact({
      owner_telegram_id: telegramId,
      contact_telegram_id: contact.user_id ?? null,
      contact_phone: contact.phone_number,
      nickname: contact.first_name,
      first_name: contact.first_name + (contact.last_name ? ` ${contact.last_name}` : ""),
    });
  }

  // Check if contact is on RemindKar
  let isOnRemindKar = false;
  if (dbContact.contact_telegram_id) {
    const contactUser = await getUser(dbContact.contact_telegram_id);
    isOnRemindKar = !!contactUser?.consent_given;
  }

  if (isOnRemindKar && dbContact.status === "pending") {
    // Send consent request to the contact
    const senderName = escapeHtml(user.first_name || "Someone");
    await sendMessageWithButtons(dbContact.contact_telegram_id!, 
      `${senderName} wants to send you tasks and reminders via RemindKar.`, [
      [
        { text: "\u{2705} Allow", callback_data: `consent_allow:${dbContact.id}` },
        { text: "\u{274C} Decline", callback_data: `consent_decline:${dbContact.id}` },
      ],
    ]);
  } else if (!isOnRemindKar && dbContact.contact_telegram_id) {
    // Send invite to non-user
    const deepLink = `https://t.me/${BOT_HANDLE}?start=invite_${dbContact.id}`;
    const senderName = escapeHtml(user.first_name || "Someone");
    await sendMessageWithButtons(dbContact.contact_telegram_id,
      `${senderName} wants to share tasks with you on RemindKar!`, [
      [{ text: "\u{1F680} Join RemindKar", url: deepLink }],
    ]);
  }

  const contactName = escapeHtml(dbContact.nickname);
  if (!isOnRemindKar && !dbContact.contact_telegram_id) {
    await sendMessage(chatId, `I can only reach Telegram users for now. ${contactName}'s contact doesn't have a linked Telegram account.`);
  } else if (!isOnRemindKar) {
    await sendMessage(chatId, `\u{2705} Contact saved: ${contactName}. I've sent them an invite to RemindKar.`);
  } else if (dbContact.status === "approved") {
    await sendMessage(chatId, `\u{2705} ${contactName} is already in your contacts.`);
  } else {
    await sendMessage(chatId, `\u{2705} Contact saved: ${contactName}. I've sent them a consent request.`);
  }

  // If we had a pending task message, re-process it now
  if (originalMessage) {
    const history = session?.conversation_history ?? [];
    const parsedItems = await parseMessage(originalMessage, history, user.timezone);
    for (const parsed of parsedItems) {
      await routeParsedIntent(chatId, telegramId, user.id, originalMessage, parsed, "text", user.timezone);
    }
  }

  await logInteraction({
    telegram_id: telegramId,
    user_message: `[contact_share:${contact.first_name}]`,
    message_type: "contact",
    primary_intent: "contact_share",
    bot_action: isOnRemindKar ? "contact_linked" : "invite_sent",
    session_id: sessionId,
    processing_time_ms: Date.now() - startMs,
    user_timezone: user.timezone,
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/telegram-webhook/index.ts
git commit -m "feat: add contact share handler with consent and invite flows"
```

---

### Task 7: Consent Callbacks

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`

- [ ] **Step 1: Add consent_allow and consent_decline callback handlers**

In `handleCallbackQuery`, after the `consent_no` handler block, add:

```typescript
// Shared task consent: recipient allows sender
if (data.startsWith("consent_allow:")) {
  const contactId = data.slice(14);
  const contact = await getContactById(contactId);
  if (!contact) {
    await answerCallbackQuery(query.id, "Contact not found.");
    return;
  }

  await updateContact(contactId, { status: "approved" });
  await answerCallbackQuery(query.id, "Allowed!");

  if (chatId && messageId) {
    const senderUser = await getUser(contact.owner_telegram_id);
    const senderName = escapeHtml(senderUser?.first_name || "They");
    await editMessageText(chatId, messageId, `\u{2705} You've allowed ${senderName} to send you tasks.`);
  }

  // Activate all queued tasks from this sender
  const activated = await activateParticipantsForContact(
    contact.owner_telegram_id,
    telegramId,
    "pending_consent",
  );

  // Notify recipient about activated tasks
  if (activated.length > 0 && chatId) {
    const senderUser = await getUser(contact.owner_telegram_id);
    const senderName = escapeHtml(senderUser?.first_name || "Someone");
    const taskList = activated.map(
      (p) => `  \u{2022} ${escapeHtml((p as DbMemoryParticipant & { memory: DbMemory }).memory?.description ?? "")}`
    ).join("\n");
    await sendMessage(chatId, `\u{1F4E5} ${senderName} has ${activated.length} task${activated.length > 1 ? "s" : ""} for you:\n${taskList}`);
  }

  // Notify sender that consent was given
  try {
    const recipientUser = await getUser(telegramId);
    const recipientName = escapeHtml(recipientUser?.first_name || "Your contact");
    await sendMessage(contact.owner_telegram_id, `\u{2705} ${recipientName} accepted your task sharing request!`);
  } catch { /* non-fatal */ }

  return;
}

// Shared task consent: recipient declines sender
if (data.startsWith("consent_decline:")) {
  const contactId = data.slice(16);
  const contact = await getContactById(contactId);
  if (!contact) {
    await answerCallbackQuery(query.id, "Contact not found.");
    return;
  }

  await updateContact(contactId, { status: "declined" });
  await answerCallbackQuery(query.id, "Declined.");

  if (chatId && messageId) {
    await editMessageText(chatId, messageId, "You've declined this request.");
  }

  // Decline all queued tasks from this sender
  await declineParticipantsFromSender(contact.owner_telegram_id, telegramId);

  // Notify sender (generic message)
  try {
    const recipientUser = await getUser(telegramId);
    const recipientName = escapeHtml(recipientUser?.first_name || "Your contact");
    await sendMessage(contact.owner_telegram_id, `${recipientName} declined your task sharing request.`);
  } catch { /* non-fatal */ }

  return;
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/telegram-webhook/index.ts
git commit -m "feat: add consent allow/decline callback handlers"
```

---

### Task 8: Delegation & Fan-Out in routeParsedIntent

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`

This is the core feature logic. When Gemini returns `target_people` with entries, the storage intent handler in `routeParsedIntent` forks into the shared-task path.

- [ ] **Step 1: Add resolveTargetPeople helper function**

Add before `routeParsedIntent`:

```typescript
// Resolve target_people names to contacts. Returns resolved contacts and unresolved names.
async function resolveTargetPeople(
  ownerTelegramId: number,
  targetPeople: string[],
  ownerFirstName: string | null,
): Promise<{
  resolved: DbContact[];
  ambiguous: { name: string; matches: DbContact[] }[];
  unknown: string[];
}> {
  const resolved: DbContact[] = [];
  const ambiguous: { name: string; matches: DbContact[] }[] = [];
  const unknown: string[] = [];

  for (const name of targetPeople) {
    // Skip self-assignment
    if (ownerFirstName && name.toLowerCase() === ownerFirstName.toLowerCase()) {
      continue;
    }

    const matches = await getContactByNickname(ownerTelegramId, name);
    // Filter out blocked/declined contacts
    const activeMatches = matches.filter((c) => c.status !== "blocked" && c.status !== "declined");

    if (activeMatches.length === 1) {
      resolved.push(activeMatches[0]);
    } else if (activeMatches.length > 1) {
      ambiguous.push({ name, matches: activeMatches });
    } else if (matches.some((c) => c.status === "blocked" || c.status === "declined")) {
      // Contact exists but is blocked/declined — treat as "not accepting"
      unknown.push(name); // Will show "not accepting tasks" message
    } else {
      unknown.push(name);
    }
  }

  return { resolved, ambiguous, unknown };
}
```

- [ ] **Step 2: Modify the default (storage intent) case in routeParsedIntent**

In the `default` case of `routeParsedIntent`, after embedding generation and before `createMemory`, add a branch for shared tasks:

```typescript
    default: {
      // Storage intents: task, reminder, event, birthday, note
      let embedding: number[] | null = null;
      try {
        embedding = await generateEmbedding(parsed.description);
      } catch (err) {
        console.error("Embedding generation failed (non-fatal):", err);
      }

      // === SHARED TASK PATH ===
      if (parsed.target_people && parsed.target_people.length > 0) {
        const user = await getUser(telegramId);
        const { resolved, ambiguous, unknown } = await resolveTargetPeople(
          telegramId, parsed.target_people, user?.first_name ?? null,
        );

        // If there are ambiguous names, show picker for first one (defer the rest)
        if (ambiguous.length > 0) {
          const first = ambiguous[0];
          const pickerLines = [`Which ${escapeHtml(first.name)}?`];
          const pickerButtons: TelegramInlineKeyboardButton[][] = [];
          first.matches.forEach((c, i) => {
            const phoneLast4 = c.contact_phone.slice(-4);
            pickerLines.push(`${i + 1}) ${escapeHtml(c.first_name || c.nickname)} (...${phoneLast4})`);
            pickerButtons.push([{
              text: `${i + 1}. ${c.first_name || c.nickname}`,
              callback_data: `pick_contact:${c.id}`,
            }]);
          });
          // Store original message in session for re-processing after pick
          await saveSession(telegramId, [], `awaiting_contact_pick:${rawInput}`);
          await sendMessageWithButtons(chatId, pickerLines.join("\n"), pickerButtons);
          return { summary: "Ambiguous contact — showing picker", response: pickerLines.join("\n") };
        }

        // If there are unknown names, prompt to share contact for the first one
        if (unknown.length > 0) {
          const firstName = unknown[0];
          // Check if the name belongs to a blocked/declined contact
          const blockedMatches = await getContactByNickname(telegramId, firstName);
          const isBlocked = blockedMatches.some((c) => c.status === "blocked" || c.status === "declined");
          if (isBlocked) {
            const responseText = `${escapeHtml(firstName)} is not accepting tasks right now.`;
            await sendMessage(chatId, responseText);
            return { summary: `Contact blocked: ${firstName}`, response: responseText };
          }

          await saveSession(telegramId, [], `awaiting_contact:${rawInput}`);
          const responseText = `I don't know ${escapeHtml(firstName)} yet. Share their contact so I can link them.`;
          await sendMessage(chatId, responseText);
          return { summary: `Unknown contact: ${firstName}`, response: responseText };
        }

        // All contacts resolved — create shared memory
        const memory = await createMemory({
          user_id: userId,
          telegram_id: telegramId,
          type: parsed.intent,
          description: parsed.description,
          raw_input: rawInput,
          due_date: parsed.due_date,
          reminder_at: parsed.reminder_at,
          entities: parsed.entities,
          recurrence: parsed.recurrence,
          source,
          description_embedding: embedding,
          is_shared: true,
        });

        // Add creator as participant if fan-out (include_creator = true)
        if (parsed.include_creator) {
          await createParticipant({
            memory_id: memory.id,
            participant_telegram_id: telegramId,
            role: "creator",
            status: "active",
          });
        }

        // Add each resolved contact as participant
        const confirmParts: string[] = [];
        for (const contact of resolved) {
          const participantStatus = contact.status === "approved" ? "active"
            : (contact.contact_telegram_id ? "pending_consent" : "pending_invite");

          await createParticipant({
            memory_id: memory.id,
            participant_telegram_id: contact.contact_telegram_id ?? 0,
            role: "assignee",
            status: participantStatus,
          });

          const contactName = escapeHtml(contact.nickname);
          if (participantStatus === "active") {
            // Notify recipient immediately
            const senderName = escapeHtml(user?.first_name || "Someone");
            const desc = escapeHtml(parsed.description);
            const dueStr = parsed.due_date
              ? ` (due ${new Date(parsed.due_date).toLocaleString("en-IN", {
                  weekday: "short", day: "numeric", month: "short",
                  timeZone: user?.timezone || "Asia/Kolkata",
                })})`
              : "";
            await sendMessage(
              contact.contact_telegram_id!,
              `\u{1F4E5} ${senderName} assigned you: <b>${desc}</b>${dueStr}`,
            );
            confirmParts.push(contactName);
          } else if (participantStatus === "pending_consent") {
            confirmParts.push(`${contactName} (awaiting approval)`);
          } else {
            confirmParts.push(`${contactName} (invite sent)`);
          }
        }

        await saveSession(telegramId, [memory.id], "created");

        const desc = escapeHtml(parsed.description);
        const responseText = `\u{2705} Assigned to ${confirmParts.join(", ")}: <b>${desc}</b>`;
        await sendMessage(chatId, responseText);
        return { summary: `Shared task: ${parsed.description} → ${confirmParts.join(", ")}`, response: responseText };
      }

      // === SOLO TASK PATH (existing, unchanged) ===
      const memory = await createMemory({
        user_id: userId,
        telegram_id: telegramId,
        // ... rest of existing code unchanged ...
```

Note: The existing solo task code from the current `default` case (from `const memory = await createMemory(...)` onward) stays exactly as-is. The shared task path is a new `if` block inserted before it.

- [ ] **Step 3: Add `is_shared` parameter to `createMemory`**

In `database.ts`, modify the `createMemory` function to accept `is_shared`:

```typescript
export async function createMemory(memory: {
  user_id: string;
  telegram_id: number;
  type: string;
  description: string;
  raw_input: string;
  due_date?: string | null;
  reminder_at?: string | null;
  entities?: Record<string, unknown>;
  recurrence?: string | null;
  source?: string;
  description_embedding?: number[] | null;
  is_shared?: boolean;
}): Promise<DbMemory> {
  const { description_embedding, ...rest } = memory;
  const insertData: Record<string, unknown> = { ...rest };
  if (description_embedding) {
    insertData.description_embedding = `[${description_embedding.join(",")}]`;
  }
  // ... rest unchanged
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/telegram-webhook/index.ts supabase/functions/_shared/database.ts
git commit -m "feat: add shared task routing with contact resolution and participant creation"
```

---

### Task 9: Invite Deep Link Handling in handleStart

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`

- [ ] **Step 1: Handle invite_ deep link payload in handleStart**

In `handleStart`, after the `ref_` payload handling block and before the consent check, add:

```typescript
  // Handle invite deep link: "/start invite_<contact_id>"
  if (payload?.startsWith("invite_")) {
    try {
      const contactId = payload.slice(7);
      const contact = await getContactById(contactId);
      if (contact && contact.contact_telegram_id === telegramId) {
        // Implicit consent — user clicked invite link
        await updateContact(contactId, { status: "approved" });

        // Activate all queued tasks
        const activated = await activateParticipantsForContact(
          contact.owner_telegram_id,
          telegramId,
          "pending_invite",
        );

        // Notify sender
        const joinerName = escapeHtml(firstName || "Someone");
        sendMessage(
          contact.owner_telegram_id,
          `\u{1F389} ${joinerName} joined RemindKar! ${activated.length > 0 ? `Your ${activated.length} task${activated.length > 1 ? "s have" : " has"} been delivered.` : ""}`,
        ).catch(() => {});

        // Notify recipient about delivered tasks
        if (activated.length > 0) {
          const senderUser = await getUser(contact.owner_telegram_id);
          const senderName = escapeHtml(senderUser?.first_name || "Someone");
          const taskList = activated.map(
            (p) => `  \u{2022} ${escapeHtml((p as DbMemoryParticipant & { memory: DbMemory }).memory?.description ?? "")}`
          ).join("\n");
          // Will be sent after onboarding completes (deferred below)
          setTimeout(() => {
            sendMessage(chatId, `\u{1F4E5} ${senderName} has tasks waiting for you:\n${taskList}`).catch(() => {});
          }, 0);
        }
      }
    } catch (err) {
      console.error("Invite conversion failed (non-fatal):", err);
    }
  }
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/telegram-webhook/index.ts
git commit -m "feat: handle invite deep link in /start for contact activation"
```

---

### Task 10: /pending Integration — Show Received Tasks

**Files:**
- Modify: `supabase/functions/_shared/formatters.ts`
- Modify: `supabase/functions/telegram-webhook/index.ts`

- [ ] **Step 1: Add received task formatting helper to formatters.ts**

Add this import at the top of `formatters.ts`:

```typescript
import { DbMemory, DbMemoryParticipant, TelegramInlineKeyboardButton } from "./types.ts";
```

Add a new function after `formatPendingList`:

```typescript
// Format received (delegated) tasks as lines to append to pending list
export function formatReceivedTasks(
  receivedTasks: { participant: DbMemoryParticipant; memory: DbMemory; senderName: string }[],
  tz = DEFAULT_TZ,
  startIndex = 1,
): string[] {
  if (receivedTasks.length === 0) return [];

  const lines: string[] = ["\n\u{1F4E5} <b>Assigned to you:</b>"];
  receivedTasks.forEach((r, i) => {
    const emoji = TYPE_EMOJI[r.memory.type] || "\u{1F4CB}";
    const due = r.memory.due_date ? ` \u{2014} due ${formatDate(r.memory.due_date, tz)}` : "";
    lines.push(`${startIndex + i}. ${emoji} ${escapeHtml(r.memory.description)}${due} \u{2014} <i>from ${escapeHtml(r.senderName)}</i>`);
  });

  return lines;
}
```

- [ ] **Step 2: Modify handlePending to include received tasks**

In `handlePending` in `index.ts`, after fetching solo pending memories, also fetch received tasks:

```typescript
async function handlePending(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  try {
    const user = await getUser(telegramId);
    if (!user?.consent_given) {
      await sendMessage(chatId, "Please send /start first and give consent before I can show your memories.");
      return;
    }
    const memories = await getPendingMemories(telegramId);

    // Fetch received tasks
    const receivedRaw = await getReceivedTasks(telegramId);
    const receivedTasks: { participant: DbMemoryParticipant; memory: DbMemory; senderName: string }[] = [];
    for (const r of receivedRaw) {
      const senderUser = await getUser(r.memory.telegram_id);
      receivedTasks.push({
        participant: r,
        memory: r.memory,
        senderName: senderUser?.first_name || "Someone",
      });
    }

    await saveSession(telegramId, memories.map((m) => m.id), "pending");
    const { text, buttons } = formatPendingList(memories, user.timezone);

    // Append received tasks
    const receivedLines = formatReceivedTasks(receivedTasks, user.timezone, memories.length + 1);
    const fullText = receivedLines.length > 0 ? text + "\n" + receivedLines.join("\n") : text;

    // Add filter row
    const filterRow: TelegramInlineKeyboardButton[] = [
      { text: "\u{1F4CB} Tasks", callback_data: "filter:task" },
      { text: "\u{1F4DD} Notes", callback_data: "filter:note" },
      { text: "\u{1F4C5} Events", callback_data: "filter:event" },
      { text: "\u{1F6A8} Overdue", callback_data: "filter:overdue" },
    ];
    const allButtons = [...buttons, filterRow];
    await sendMessageWithButtons(chatId, fullText, allButtons);
  } catch (error) {
    console.error("Pending error:", error);
    await sendMessage(chatId, "Something went wrong. Please try again.");
  }
}
```

- [ ] **Step 3: Add `formatReceivedTasks` import to index.ts**

Add to the import from `formatters.ts`:

```typescript
import {
  // ... existing imports ...
  formatReceivedTasks,
} from "../_shared/formatters.ts";
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/formatters.ts supabase/functions/telegram-webhook/index.ts
git commit -m "feat: show received tasks in /pending list"
```

---

### Task 11: Done/Snooze/Delete for Received Tasks

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`

- [ ] **Step 1: Modify done callback to handle shared tasks**

In the `done:` callback handler in `handleCallbackQuery`, after marking the memory as done, add a check for shared-task participant state and creator notification:

```typescript
if (data.startsWith("done:")) {
  const memoryId = data.slice(5);
  const doneMemory = await getMemoryById(memoryId);

  // Check if this is a received (shared) task
  const participant = await getParticipant(memoryId, telegramId);
  if (participant && participant.role === "assignee") {
    // Mark participant as done (not the memory itself)
    await updateParticipant(participant.id, {
      status: "done",
      completed_at: new Date().toISOString(),
    });
    await answerCallbackQuery(query.id, "Marked as done!");

    if (chatId && messageId && doneMemory) {
      await editMessageText(chatId, messageId,
        `\u{2705} Done: ${escapeHtml(doneMemory.description)}`);
    }

    // Notify creator
    if (doneMemory) {
      try {
        const recipientUser = await getUser(telegramId);
        const recipientName = escapeHtml(recipientUser?.first_name || "Someone");
        await sendMessage(
          doneMemory.telegram_id,
          `\u{2705} ${recipientName} completed: <b>${escapeHtml(doneMemory.description)}</b>`,
        );
      } catch { /* non-fatal */ }
    }
    return;
  }

  // Existing solo-task done logic (unchanged)
  await updateMemory(memoryId, {
    status: "done",
    completed_at: new Date().toISOString(),
  });
  // ... rest of existing done handler unchanged
```

- [ ] **Step 2: Modify delete callback to handle shared tasks**

In the `delete:` callback handler, add a participant check:

```typescript
if (data.startsWith("delete:")) {
  const memoryId = data.slice(7);

  // Check if this is a received task — decline participant, don't delete memory
  const participant = await getParticipant(memoryId, telegramId);
  if (participant && participant.role === "assignee") {
    await updateParticipant(participant.id, { status: "declined" });
    await answerCallbackQuery(query.id, "Dismissed!");
    if (chatId && messageId) {
      await editMessageText(chatId, messageId, "\u{1F5D1} Dismissed.");
    }
    return;
  }

  // Existing solo delete logic
  await deleteMemory(memoryId);
  // ... rest unchanged
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/telegram-webhook/index.ts
git commit -m "feat: handle done/delete callbacks for received shared tasks"
```

---

### Task 12: New Commands — /contacts, /block, /unblock, /assigned

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`

- [ ] **Step 1: Add new commands to handleCommand switch**

In `handleCommand`, add new cases before the `default`:

```typescript
    case "/contacts":
      await handleContacts(message);
      break;
    case "/block":
      await handleBlock(message);
      break;
    case "/unblock":
      await handleUnblock(message);
      break;
    case "/assigned":
      await handleAssigned(message);
      break;
```

- [ ] **Step 2: Implement handleContacts**

```typescript
async function handleContacts(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first.");
    return;
  }

  const contacts = await getContactsByOwner(telegramId);
  if (contacts.length === 0) {
    await sendMessage(chatId, "You don't have any contacts yet. Share a contact with me to add someone.");
    return;
  }

  const statusEmoji: Record<string, string> = {
    approved: "\u{2705}",
    pending: "\u{23F3}",
    blocked: "\u{1F6AB}",
    declined: "\u{274C}",
  };

  const lines = ["<b>Your Contacts:</b>\n"];
  contacts.forEach((c, i) => {
    const emoji = statusEmoji[c.status] || "\u{2753}";
    lines.push(`${i + 1}. ${emoji} ${escapeHtml(c.nickname)}${c.first_name ? ` (${escapeHtml(c.first_name)})` : ""} \u{2014} ${c.status}`);
  });

  await sendMessage(chatId, lines.join("\n"));
}
```

- [ ] **Step 3: Implement handleBlock**

```typescript
async function handleBlock(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first.");
    return;
  }

  // Get all senders who have approved status pointing to this user
  const senders = await getApprovedSenders(telegramId);
  if (senders.length === 0) {
    await sendMessage(chatId, "No one is sending you tasks right now.");
    return;
  }

  const buttons: TelegramInlineKeyboardButton[][] = [];
  for (const s of senders) {
    const senderUser = await getUser(s.owner_telegram_id);
    const senderName = senderUser?.first_name || `User ${s.owner_telegram_id}`;
    buttons.push([{
      text: `\u{1F6AB} ${senderName}`,
      callback_data: `block_sender:${s.owner_telegram_id}`,
    }]);
  }

  await sendMessageWithButtons(chatId, "Who would you like to block from sending you tasks?", buttons);
}
```

- [ ] **Step 4: Implement handleUnblock**

```typescript
async function handleUnblock(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first.");
    return;
  }

  // Get all contacts where this user is blocked
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("contact_telegram_id", telegramId)
    .eq("status", "blocked");

  // We can't use supabase directly here — we need a database function
  // Instead, query via getApprovedSenders pattern but for blocked
  // For now, use the same approach with a dedicated query

  // Actually, let's add a getBlockedSenders function to database.ts
  // For this step, send a placeholder message
  await sendMessage(chatId, "Use /contacts to see your contact list. Unblock support coming soon.");
}
```

Actually, let's properly implement it. Add `getBlockedSenders` to database.ts first:

```typescript
export async function getBlockedSenders(recipientTelegramId: number): Promise<DbContact[]> {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("contact_telegram_id", recipientTelegramId)
    .eq("status", "blocked");
  if (error) throw error;
  return (data ?? []) as DbContact[];
}
```

Then implement handleUnblock properly:

```typescript
async function handleUnblock(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first.");
    return;
  }

  const blockedSenders = await getBlockedSenders(telegramId);
  if (blockedSenders.length === 0) {
    await sendMessage(chatId, "You haven't blocked anyone.");
    return;
  }

  const buttons: TelegramInlineKeyboardButton[][] = [];
  for (const s of blockedSenders) {
    const senderUser = await getUser(s.owner_telegram_id);
    const senderName = senderUser?.first_name || `User ${s.owner_telegram_id}`;
    buttons.push([{
      text: `\u{2705} Unblock ${senderName}`,
      callback_data: `unblock_sender:${s.owner_telegram_id}`,
    }]);
  }

  await sendMessageWithButtons(chatId, "Who would you like to unblock?", buttons);
}
```

- [ ] **Step 5: Implement handleAssigned**

```typescript
async function handleAssigned(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first.");
    return;
  }

  const assigned = await getAssignedByUser(telegramId);
  if (assigned.length === 0) {
    await sendMessage(chatId, "You haven't assigned any tasks to others yet.");
    return;
  }

  const statusEmoji: Record<string, string> = {
    active: "\u{23F3}",
    done: "\u{2705}",
    pending_consent: "\u{1F4E8}",
    pending_invite: "\u{1F4E8}",
    declined: "\u{274C}",
  };

  const lines = ["<b>Tasks you've assigned:</b>\n"];
  for (const a of assigned) {
    const recipientUser = await getUser(a.participant_telegram_id);
    const recipientName = recipientUser?.first_name || `User ${a.participant_telegram_id}`;
    const emoji = statusEmoji[a.status] || "\u{2753}";
    lines.push(`${emoji} ${escapeHtml(a.memory.description)} \u{2192} ${escapeHtml(recipientName)} (${a.status})`);
  }

  await sendMessage(chatId, lines.join("\n"));
}
```

- [ ] **Step 6: Add block_sender and unblock_sender callback handlers**

In `handleCallbackQuery`, add:

```typescript
// Contact disambiguation picker
if (data.startsWith("pick_contact:")) {
  const contactId = data.slice(13);
  await answerCallbackQuery(query.id);

  // Get the session to find the original message to re-process
  const pickSession = await getSession(telegramId);
  const originalMsg = pickSession?.last_intent?.startsWith("awaiting_contact_pick:")
    ? pickSession.last_intent.split("awaiting_contact_pick:")[1]
    : null;

  if (chatId && messageId) {
    const contact = await getContactById(contactId);
    const contactName = contact ? escapeHtml(contact.nickname) : "contact";
    await editMessageText(chatId, messageId, `\u{2705} Selected: ${contactName}`);
  }

  // Re-process the original message with the resolved contact
  if (originalMsg && chatId) {
    const pickUser = await getUser(telegramId);
    if (pickUser?.consent_given) {
      const history = pickSession?.conversation_history ?? [];
      const parsedItems = await parseMessage(originalMsg, history, pickUser.timezone);
      for (const parsed of parsedItems) {
        await routeParsedIntent(chatId, telegramId, pickUser.id, originalMsg, parsed, "text", pickUser.timezone);
      }
    }
  }
  return;
}

if (data.startsWith("block_sender:")) {
  const senderTelegramId = parseInt(data.slice(13), 10);
  await blockSender(senderTelegramId, telegramId);
  await declineParticipantsFromSender(senderTelegramId, telegramId);
  await answerCallbackQuery(query.id, "Blocked!");
  if (chatId && messageId) {
    await editMessageText(chatId, messageId, "\u{1F6AB} Blocked. They won't be able to send you tasks anymore.");
  }
  return;
}

if (data.startsWith("unblock_sender:")) {
  const senderTelegramId = parseInt(data.slice(15), 10);
  await unblockSender(senderTelegramId, telegramId);
  await answerCallbackQuery(query.id, "Unblocked!");
  if (chatId && messageId) {
    await editMessageText(chatId, messageId, "\u{2705} Unblocked. They can send you tasks again.");
  }
  return;
}
```

- [ ] **Step 7: Add getBlockedSenders import and update /help text**

Add `getBlockedSenders` to the imports from `database.ts`.

Update `handleHelp` to include new commands:

```typescript
"/contacts \u{2014} See your linked contacts\n" +
"/block \u{2014} Block someone from assigning tasks\n" +
"/unblock \u{2014} Unblock a blocked sender\n" +
"/assigned \u{2014} See tasks you've assigned to others\n" +
```

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/telegram-webhook/index.ts supabase/functions/_shared/database.ts
git commit -m "feat: add /contacts, /block, /unblock, /assigned commands"
```

---

### Task 13: send-reminders Fan-Out

**Files:**
- Modify: `supabase/functions/send-reminders/index.ts`

- [ ] **Step 1: Add imports for shared reminder queries**

Update imports in `send-reminders/index.ts`:

```typescript
import {
  getDueReminders, getDuePreReminders, updateMemory, getUser,
  getDueSharedReminders, getDueSharedPreReminders, updateParticipant,
} from "../_shared/database.ts";
```

- [ ] **Step 2: Add shared reminder fan-out after existing solo logic**

After the existing `// 2. Send due reminders` section, add:

```typescript
    // 3. Send shared pre-reminders
    const sharedPreReminders = await getDueSharedPreReminders();
    console.log(`send-reminders: ${sharedPreReminders.length} shared pre-reminders due`);

    for (const sp of sharedPreReminders) {
      try {
        const tz = await getUserTz(sp.participant_telegram_id);
        const { text, buttons } = formatPreReminder(sp.memory, tz);
        // Tag with sender name
        const senderUser = await getUser(sp.memory.telegram_id);
        const senderName = senderUser?.first_name || "Someone";
        const taggedText = `${text}\n<i>Shared by ${senderName}</i>`;
        await sendMessageWithButtons(sp.participant_telegram_id, taggedText, buttons);
        await updateParticipant(sp.id, { is_pre_reminded: true });
      } catch (err) {
        console.error(`Failed to send shared pre-reminder for participant ${sp.id}:`, err);
      }
    }

    // 4. Send shared due reminders
    const sharedReminders = await getDueSharedReminders();
    console.log(`send-reminders: ${sharedReminders.length} shared reminders due`);

    for (const sr of sharedReminders) {
      try {
        const tz = await getUserTz(sr.participant_telegram_id);
        const { text, buttons } = formatReminder(sr.memory, tz);
        const senderUser = await getUser(sr.memory.telegram_id);
        const senderName = senderUser?.first_name || "Someone";
        const taggedText = `${text}\n<i>Shared by ${senderName}</i>`;
        await sendMessageWithButtons(sr.participant_telegram_id, taggedText, buttons);
        await updateParticipant(sr.id, { is_reminded: true });
      } catch (err) {
        console.error(`Failed to send shared reminder for participant ${sr.id}:`, err);
      }
    }
```

Update the response JSON:

```typescript
    return new Response(JSON.stringify({
      pre: preReminders.length,
      reminders: reminders.length,
      shared_pre: sharedPreReminders.length,
      shared_reminders: sharedReminders.length,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/send-reminders/index.ts
git commit -m "feat: add shared reminder fan-out in send-reminders"
```

---

### Task 14: send-digest — "Assigned to you" Section

**Files:**
- Modify: `supabase/functions/send-digest/index.ts`
- Modify: `supabase/functions/_shared/formatters.ts`

- [ ] **Step 1: Add received tasks to digest formatter**

In `formatters.ts`, modify `formatDigest` to accept an optional `receivedTasks` parameter:

```typescript
export function formatDigest(
  firstName: string | null,
  overdue: DbMemory[],
  today: DbMemory[],
  tomorrow: DbMemory[],
  somedayCount: number,
  tz = DEFAULT_TZ,
  currentStreak = 0,
  longestStreak = 0,
  receivedTasks: { memory: DbMemory; senderName: string }[] = [],
): string {
  // ... existing code unchanged until after the somedayCount section ...

  // Add received tasks section (insert before streak)
  if (receivedTasks.length > 0) {
    lines.push("\n\u{1F4E5} <b>ASSIGNED TO YOU:</b>");
    receivedTasks.forEach((r) => {
      const emoji = TYPE_EMOJI[r.memory.type] || "\u{1F4CB}";
      const due = r.memory.due_date ? ` (due ${formatDateShort(r.memory.due_date, tz)})` : "";
      lines.push(`  \u{2022} ${emoji} ${escapeHtml(r.memory.description)}${due} \u{2014} <i>from ${escapeHtml(r.senderName)}</i>`);
    });
  }

  // ... existing streak code ...
```

- [ ] **Step 2: Fetch received tasks in send-digest**

In `send-digest/index.ts`, add import and fetch:

```typescript
import { getActiveConsentedUsers, getDigestMemories, getReceivedDigestTasks, getUser } from "../_shared/database.ts";
```

In the user loop, after fetching digest memories:

```typescript
      // Fetch received tasks for this user
      const receivedMemories = await getReceivedDigestTasks(user.telegram_id);
      const receivedTasks: { memory: DbMemory; senderName: string }[] = [];
      for (const m of receivedMemories) {
        const senderUser = await getUser(m.telegram_id);
        receivedTasks.push({
          memory: m,
          senderName: senderUser?.first_name || "Someone",
        });
      }

      const digestText = formatDigest(
        user.first_name, overdue, today, tomorrow, somedayCount, tz,
        user.current_streak ?? 0, user.longest_streak ?? 0,
        receivedTasks,
      );
```

- [ ] **Step 3: Add DbMemory import to send-digest**

```typescript
import { DbMemory } from "../_shared/types.ts";
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/send-digest/index.ts supabase/functions/_shared/formatters.ts
git commit -m "feat: add received tasks section to daily digest"
```

---

### Task 15: Update CLAUDE.md and ROADMAP.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Add shared reminders section to CLAUDE.md**

Add to the Key Rules section:

```markdown
- Shared tasks: `target_people` in GeminiParsedResponse triggers shared-task path. Solo tasks (`target_people: []`) are completely unchanged. `memory_participants` tracks per-person state for shared tasks. `contacts` table is per-user private address book.
- Contact linking: Telegram Share Contact → `contacts` row. Session intent `awaiting_contact:<msg>` re-processes original message after contact shared.
- Consent model: one-time approval per sender stored in `contacts.status`. `consent_allow:` / `consent_decline:` callbacks. After approval, all future tasks flow without prompts.
- Delegation vs fan-out: `include_creator: false` = delegation (task for others only), `include_creator: true` = fan-out (creator also a participant).
- Done on received task: updates `memory_participants.status`, NOT `memories.status`. Notifies creator.
- Delete on received task: sets `memory_participants.status = 'declined'`. Does NOT delete the memory. Creator NOT notified.
```

Add new tables to the DB tables list:

```markdown
`contacts`, `memory_participants`, `archived_contacts`, `archived_memory_participants`
```

- [ ] **Step 2: Update ROADMAP.md to mark feature as shipped**

Change the shared reminders checkbox from `[ ]` to `[x]` and add the ship date.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md ROADMAP.md
git commit -m "docs: update CLAUDE.md and ROADMAP.md for shared reminders feature"
```

---

### Task 16: Deploy and Test

**Files:** None (deployment commands only)

- [ ] **Step 1: Deploy all functions**

```bash
npx supabase functions deploy telegram-webhook
npx supabase functions deploy send-reminders
npx supabase functions deploy send-digest
```

- [ ] **Step 2: Test solo task flow (regression)**

Send a normal message to the bot: "remind me to buy milk tomorrow". Verify it works exactly as before with no changes.

- [ ] **Step 3: Test contact sharing**

Share a contact with the bot. Verify it creates a contact row and sends consent request or invite.

- [ ] **Step 4: Test delegation flow**

1. Add a contact (share contact of a test user)
2. Have the test user accept consent
3. Send "remind [contact_name] to send the invoice by Friday"
4. Verify the contact receives the assigned task notification
5. Have the contact mark it done
6. Verify the creator receives the done notification

- [ ] **Step 5: Test fan-out flow**

Send "remind me and [contact_name] about the call at 8 PM". Verify both users receive independent reminders at 8 PM.

- [ ] **Step 6: Test /block and /unblock**

1. As the recipient, run /block and block the sender
2. Verify the sender sees "not accepting tasks" on next assignment attempt
3. As the recipient, run /unblock
4. Verify assignment works again

- [ ] **Step 7: Test /contacts and /assigned**

Run both commands and verify they show correct data.

- [ ] **Step 8: Test non-user flow**

Share a contact for someone not on RemindKar. Verify invite is sent. Have them click the invite link and verify tasks activate.
