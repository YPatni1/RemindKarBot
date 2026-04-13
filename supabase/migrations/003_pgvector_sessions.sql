-- =============================================================
-- RemindKar: pgvector embeddings + session context
-- =============================================================

-- Enable pgvector extension
create extension if not exists vector;

-- Add embedding column to memories
alter table public.memories
  add column description_embedding vector(768);

-- Semantic search function (single function, optional status filter)
create or replace function match_memories(
  query_telegram_id bigint,
  query_embedding vector(768),
  match_threshold float,
  match_count int,
  status_filter text default null
) returns setof public.memories
language sql stable as $$
  select m.*
  from public.memories m
  where m.telegram_id = query_telegram_id
    and m.description_embedding is not null
    and (status_filter is null or m.status = status_filter)
    and 1 - (m.description_embedding <=> query_embedding) > match_threshold
  order by m.description_embedding <=> query_embedding
  limit match_count;
$$;

-- Session context table (tracks last shown list per user)
create table public.user_sessions (
  telegram_id bigint primary key references public.users(telegram_id) on delete cascade,
  last_shown_ids uuid[] default '{}',
  last_intent text,
  updated_at timestamptz default now()
);
