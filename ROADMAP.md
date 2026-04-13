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

## This Month — Make It Proactive

- [ ] **Entity linking on save**
  When user saves a memory mentioning a person/project, surface related items: "You also have 2 items about Chaitanya." Uses the existing `entities` JSONB column (already populated, currently unused). Simple query: `entities->'people' ? 'name'`.

- [ ] **Smart digest**
  Upgrade morning digest from a flat list to an intelligent briefing:
  - Conflict detection: "You have 3 things at 5 PM tomorrow"
  - Streak tracking: "5-day completion streak!"
  - Entity grouping: cluster tasks by person/project
  - Overdue escalation: items snoozed 3+ times get highlighted

- [ ] **Snooze intelligence**
  Track snooze count per memory. After 3 snoozes:
  - Ask: "You've postponed this 3 times. Commit to a date, or drop it?"
  - Add `snooze_count` column to memories table
  - Surface chronic snoozes in digest

- [ ] **Related memories on save**
  After creating a memory, run semantic search against existing memories. If similarity > 0.7, show: "Related: Buy gift for Chaitanya's birthday (due tomorrow)". Helps users spot conflicts and duplicates before they happen.

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
