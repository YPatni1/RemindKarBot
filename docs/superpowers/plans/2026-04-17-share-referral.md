# Share + Referral Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/share` command that lets users share RemindKar via Telegram's inline chat picker, with full referral tracking (who shared, who joined, conversion status).

**Architecture:** User taps `/share` → gets a `switch_inline_query_chosen_chat` button → picks a friend/group → inline query fires → bot responds with an invite card containing a deep link → friend taps "Try it" → `/start ref_<telegram_id>` detected → referral row updated to `converted`.

**Tech Stack:** Telegram Bot API (inline mode + deep links), Supabase PostgreSQL (referrals table), Deno/TypeScript Edge Functions.

---

## Pre-Implementation: Manual BotFather Step (do this FIRST)

Before any code runs, enable inline mode:
1. Open `@BotFather` in Telegram
2. Send `/setinline`
3. Pick your bot
4. Set placeholder: `Share RemindKar with a friend`

Without this, the `switch_inline_query_chosen_chat` button silently fails.

---

## File Map

| File | Action | What changes |
|---|---|---|
| `supabase/migrations/010_referrals.sql` | Create | `referrals` table + `referral_code`/`referred_by` cols on `users` |
| `supabase/functions/_shared/types.ts` | Modify | Add `TelegramInlineQuery`, update `TelegramUpdate`, update button type to union, extend `DbUser` |
| `supabase/functions/_shared/constants.ts` | Modify | Add `BOT_HANDLE` constant |
| `supabase/functions/_shared/database.ts` | Modify | Add `createReferral`, `convertReferral`, `getReferralStats` |
| `supabase/functions/_shared/telegram.ts` | Modify | Add `answerInlineQuery` helper |
| `supabase/functions/telegram-webhook/index.ts` | Modify | Add `/share` command, `handleInlineQuery`, referral parsing in `handleStart`, `/help` update |
| `CLAUDE.md` | Modify | Add referral/share feature notes |
| `OVERVIEW.md` | Modify | Add referrals table, share feature |
| `ROADMAP.md` | Modify | Add /share to shipped section |

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/010_referrals.sql`

- [ ] **Step 1: Write migration**

```sql
-- Migration 010: referral tracking
-- Adds referral_code + referred_by to users, creates referrals table

ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code text UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by bigint REFERENCES users(telegram_id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id bigint NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  referred_id bigint REFERENCES users(telegram_id) ON DELETE SET NULL,
  referral_code text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'converted')),
  shared_at timestamptz NOT NULL DEFAULT now(),
  converted_at timestamptz,
  UNIQUE(referrer_id, referred_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
```

- [ ] **Step 2: Apply migration**

```bash
cd /Users/yashpatni/Desktop/Claude-Code/Telegram
npx supabase db push --linked
```

Expected output: migration applied successfully, no errors.

- [ ] **Step 3: Verify in Supabase dashboard**

Check that:
- `users` table has `referral_code` (text, nullable, unique) and `referred_by` (bigint, nullable)
- `referrals` table exists with all columns and indexes

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/010_referrals.sql
git commit -m "feat: add referrals table + referral_code/referred_by to users"
```

---

## Task 2: Types

**Files:**
- Modify: `supabase/functions/_shared/types.ts`

- [ ] **Step 1: Add `TelegramInlineQuery` interface and update `TelegramUpdate`**

In `types.ts`, add after the `TelegramCallbackQuery` interface:

```typescript
export interface TelegramInlineQuery {
  id: string;
  from: TelegramUser;
  query: string;
  offset: string;
}
```

Update `TelegramUpdate`:

```typescript
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  inline_query?: TelegramInlineQuery;
}
```

- [ ] **Step 2: Update `TelegramInlineKeyboardButton` to a union type**

Replace the existing interface:

```typescript
// Old:
export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}
```

With:

```typescript
export type TelegramInlineKeyboardButton =
  | { text: string; callback_data: string }
  | { text: string; url: string }
  | { text: string; switch_inline_query_chosen_chat: {
      query: string;
      allow_user_chats: boolean;
      allow_group_chats: boolean;
      allow_channel_chats: boolean;
      allow_bot_chats: boolean;
    }
  };
```

- [ ] **Step 3: Add `InlineQueryResultArticle` type**

After the `TelegramInlineQuery` interface:

```typescript
export interface InlineQueryResultArticle {
  type: "article";
  id: string;
  title: string;
  description?: string;
  thumb_url?: string;
  input_message_content: {
    message_text: string;
    parse_mode?: string;
  };
  reply_markup?: {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
}
```

- [ ] **Step 4: Extend `DbUser` with referral fields**

Add to `DbUser`:

```typescript
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
  current_streak: number;
  longest_streak: number;
  last_streak_date: string | null;
  referral_code: string | null;    // ADD
  referred_by: number | null;      // ADD
}
```

- [ ] **Step 5: Verify no TypeScript errors**

The union type means existing button objects `{ text: "...", callback_data: "..." }` still satisfy the type. Check that no existing call sites break.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/types.ts
git commit -m "feat: add inline query types, url/switch button types, referral fields on DbUser"
```

---

## Task 3: Constants

**Files:**
- Modify: `supabase/functions/_shared/constants.ts`

- [ ] **Step 1: Read the file to see current contents**

Read `supabase/functions/_shared/constants.ts` to understand current TZ_OFFSETS structure.

- [ ] **Step 2: Add `BOT_HANDLE` constant**

Add at the top of the file, before `TZ_OFFSETS`:

```typescript
// Telegram bot handle — used for constructing deep links in /share
// Update this if the bot username changes
export const BOT_HANDLE = "RemindKar_bot";
```

> Note: Update `RemindKar_bot` to match your actual bot's username from BotFather.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/constants.ts
git commit -m "feat: add BOT_HANDLE constant for share deep links"
```

---

## Task 4: Database Functions

**Files:**
- Modify: `supabase/functions/_shared/database.ts`

- [ ] **Step 1: Add `createReferral` function**

Add after the `createFeedback` function:

```typescript
// ---- Referrals ----

// Log a share event (pending referral) — idempotent, uses ON CONFLICT DO NOTHING
// referral_code is "ref_<referrer_telegram_id>"
export async function createReferral(referrerId: number): Promise<void> {
  const referralCode = `ref_${referrerId}`;
  // Ensure user has referral_code set
  await supabase
    .from("users")
    .update({ referral_code: referralCode })
    .eq("telegram_id", referrerId)
    .is("referral_code", null);

  // Insert pending referral — ignore if a pending one already exists for this referrer
  // We don't have referred_id yet (that comes at conversion), so just record the share
  // This is informational — we track it for analytics (how many shares happened)
  await supabase.from("referrals").upsert(
    {
      referrer_id: referrerId,
      referral_code: referralCode,
      status: "pending",
    },
    { onConflict: "referrer_id,referral_code", ignoreDuplicates: true }
  );
}

// Convert a referral when a new user joins via deep link
// referralCode is the "ref_<referrer_telegram_id>" string from /start payload
export async function convertReferral(
  referralCode: string,
  referredId: number,
): Promise<number | null> {
  // Extract referrer telegram_id from code
  const match = referralCode.match(/^ref_(\d+)$/);
  if (!match) return null;
  const referrerId = parseInt(match[1], 10);

  // Self-referral guard
  if (referrerId === referredId) return null;

  // Check referrer exists
  const { data: referrer } = await supabase
    .from("users")
    .select("telegram_id")
    .eq("telegram_id", referrerId)
    .maybeSingle();
  if (!referrer) return null;

  // Ensure referrer has referral_code set
  await supabase
    .from("users")
    .update({ referral_code: referralCode })
    .eq("telegram_id", referrerId)
    .is("referral_code", null);

  // Record referred_by on new user
  await supabase
    .from("users")
    .update({ referred_by: referrerId })
    .eq("telegram_id", referredId)
    .is("referred_by", null);

  // Upsert referral row with conversion info
  const { error } = await supabase.from("referrals").upsert(
    {
      referrer_id: referrerId,
      referred_id: referredId,
      referral_code: referralCode,
      status: "converted",
      converted_at: new Date().toISOString(),
    },
    { onConflict: "referrer_id,referred_id" }
  );
  if (error) {
    console.error("convertReferral upsert failed:", error);
    return null;
  }

  return referrerId;
}

// Get referral stats for a user (total shares, total conversions)
export async function getReferralStats(
  telegramId: number,
): Promise<{ shares: number; conversions: number }> {
  const { data, error } = await supabase
    .from("referrals")
    .select("status")
    .eq("referrer_id", telegramId);

  if (error || !data) return { shares: 0, conversions: 0 };

  const conversions = data.filter((r) => r.status === "converted").length;
  return { shares: data.length, conversions };
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/database.ts
git commit -m "feat: add createReferral, convertReferral, getReferralStats to database.ts"
```

---

## Task 5: Telegram Helper

**Files:**
- Modify: `supabase/functions/_shared/telegram.ts`

- [ ] **Step 1: Import `InlineQueryResultArticle` at the top**

Update the import line from types.ts:

```typescript
import { TelegramInlineKeyboardButton, InlineQueryResultArticle } from "./types.ts";
```

- [ ] **Step 2: Add `answerInlineQuery` function**

Add after the `downloadTelegramFile` function:

```typescript
export async function answerInlineQuery(
  inlineQueryId: string,
  results: InlineQueryResultArticle[],
): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}/answerInlineQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inline_query_id: inlineQueryId,
      results,
      cache_time: 0,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`answerInlineQuery failed: ${res.status} ${err}`);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/telegram.ts
git commit -m "feat: add answerInlineQuery helper to telegram.ts"
```

---

## Task 6: Index — `/share` Command + Inline Handler + `/start` Referral

**Files:**
- Modify: `supabase/functions/telegram-webhook/index.ts`

- [ ] **Step 1: Update imports**

Add `BOT_HANDLE` to the constants import and `answerInlineQuery` to the telegram import, and `createReferral`, `convertReferral`, `getReferralStats` to the database import. Also add `InlineQueryResultArticle` and `TelegramInlineQuery` to the types import.

At the top of `index.ts`:

```typescript
import { TelegramUpdate, TelegramMessage, TelegramCallbackQuery, TelegramInlineQuery, GeminiParsedResponse, DbMemory, ConversationMessage, InlineQueryResultArticle } from "../_shared/types.ts";
import { TZ_OFFSETS, BOT_HANDLE } from "../_shared/constants.ts";
import {
  sendMessage,
  sendMessageWithButtons,
  editMessageText,
  editMessageWithButtons,
  answerCallbackQuery,
  answerInlineQuery,
  downloadTelegramFile,
  escapeHtml,
} from "../_shared/telegram.ts";
import {
  upsertUser,
  getUser,
  updateUserConsent,
  updateUserTimezone,
  deleteUserData,
  deleteAllMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  getPendingMemories,
  searchMemories,
  searchPendingByDescription,
  getCompletedSince,
  getMemoryById,
  getMemoriesByDateRange,
  semanticSearch,
  getOverdueMemories,
  updateUserStreak,
  upsertSession,
  getSession,
  createConversationLog,
  createFeedback,
  createReferral,
  convertReferral,
  getReferralStats,
} from "../_shared/database.ts";
```

- [ ] **Step 2: Add inline_query routing in `handleUpdate`**

In `handleUpdate`, add a branch for `inline_query` BEFORE the `callback_query` check (line ~228):

```typescript
async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const startMs = Date.now();

  // Handle inline queries (from /share button)
  if (update.inline_query) {
    await handleInlineQuery(update.inline_query);
    return;
  }

  if (update.callback_query) {
    // ... existing callback handling ...
```

- [ ] **Step 3: Add `handleInlineQuery` function**

Add this function before the command handlers section:

```typescript
// ============================================================
// Inline query handler — fires when user taps the /share button
// and picks a chat from Telegram's chat picker
// ============================================================

async function handleInlineQuery(query: TelegramInlineQuery): Promise<void> {
  const telegramId = query.from.id;

  // Only serve registered, consented users
  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    // Return empty results for unregistered users
    await answerInlineQuery(query.id, []);
    return;
  }

  const referralCode = `ref_${telegramId}`;
  const deepLink = `https://t.me/${BOT_HANDLE}?start=${referralCode}`;
  const firstName = escapeHtml(user.first_name || "a friend");

  // Log the share event (non-fatal)
  try {
    await createReferral(telegramId);
  } catch (err) {
    console.error("createReferral failed (non-fatal):", err);
  }

  const inviteCard: InlineQueryResultArticle = {
    type: "article",
    id: "share_remindkar",
    title: "Invite to RemindKar",
    description: "AI-powered task & reminder tracker — works right in Telegram",
    input_message_content: {
      message_text:
        `Hey! I've been using <b>RemindKar</b> to track my tasks and reminders — it works right here in Telegram.\n\n` +
        `Just text it anything you want to remember and it handles the rest. Try it \u{1F447}`,
      parse_mode: "HTML",
    },
    reply_markup: {
      inline_keyboard: [[{ text: "\u{2728} Try RemindKar", url: deepLink }]],
    },
  };

  await answerInlineQuery(query.id, [inviteCard]);
}
```

- [ ] **Step 4: Add `/share` to `handleCommand` switch**

In the `handleCommand` switch, add before the `default` case:

```typescript
    case "/share":
      await handleShare(message);
      break;
```

- [ ] **Step 5: Add `handleShare` function**

Add after `handleFeedbackCommand`:

```typescript
async function handleShare(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first to set up RemindKar.");
    return;
  }

  // Get referral stats to personalise the message
  let statsText = "";
  try {
    const stats = await getReferralStats(telegramId);
    if (stats.conversions > 0) {
      statsText = `\n\nYou've already brought in <b>${stats.conversions}</b> friend${stats.conversions > 1 ? "s" : ""}!`;
    }
  } catch {
    // Non-fatal — skip stats line
  }

  const shareText =
    `\u{1F4E8} <b>Share RemindKar</b>\n\n` +
    `Tap the button below, pick a friend or group, and send them an invite card with your personal link.${statsText}`;

  await sendMessageWithButtons(chatId, shareText, [
    [
      {
        text: "\u{1F4E4} Share with a friend",
        switch_inline_query_chosen_chat: {
          query: "",
          allow_user_chats: true,
          allow_group_chats: true,
          allow_channel_chats: false,
          allow_bot_chats: false,
        },
      },
    ],
  ]);
}
```

- [ ] **Step 6: Update `handleStart` to parse referral deep link**

In `handleStart`, after `const user = await upsertUser(telegramId, username, firstName);`, add referral parsing:

```typescript
async function handleStart(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;
  const username = message.from?.username ?? null;
  const firstName = message.from?.first_name ?? null;

  // Parse deep link payload: "/start ref_123456"
  const payload = message.text?.split(" ")[1] ?? null;

  const user = await upsertUser(telegramId, username, firstName);

  // Handle referral conversion (non-fatal — never block onboarding)
  if (payload?.startsWith("ref_") && !user.referred_by) {
    try {
      const referrerId = await convertReferral(payload, telegramId);
      if (referrerId) {
        // Notify the referrer
        const joinerName = escapeHtml(firstName || "Someone");
        await sendMessage(
          referrerId,
          `\u{1F389} <b>${joinerName}</b> just joined RemindKar using your invite link!`,
        ).catch(() => {}); // Referrer may have blocked the bot — non-fatal
      }
    } catch (err) {
      console.error("Referral conversion failed (non-fatal):", err);
    }
  }

  if (user.consent_given) {
    await sendMessage(
      chatId,
      `Welcome back, ${escapeHtml(firstName || "there")}! Just send me a message or voice note and I'll remember it for you.`,
    );
    return;
  }

  // ... rest of existing handleStart (consent message) unchanged ...
```

- [ ] **Step 7: Update `/help` to include `/share`**

In `handleHelp`, add `/share` to the commands list:

```typescript
async function handleHelp(chatId: number): Promise<void> {
  const helpText =
    "<b>RemindKar \u{2014} Commands</b>\n\n" +
    "/start \u{2014} Set up or restart the bot\n" +
    "/pending \u{2014} Show all pending tasks\n" +
    "/done &lt;text&gt; \u{2014} Mark a task as done\n" +
    "/share \u{2014} Invite friends to RemindKar\n" +
    "/feedback \u{2014} Share feedback with us\n" +
    "/privacy \u{2014} See privacy info\n" +
    "/delete \u{2014} Delete all your data\n" +
    "/help \u{2014} Show this message\n\n" +
    "<b>Just send me:</b>\n" +
    '\u{2022} A task: "Call Aman tomorrow at 5 PM"\n' +
    '\u{2022} A birthday: "Mom\'s birthday is 15th August"\n' +
    '\u{2022} A question: "Show my pending tasks"\n' +
    "\u{2022} A voice note in any language!";

  await sendMessage(chatId, helpText);
}
```

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/telegram-webhook/index.ts
git commit -m "feat: add /share command, inline query handler, referral deep link parsing in /start"
```

---

## Task 7: Update Docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `OVERVIEW.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Update `CLAUDE.md`**

Add to the **Key Rules** section:

```
- Inline mode: enabled via BotFather (`/setinline`). Bot handles `inline_query` updates in `handleUpdate` before `callback_query`. Non-consented users get empty results.
- Referral tracking: `/share` sends `switch_inline_query_chosen_chat` button. Inline query response logs share via `createReferral`. Deep link `?start=ref_<telegram_id>` triggers `convertReferral` in `handleStart`. Referrer notified on conversion (non-fatal if blocked).
- `BOT_HANDLE` constant in `_shared/constants.ts` — must match actual BotFather username for deep links to work.
- Referral code format: `ref_<telegram_id>` (deterministic, no random codes needed). Self-referral blocked in `convertReferral`.
- Migration 010: `referrals` table (referrer_id, referred_id, status pending/converted). `users` gets `referral_code` (text unique) and `referred_by` (bigint FK).
```

Also update the migrations list in the project structure section:

```
    010_referrals.sql                  # referrals table + referral_code/referred_by on users
```

- [ ] **Step 2: Update `OVERVIEW.md`**

Add `referrals` table to the Database Schema section:

```markdown
### `referrals`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| referrer_id | bigint FK → users | Who shared the link |
| referred_id | bigint FK → users | Who joined (null until converted) |
| referral_code | text | `ref_<referrer_telegram_id>` |
| status | text | `pending` (shared) / `converted` (joined) |
| shared_at | timestamptz | When inline query fired |
| converted_at | timestamptz | When new user hit /start with code |
```

Add to the `users` schema table:

```
| referral_code | text | Unique, nullable. Format: `ref_<telegram_id>` |
| referred_by | bigint | FK to users.telegram_id of their referrer |
```

Add to Key Features & Logic table:

```
| **Viral sharing** | `/share` sends `switch_inline_query_chosen_chat` button → user picks friend → invite card sent with deep link → referral tracked on conversion |
```

Add to the Message Processing Flow diagram — add `/share` under `/command?` branch.

- [ ] **Step 3: Update `ROADMAP.md`**

Add to the "This Week (Shipped)" section (update the date):

```markdown
## Share + Referrals (Shipped 2026-04-17)

- [x] **`/share` command with inline chat picker** — `switch_inline_query_chosen_chat` button opens Telegram's native chat picker. User picks a friend or group; invite card with deep link is sent.
- [x] **Referral tracking** — `referrals` table tracks every share (pending) and every join (converted). `convertReferral` called on `/start ref_<id>`; referrer notified on conversion.
- [x] **Referral stats in `/share`** — Shows "You've brought in N friends!" for users who have conversions.
```

- [ ] **Step 4: Commit docs**

```bash
git add CLAUDE.md OVERVIEW.md ROADMAP.md
git commit -m "docs: update CLAUDE.md, OVERVIEW.md, ROADMAP.md for /share + referral tracking"
```

---

## Task 8: Deploy

- [ ] **Step 1: Deploy the webhook function**

```bash
cd /Users/yashpatni/Desktop/Claude-Code/Telegram
npx supabase functions deploy telegram-webhook
```

Expected: `Deployed telegram-webhook`

- [ ] **Step 2: Verify deployment**

```bash
npx supabase functions list
```

Expected: `telegram-webhook` shows in the list with a recent deploy timestamp.

---

## Task 9: Test

- [ ] **Step 1: Test `/share` command**

Send a POST simulating the `/share` command (replace `<WEBHOOK_URL>` and `<YOUR_TELEGRAM_ID>` with real values):

```bash
curl -s -X POST <WEBHOOK_URL> \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 1001,
    "message": {
      "message_id": 1,
      "from": {"id": <YOUR_TELEGRAM_ID>, "is_bot": false, "first_name": "Test"},
      "chat": {"id": <YOUR_TELEGRAM_ID>, "type": "private"},
      "date": 1700000000,
      "text": "/share"
    }
  }'
```

Expected: Bot sends a message with "Share RemindKar" text and a "Share with a friend" button.

- [ ] **Step 2: Test inline query handler**

Send a POST simulating an inline query:

```bash
curl -s -X POST <WEBHOOK_URL> \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 1002,
    "inline_query": {
      "id": "test_inline_123",
      "from": {"id": <YOUR_TELEGRAM_ID>, "is_bot": false, "first_name": "Test"},
      "query": "",
      "offset": ""
    }
  }'
```

Expected: Response is 200 OK, `answerInlineQuery` is called with one `InlineQueryResultArticle` containing the invite card.

Verify in Supabase: check `referrals` table has a new pending row for your telegram_id.

- [ ] **Step 3: Test referral conversion**

Simulate a new user starting via a deep link (use a test telegram_id like 999999999):

```bash
curl -s -X POST <WEBHOOK_URL> \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 1003,
    "message": {
      "message_id": 2,
      "from": {"id": 999999999, "is_bot": false, "first_name": "NewUser"},
      "chat": {"id": 999999999, "type": "private"},
      "date": 1700000000,
      "text": "/start ref_<YOUR_TELEGRAM_ID>"
    }
  }'
```

Expected:
1. New user gets normal onboarding (consent screen)
2. Referrer (`<YOUR_TELEGRAM_ID>`) gets "NewUser just joined RemindKar using your invite link!"
3. In Supabase: `referrals` table shows row with `status = converted`, `referred_id = 999999999`
4. `users` table for 999999999 shows `referred_by = <YOUR_TELEGRAM_ID>`

- [ ] **Step 4: Test self-referral guard**

```bash
curl -s -X POST <WEBHOOK_URL> \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 1004,
    "message": {
      "message_id": 3,
      "from": {"id": <YOUR_TELEGRAM_ID>, "is_bot": false, "first_name": "Test"},
      "chat": {"id": <YOUR_TELEGRAM_ID>, "type": "private"},
      "date": 1700000000,
      "text": "/start ref_<YOUR_TELEGRAM_ID>"
    }
  }'
```

Expected: Normal "Welcome back" message — no referral recorded.

- [ ] **Step 5: Clean up test data**

```sql
-- Run in Supabase SQL editor
DELETE FROM users WHERE telegram_id = 999999999;
DELETE FROM referrals WHERE referred_id = 999999999;
```

---

## Task 10: Push to GitHub

- [ ] **Step 1: Final status check**

```bash
git status
git log --oneline -8
```

Expected: All changes committed, clean working tree.

- [ ] **Step 2: Push**

```bash
git push origin main
```

Expected: All commits pushed successfully.

---

## Self-Review: Spec Coverage

| Requirement | Covered by task |
|---|---|
| BotFather inline mode enable | Pre-implementation note |
| `switch_inline_query_chosen_chat` button | Task 6 Step 5 |
| Inline query handler (returns invite card) | Task 6 Step 3 |
| Referral table + user columns | Task 1 |
| Share logged as pending referral | Task 4 `createReferral` + Task 6 Step 3 |
| Referral converted on `/start ref_<id>` | Task 4 `convertReferral` + Task 6 Step 6 |
| Referrer notified on conversion | Task 6 Step 6 |
| Self-referral guard | Task 4 `convertReferral` |
| Stats shown in `/share` | Task 6 Step 5 |
| Non-consented users get empty inline results | Task 6 Step 3 |
| `/help` updated | Task 6 Step 7 |
| CLAUDE.md updated | Task 7 Step 1 |
| OVERVIEW.md updated | Task 7 Step 2 |
| ROADMAP.md updated | Task 7 Step 3 |
| Deployed | Task 8 |
| Tested end-to-end | Task 9 |
| Pushed to GitHub | Task 10 |
