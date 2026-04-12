-- =============================================================
-- RemindKar: Initial Schema
-- =============================================================

-- Users table
create table public.users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique not null,
  telegram_username text,
  first_name text,
  consent_given boolean default false,
  consent_given_at timestamptz,
  created_at timestamptz default now(),
  timezone text default 'Asia/Kolkata',
  is_active boolean default true,
  last_active_at timestamptz default now()
);

alter table public.users enable row level security;

-- Memories table (tasks, reminders, notes, events, birthdays)
create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  telegram_id bigint not null,
  type text not null check (type in ('task', 'reminder', 'note', 'event', 'birthday')),
  description text not null,
  raw_input text not null,
  due_date timestamptz,
  reminder_at timestamptz,
  entities jsonb default '{}',
  recurrence text check (recurrence in ('daily', 'weekly', 'yearly')),
  status text default 'pending' check (status in ('pending', 'done', 'snoozed', 'expired')),
  is_reminded boolean default false,
  is_pre_reminded boolean default false,
  source text default 'text' check (source in ('text', 'voice', 'forwarded')),
  created_at timestamptz default now(),
  completed_at timestamptz
);

alter table public.memories enable row level security;

-- Indexes
create index idx_memories_telegram_status on public.memories(telegram_id, status);
create index idx_memories_reminder on public.memories(reminder_at, is_reminded) where status = 'pending';
create index idx_memories_due_date on public.memories(due_date) where status = 'pending';
create index idx_memories_pre_reminder on public.memories(reminder_at, is_pre_reminded) where status = 'pending';
