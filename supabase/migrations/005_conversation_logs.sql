-- Conversation logs for observability and evaluation
create table public.conversation_logs (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  user_message text,
  message_type text not null check (message_type in ('text', 'voice', 'command', 'callback', 'forward', 'unsupported')),
  parsed_intents jsonb,
  primary_intent text,
  bot_action text,
  processing_time_ms integer,
  error text,
  user_timezone text default 'Asia/Kolkata',
  created_at timestamptz default now()
);

-- Indexes for common queries
create index idx_logs_telegram_id on public.conversation_logs(telegram_id, created_at desc);
create index idx_logs_intent on public.conversation_logs(primary_intent, created_at desc);
create index idx_logs_errors on public.conversation_logs(created_at desc) where error is not null;
create index idx_logs_created on public.conversation_logs(created_at desc);

alter table public.conversation_logs enable row level security;
