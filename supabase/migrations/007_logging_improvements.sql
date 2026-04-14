-- 007_logging_improvements.sql
-- Enhances logging & audit: bot_response, session_id, conversation_logs archival

-- =============================================================
-- 1. New columns on conversation_logs
-- =============================================================

alter table public.conversation_logs add column bot_response text;
alter table public.conversation_logs add column session_id uuid;

create index idx_logs_session on public.conversation_logs(session_id) where session_id is not null;

-- =============================================================
-- 2. session_id on user_sessions (auto-generated on insert,
--    preserved on upsert-update when not explicitly set)
-- =============================================================

alter table public.user_sessions add column session_id uuid default gen_random_uuid();

-- =============================================================
-- 3. Archive table for conversation_logs
-- =============================================================

create table public.archived_conversation_logs (
  archive_id uuid primary key default gen_random_uuid(),
  id uuid not null,
  telegram_id bigint not null,
  user_message text,
  message_type text,
  parsed_intents jsonb,
  primary_intent text,
  bot_action text,
  bot_response text,
  session_id uuid,
  processing_time_ms integer,
  error text,
  user_timezone text,
  created_at timestamptz,
  deleted_at timestamptz default now(),
  deletion_type text not null default 'account_cascade'
);

alter table public.archived_conversation_logs enable row level security;
create index idx_archived_logs_telegram on public.archived_conversation_logs(telegram_id, deleted_at desc);

-- =============================================================
-- 4. Trigger: archive + purge conversation_logs on user delete
-- =============================================================

create or replace function archive_logs_on_user_delete()
returns trigger language plpgsql as $$
begin
  insert into public.archived_conversation_logs (
    id, telegram_id, user_message, message_type, parsed_intents,
    primary_intent, bot_action, bot_response, session_id,
    processing_time_ms, error, user_timezone, created_at,
    deleted_at, deletion_type
  )
  select
    id, telegram_id, user_message, message_type, parsed_intents,
    primary_intent, bot_action, bot_response, session_id,
    processing_time_ms, error, user_timezone, created_at,
    now(), 'account_cascade'
  from public.conversation_logs
  where telegram_id = OLD.telegram_id;

  delete from public.conversation_logs where telegram_id = OLD.telegram_id;

  return OLD;
end;
$$;

create trigger trg_archive_logs_on_user_delete
  before delete on public.users
  for each row execute function archive_logs_on_user_delete();
