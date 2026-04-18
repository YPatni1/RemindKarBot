-- Migration 012: shared reminders and task delegation
-- Adds contacts, memory_participants tables + archive tables + triggers

-- =============================================================
-- 1. New columns on existing tables
-- =============================================================

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone_number text UNIQUE;
ALTER TABLE public.memories ADD COLUMN IF NOT EXISTS is_shared boolean DEFAULT false;

-- =============================================================
-- 2. contacts table
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
-- 3. memory_participants table
-- =============================================================

CREATE TABLE public.memory_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
  participant_telegram_id bigint NOT NULL,
  role text NOT NULL CHECK (role IN ('creator', 'assignee')),
  status text DEFAULT 'pending_invite' CHECK (status IN ('pending_invite', 'pending_consent', 'active', 'done', 'snoozed', 'declined', 'expired')),
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
-- 5. Archive tables
-- =============================================================

CREATE TABLE public.archived_contacts (
  archive_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id uuid NOT NULL,
  owner_telegram_id bigint NOT NULL,
  contact_telegram_id bigint,
  contact_phone text NOT NULL,
  nickname text NOT NULL,
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
-- 6. Sync archived_users and archived_memories with new columns
-- =============================================================

ALTER TABLE public.archived_users ADD COLUMN IF NOT EXISTS phone_number text;
ALTER TABLE public.archived_memories ADD COLUMN IF NOT EXISTS is_shared boolean DEFAULT false;

-- =============================================================
-- 7. Trigger functions for new archive tables
-- =============================================================

-- contacts: depth > 1 means CASCADE (e.g. owner user deleted), else direct
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

-- memory_participants: depth > 1 means CASCADE from memories trigger, else direct
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
-- 8. Rewrite archive_user_before_delete to include phone_number
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
    phone_number,
    deleted_at, deletion_type
  ) VALUES (
    OLD.id, OLD.telegram_id, OLD.telegram_username, OLD.first_name,
    OLD.consent_given, OLD.consent_given_at, OLD.created_at, OLD.timezone,
    OLD.is_active, OLD.last_active_at,
    OLD.current_streak, OLD.longest_streak, OLD.last_streak_date,
    OLD.referral_code, OLD.referred_by,
    OLD.phone_number,
    now(), 'account_delete'
  );
  RETURN OLD;
END;
$$;

-- =============================================================
-- 9. Rewrite archive_memory_before_delete to include is_shared
-- =============================================================

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

-- =============================================================
-- 10. Bind triggers
-- =============================================================

CREATE TRIGGER trg_archive_contact
  BEFORE DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION archive_contact_before_delete();

CREATE TRIGGER trg_archive_participant
  BEFORE DELETE ON public.memory_participants
  FOR EACH ROW EXECUTE FUNCTION archive_participant_before_delete();
