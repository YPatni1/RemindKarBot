# RemindKar — Product Roadmap

## Status Key
- [x] Shipped
- [ ] Planned

---

## This Week (Shipped 2026-04-12)

- [x] **pgvector semantic search** — Gemini text-embedding-004 embeddings stored on every memory. `match_memories` RPC replaces ILIKE for done/delete/search matching. ILIKE kept as fallback for pre-embedding memories.
- [x] **Session context table** — `user_sessions` tracks last shown list (IDs + intent). Number references ("delete 2") now resolve against whatever list the user last saw, not just pending. 30-min TTL, auto-expiry.
- [x] **Number-based actions** — "delete 2", "mark 1 done", "reschedule 3 to Friday" all resolve via session-aware `resolveByIndex`.
- [x] **Delete intent** — Natural language deletion: "delete the reschedule task", "remove that". Semantic match + fuzzy fallback + picker.
- [x] **Edit intent** — "1 is birthday not task" updates type in-place instead of creating duplicates.
- [x] **Status intent** — "How am I doing?" shows completed this week, pending, overdue, due today, with encouragement.
- [x] **Reschedule intent** — "Can't do this today, reschedule to Tuesday" updates existing task instead of creating a new one.
- [x] **Anti-duplicate Gemini rule** — Prompt explicitly prohibits classifying management messages as new tasks/reminders.

---

## Share + Referrals (Shipped 2026-04-17)

- [x] **`/share` command with inline chat picker** — `switch_inline_query_chosen_chat` button opens Telegram's native chat picker. User picks a friend or group; invite card with deep link is sent.
- [x] **Referral tracking** — `referrals` table tracks every share and every join (converted). `convertReferral` called on `/start ref_<id>`; referrer notified on conversion.
- [x] **Referral stats in `/share`** — Shows "You've already brought in N friends!" for users with conversions.

---

## This Month — Make It Proactive

- [x] **Related memories on save** (shipped batch 10)
  After creating a memory, runs semantic search (embedding similarity > 0.75). Shows up to 2 related pending items in confirmation message.

- [x] **Snooze intelligence** (shipped batch 10)
  `snooze_count` column on memories. After 3 snoozes, escalation message suggests done/delete/reschedule. Smart snooze picker shows time-aware options based on local hour.

- [ ] **Entity linking on save**
  Surface related items by person/project name using `entities` JSONB column: "You also have 2 items about Chaitanya." (Currently uses embedding similarity only — entity-based matching is the gap.)

- [ ] **Smart digest**
  Upgrade morning digest from a flat list to an intelligent briefing:
  - Conflict detection: "You have 3 things at 5 PM tomorrow"
  - Streak tracking in digest: already shows streak, but no personal-best callout yet
  - Entity grouping: cluster tasks by person/project
  - Overdue escalation: items snoozed 3+ times get highlighted

---

## Shared Reminders & Delegation (Shipped 2026-04-18)

- [x] **Shared reminders (fan-out to contacts)**
  "remind me, Yash, and Ameet about tonight's call" — all receive independent reminders.
  - **Contacts book:** `contacts` table with consent model (`pending` → `approved` via callback).
  - **Contact linking:** Telegram Share Contact → nickname resolution. Unknown names → "Share their contact." Invite link for non-users.
  - **Delegation vs fan-out:** `include_creator: false` = task for others only; `true` = creator + others.
  - **Per-participant state:** `memory_participants` tracks done/snooze/decline per person. Done on received task notifies creator.
  - **Commands:** `/contacts`, `/block`, `/unblock`, `/assigned`.
  - **Cron integration:** `send-reminders` fans out to participants. `send-digest` includes "Assigned to you" section.

---

## Bug Fixes (2026-04-19)

- [x] **`awaiting_contact` session overwrite** — `handleText`'s final `saveSession` was overwriting the `awaiting_contact:<memoryId>:<names>` intent set by `routeParsedIntent` with computed `lastIntent`. Fixed by preserving session intent when it starts with `awaiting_contact:` or `awaiting_contact_pick:`.
- [x] **Progressive clarification too greedy** — `tryApplyDate` case #2 matched any task/reminder with a `due_date`, consuming full new task messages (e.g. "Remind me to take medicine at 8 AM tomorrow") as date follow-ups. Fixed with `text.split(/\s+/).length <= 5` guard.

---

## This Quarter — Make It Grow

- [ ] **Reminder fan-out architecture**
  Current: sequential loop in `send-reminders` (one HTTP call at a time). Dies at 500+ users.
  Fix: Cron job fetches due reminder IDs, enqueues individual sends via `pg_net` parallel HTTP calls. Each send is independent, respects Telegram's 30 msg/sec rate limit.

- [ ] **Digest parallelization**
  Same problem as reminders — sequential user loop in `send-digest`. Fan out via pg_net or Supabase Queues.

- [ ] **WhatsApp channel**
  Same backend (Supabase Edge Functions + Gemini), second distribution channel via WhatsApp Business API. Key differences: different webhook format, media handling, template messages for proactive sends. WhatsApp-first for Tier 2/3 India users.

- [ ] **Group mode**
  Telegram group bot: track tasks per group, assign to members with @mentions. Requires:
  - `group_id` column on memories
  - Per-member digest within groups
  - "Assign to @aman" parsing in Gemini prompt
  - Group-level pending/status views

- [ ] **Recurring task intelligence**
  Auto-detect patterns: "You complete 'gym' every Mon/Wed/Fri." Suggest recurring tasks. Handle missed recurrences: "You missed gym yesterday — still going today?"

- [ ] **Backfill embeddings**
  One-time script to generate embeddings for all existing memories that have `description_embedding IS NULL`. Run as Edge Function with batch processing.

---

## Not Doing (and why)

| Idea | Why Not |
|---|---|
| Separate vector DB (Pinecone, Weaviate) | pgvector on Supabase is sufficient. Per-user corpus is <1000 docs. No need for a separate service. |
| RAG / retrieval-augmented generation | Not answering open questions. Structured intent parsing via Gemini Flash is the right tool. |
| Multi-model routing | One model for NLU (Gemini Flash), one for embeddings (text-embedding-004). Adding a third model adds latency and cost with no benefit. |
| Full conversation memory (LLM context window) | Session table (last shown IDs) solves 95% of context needs. Storing full chat history for LLM context is expensive and unnecessary for a task bot. |
| Multi-language UI | Bot already handles English/Hindi/Hinglish/Marathi input via Gemini. UI chrome (button labels, system messages) in English is fine for target users. |
| DST-aware timezone offsets | `TZ_OFFSETS` is a static map — no DST handling. India (primary market) doesn't observe DST. US/UK/Europe users may see reminders 1hr off during DST transitions. Fix requires replacing manual offset math with `Intl.DateTimeFormat` — a bigger refactor. |

---

## Architecture Notes

### Embedding Pipeline
```
User message → Gemini Flash (parse intent) → Gemini text-embedding-004 (embed description)
                                            → Supabase INSERT with vector
```

### Semantic Search Flow
```
User query → embed query → pgvector cosine similarity (match_memories RPC)
           → if 0 results → ILIKE fallback
```

### Session Context Flow
```
Bot shows list → upsertSession(telegram_id, [id1, id2, ...], intent)
User says "delete 2" → getSession → resolve id2 → perform action
                      → TTL 30 min, auto-expiry on read
```

### Scale Bottlenecks (in order)
| At N Users | Bottleneck | Fix |
|---|---|---|
| 100 | None | Current architecture handles it |
| 500 | Reminder loop timeout | pg_net fan-out |
| 1000 | Gemini free tier rate limits | Paid tier + request queue |
| 5000 | Digest loop timeout | Parallel sends |
| 10000+ | pgvector scan performance | Add HNSW index on description_embedding |
