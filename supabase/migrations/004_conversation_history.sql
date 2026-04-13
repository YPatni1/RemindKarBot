-- =============================================================
-- RemindKar: conversation history in sessions
-- =============================================================

-- Store last few user+bot messages for conversational context
alter table public.user_sessions
  add column conversation_history jsonb default '[]';
