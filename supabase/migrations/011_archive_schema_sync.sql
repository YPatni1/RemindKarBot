-- Migration 011: sync archive tables with columns added in migrations 003, 007, 009, 010
-- Archive tables had explicit column lists that missed newer columns

-- =============================================================
-- 1. archived_users: add streak + referral columns
-- =============================================================

ALTER TABLE public.archived_users ADD COLUMN IF NOT EXISTS current_streak integer DEFAULT 0;
ALTER TABLE public.archived_users ADD COLUMN IF NOT EXISTS longest_streak integer DEFAULT 0;
ALTER TABLE public.archived_users ADD COLUMN IF NOT EXISTS last_streak_date date;
ALTER TABLE public.archived_users ADD COLUMN IF NOT EXISTS referral_code text;
ALTER TABLE public.archived_users ADD COLUMN IF NOT EXISTS referred_by bigint;

-- =============================================================
-- 2. archived_memories: add embedding + snooze columns
-- =============================================================

ALTER TABLE public.archived_memories ADD COLUMN IF NOT EXISTS description_embedding vector(768);
ALTER TABLE public.archived_memories ADD COLUMN IF NOT EXISTS snooze_count integer DEFAULT 0;

-- =============================================================
-- 3. archived_user_sessions: add session_id
-- =============================================================

ALTER TABLE public.archived_user_sessions ADD COLUMN IF NOT EXISTS session_id uuid;

-- =============================================================
-- 4. Rewrite trigger functions to include all columns
-- =============================================================

CREATE OR REPLACE FUNCTION archive_user_before_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.archived_users (
    id, telegram_id, telegram_username, first_name,
    consent_given, consent_given_at, created_at, timezone,
    is_active, last_active_at,
    current_streak, longest_streak, last_streak_date,
    referral_code, referred_by,
    deleted_at, deletion_type
  ) VALUES (
    OLD.id, OLD.telegram_id, OLD.telegram_username, OLD.first_name,
    OLD.consent_given, OLD.consent_given_at, OLD.created_at, OLD.timezone,
    OLD.is_active, OLD.last_active_at,
    OLD.current_streak, OLD.longest_streak, OLD.last_streak_date,
    OLD.referral_code, OLD.referred_by,
    now(), 'account_delete'
  );
  RETURN OLD;
END;
$$;

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
    description_embedding, snooze_count,
    deleted_at, deletion_type
  ) VALUES (
    OLD.id, OLD.user_id, OLD.telegram_id, OLD.type, OLD.description, OLD.raw_input,
    OLD.due_date, OLD.reminder_at, OLD.entities, OLD.recurrence, OLD.status,
    OLD.is_reminded, OLD.is_pre_reminded, OLD.source, OLD.created_at, OLD.completed_at,
    OLD.description_embedding, OLD.snooze_count,
    now(), v_deletion_type
  );
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION archive_session_before_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_deletion_type text;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    v_deletion_type := 'account_cascade';
  ELSE
    v_deletion_type := 'direct';
  END IF;

  INSERT INTO public.archived_user_sessions (
    telegram_id, last_shown_ids, last_intent,
    conversation_history, updated_at, session_id,
    deleted_at, deletion_type
  ) VALUES (
    OLD.telegram_id, OLD.last_shown_ids, OLD.last_intent,
    OLD.conversation_history, OLD.updated_at, OLD.session_id,
    now(), v_deletion_type
  );
  RETURN OLD;
END;
$$;
