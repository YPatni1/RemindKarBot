-- Phase 2: snooze count on memories + streak tracking on users

-- Track how many times a memory has been snoozed
ALTER TABLE public.memories
  ADD COLUMN snooze_count INTEGER NOT NULL DEFAULT 0;

-- Track completion streaks per user
ALTER TABLE public.users
  ADD COLUMN current_streak INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN longest_streak INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_streak_date DATE;
