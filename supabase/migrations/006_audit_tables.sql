-- Audit/archive tables: preserve user and memory data on deletion
-- Uses BEFORE DELETE triggers so data is captured regardless of deletion path
-- pg_trigger_depth() distinguishes CASCADE (account delete) from direct deletes

-- =============================================================
-- Archive tables (no FKs, no CHECKs — append-only snapshots)
-- =============================================================

create table public.archived_users (
  archive_id uuid primary key default gen_random_uuid(),
  id uuid not null,
  telegram_id bigint not null,
  telegram_username text,
  first_name text,
  consent_given boolean,
  consent_given_at timestamptz,
  created_at timestamptz,
  timezone text,
  is_active boolean,
  last_active_at timestamptz,
  deleted_at timestamptz default now(),
  deletion_type text not null default 'account_delete'
);

create table public.archived_memories (
  archive_id uuid primary key default gen_random_uuid(),
  id uuid not null,
  user_id uuid,
  telegram_id bigint not null,
  type text,
  description text,
  raw_input text,
  due_date timestamptz,
  reminder_at timestamptz,
  entities jsonb,
  recurrence text,
  status text,
  is_reminded boolean,
  is_pre_reminded boolean,
  source text,
  created_at timestamptz,
  completed_at timestamptz,
  deleted_at timestamptz default now(),
  deletion_type text not null default 'direct'
);

create table public.archived_user_sessions (
  archive_id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  last_shown_ids uuid[],
  last_intent text,
  conversation_history jsonb,
  updated_at timestamptz,
  deleted_at timestamptz default now(),
  deletion_type text not null default 'direct'
);

-- RLS (service role bypasses; no public access)
alter table public.archived_users enable row level security;
alter table public.archived_memories enable row level security;
alter table public.archived_user_sessions enable row level security;

-- =============================================================
-- Indexes for demo queries
-- =============================================================

create index idx_archived_users_telegram on public.archived_users(telegram_id);
create index idx_archived_memories_telegram on public.archived_memories(telegram_id, deleted_at desc);
create index idx_archived_memories_deleted on public.archived_memories(deleted_at desc);

-- =============================================================
-- Trigger functions
-- =============================================================

-- Users: always 'account_delete' (only deleted via full account deletion)
create or replace function archive_user_before_delete()
returns trigger language plpgsql as $$
begin
  insert into public.archived_users (
    id, telegram_id, telegram_username, first_name,
    consent_given, consent_given_at, created_at, timezone,
    is_active, last_active_at, deleted_at, deletion_type
  ) values (
    OLD.id, OLD.telegram_id, OLD.telegram_username, OLD.first_name,
    OLD.consent_given, OLD.consent_given_at, OLD.created_at, OLD.timezone,
    OLD.is_active, OLD.last_active_at, now(), 'account_delete'
  );
  return OLD;
end;
$$;

-- Memories: depth > 1 means CASCADE from users trigger, else direct delete
create or replace function archive_memory_before_delete()
returns trigger language plpgsql as $$
declare
  v_deletion_type text;
begin
  if pg_trigger_depth() > 1 then
    v_deletion_type := 'account_cascade';
  else
    v_deletion_type := 'direct';
  end if;

  insert into public.archived_memories (
    id, user_id, telegram_id, type, description, raw_input,
    due_date, reminder_at, entities, recurrence, status,
    is_reminded, is_pre_reminded, source, created_at, completed_at,
    deleted_at, deletion_type
  ) values (
    OLD.id, OLD.user_id, OLD.telegram_id, OLD.type, OLD.description, OLD.raw_input,
    OLD.due_date, OLD.reminder_at, OLD.entities, OLD.recurrence, OLD.status,
    OLD.is_reminded, OLD.is_pre_reminded, OLD.source, OLD.created_at, OLD.completed_at,
    now(), v_deletion_type
  );
  return OLD;
end;
$$;

-- Sessions: depth > 1 means CASCADE from users trigger, else direct delete
create or replace function archive_session_before_delete()
returns trigger language plpgsql as $$
declare
  v_deletion_type text;
begin
  if pg_trigger_depth() > 1 then
    v_deletion_type := 'account_cascade';
  else
    v_deletion_type := 'direct';
  end if;

  insert into public.archived_user_sessions (
    telegram_id, last_shown_ids, last_intent,
    conversation_history, updated_at, deleted_at, deletion_type
  ) values (
    OLD.telegram_id, OLD.last_shown_ids, OLD.last_intent,
    OLD.conversation_history, OLD.updated_at, now(), v_deletion_type
  );
  return OLD;
end;
$$;

-- =============================================================
-- Bind triggers
-- =============================================================

create trigger trg_archive_user
  before delete on public.users
  for each row execute function archive_user_before_delete();

create trigger trg_archive_memory
  before delete on public.memories
  for each row execute function archive_memory_before_delete();

create trigger trg_archive_session
  before delete on public.user_sessions
  for each row execute function archive_session_before_delete();
