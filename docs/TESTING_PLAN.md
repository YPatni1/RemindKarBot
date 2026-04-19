# RemindKar — Comprehensive Testing Plan

**Test method:** Simulate Telegram webhooks via `curl POST` to Edge Function URL.
**Test user:** Use fake `telegram_id` (e.g., 999999999). Clean up test data after each section.
**Base URL:** `$SUPABASE_URL/functions/v1/telegram-webhook`

> Before testing: `source .env` to load credentials.

---

## Curl Template

```bash
curl -X POST "$SUPABASE_URL/functions/v1/telegram-webhook" \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 1,
    "message": {
      "message_id": 1,
      "from": { "id": 999999999, "is_bot": false, "first_name": "TestUser", "username": "testuser" },
      "chat": { "id": 999999999, "type": "private" },
      "date": '"$(date +%s)"',
      "text": "YOUR_TEXT_HERE"
    }
  }'
```

---

## 1. Onboarding & Consent Flow

### 1.1 First-time /start
- **Input:** `/start`
- **Expected:** Upserts user with `consent_given: false`. Returns welcome text with "Let's go!" and "Tell me more" buttons.
- **Verify in DB:** `users` row exists, `consent_given = false`, `timezone = 'Asia/Kolkata'` (default).

### 1.2 Consent — "Let's go!"
- **Input:** Callback `consent_yes`
- **Expected:** Sets `consent_given: true`, `consent_given_at` populated. Edits original message to "Let's go!". Sends timezone picker.

### 1.3 Consent — "Tell me more"
- **Input:** Callback `consent_info`
- **Expected:** Sends privacy policy text. Does NOT set consent.

### 1.4 Timezone selection
- **Input:** Callback `tz:America/New_York`
- **Expected:** Updates `users.timezone`. Edits message. Sends notification nudge + onboarding examples with digest time computed for US East (10:30 PM prior day).

### 1.5 Consent gate — message before consent
- **Input:** Send any text (e.g., "hello") without consenting
- **Expected:** "Please send /start first and give consent before I can save your memories."

### 1.6 /start returning user (already consented)
- **Input:** `/start` again after consenting
- **Expected:** "Welcome back, TestUser!" — does NOT reset consent, does NOT show consent buttons.

### 1.7 /start with referral deep link
- **Input:** `/start ref_888888888` (where 888888888 is another user's telegram_id)
- **Expected:** Converts referral — sets `referred_by` on user. Sends notification to referrer. Self-referral (own ID) should be blocked.

### 1.8 /start with invite deep link
- **Input:** `/start invite_<contact_uuid>`
- **Expected:** Updates contact status to `approved`, activates pending participants, notifies sender.

### Edge Cases
- **1.9** `/start` with invalid payload (e.g., `/start garbage`) — should silently ignore payload, proceed normally
- **1.10** `/start ref_999999999` (self-referral) — should be blocked by `convertReferral`
- **1.11** Double consent — tapping "Let's go!" twice — should be idempotent
- **1.12** Timezone selection without consent — callback `tz:Asia/Kolkata` from non-consented user — should not crash

---

## 2. Task/Reminder/Note Creation

### 2.1 Simple task
- **Input:** "Call Aman tomorrow at 5 PM"
- **Expected:** Saved as `task`, `due_date` set to tomorrow 5 PM in user's TZ (converted to UTC), `reminder_at` 30 min before. Confirmation with Done/Delete/Wrong buttons.

### 2.2 Task without date
- **Input:** "Buy groceries"
- **Expected:** Saved as `task`, `due_date = null`. Shows "When should I remind you?" with quickdate buttons (Tomorrow 9 AM, In 1 hour, No reminder, Wrong?). Session set to `awaiting_date`.

### 2.3 Reminder
- **Input:** "Remind me to take medicine at 8 AM"
- **Expected:** Saved as `reminder` type.

### 2.4 Birthday
- **Input:** "Mom's birthday is 15th August"
- **Expected:** Saved as `birthday`, `recurrence: 'yearly'`.

### 2.5 Event
- **Input:** "Team meeting on Friday at 3 PM"
- **Expected:** Saved as `event`.

### 2.6 Note
- **Input:** "Note: Aman's phone number is 9876543210"
- **Expected:** Saved as `note`, no due_date expected.

### 2.7 Multi-task message
- **Input:** "Call Aman tomorrow, buy milk, and finish the report by Friday"
- **Expected:** 3 separate memories created. Each gets its own confirmation.

### 2.8 Low confidence gate
- **Input:** Something ambiguous that Gemini gives `confidence < 0.6`
- **Expected:** Appends "Not what you meant? Say delete/edit this" hint.

### 2.9 Ambiguous date
- **Input:** Something like "meeting on Saturday" when Gemini returns `ambiguous_date: true` with `date_options`
- **Expected:** Shows date picker buttons. Tapping one sets the date.

### 2.10 Entity linking
- **Input:** Create a task "call Aman" then create "follow up with Aman about project"
- **Expected:** Second confirmation shows "Related:" section with the first task.

### Edge Cases
- **2.11** Empty text after /start and consent — should trigger Gemini parse, likely `unknown` intent
- **2.12** Very long task description (500+ chars) — should save, test for truncation
- **2.13** Task with HTML special characters: `"Buy <script>alert('xss')</script>"` — must be escaped via `escapeHtml()`
- **2.14** Task in Hindi: "Kal subah 9 baje Aman ko call karna hai" — should parse correctly
- **2.15** Task in Marathi: "Udya sandhyakali 6 la meeting ahe" — should parse correctly
- **2.16** Task with Hinglish: "Agle hafte Monday ko dentist jaana hai" — should parse

---

## 3. Progressive Clarification (Awaiting Date)

### 3.1 Quickdate — Tomorrow 9 AM
- **Input:** Create dateless task, then callback `quickdate:<memory_id>:tomorrow9am`
- **Expected:** Sets `due_date` to tomorrow 9 AM in user's TZ. Edits message. Clears `awaiting_date` session.

### 3.2 Quickdate — In 1 hour
- **Input:** Callback `quickdate:<memory_id>:1hour`
- **Expected:** Sets `due_date` to now + 1 hour.

### 3.3 Quickdate — No reminder
- **Input:** Callback `quickdate:<memory_id>:noreminder`
- **Expected:** Edits message to "Saved. No reminder set." Does NOT set due_date.

### 3.4 Text date follow-up
- **Input:** Create dateless task, then type "tomorrow 5pm"
- **Expected:** `tryApplyDate` succeeds — updates memory with the parsed date. Sends "Set [formatted date]".

### 3.5 Non-date text during awaiting_date
- **Input:** Create dateless task, then type "Call Aman"
- **Expected:** Falls through `tryApplyDate` (returns null), gets processed as a new task.

### Edge Cases
- **3.6** Quickdate with invalid/deleted memory_id — should handle gracefully
- **3.7** Two consecutive dateless tasks — session should reference the latest one

---

## 4. Done Flow

### 4.1 Text "done" intent
- **Input:** "I called Aman" (after saving "Call Aman" task)
- **Expected:** Gemini parses as `done` intent. Finds match via semantic search. Marks as `done`, shows celebration message with Undo button.

### 4.2 /done command with search text
- **Input:** `/done call Aman`
- **Expected:** Searches pending, finds match, marks done.

### 4.3 /done with no match
- **Input:** `/done something that doesn't exist`
- **Expected:** Shows picker of first 5 pending items.

### 4.4 /done with no text
- **Input:** `/done`
- **Expected:** "Tell me which task you completed. Example: /done call Aman"

### 4.5 /done when no pending tasks
- **Input:** `/done anything` with 0 pending tasks
- **Expected:** "You have no pending tasks."

### 4.6 Done via callback button
- **Input:** Callback `done:<memory_id>`
- **Expected:** Marks done, shows celebration message with Undo button. Updates streak.

### 4.7 Number reference — "mark 2 as done"
- **Input:** After viewing pending list, Gemini returns `target_index: 2`
- **Expected:** Resolves item #2 from session's `last_shown_ids`. Marks done.

### 4.8 Done on received (shared) task
- **Input:** Callback `done:<memory_id>` where user is an assignee
- **Expected:** Updates `memory_participants.status = 'done'`, NOT `memories.status`. Notifies creator.

### 4.9 Undo done — within 30 seconds
- **Input:** Callback `undo_done:<memory_id>` within 30s
- **Expected:** Reverts to `pending`, clears `completed_at`.

### 4.10 Undo done — after 30 seconds
- **Input:** Callback `undo_done:<memory_id>` after 30s
- **Expected:** "Undo window expired (30s)."

### Edge Cases
- **4.11** Undo on already-modified task (e.g., re-marked as done or deleted)
- **4.12** Done on already-done task — should handle gracefully
- **4.13** Multiple matches for done — shows picker buttons

### Streak Tests
- **4.14** First done of the day — streak starts at 1
- **4.15** Done on consecutive days — streak increments
- **4.16** Skip a day then done — streak resets to 1
- **4.17** Multiple dones same day — streak counted once

---

## 5. Delete Flow

### 5.1 Text "delete" intent — specific task
- **Input:** "Delete the call Aman task"
- **Expected:** Finds match, shows delete confirmation or deletes directly.

### 5.2 Delete via callback
- **Input:** Callback `delete:<memory_id>`
- **Expected:** Deletes memory. Edits message to "Deleted."

### 5.3 Delete received (shared) task
- **Input:** Callback `delete:<memory_id>` where user is assignee
- **Expected:** Sets `memory_participants.status = 'declined'`. Does NOT delete memory. Creator NOT notified.

### 5.4 "Delete everything" safety gate
- **Input:** "Delete everything" / "delete all my tasks"
- **Expected:** Shows confirmation with "Yes, delete everything" and "Cancel" buttons.

### 5.5 Confirm delete all
- **Input:** Callback `confirm_delete_all`
- **Expected:** Deletes all memories (keeps user account). Message confirms.

### 5.6 Cancel delete all
- **Input:** Callback `cancel_delete_all` or `cancel_delete`
- **Expected:** "Cancelled — nothing was deleted."

### 5.7 /delete command (full account deletion)
- **Input:** `/delete`
- **Expected:** Shows "Delete ALL your data?" with confirm/cancel.

### 5.8 Confirm account delete
- **Input:** Callback `confirm_account_delete`
- **Expected:** Full cascade delete — user, memories, sessions, conversation logs all removed. Archived copies created by triggers.

### Edge Cases
- **5.9** Delete by index — "delete 3" after viewing list
- **5.10** Delete already-deleted memory — should not crash
- **5.11** Regex for `isDeleteAllRequest` — test: "everything", "all my tasks", "all", "every thing"

---

## 6. Reschedule Flow

### 6.1 Reschedule with date
- **Input:** "Reschedule the call to Friday"
- **Expected:** Gemini extracts `reschedule_to`. Shows picker if multiple matches, or reschedules directly.

### 6.2 Reschedule without date
- **Input:** "Reschedule the call"
- **Expected:** "When would you like to reschedule it to?"

### 6.3 Reschedule by index
- **Input:** "Reschedule 2 to Monday"
- **Expected:** Resolves item #2 from session, reschedules.

### 6.4 Reschedule via callback (rsc:)
- **Input:** Callback `rsc:<memory_id>:2026-04-25`
- **Expected:** Updates due_date and reminder_at. Edits message.

### Edge Cases
- **6.5** Reschedule with no pending tasks — "You have no pending tasks to reschedule."
- **6.6** Reschedule past date — should still save (Gemini may or may not catch this)

---

## 7. Edit / Correction Flow ("Wrong?")

### 7.1 Wrong? button
- **Input:** Callback `wrong:<memory_id>`
- **Expected:** Shows fix options: Type, Date, Description, Delete it.

### 7.2 Fix type
- **Input:** Callback `fix_type:<memory_id>` then `set_type:<memory_id>:note`
- **Expected:** Updates memory type to "note". Edits message.

### 7.3 Fix date
- **Input:** Callback `fix_date:<memory_id>`
- **Expected:** Sets session to `awaiting_date`. Prompts "When should it be?"

### 7.4 Fix description
- **Input:** Callback `fix_desc:<memory_id>` then type "Updated description text"
- **Expected:** Updates memory description. Re-generates embedding. Confirms.

### 7.5 Gemini edit intent
- **Input:** "Change the type of call Aman to reminder"
- **Expected:** Gemini returns `intent: edit`, `edit_field: type`, `edit_value: reminder`.

### Edge Cases
- **7.6** Fix description with HTML chars — must be escaped
- **7.7** Fix date then type a non-date message — should fall through to normal parsing

---

## 8. Snooze Flow

### 8.1 Snooze button (time-aware picker)
- **Input:** Callback `snooze:<memory_id>`
- **Expected:** Shows contextual snooze options based on local hour (morning: afternoon/tomorrow, afternoon: evening/tomorrow, evening: tomorrow morning/afternoon).

### 8.2 Snooze +1 hour
- **Input:** Callback `snz_do:<memory_id>:1h`
- **Expected:** Sets `reminder_at` to now + 1 hour, resets `is_reminded`, increments `snooze_count`.

### 8.3 Snooze to tomorrow morning
- **Input:** Callback `snz_do:<memory_id>:tomorrow`
- **Expected:** Sets to tomorrow 9 AM in user's timezone.

### 8.4 Snooze escalation (3+ snoozes)
- **Input:** Snooze same task 3 times
- **Expected:** After 3rd snooze, shows escalation message "Keep rescheduling, or time to drop it?" with Reschedule/Drop it/Done actually buttons.

### Edge Cases
- **8.5** Snooze "this afternoon" when it's already evening — should fallback to +1 hour
- **8.6** Snooze "this evening" when it's already night — should fallback to +1 hour
- **8.7** Snooze "tomorrow afternoon" — should compute correctly for fractional timezone offsets (e.g., Asia/Kolkata +5:30)

---

## 9. Query Flow

### 9.1 Pending query
- **Input:** "Show my pending tasks"
- **Expected:** Returns formatted pending list via `handleQuery` pending pattern match.

### 9.2 Semantic search
- **Input:** "What did I say about Aman?"
- **Expected:** Uses embedding search, returns matching memories.

### 9.3 Date-filtered query
- **Input:** "What's due today?"
- **Expected:** Gemini extracts `query_date_start`/`query_date_end`. Returns memories filtered by `due_date`.

### 9.4 Creation-date query
- **Input:** "What did I add yesterday?"
- **Expected:** Detects creation pattern ("added"), filters by `created_at`.

### 9.5 Status intent
- **Input:** "How am I doing?" / "Show my status"
- **Expected:** Shows summary stats.

### Edge Cases
- **9.6** Query with no results — "No results found for ..."
- **9.7** Query "this week" — date range should span Mon-Sun (or Gemini's interpretation)
- **9.8** Pending query variant: "what do i have" — should match pending pattern

---

## 10. Pending List & Pagination

### 10.1 /pending command
- **Input:** `/pending`
- **Expected:** Shows pending items (10 per page) with filter buttons (Tasks, Notes, Events, Overdue). Shows received tasks section if any.

### 10.2 Pagination — Show more
- **Input:** Callback `page:10`
- **Expected:** Edits existing message to show items 11-20. Updates session IDs.

### 10.3 Filter — Tasks only
- **Input:** Callback `filter:task`
- **Expected:** Edits message to show only tasks. Shows "All pending" back button.

### 10.4 Filter — Overdue
- **Input:** Callback `filter:overdue`
- **Expected:** Shows only overdue memories.

### 10.5 Filter — All (back)
- **Input:** Callback `filter:all`
- **Expected:** Returns to unfiltered view.

### Edge Cases
- **10.6** /pending with no pending items — "You have no pending tasks. Enjoy your free time!"
- **10.7** /pending without consent — "Please send /start first..."
- **10.8** Filter type with 0 results — shows empty message for that type
- **10.9** Pagination at exact boundary (e.g., exactly 10 items) — should NOT show "Show more"
- **10.10** Pagination past end — should handle gracefully

---

## 11. Voice Notes

### 11.1 Normal voice note
- **Input:** Voice message (>1s, <120s)
- **Expected:** Downloads file, transcribes via Gemini, shows transcription `"text"`, then processes as text.

### 11.2 Too-short voice note (<1s)
- **Input:** Voice with `duration: 0`
- **Expected:** "That was too short — try a longer voice note?"

### 11.3 Too-long voice note (>120s)
- **Input:** Voice with `duration: 150`
- **Expected:** Warning message, but still processes.

### Edge Cases
- **11.4** Voice note without consent — consent gate message
- **11.5** Transcription failure — "I couldn't process your voice note — could you type it instead?"
- **11.6** Download failure — "I couldn't download your voice note, please try again."
- **11.7** Voice note with multi-task content — should create multiple memories

---

## 12. Forwarded Messages

### 12.1 Forwarded text message
- **Input:** Message with `forward_date` set and text content
- **Expected:** Parses and saves. Conversation history prefixed with `[forwarded]`.

### 12.2 Forwarded non-text message
- **Input:** Forwarded message without text (e.g., forwarded photo)
- **Expected:** "I can only process forwarded text messages for now."

### Edge Cases
- **12.3** Forwarded message without consent — consent gate
- **12.4** Forwarded message with multiple intents — should create multiple memories

---

## 13. Unsupported Inputs

### 13.1 Photo
- **Input:** Message with photo, no text
- **Expected:** "I can only process text and voice messages for now."

### 13.2 Sticker
- **Input:** Sticker message
- **Expected:** Same unsupported message.

### 13.3 Document
- **Input:** Document message
- **Expected:** Same unsupported message.

---

## 14. Commands

### 14.1 /help
- **Expected:** Lists all commands with descriptions and examples.

### 14.2 /privacy
- **Expected:** Shows privacy info — what's stored, what's not, user controls.

### 14.3 Unknown command
- **Input:** `/foobar`
- **Expected:** "Unknown command. Try /help to see what I can do."

### 14.4 Command with bot handle suffix
- **Input:** `/help@RemindKarBot`
- **Expected:** Should strip `@RemindKarBot` and recognize `/help`.

---

## 15. Feedback Flow

### 15.1 /feedback (no args)
- **Input:** `/feedback`
- **Expected:** Shows category picker: Bug, Feature, General.

### 15.2 Feedback category selection
- **Input:** Callback `feedback_bug`
- **Expected:** Edits message, sets session to `awaiting_feedback:bug`.

### 15.3 Feedback text after category
- **Input:** Type "The app crashes when I send a sticker" after selecting Bug
- **Expected:** Saves to `feedback` table with `category: 'bug'`. Thanks user. Clears session.

### 15.4 /feedback with inline text
- **Input:** `/feedback Great bot, love it!`
- **Expected:** Saves directly as `category: 'general'`. No category picker shown.

### Edge Cases
- **15.5** Select feedback category then send a task instead — should save as feedback (since session intent is `awaiting_feedback`)
- **15.6** /feedback without consent — should still check (currently doesn't gate, verify behavior)

---

## 16. Referral / Share Flow

### 16.1 /share command
- **Input:** `/share`
- **Expected:** Shows share button with `switch_inline_query_chosen_chat`. Shows referral stats if any.

### 16.2 Inline query (user picks a chat)
- **Input:** `inline_query` update
- **Expected:** Creates referral record. Returns invite card with deep link.

### 16.3 Referral conversion
- **Input:** New user sends `/start ref_888888888`
- **Expected:** Sets `referred_by`. Notifies referrer. Does not block onboarding if referrer has blocked bot.

### Edge Cases
- **16.4** /share without consent — "Please send /start first to set up RemindKar."
- **16.5** Inline query from non-consented user — returns empty results
- **16.6** Self-referral — blocked
- **16.7** Double referral conversion (same user) — should not create duplicate

---

## 17. Shared Tasks / Delegation

### 17.1 Assign task to known contact
- **Input:** "Remind Aman to submit the report tomorrow" (Aman is an approved contact)
- **Expected:** Creates memory with `is_shared: true`. Creates participant for Aman with `status: 'active'`. Notifies Aman immediately. Creator included only if `include_creator: true`.

### 17.2 Assign task — unknown contact
- **Input:** "Tell Rahul to call the vendor" (Rahul not in contacts)
- **Expected:** Saves memory for creator. Prompts "I don't have a contact for Rahul. Share their Telegram contact."

### 17.3 Contact share after unknown prompt
- **Input:** Share Rahul's contact card
- **Expected:** Creates contact, creates participant for the pending memory (linked via `awaiting_contact` session).

### 17.4 Delegation (include_creator: false)
- **Input:** "Ask Aman to buy groceries" (Gemini sets `include_creator: false`)
- **Expected:** Only Aman is a participant. Creator is NOT a participant.

### 17.5 Fan-out (include_creator: true)
- **Input:** "We need to review the doc — me and Aman"
- **Expected:** Both creator and Aman are participants.

### 17.6 Blocked/declined contact
- **Input:** Assign task to blocked contact
- **Expected:** "X is not accepting tasks right now."

### 17.7 Ambiguous contact (multiple matches for same name)
- **Input:** Task for "Aman" when two contacts named Aman exist
- **Expected:** Shows contact picker with phone numbers.

### Edge Cases
- **17.8** Multiple target_people, some known, some unknown — should save task, create participants for known, prompt for unknown
- **17.9** Self-assignment (own name in target_people) — should be skipped
- **17.10** Solo task (target_people: []) — standard path, no shared logic triggered
- **17.11** Contact share without awaiting_contact session — should save contact normally, not try to link to memory

---

## 18. Contact Management

### 18.1 Share contact (no pending task)
- **Input:** Share a Telegram contact card
- **Expected:** Creates contact with `status: 'pending'`. If contact is on RemindKar, sends consent request. If not, offers invite link.

### 18.2 Consent allow
- **Input:** Recipient taps `consent_allow:<contact_id>`
- **Expected:** Contact status → `approved`. Activates queued pending_consent tasks. Notifies sender.

### 18.3 Consent decline
- **Input:** Recipient taps `consent_decline:<contact_id>`
- **Expected:** Contact status → `declined`. Declines queued tasks. Sends generic rejection to sender.

### 18.4 /contacts command
- **Input:** `/contacts`
- **Expected:** Lists contacts with status emoji (approved, pending, blocked, declined).

### 18.5 No contacts
- **Input:** `/contacts` with no contacts
- **Expected:** "You have no linked contacts yet."

### 18.6 Contact without Telegram account
- **Input:** Share contact card with no `user_id`
- **Expected:** "I can only reach Telegram users for now."

### 18.7 Duplicate contact (same phone)
- **Input:** Share same contact card again
- **Expected:** Updates `contact_telegram_id` if missing, does not create duplicate.

### 18.8 Already-approved contact share
- **Input:** Share contact that's already approved
- **Expected:** "X is already connected!"

---

## 19. Block / Unblock

### 19.1 /block command
- **Input:** `/block`
- **Expected:** Shows list of approved senders with block buttons.

### 19.2 Block a sender
- **Input:** Callback `block_sender:<sender_telegram_id>`
- **Expected:** Blocks sender, declines all pending tasks from them. Edits message.

### 19.3 /unblock command
- **Input:** `/unblock`
- **Expected:** Shows list of blocked senders with unblock buttons.

### 19.4 Unblock a sender
- **Input:** Callback `unblock_sender:<sender_telegram_id>`
- **Expected:** Unblocks sender. Edits message.

### Edge Cases
- **19.5** /block with no approved senders — "No one is sending you tasks right now."
- **19.6** /unblock with no blocked senders — "You haven't blocked anyone."
- **19.7** Block then task from blocked sender — should fail at contact resolution

---

## 20. /assigned Command

### 20.1 Tasks assigned to others
- **Input:** `/assigned`
- **Expected:** Lists tasks with assignee names and statuses (active, done, pending_consent, pending_invite, declined).

### 20.2 No assigned tasks
- **Input:** `/assigned` with no assignments
- **Expected:** "You haven't assigned any tasks to others yet."

---

## 21. Onboarding Example Buttons

### 21.1 Example: Call mom
- **Input:** Callback `example:call_mom`
- **Expected:** Parses "Call mom tomorrow 5 PM" and saves as task.

### 21.2 Example: Birthday
- **Input:** Callback `example:birthday`
- **Expected:** Parses "Aman's birthday is 15th August" and saves as birthday.

### 21.3 Example: Groceries
- **Input:** Callback `example:groceries`
- **Expected:** Parses "Buy groceries this weekend" and saves as task.

---

## 22. Conversation Context & Sessions

### 22.1 Follow-up pronoun resolution
- **Input:** "Call Aman tomorrow" then "Actually make it 5 PM"
- **Expected:** Conversation history enables Gemini to resolve "it" → the Aman call. Should either reschedule or edit.

### 22.2 Number reference after list
- **Input:** `/pending` then "delete 2"
- **Expected:** Resolves item #2 from `last_shown_ids`, deletes it.

### 22.3 Session TTL (30 min)
- **Expected:** After 30 min of inactivity, new session_id is generated.

### 22.4 History trimming
- **Expected:** History capped at 6 entries (3 user + 3 bot pairs).

### Edge Cases
- **22.5** Number reference with no prior list — falls back to pending list
- **22.6** Number reference out of bounds — "No item #N in your list."
- **22.7** Session save failure — should not crash main flow (wrapped in try/catch)

---

## 23. Casual & Greeting Intents

### 23.1 Greeting
- **Input:** "Hello" / "Hi"
- **Expected:** "Hey! Send me a task, reminder, or question — I'm ready to help."

### 23.2 Casual with pending tasks
- **Input:** "How's it going?" (with pending tasks)
- **Expected:** Mentions pending count or due-today count.

### 23.3 Casual with no pending tasks
- **Input:** "How's it going?" (no pending)
- **Expected:** "All clear! Text me when you need to remember something."

### 23.4 Unknown intent
- **Input:** Something Gemini can't classify
- **Expected:** Help text with examples.

---

## 24. Send-Reminders (Cron Function)

### 24.1 Pre-reminder (30 min before due)
- **Setup:** Memory with `due_date` 30 min from now, `is_pre_reminded: false`
- **Expected:** Sends pre-reminder message with Done/Snooze buttons. Sets `is_pre_reminded: true`.

### 24.2 Due reminder
- **Setup:** Memory with `reminder_at` in the past, `is_reminded: false`
- **Expected:** Sends reminder message. Sets `is_reminded: true`.

### 24.3 Already-reminded skip
- **Setup:** Memory with `is_reminded: true`
- **Expected:** Skipped — no duplicate reminder.

### 24.4 Shared task pre-reminder
- **Setup:** Shared task with active participant
- **Expected:** Participant gets pre-reminder tagged with "Shared by {sender}".

### 24.5 Shared task due reminder
- **Setup:** Shared task with active participant
- **Expected:** Participant gets reminder tagged with "Shared by {sender}".

### 24.6 Authorization check
- **Input:** Request without `Authorization: Bearer` header
- **Expected:** 401 Unauthorized.

### Edge Cases
- **24.7** User who blocked the bot — should fail per-user, not crash batch
- **24.8** Per-user timezone caching — second reminder for same user should use cache
- **24.9** Memory with no due_date — should not be picked up

---

## 25. Send-Digest (Cron Function)

### 25.1 Normal digest
- **Setup:** User with overdue, today, and tomorrow tasks
- **Expected:** Formatted digest with all sections.

### 25.2 Streak in digest
- **Setup:** User with `current_streak > 0`
- **Expected:** Shows streak with fire emoji. Shows "personal best!" if at longest.

### 25.3 Received tasks in digest
- **Setup:** User with active received tasks
- **Expected:** "ASSIGNED TO YOU" section in digest.

### 25.4 Empty digest
- **Setup:** User with no pending tasks, no overdue, no received
- **Expected:** Digest skipped (no message sent).

### 25.5 Authorization check
- **Expected:** 401 without Bearer token.

### Edge Cases
- **25.6** Inactive user — should still be included if consented
- **25.7** User with only "someday" items (no deadline) — digest shows count
- **25.8** User who blocked bot — should fail gracefully, not crash batch

---

## 26. Timezone Handling

### 26.1 India (Asia/Kolkata, +5:30)
- **Input:** "Remind me at 9 AM tomorrow"
- **Expected:** due_date is tomorrow 3:30 UTC (9 AM - 5:30)

### 26.2 US East (America/New_York, -5)
- **Input:** Same
- **Expected:** due_date is tomorrow 14:00 UTC (9 AM + 5)

### 26.3 Fractional timezone math
- **Test:** `localHourToUtcDate` with Asia/Kolkata — verify minutes component is correct (30 min offset, not truncated).

### 26.4 Digest time calculation
- **Test:** For Asia/Kolkata: 3:30 UTC + 5:30 = 9:00 AM. For US East: 3:30 UTC - 5 = 10:30 PM prior day.

### 26.5 Snooze times across timezones
- **Test:** "This afternoon" snooze at 2 PM local for different TZs — verify UTC conversion is correct.

### Edge Cases
- **26.6** Unknown timezone (not in TZ_OFFSETS) — should fallback to 5.5 (Asia/Kolkata)
- **26.7** DST changes (US timezones) — TZ_OFFSETS is static, does not account for DST. Document as known limitation.

---

## 27. HTTP & Error Handling

### 27.1 Non-POST request
- **Input:** `GET` request to webhook
- **Expected:** 405 Method Not Allowed.

### 27.2 Always 200 on POST
- **Input:** Any POST (valid or malformed)
- **Expected:** Always returns 200 to prevent Telegram retries.

### 27.3 Empty/missing message
- **Input:** `{"update_id": 1}` (no message, no callback, no inline)
- **Expected:** Returns 200, does nothing.

### 27.4 Missing `from` field
- **Input:** Message without `from` object
- **Expected:** `telegramId` defaults to 0, should not crash.

---

## 28. Conversation Logging

### 28.1 Text message logging
- **Verify:** `conversation_logs` row with message_type: "text", parsed_intents, primary_intent, bot_action, bot_response, session_id, processing_time_ms.

### 28.2 Callback logging
- **Verify:** Row with message_type: "callback", primary_intent from callback data prefix.

### 28.3 Error logging
- **Verify:** On error, row has `error` column populated.

### 28.4 Non-fatal logging failures
- **Verify:** `logInteraction` wrapped in try/catch — logging failure does not crash main flow.

---

## 29. Archive / Audit Tables

### 29.1 User deletion archives
- **Input:** Delete user via `confirm_account_delete`
- **Verify in DB:** `archived_users`, `archived_memories`, `archived_user_sessions`, `archived_conversation_logs` have copies. `deletion_type` field populated (direct vs cascade).

### 29.2 Memory deletion archives
- **Input:** Delete a single memory
- **Verify:** `archived_memories` has copy with `deletion_type: 'direct'`.

### 29.3 Cascade deletion
- **Input:** Delete user (cascades to memories)
- **Verify:** Memories archived with `deletion_type: 'account_cascade'`.

---

## 30. Security Tests

### 30.1 HTML injection
- **Input:** Task with `<b>bold</b>` in text
- **Expected:** Displayed as `&lt;b&gt;bold&lt;/b&gt;` — escaped by `escapeHtml()`.

### 30.2 Script injection
- **Input:** `"<script>alert(1)</script>"`
- **Expected:** Escaped.

### 30.3 XSS via callback data
- **Expected:** Callback data is always generated server-side (uuid-based), not user-controlled.

### 30.4 Malformed callback data
- **Input:** Callback `done:not-a-valid-uuid`
- **Expected:** `getMemoryById` returns null, handled gracefully.

### 30.5 Rate limiting
- **Expected:** No explicit rate limiting in app code — relies on Supabase edge function limits. Document if needed.

### 30.6 verify_jwt = false
- **Verify:** telegram-webhook has `verify_jwt = false` in config. send-reminders and send-digest require auth header.

---

## Test Execution Checklist

| Section | # Tests | Priority |
|---------|---------|----------|
| 1. Onboarding & Consent | 12 | P0 |
| 2. Task/Note Creation | 16 | P0 |
| 3. Progressive Clarification | 7 | P0 |
| 4. Done Flow | 17 | P0 |
| 5. Delete Flow | 11 | P0 |
| 6. Reschedule | 6 | P1 |
| 7. Edit/Correction | 7 | P1 |
| 8. Snooze | 7 | P1 |
| 9. Query | 8 | P1 |
| 10. Pending List & Pagination | 10 | P1 |
| 11. Voice Notes | 7 | P1 |
| 12. Forwarded Messages | 4 | P2 |
| 13. Unsupported Inputs | 3 | P2 |
| 14. Commands | 4 | P2 |
| 15. Feedback | 6 | P2 |
| 16. Referral/Share | 7 | P2 |
| 17. Shared Tasks | 11 | P0 |
| 18. Contact Management | 8 | P1 |
| 19. Block/Unblock | 7 | P1 |
| 20. /assigned | 2 | P2 |
| 21. Onboarding Examples | 3 | P2 |
| 22. Sessions & Context | 7 | P1 |
| 23. Casual/Greeting | 4 | P2 |
| 24. Send-Reminders | 9 | P0 |
| 25. Send-Digest | 8 | P0 |
| 26. Timezone | 7 | P0 |
| 27. HTTP & Errors | 4 | P0 |
| 28. Logging | 4 | P2 |
| 29. Archive/Audit | 3 | P1 |
| 30. Security | 6 | P0 |
| **TOTAL** | **~215** | |

---

## Multi-User Test Scenarios

These require two test users (e.g., 999999999 and 888888888):

| # | Scenario | Steps |
|---|----------|-------|
| M1 | Full delegation flow | User A shares User B's contact → B consents → A assigns task → B marks done → A notified |
| M2 | Consent decline flow | User A shares B's contact → B declines → A's pending task declined |
| M3 | Block flow | B blocks A → A tries to assign → "not accepting" |
| M4 | Invite flow | A shares contact for user not on RemindKar → user joins via invite link → tasks activated |
| M5 | Referral flow | A shares → B joins via ref link → A notified |
| M6 | Shared reminders | A assigns task with due_date to B → cron fires → B gets reminder tagged "Shared by A" |

---

## Data Cleanup

After testing, clean up with:
```sql
DELETE FROM users WHERE telegram_id IN (999999999, 888888888);
-- CASCADE triggers will archive and clean related tables
```
