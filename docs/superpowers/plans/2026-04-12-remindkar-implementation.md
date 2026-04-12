# RemindKar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy RemindKar, a Telegram bot that captures tasks/reminders via text and voice, stores them in Supabase, and sends daily digests and time-based reminders.

**Architecture:** Single Supabase project with 3 Edge Functions (Deno/TypeScript): `telegram-webhook` handles all user interactions via Telegram Bot API webhooks, `send-reminders` checks for due reminders every 5 minutes, `send-digest` sends morning summaries. All AI processing uses Gemini 2.0 Flash via REST API. PostgreSQL stores users and memories, with pg_cron + pg_net triggering the scheduled functions.

**Tech Stack:** Supabase Edge Functions (Deno), Gemini 2.0 Flash REST API, PostgreSQL + pg_cron + pg_net, Telegram Bot API

**Spec:** `docs/superpowers/specs/2026-04-12-remindkar-design.md`

---

## File Map

```
supabase/
  config.toml                          # Supabase config — disables JWT for webhook
  functions/
    telegram-webhook/index.ts          # Main webhook: routing, command handlers, text/voice/forward handlers
    send-reminders/index.ts            # Cron-triggered: query + send due reminders
    send-digest/index.ts               # Cron-triggered: query + format + send morning digest
    _shared/
      types.ts                         # TypeScript interfaces for Telegram, Gemini, DB types
      telegram.ts                      # Telegram Bot API helpers (send, edit, answer, getFile, download)
      database.ts                      # Supabase client + all CRUD operations
      gemini.ts                        # Gemini REST API calls (parseMessage, transcribeAudio)
      formatters.ts                    # Message formatting (confirmation, digest, query results)
  migrations/
    001_initial_schema.sql             # Tables, indexes, RLS, extensions
    002_cron_jobs.sql                  # pg_cron schedules (applied after Edge Functions are deployed)
```

---

### Task 1: Project Scaffolding + Database Migration

**Files:**
- Create: `supabase/config.toml`
- Create: `supabase/migrations/001_initial_schema.sql`

- [ ] **Step 1: Initialize Supabase project**

Run from the project root (`/Users/yashpatni/Desktop/Claude-Code/Telegram`):

```bash
supabase init
```

Expected: Creates `supabase/` directory with `config.toml` and other scaffolding.

- [ ] **Step 2: Update config.toml to disable JWT verification for webhook**

In `supabase/config.toml`, add at the end of the file:

```toml
[functions.telegram-webhook]
verify_jwt = false
```

This allows Telegram to POST to the webhook without a Supabase JWT. The `send-reminders` and `send-digest` functions keep JWT verification enabled (default) — pg_net sends the service role key as Bearer token.

- [ ] **Step 3: Create the database migration**

Create `supabase/migrations/001_initial_schema.sql`:

```sql
-- =============================================================
-- RemindKar: Initial Schema
-- =============================================================

-- Users table
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

-- Memories table (tasks, reminders, notes, events, birthdays)
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

-- Indexes
create index idx_memories_telegram_status on public.memories(telegram_id, status);
create index idx_memories_reminder on public.memories(reminder_at, is_reminded) where status = 'pending';
create index idx_memories_due_date on public.memories(due_date) where status = 'pending';
create index idx_memories_pre_reminder on public.memories(reminder_at, is_pre_reminded) where status = 'pending';
```

- [ ] **Step 4: Apply migration to Supabase**

Option A — if using Supabase CLI linked to remote project:
```bash
supabase link --project-ref <YOUR_PROJECT_REF>
supabase db push
```

Option B — copy the SQL from `001_initial_schema.sql` and run it in the Supabase Dashboard SQL Editor.

- [ ] **Step 5: Verify tables exist**

Run in Supabase SQL Editor:
```sql
select table_name from information_schema.tables where table_schema = 'public';
```

Expected output should include `users` and `memories`.

- [ ] **Step 6: Commit**

```bash
git init
git add supabase/config.toml supabase/migrations/001_initial_schema.sql
git commit -m "feat: initialize supabase project with database schema"
```

---

### Task 2: TypeScript Types (`_shared/types.ts`)

**Files:**
- Create: `supabase/functions/_shared/types.ts`

- [ ] **Step 1: Create shared types file**

Create `supabase/functions/_shared/types.ts`:

```typescript
// ============================================================
// Telegram Bot API types (subset we use)
// ============================================================

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  voice?: TelegramVoice;
  forward_date?: number;
  forward_origin?: unknown;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

// ============================================================
// Gemini API types
// ============================================================

export interface GeminiParsedResponse {
  intent: "task" | "reminder" | "event" | "birthday" | "note" | "query" | "greeting" | "done" | "unknown";
  description: string;
  due_date: string | null;
  reminder_at: string | null;
  entities: {
    people: string[];
    projects: string[];
    locations: string[];
  };
  recurrence: "daily" | "weekly" | "yearly" | null;
  priority: "high" | "medium" | "low";
  query_text: string | null;
  confidence: number;
  ambiguous_date: boolean;
  date_options: string[];
}

// ============================================================
// Database types
// ============================================================

export interface DbUser {
  id: string;
  telegram_id: number;
  telegram_username: string | null;
  first_name: string | null;
  consent_given: boolean;
  consent_given_at: string | null;
  created_at: string;
  timezone: string;
  is_active: boolean;
  last_active_at: string;
}

export interface DbMemory {
  id: string;
  user_id: string;
  telegram_id: number;
  type: string;
  description: string;
  raw_input: string;
  due_date: string | null;
  reminder_at: string | null;
  entities: Record<string, unknown>;
  recurrence: string | null;
  status: string;
  is_reminded: boolean;
  is_pre_reminded: boolean;
  source: string;
  created_at: string;
  completed_at: string | null;
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/types.ts
git commit -m "feat: add shared TypeScript type definitions"
```

---

### Task 3: Telegram API Helpers (`_shared/telegram.ts`)

**Files:**
- Create: `supabase/functions/_shared/telegram.ts`

- [ ] **Step 1: Create Telegram helpers**

Create `supabase/functions/_shared/telegram.ts`:

```typescript
import { TelegramInlineKeyboardButton } from "./types.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

export async function sendMessage(chatId: number, text: string): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`sendMessage failed: ${res.status} ${err}`);
  }
}

export async function sendMessageWithButtons(
  chatId: number,
  text: string,
  buttons: TelegramInlineKeyboardButton[][],
): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: buttons },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`sendMessageWithButtons failed: ${res.status} ${err}`);
  }
}

export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "Markdown",
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`editMessageText failed: ${res.status} ${err}`);
  }
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
    }),
  });
}

// Returns the file content as a Uint8Array, or null on failure
export async function downloadTelegramFile(fileId: string): Promise<Uint8Array | null> {
  // Step 1: Get file path from Telegram
  const fileRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  if (!fileRes.ok) {
    console.error(`getFile failed: ${fileRes.status}`);
    return null;
  }
  const fileData = await fileRes.json();
  const filePath = fileData.result?.file_path;
  if (!filePath) {
    console.error("getFile returned no file_path");
    return null;
  }

  // Step 2: Download the actual file
  const downloadRes = await fetch(
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`,
  );
  if (!downloadRes.ok) {
    console.error(`File download failed: ${downloadRes.status}`);
    return null;
  }
  const buffer = await downloadRes.arrayBuffer();
  return new Uint8Array(buffer);
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/telegram.ts
git commit -m "feat: add Telegram Bot API helper functions"
```

---

### Task 4: Database Helpers (`_shared/database.ts`)

**Files:**
- Create: `supabase/functions/_shared/database.ts`

- [ ] **Step 1: Create database helpers**

Create `supabase/functions/_shared/database.ts`:

```typescript
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DbUser, DbMemory } from "./types.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---- Users ----

// Upserts user on /start. Does NOT reset consent_given on returning users.
export async function upsertUser(
  telegramId: number,
  username: string | null,
  firstName: string | null,
): Promise<DbUser> {
  // Try to find existing user first
  const { data: existing } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegramId)
    .maybeSingle();

  if (existing) {
    // Update last_active and optional fields, but never reset consent
    const { data, error } = await supabase
      .from("users")
      .update({
        telegram_username: username,
        first_name: firstName,
        last_active_at: new Date().toISOString(),
        is_active: true,
      })
      .eq("telegram_id", telegramId)
      .select()
      .single();
    if (error) throw error;
    return data as DbUser;
  }

  // New user — insert with consent_given=false
  const { data, error } = await supabase
    .from("users")
    .insert({
      telegram_id: telegramId,
      telegram_username: username,
      first_name: firstName,
    })
    .select()
    .single();
  if (error) throw error;
  return data as DbUser;
}

export async function getUser(telegramId: number): Promise<DbUser | null> {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  if (error) throw error;
  return data as DbUser | null;
}

export async function updateUserConsent(
  telegramId: number,
  consent: boolean,
): Promise<void> {
  const update: Record<string, unknown> = { consent_given: consent };
  if (consent) {
    update.consent_given_at = new Date().toISOString();
  }
  const { error } = await supabase
    .from("users")
    .update(update)
    .eq("telegram_id", telegramId);
  if (error) throw error;
}

export async function deleteUserData(telegramId: number): Promise<void> {
  // on delete cascade handles memories
  const { error } = await supabase
    .from("users")
    .delete()
    .eq("telegram_id", telegramId);
  if (error) throw error;
}

export async function getActiveConsentedUsers(): Promise<DbUser[]> {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("is_active", true)
    .eq("consent_given", true);
  if (error) throw error;
  return (data ?? []) as DbUser[];
}

// ---- Memories ----

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
}): Promise<DbMemory> {
  const { data, error } = await supabase
    .from("memories")
    .insert(memory)
    .select()
    .single();
  if (error) throw error;
  return data as DbMemory;
}

export async function updateMemory(
  memoryId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("memories")
    .update(updates)
    .eq("id", memoryId);
  if (error) throw error;
}

export async function deleteMemory(memoryId: string): Promise<void> {
  const { error } = await supabase
    .from("memories")
    .delete()
    .eq("id", memoryId);
  if (error) throw error;
}

export async function getPendingMemories(telegramId: number): Promise<DbMemory[]> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("status", "pending")
    .order("due_date", { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as DbMemory[];
}

export async function searchMemories(
  telegramId: number,
  queryText: string,
): Promise<DbMemory[]> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("telegram_id", telegramId)
    .ilike("description", `%${queryText}%`)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw error;
  return (data ?? []) as DbMemory[];
}

// Search pending memories by description for /done command
export async function searchPendingByDescription(
  telegramId: number,
  searchText: string,
): Promise<DbMemory[]> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("status", "pending")
    .ilike("description", `%${searchText}%`);
  if (error) throw error;
  return (data ?? []) as DbMemory[];
}

// For send-reminders: get memories where reminder is due
export async function getDueReminders(): Promise<DbMemory[]> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("status", "pending")
    .eq("is_reminded", false)
    .lte("reminder_at", new Date().toISOString())
    .not("reminder_at", "is", null);
  if (error) throw error;
  return (data ?? []) as DbMemory[];
}

// For send-reminders: get memories where pre-reminder (30 min before) is due
export async function getDuePreReminders(): Promise<DbMemory[]> {
  const now = new Date();
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("status", "pending")
    .eq("is_pre_reminded", false)
    .gt("reminder_at", now.toISOString()) // reminder hasn't fired yet
    .lte("reminder_at", new Date(now.getTime() + 30 * 60 * 1000).toISOString()); // but within 30 min
  if (error) throw error;
  return (data ?? []) as DbMemory[];
}

// For send-digest: get pending memories grouped by due date category
export async function getDigestMemories(telegramId: number): Promise<{
  overdue: DbMemory[];
  today: DbMemory[];
  tomorrow: DbMemory[];
  somedayCount: number;
}> {
  // All pending memories for this user
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("status", "pending")
    .order("due_date", { ascending: true });
  if (error) throw error;

  const memories = (data ?? []) as DbMemory[];

  // Calculate IST boundaries
  const nowUtc = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const nowIst = new Date(nowUtc.getTime() + istOffset);

  const todayStart = new Date(nowIst);
  todayStart.setHours(0, 0, 0, 0);
  const todayStartUtc = new Date(todayStart.getTime() - istOffset);

  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  const tomorrowStartUtc = new Date(tomorrowStart.getTime() - istOffset);

  const dayAfterStart = new Date(tomorrowStart);
  dayAfterStart.setDate(dayAfterStart.getDate() + 1);
  const dayAfterStartUtc = new Date(dayAfterStart.getTime() - istOffset);

  const overdue: DbMemory[] = [];
  const today: DbMemory[] = [];
  const tomorrow: DbMemory[] = [];
  let somedayCount = 0;

  for (const m of memories) {
    if (!m.due_date) {
      somedayCount++;
      continue;
    }
    const due = new Date(m.due_date);
    if (due < todayStartUtc) {
      overdue.push(m);
    } else if (due < tomorrowStartUtc) {
      today.push(m);
    } else if (due < dayAfterStartUtc) {
      tomorrow.push(m);
    }
    // Future items beyond tomorrow are not shown in digest
  }

  return { overdue, today, tomorrow, somedayCount };
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/database.ts
git commit -m "feat: add database CRUD helper functions"
```

---

### Task 5: Gemini API Helpers (`_shared/gemini.ts`)

**Files:**
- Create: `supabase/functions/_shared/gemini.ts`

- [ ] **Step 1: Create Gemini helpers**

Create `supabase/functions/_shared/gemini.ts`:

```typescript
import { GeminiParsedResponse } from "./types.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

function getCurrentDatetimeIST(): string {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  return ist.toISOString().replace("T", " ").replace("Z", " IST");
}

const PARSE_SYSTEM_PROMPT = `You are a personal memory assistant that extracts structured information from user messages. The user may write in English, Hindi, Hinglish (mixed Hindi-English), or Marathi.

Current date and time: {CURRENT_DATETIME}
User's timezone: Asia/Kolkata

Analyze the user's message and respond with ONLY a JSON object (no markdown, no explanation, no code fences):

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
- For voice transcriptions, clean up filler words but preserve the core meaning`;

export async function parseMessage(userMessage: string): Promise<GeminiParsedResponse> {
  const systemPrompt = PARSE_SYSTEM_PROMPT.replace(
    "{CURRENT_DATETIME}",
    getCurrentDatetimeIST(),
  );

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userMessage }] }],
    generationConfig: {
      response_mime_type: "application/json",
    },
  };

  // Try up to 2 times (initial + 1 retry)
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Gemini API error (attempt ${attempt + 1}): ${res.status} ${errText}`);
      if (attempt === 1) throw new Error(`Gemini API failed: ${res.status}`);
      continue;
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error(`Gemini returned no text (attempt ${attempt + 1})`);
      if (attempt === 1) throw new Error("Gemini returned empty response");
      continue;
    }

    try {
      // Strip any markdown code fences if Gemini adds them despite instructions
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned) as GeminiParsedResponse;
    } catch (parseErr) {
      console.error(`JSON parse failed (attempt ${attempt + 1}):`, text);
      if (attempt === 1) throw new Error("Gemini returned invalid JSON");
    }
  }

  throw new Error("Gemini parsing failed after retries");
}

export async function transcribeAudio(audioBytes: Uint8Array): Promise<string> {
  // Convert to base64 for Gemini inline_data (chunked to avoid max arguments limit)
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < audioBytes.length; i += chunkSize) {
    const chunk = audioBytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  const base64Audio = btoa(binary);

  const body = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: "audio/ogg",
              data: base64Audio,
            },
          },
          {
            text: "Transcribe this audio accurately. The speaker may use English, Hindi, Hinglish, or Marathi. Output only the transcription, nothing else.",
          },
        ],
      },
    ],
  };

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Gemini transcription error: ${res.status} ${errText}`);
    throw new Error(`Gemini transcription failed: ${res.status}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || text.trim().length === 0) {
    throw new Error("Gemini transcription returned empty");
  }

  return text.trim();
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/gemini.ts
git commit -m "feat: add Gemini API helpers for parsing and transcription"
```

---

### Task 6: Message Formatters (`_shared/formatters.ts`)

**Files:**
- Create: `supabase/functions/_shared/formatters.ts`

- [ ] **Step 1: Create formatters**

Create `supabase/functions/_shared/formatters.ts`:

```typescript
import { DbMemory, TelegramInlineKeyboardButton } from "./types.ts";

const TYPE_EMOJI: Record<string, string> = {
  task: "\u{1F4CB}",       // clipboard
  reminder: "\u{23F0}",   // alarm clock
  note: "\u{1F4DD}",      // memo
  event: "\u{1F4C5}",     // calendar
  birthday: "\u{1F382}",  // birthday cake
};

function formatDate(isoDate: string | null): string {
  if (!isoDate) return "No deadline";
  const d = new Date(isoDate);
  return d.toLocaleString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function formatDateShort(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
}

function formatTime(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

// ---- Confirmation after saving a memory ----

export function formatConfirmation(memory: DbMemory): {
  text: string;
  buttons: TelegramInlineKeyboardButton[][];
} {
  const emoji = TYPE_EMOJI[memory.type] || "\u{1F4CB}";
  const lines = [
    "Got it! Here's what I saved:\n",
    `${emoji} *${memory.type.charAt(0).toUpperCase() + memory.type.slice(1)}:* ${memory.description}`,
  ];

  if (memory.due_date) {
    lines.push(`\u{1F4C6} *Due:* ${formatDate(memory.due_date)}`);
  } else {
    lines.push(`\u{1F4C6} *Due:* No deadline`);
  }

  if (memory.reminder_at) {
    lines.push(`\u{1F514} *Reminder:* ${formatDate(memory.reminder_at)}`);
  }

  const entities = memory.entities as { people?: string[] } | null;
  if (entities?.people && entities.people.length > 0) {
    lines.push(`\u{1F465} *People:* ${entities.people.join(", ")}`);
  }

  const buttons: TelegramInlineKeyboardButton[][] = [
    [
      { text: "\u{2705} Done", callback_data: `done:${memory.id}` },
      { text: "\u{23F0} Snooze 1hr", callback_data: `snooze:${memory.id}` },
      { text: "\u{1F5D1} Delete", callback_data: `delete:${memory.id}` },
    ],
  ];

  return { text: lines.join("\n"), buttons };
}

// ---- Query results ----

export function formatQueryResults(memories: DbMemory[], queryText: string): string {
  if (memories.length === 0) {
    return `No results found for "${queryText}".`;
  }

  const lines = [`Here's what I found for "${queryText}":\n`];
  memories.forEach((m, i) => {
    const emoji = TYPE_EMOJI[m.type] || "\u{1F4CB}";
    const status = m.status === "done" ? "\u{2705}" : "\u{23F3}";
    const due = m.due_date ? ` (due: ${formatDateShort(m.due_date)})` : "";
    lines.push(`${i + 1}. ${emoji} ${status} ${m.description}${due}`);
  });

  return lines.join("\n");
}

// ---- Pending tasks list ----

export function formatPendingList(memories: DbMemory[]): string {
  if (memories.length === 0) {
    return "You have no pending tasks. Enjoy your free time!";
  }

  const lines = [`You have *${memories.length}* pending items:\n`];
  memories.forEach((m, i) => {
    const emoji = TYPE_EMOJI[m.type] || "\u{1F4CB}";
    const due = m.due_date ? ` \u{2014} due ${formatDate(m.due_date)}` : "";
    lines.push(`${i + 1}. ${emoji} ${m.description}${due}`);
  });

  return lines.join("\n");
}

// ---- Ambiguous date options ----

export function formatAmbiguousDate(
  memoryId: string,
  dateOptions: string[],
): { text: string; buttons: TelegramInlineKeyboardButton[][] } {
  const text = "I'm not sure which date you mean. Which one?";
  const buttons: TelegramInlineKeyboardButton[][] = [
    dateOptions.map((iso) => ({
      text: formatDate(iso),
      callback_data: `date:${memoryId}:${iso}`,
    })),
  ];
  return { text, buttons };
}

// ---- Daily digest ----

export function formatDigest(
  firstName: string | null,
  overdue: DbMemory[],
  today: DbMemory[],
  tomorrow: DbMemory[],
  somedayCount: number,
): string {
  const name = firstName || "there";
  const lines: string[] = [`Good morning, ${name}!\n`];

  if (overdue.length > 0) {
    lines.push("\u{1F6A8} *OVERDUE:*");
    overdue.forEach((m) => {
      lines.push(`  \u{2022} ${m.description} (was due ${formatDateShort(m.due_date!)})`);
    });
    lines.push("");
  }

  if (today.length > 0) {
    lines.push("\u{1F4CB} *DUE TODAY:*");
    today.forEach((m) => {
      const time = m.due_date ? ` at ${formatTime(m.due_date)}` : "";
      lines.push(`  \u{2022} ${m.description}${time}`);
    });
    lines.push("");
  }

  if (tomorrow.length > 0) {
    lines.push("\u{1F4C5} *COMING TOMORROW:*");
    tomorrow.forEach((m) => {
      lines.push(`  \u{2022} ${m.description}`);
    });
    lines.push("");
  }

  if (somedayCount > 0) {
    lines.push(`\u{1F4AD} + ${somedayCount} items with no deadline`);
  }

  if (overdue.length === 0 && today.length === 0 && tomorrow.length === 0 && somedayCount === 0) {
    return ""; // Empty string signals "skip this user" to the digest sender
  }

  return lines.join("\n");
}

// ---- Reminder messages ----

export function formatReminder(memory: DbMemory): {
  text: string;
  buttons: TelegramInlineKeyboardButton[][];
} {
  const due = memory.due_date ? `\n*Due:* ${formatDate(memory.due_date)}` : "";
  const text = `\u{23F0} *Reminder:* ${memory.description}${due}`;
  const buttons: TelegramInlineKeyboardButton[][] = [
    [
      { text: "\u{2705} Done", callback_data: `done:${memory.id}` },
      { text: "\u{23F0} Snooze 1hr", callback_data: `snooze:${memory.id}` },
    ],
  ];
  return { text, buttons };
}

export function formatPreReminder(memory: DbMemory): {
  text: string;
  buttons: TelegramInlineKeyboardButton[][];
} {
  const text = `\u{1F514} *Heads up \u{2014} in 30 minutes:*\n${memory.description}`;
  const buttons: TelegramInlineKeyboardButton[][] = [
    [
      { text: "\u{2705} Done", callback_data: `done:${memory.id}` },
      { text: "\u{23F0} Snooze 1hr", callback_data: `snooze:${memory.id}` },
    ],
  ];
  return { text, buttons };
}

// ---- Done command: multiple match picker ----

export function formatDoneOptions(
  memories: DbMemory[],
): { text: string; buttons: TelegramInlineKeyboardButton[][] } {
  const lines = ["Multiple tasks match. Which one did you complete?\n"];
  const buttons: TelegramInlineKeyboardButton[][] = [];

  memories.forEach((m, i) => {
    lines.push(`${i + 1}. ${m.description}`);
    buttons.push([
      { text: `\u{2705} ${i + 1}. ${m.description.slice(0, 30)}`, callback_data: `done:${m.id}` },
    ]);
  });

  return { text: lines.join("\n"), buttons };
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/formatters.ts
git commit -m "feat: add message formatting helpers"
```

---

### Task 7: Webhook — Main Router + /start + Consent

**Files:**
- Create: `supabase/functions/telegram-webhook/index.ts`

This is the first deployable function. After this task, you can test `/start` and consent flow on Telegram.

- [ ] **Step 1: Create the webhook Edge Function scaffold**

```bash
cd /Users/yashpatni/Desktop/Claude-Code/Telegram
supabase functions new telegram-webhook
```

This creates `supabase/functions/telegram-webhook/index.ts` with boilerplate. We'll replace it entirely.

- [ ] **Step 2: Write the full webhook handler**

Replace `supabase/functions/telegram-webhook/index.ts` with:

```typescript
import { TelegramUpdate, TelegramMessage, TelegramCallbackQuery, GeminiParsedResponse } from "../_shared/types.ts";
import {
  sendMessage,
  sendMessageWithButtons,
  editMessageText,
  answerCallbackQuery,
  downloadTelegramFile,
} from "../_shared/telegram.ts";
import {
  upsertUser,
  getUser,
  updateUserConsent,
  deleteUserData,
  createMemory,
  updateMemory,
  deleteMemory,
  getPendingMemories,
  searchMemories,
  searchPendingByDescription,
} from "../_shared/database.ts";
import { parseMessage, transcribeAudio } from "../_shared/gemini.ts";
import {
  formatConfirmation,
  formatQueryResults,
  formatPendingList,
  formatAmbiguousDate,
  formatDoneOptions,
} from "../_shared/formatters.ts";

// ============================================================
// Main entry point
// ============================================================

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const update: TelegramUpdate = await req.json();
    await handleUpdate(update);
  } catch (error) {
    console.error("Top-level error:", error);
  }
  // Always 200 to prevent Telegram retries
  return new Response("OK", { status: 200 });
});

// ============================================================
// Update router (order matters — see spec section 6)
// ============================================================

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  const message = update.message;
  if (!message) return; // No message and no callback — ignore

  if (message.voice) {
    await handleVoice(message);
    return;
  }

  if (message.forward_date || message.forward_origin) {
    await handleForward(message);
    return;
  }

  if (message.text?.startsWith("/")) {
    await handleCommand(message);
    return;
  }

  if (message.text) {
    await handleText(message);
    return;
  }

  // Anything else (photos, stickers, etc.) — silently ignore
}

// ============================================================
// Command handlers
// ============================================================

async function handleCommand(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text!;
  const command = text.split(" ")[0].split("@")[0].toLowerCase(); // Handle /command@botname
  const args = text.slice(command.length).trim();

  switch (command) {
    case "/start":
      await handleStart(message);
      break;
    case "/help":
      await handleHelp(chatId);
      break;
    case "/privacy":
      await handlePrivacy(chatId);
      break;
    case "/delete":
      await handleDelete(message);
      break;
    case "/done":
      await handleDoneCommand(message, args);
      break;
    case "/pending":
      await handlePending(message);
      break;
    default:
      await sendMessage(chatId, "Unknown command. Try /help to see what I can do.");
  }
}

async function handleStart(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;
  const username = message.from?.username ?? null;
  const firstName = message.from?.first_name ?? null;

  const user = await upsertUser(telegramId, username, firstName);

  if (user.consent_given) {
    // Returning user who already consented
    await sendMessage(
      chatId,
      `Welcome back, ${firstName || "there"}! Just send me a message or voice note and I'll remember it for you.`,
    );
    return;
  }

  // New user or user who hasn't consented yet
  const name = firstName || "there";
  const welcomeText =
    `Hey ${name}!\n\n` +
    `I'm RemindKar \u{2014} your personal AI memory. Tell me anything you want to remember, and I'll make sure you never forget it.\n\n` +
    `Tasks, deadlines, birthdays, meeting notes, random ideas \u{2014} just text or voice note me. I'll organize everything and remind you when it matters.\n\n` +
    `Before we start, I need your consent to store your messages so I can help you. Your data is private, never shared, and you can delete everything anytime with /delete.`;

  await sendMessageWithButtons(chatId, welcomeText, [
    [
      { text: "\u{2705} I consent", callback_data: "consent_yes" },
      { text: "\u{274C} No thanks", callback_data: "consent_no" },
    ],
  ]);
}

async function handleHelp(chatId: number): Promise<void> {
  const helpText =
    "*RemindKar \u{2014} Commands*\n\n" +
    "/start \u{2014} Set up or restart the bot\n" +
    "/pending \u{2014} Show all pending tasks\n" +
    "/done <text> \u{2014} Mark a task as done\n" +
    "/privacy \u{2014} See privacy info\n" +
    "/delete \u{2014} Delete all your data\n" +
    "/help \u{2014} Show this message\n\n" +
    "*Just send me:*\n" +
    '\u{2022} A task: "Call Aman tomorrow at 5 PM"\n' +
    '\u{2022} A birthday: "Mom\'s birthday is 15th August"\n' +
    '\u{2022} A question: "Show my pending tasks"\n' +
    "\u{2022} A voice note in any language!";

  await sendMessage(chatId, helpText);
}

async function handlePrivacy(chatId: number): Promise<void> {
  const privacyText =
    "*RemindKar Privacy Info:*\n\n" +
    "*What I store:*\n" +
    "\u{2022} Your Telegram ID and first name\n" +
    "\u{2022} Messages you send me (text and voice transcriptions)\n" +
    "\u{2022} Tasks, reminders, and notes I extract from your messages\n\n" +
    "*What I DON'T do:*\n" +
    "\u{2022} Share your data with anyone\n" +
    "\u{2022} Use your data for training\n" +
    "\u{2022} Store data beyond what you send me\n\n" +
    "*Your controls:*\n" +
    "\u{2022} /delete \u{2014} permanently erase all your data\n" +
    "\u{2022} Every task has a Delete button\n\n" +
    "Data is stored on Supabase (hosted on AWS).";

  await sendMessage(chatId, privacyText);
}

async function handleDelete(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  try {
    await deleteUserData(telegramId);
    await sendMessage(
      chatId,
      "All your data has been permanently deleted. Send /start if you ever want to use RemindKar again.",
    );
  } catch (error) {
    console.error("Delete error:", error);
    await sendMessage(chatId, "Something went wrong. Please try again.");
  }
}

async function handleDoneCommand(message: TelegramMessage, searchText: string): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  if (!searchText) {
    await sendMessage(chatId, "Tell me which task you completed. Example: /done call Aman");
    return;
  }

  try {
    const matches = await searchPendingByDescription(telegramId, searchText);

    if (matches.length === 0) {
      await sendMessage(chatId, `No pending task found matching "${searchText}".`);
    } else if (matches.length === 1) {
      await updateMemory(matches[0].id, {
        status: "done",
        completed_at: new Date().toISOString(),
      });
      await sendMessage(chatId, `\u{2705} Done: ${matches[0].description}`);
    } else {
      // Multiple matches — show picker
      const { text, buttons } = formatDoneOptions(matches.slice(0, 5));
      await sendMessageWithButtons(chatId, text, buttons);
    }
  } catch (error) {
    console.error("Done command error:", error);
    await sendMessage(chatId, "Something went wrong. Please try again.");
  }
}

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
    await sendMessage(chatId, formatPendingList(memories));
  } catch (error) {
    console.error("Pending error:", error);
    await sendMessage(chatId, "Something went wrong. Please try again.");
  }
}

// ============================================================
// Callback query handler
// ============================================================

async function handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const data = query.data;
  if (!data) return;

  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  const telegramId = query.from.id;

  try {
    if (data === "consent_yes") {
      await updateUserConsent(telegramId, true);
      await answerCallbackQuery(query.id, "Consent recorded!");

      const onboardingText =
        "Let's try it out! Send me something \u{2014} a task, a reminder, anything:\n\n" +
        '"Remind me to call Aman tomorrow at 5 PM"\n' +
        '"Mom\'s birthday is on 15th August"\n' +
        '"Send the quarterly report to Priya by Friday EOD"\n\n' +
        "Or just send a voice note \u{2014} I understand Hindi, English, and Hinglish!";

      if (chatId && messageId) {
        await editMessageText(chatId, messageId, "Consent recorded. Let's go!");
      }
      if (chatId) {
        await sendMessage(chatId, onboardingText);
      }
      return;
    }

    if (data === "consent_no") {
      await answerCallbackQuery(query.id);
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          "No problem! I can't store memories without your consent, but feel free to come back anytime. Just send /start to begin again.",
        );
      }
      return;
    }

    if (data.startsWith("done:")) {
      const memoryId = data.slice(5);
      await updateMemory(memoryId, {
        status: "done",
        completed_at: new Date().toISOString(),
      });
      await answerCallbackQuery(query.id, "Marked as done!");
      if (chatId && messageId) {
        await editMessageText(chatId, messageId, "\u{2705} Task completed!");
      }
      return;
    }

    if (data.startsWith("snooze:")) {
      const memoryId = data.slice(7);
      // Push reminder_at by 1 hour from now
      const newReminder = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await updateMemory(memoryId, {
        reminder_at: newReminder,
        is_reminded: false,
        is_pre_reminded: false,
      });
      await answerCallbackQuery(query.id, "Snoozed for 1 hour!");
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          "\u{23F0} Snoozed! I'll remind you again in 1 hour.",
        );
      }
      return;
    }

    if (data.startsWith("delete:")) {
      const memoryId = data.slice(7);
      await deleteMemory(memoryId);
      await answerCallbackQuery(query.id, "Deleted!");
      if (chatId && messageId) {
        await editMessageText(chatId, messageId, "\u{1F5D1} Deleted.");
      }
      return;
    }

    if (data.startsWith("date:")) {
      // Format: date:{memoryId}:{isoDate}
      const parts = data.split(":");
      const memoryId = parts[1];
      const isoDate = parts.slice(2).join(":"); // ISO dates contain colons
      // Recalculate reminder_at: 30 min before due_date, or 9 AM on that date
      const dueDate = new Date(isoDate);
      const reminderAt = new Date(dueDate.getTime() - 30 * 60 * 1000).toISOString();
      await updateMemory(memoryId, {
        due_date: isoDate,
        reminder_at: reminderAt,
      });
      await answerCallbackQuery(query.id, "Date confirmed!");
      if (chatId && messageId) {
        const formatted = new Date(isoDate).toLocaleString("en-IN", {
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
          timeZone: "Asia/Kolkata",
        });
        await editMessageText(chatId, messageId, `\u{1F4C5} Date set: ${formatted}`);
      }
      return;
    }
  } catch (error) {
    console.error("Callback query error:", error);
    await answerCallbackQuery(query.id, "Something went wrong.");
  }
}

// ============================================================
// Text message handler
// ============================================================

async function handleText(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;
  const text = message.text!;

  // Consent gate
  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first and give consent before I can save your memories.");
    return;
  }

  try {
    const parsed = await parseMessage(text);
    await routeParsedIntent(chatId, telegramId, user.id, text, parsed, "text");
  } catch (error) {
    console.error("Text handler error:", error);
    await sendMessage(chatId, "I couldn't process that, please try again in a moment.");
  }
}

// ============================================================
// Voice message handler
// ============================================================

async function handleVoice(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  // Consent gate
  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first and give consent before I can save your memories.");
    return;
  }

  try {
    // Step 1: Download the voice file
    const audioBytes = await downloadTelegramFile(message.voice!.file_id);
    if (!audioBytes) {
      await sendMessage(chatId, "I couldn't download your voice note, please try again.");
      return;
    }

    // Step 2: Transcribe with Gemini
    let transcription: string;
    try {
      transcription = await transcribeAudio(audioBytes);
    } catch {
      await sendMessage(chatId, "I couldn't process your voice note \u{2014} could you type it instead?");
      return;
    }

    // Step 3: Parse the transcription
    const parsed = await parseMessage(transcription);

    // Show what was heard
    await sendMessage(chatId, `\u{1F399} I heard: "${transcription}"`);

    // Step 4: Route the parsed intent
    await routeParsedIntent(chatId, telegramId, user.id, transcription, parsed, "voice");
  } catch (error) {
    console.error("Voice handler error:", error);
    await sendMessage(chatId, "I couldn't process your voice note \u{2014} could you type it instead?");
  }
}

// ============================================================
// Forward handler
// ============================================================

async function handleForward(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  // Consent gate
  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first and give consent before I can save your memories.");
    return;
  }

  // Extract text from forwarded message
  const text = message.text;
  if (!text) {
    await sendMessage(chatId, "I can only process forwarded text messages for now.");
    return;
  }

  try {
    const parsed = await parseMessage(text);
    await routeParsedIntent(chatId, telegramId, user.id, text, parsed, "forwarded");
  } catch (error) {
    console.error("Forward handler error:", error);
    await sendMessage(chatId, "I couldn't process that forwarded message, please try again.");
  }
}

// ============================================================
// Shared: route parsed intent to storage or query
// ============================================================

async function routeParsedIntent(
  chatId: number,
  telegramId: number,
  userId: string,
  rawInput: string,
  parsed: GeminiParsedResponse,
  source: string,
): Promise<void> {
  switch (parsed.intent) {
    case "greeting":
      await sendMessage(
        chatId,
        "Hey! Send me a task, reminder, or question \u{2014} I'm ready to help.",
      );
      return;

    case "query":
      await handleQuery(chatId, telegramId, parsed.query_text || rawInput);
      return;

    case "done":
      await handleDoneIntent(chatId, telegramId, parsed.description);
      return;

    case "unknown":
      await sendMessage(
        chatId,
        "I'm not sure what to do with that. Try sending a task, reminder, or ask me a question about your saved items.",
      );
      return;

    default: {
      // task, reminder, event, birthday, note — store it
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
      });

      // Handle ambiguous dates
      if (parsed.ambiguous_date && parsed.date_options.length > 1) {
        const { text, buttons } = formatAmbiguousDate(memory.id, parsed.date_options);
        await sendMessageWithButtons(chatId, text, buttons);
        return;
      }

      // Normal confirmation
      const { text, buttons } = formatConfirmation(memory);
      await sendMessageWithButtons(chatId, text, buttons);
    }
  }
}

async function handleQuery(
  chatId: number,
  telegramId: number,
  queryText: string,
): Promise<void> {
  const results = await searchMemories(telegramId, queryText);
  await sendMessage(chatId, formatQueryResults(results, queryText));
}

async function handleDoneIntent(
  chatId: number,
  telegramId: number,
  description: string,
): Promise<void> {
  const matches = await searchPendingByDescription(telegramId, description);

  if (matches.length === 0) {
    await sendMessage(chatId, `No pending task found matching "${description}".`);
  } else if (matches.length === 1) {
    await updateMemory(matches[0].id, {
      status: "done",
      completed_at: new Date().toISOString(),
    });
    await sendMessage(chatId, `\u{2705} Done: ${matches[0].description}`);
  } else {
    const { text, buttons } = formatDoneOptions(matches.slice(0, 5));
    await sendMessageWithButtons(chatId, text, buttons);
  }
}
```

- [ ] **Step 3: Deploy and test /start**

Set secrets (replace with your actual values):
```bash
supabase secrets set TELEGRAM_BOT_TOKEN=<your-token> GEMINI_API_KEY=<your-key>
```

Deploy:
```bash
supabase functions deploy telegram-webhook
```

Register webhook with Telegram (replace placeholders):
```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=<YOUR_SUPABASE_URL>/functions/v1/telegram-webhook"
```

Expected response: `{"ok":true,"result":true,"description":"Webhook was set"}`

- [ ] **Step 4: Manual test — /start and consent flow**

On Telegram, message @RemindKarBot:
1. Send `/start` — expect welcome message with consent buttons
2. Tap "I consent" — expect onboarding message with examples
3. Send `/start` again — expect "Welcome back!" (consent not reset)

- [ ] **Step 5: Manual test — text message parsing**

Send: `Remind me to call Aman tomorrow at 5 PM`
Expected: Confirmation message with parsed task, due date, and Done/Snooze/Delete buttons.

Send: `Show my pending tasks`
Expected: Query result showing the task just created.

- [ ] **Step 6: Manual test — callback buttons**

Tap "Done" on the confirmation message — expect "Task completed!"
Send another task, tap "Snooze 1hr" — expect "Snoozed!" message.
Send another task, tap "Delete" — expect "Deleted." message.

- [ ] **Step 7: Manual test — commands**

Send `/help` — expect help text
Send `/privacy` — expect privacy policy
Send `/pending` — expect pending list
Send `/done call` — expect matching task or "no match"

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/telegram-webhook/index.ts
git commit -m "feat: add main webhook handler with all routes"
```

---

### Task 8: Send-Reminders Edge Function

**Files:**
- Create: `supabase/functions/send-reminders/index.ts`

- [ ] **Step 1: Create the function scaffold**

```bash
cd /Users/yashpatni/Desktop/Claude-Code/Telegram
supabase functions new send-reminders
```

- [ ] **Step 2: Write the send-reminders handler**

Replace `supabase/functions/send-reminders/index.ts` with:

```typescript
import { getDueReminders, getDuePreReminders, updateMemory } from "../_shared/database.ts";
import { sendMessageWithButtons } from "../_shared/telegram.ts";
import { formatReminder, formatPreReminder } from "../_shared/formatters.ts";

Deno.serve(async (req) => {
  try {
    // Verify this is called with proper auth (service role key via pg_net)
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }

    console.log("send-reminders: starting check...");

    // 1. Send pre-reminders (30 min before)
    const preReminders = await getDuePreReminders();
    console.log(`send-reminders: ${preReminders.length} pre-reminders due`);

    for (const memory of preReminders) {
      try {
        const { text, buttons } = formatPreReminder(memory);
        await sendMessageWithButtons(memory.telegram_id, text, buttons);
        await updateMemory(memory.id, { is_pre_reminded: true });
      } catch (err) {
        console.error(`Failed to send pre-reminder for ${memory.id}:`, err);
      }
    }

    // 2. Send due reminders
    const reminders = await getDueReminders();
    console.log(`send-reminders: ${reminders.length} reminders due`);

    for (const memory of reminders) {
      try {
        const { text, buttons } = formatReminder(memory);
        await sendMessageWithButtons(memory.telegram_id, text, buttons);
        await updateMemory(memory.id, { is_reminded: true });
      } catch (err) {
        console.error(`Failed to send reminder for ${memory.id}:`, err);
      }
    }

    console.log("send-reminders: done");
    return new Response(JSON.stringify({ pre: preReminders.length, reminders: reminders.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("send-reminders error:", error);
    return new Response("Internal error", { status: 500 });
  }
});
```

- [ ] **Step 3: Deploy and test**

```bash
supabase functions deploy send-reminders
```

Test manually with curl (replace placeholders):
```bash
curl -X POST "<YOUR_SUPABASE_URL>/functions/v1/send-reminders" \
  -H "Authorization: Bearer <YOUR_SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected: `{"pre":0,"reminders":0}` (or actual counts if you have tasks with reminder_at in the past).

To test with real data: create a task on Telegram with a reminder in the past (e.g., "remind me at [2 minutes ago]"), then curl the function. Check Telegram for the reminder message.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/send-reminders/index.ts
git commit -m "feat: add send-reminders cron function"
```

---

### Task 9: Send-Digest Edge Function

**Files:**
- Create: `supabase/functions/send-digest/index.ts`

- [ ] **Step 1: Create the function scaffold**

```bash
cd /Users/yashpatni/Desktop/Claude-Code/Telegram
supabase functions new send-digest
```

- [ ] **Step 2: Write the send-digest handler**

Replace `supabase/functions/send-digest/index.ts` with:

```typescript
import { getActiveConsentedUsers, getDigestMemories } from "../_shared/database.ts";
import { sendMessage } from "../_shared/telegram.ts";
import { formatDigest } from "../_shared/formatters.ts";

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }

    console.log("send-digest: starting...");

    const users = await getActiveConsentedUsers();
    console.log(`send-digest: ${users.length} active users`);

    let sentCount = 0;

    for (const user of users) {
      try {
        const { overdue, today, tomorrow, somedayCount } = await getDigestMemories(user.telegram_id);
        const digestText = formatDigest(user.first_name, overdue, today, tomorrow, somedayCount);

        // Skip users with nothing pending
        if (!digestText) continue;

        await sendMessage(user.telegram_id, digestText);
        sentCount++;
      } catch (err) {
        console.error(`Failed to send digest to ${user.telegram_id}:`, err);
      }
    }

    console.log(`send-digest: sent to ${sentCount} users`);
    return new Response(JSON.stringify({ users: users.length, sent: sentCount }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("send-digest error:", error);
    return new Response("Internal error", { status: 500 });
  }
});
```

- [ ] **Step 3: Deploy and test**

```bash
supabase functions deploy send-digest
```

Test manually:
```bash
curl -X POST "<YOUR_SUPABASE_URL>/functions/v1/send-digest" \
  -H "Authorization: Bearer <YOUR_SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected: JSON response with user and sent counts. If you have pending tasks, check Telegram for the digest message.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/send-digest/index.ts
git commit -m "feat: add send-digest daily cron function"
```

---

### Task 10: pg_cron Job Setup

**Files:**
- Create: `supabase/migrations/002_cron_jobs.sql`

- [ ] **Step 1: Create the cron jobs migration**

Create `supabase/migrations/002_cron_jobs.sql`:

```sql
-- =============================================================
-- RemindKar: Cron Jobs
-- Run AFTER Edge Functions are deployed (needs their URLs)
-- =============================================================

-- Enable required extensions
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Daily digest at 9:00 AM IST (3:30 AM UTC)
select cron.schedule(
  'daily-digest',
  '30 3 * * *',
  $$select net.http_post(
    url := 'SUPABASE_URL_PLACEHOLDER/functions/v1/send-digest',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY_PLACEHOLDER", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  )$$
);

-- Reminder check every 5 minutes
select cron.schedule(
  'check-reminders',
  '*/5 * * * *',
  $$select net.http_post(
    url := 'SUPABASE_URL_PLACEHOLDER/functions/v1/send-reminders',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY_PLACEHOLDER", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  )$$
);
```

- [ ] **Step 2: Apply the cron jobs**

**Do NOT use `supabase db push` for this file.** The placeholders must be replaced first.

Copy the SQL, replace `SUPABASE_URL_PLACEHOLDER` with your actual Supabase URL (e.g., `https://abcdefgh.supabase.co`) and `SERVICE_ROLE_KEY_PLACEHOLDER` with your service role key. Then run the SQL in the Supabase Dashboard SQL Editor.

- [ ] **Step 3: Verify cron jobs are scheduled**

Run in SQL Editor:
```sql
select * from cron.job;
```

Expected: Two rows — `daily-digest` and `check-reminders`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/002_cron_jobs.sql
git commit -m "feat: add pg_cron jobs for digest and reminders"
```

---

### Task 11: End-to-End Smoke Test

No new files. This task verifies the full system works.

- [ ] **Step 1: Test text task with date**

Send to @RemindKarBot: `Remind me to submit the report by tomorrow 6 PM`

Verify:
- Confirmation message appears with correct description, date, and buttons
- Run `/pending` — task appears in list

- [ ] **Step 2: Test text task without date**

Send: `Buy groceries from Big Bazaar`

Verify:
- Confirmation shows "No deadline"
- Run `/pending` — appears in list

- [ ] **Step 3: Test voice note**

Record a voice note saying: "Aman ko kal 5 baje call karna hai"

Verify:
- Bot replies with "I heard: ..." showing the transcription
- Confirmation message appears with parsed task

- [ ] **Step 4: Test query**

Send: `What did I save about report?`

Verify:
- Bot returns search results including the report task

Send: `Show my pending tasks`

Verify:
- Bot returns list of pending items

- [ ] **Step 5: Test forwarded message**

Forward a message from another chat to @RemindKarBot.

Verify:
- Bot extracts actionable content and creates a task

- [ ] **Step 6: Test button interactions**

On any confirmation message:
- Tap "Done" — message changes to "Task completed!"
- Create new task, tap "Snooze 1hr" — message changes to "Snoozed!"
- Create new task, tap "Delete" — message changes to "Deleted."

- [ ] **Step 7: Test reminder delivery**

Create a task with a reminder set to 2-3 minutes from now: `Remind me to check email in 3 minutes`

Wait for the next 5-minute cron cycle. Verify:
- Pre-reminder arrives ~30 seconds before (if within the 30-min window)
- Reminder arrives at the scheduled time
- Reminder includes Done/Snooze buttons

Alternative: manually trigger the reminder function via curl to test immediately.

- [ ] **Step 8: Test digest delivery**

Manually trigger the digest:
```bash
curl -X POST "<YOUR_SUPABASE_URL>/functions/v1/send-digest" \
  -H "Authorization: Bearer <YOUR_SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Verify: Telegram message arrives with correct sections (overdue, today, tomorrow, someday count).

- [ ] **Step 9: Test privacy and deletion**

Send `/privacy` — verify privacy text appears.
Send `/delete` — verify confirmation and that `/pending` returns empty after.
Send `/start` — verify fresh onboarding (consent required again).

- [ ] **Step 10: Test edge cases**

- Send a photo — bot should silently ignore it
- Send `/start` twice — second time should say "Welcome back!"
- Send a message without consenting first — bot should ask for consent
- Send two messages rapidly — both should be processed

---

### Task 12: Final Cleanup + Deploy All

- [ ] **Step 1: Redeploy all functions**

If any changes were made during testing:

```bash
supabase functions deploy telegram-webhook
supabase functions deploy send-reminders
supabase functions deploy send-digest
```

- [ ] **Step 2: Verify webhook is set**

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo"
```

Verify: `url` points to your telegram-webhook function, `pending_update_count` is 0 or low.

- [ ] **Step 3: Set bot commands in Telegram**

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{"commands": [
    {"command": "start", "description": "Set up RemindKar"},
    {"command": "pending", "description": "Show pending tasks"},
    {"command": "done", "description": "Mark a task as done"},
    {"command": "help", "description": "Show help"},
    {"command": "privacy", "description": "Privacy info"},
    {"command": "delete", "description": "Delete all your data"}
  ]}'
```

- [ ] **Step 4: Set bot description**

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/setMyDescription" \
  -H "Content-Type: application/json" \
  -d '{"description": "Your personal AI memory — tasks, reminders, and notes. Just text or voice note me in English, Hindi, or Hinglish!"}'
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: RemindKar MVP complete — ready for launch"
```
