import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DbUser, DbMemory, ConversationMessage } from "./types.ts";
import { TZ_OFFSETS } from "./constants.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---- Users ----

// Upserts user on /start. Does NOT reset consent_given on returning users.
export async function upsertUser(
  telegramId: number,
  username: string | null,
  firstName: string | null,
): Promise<DbUser> {
  // Try to find existing user first
  const { data: existing } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegramId)
    .maybeSingle();

  if (existing) {
    // Update last_active and optional fields, but never reset consent
    const { data, error } = await supabase
      .from("users")
      .update({
        telegram_username: username,
        first_name: firstName,
        last_active_at: new Date().toISOString(),
        is_active: true,
      })
      .eq("telegram_id", telegramId)
      .select()
      .single();
    if (error) throw error;
    return data as DbUser;
  }

  // New user — insert with consent_given=false
  const { data, error } = await supabase
    .from("users")
    .insert({
      telegram_id: telegramId,
      telegram_username: username,
      first_name: firstName,
    })
    .select()
    .single();
  if (error) throw error;
  return data as DbUser;
}

export async function getUser(telegramId: number): Promise<DbUser | null> {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  if (error) throw error;
  return data as DbUser | null;
}

export async function updateUserConsent(
  telegramId: number,
  consent: boolean,
): Promise<void> {
  const update: Record<string, unknown> = { consent_given: consent };
  if (consent) {
    update.consent_given_at = new Date().toISOString();
  }
  const { error } = await supabase
    .from("users")
    .update(update)
    .eq("telegram_id", telegramId);
  if (error) throw error;
}

export async function updateUserTimezone(
  telegramId: number,
  timezone: string,
): Promise<void> {
  const { error } = await supabase
    .from("users")
    .update({ timezone })
    .eq("telegram_id", telegramId);
  if (error) throw error;
}

export async function updateUserStreak(
  telegramId: number,
  currentStreak: number,
  longestStreak: number,
  lastStreakDate: string,
): Promise<void> {
  const { error } = await supabase
    .from("users")
    .update({
      current_streak: currentStreak,
      longest_streak: longestStreak,
      last_streak_date: lastStreakDate,
    })
    .eq("telegram_id", telegramId);
  if (error) throw error;
}

export async function deleteUserData(telegramId: number): Promise<void> {
  // on delete cascade handles memories
  const { error } = await supabase
    .from("users")
    .delete()
    .eq("telegram_id", telegramId);
  if (error) throw error;
}

// Delete only memories + sessions, keep user account intact
export async function deleteAllMemories(telegramId: number): Promise<void> {
  const { error: memErr } = await supabase
    .from("memories")
    .delete()
    .eq("telegram_id", telegramId);
  if (memErr) throw memErr;
  const { error: sesErr } = await supabase
    .from("user_sessions")
    .delete()
    .eq("telegram_id", telegramId);
  if (sesErr) throw sesErr;
}

export async function getActiveConsentedUsers(): Promise<DbUser[]> {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("is_active", true)
    .eq("consent_given", true);
  if (error) throw error;
  return (data ?? []) as DbUser[];
}

// ---- Memories ----

export async function createMemory(memory: {
  user_id: string;
  telegram_id: number;
  type: string;
  description: string;
  raw_input: string;
  due_date?: string | null;
  reminder_at?: string | null;
  entities?: Record<string, unknown>;
  recurrence?: string | null;
  source?: string;
  description_embedding?: number[] | null;
}): Promise<DbMemory> {
  const { description_embedding, ...rest } = memory;
  const insertData: Record<string, unknown> = { ...rest };
  if (description_embedding) {
    insertData.description_embedding = `[${description_embedding.join(",")}]`;
  }
  let result = await supabase
    .from("memories")
    .insert(insertData)
    .select()
    .single();
  // If insert fails (e.g. embedding column missing), retry without embedding
  if (result.error && description_embedding) {
    console.error("createMemory with embedding failed, retrying without:", result.error.message);
    result = await supabase.from("memories").insert(rest).select().single();
  }
  if (result.error) throw result.error;
  return result.data as DbMemory;
}

export async function updateMemory(
  memoryId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("memories")
    .update(updates)
    .eq("id", memoryId);
  if (error) throw error;
}

export async function deleteMemory(memoryId: string): Promise<void> {
  const { error } = await supabase
    .from("memories")
    .delete()
    .eq("id", memoryId);
  if (error) throw error;
}

export async function getMemoryById(memoryId: string): Promise<DbMemory | null> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("id", memoryId)
    .maybeSingle();
  if (error) throw error;
  return data as DbMemory | null;
}

// Semantic search using pgvector cosine similarity
export async function semanticSearch(
  telegramId: number,
  embedding: number[],
  statusFilter: string | null = null,
  threshold = 0.4,
  limit = 10,
): Promise<DbMemory[]> {
  const { data, error } = await supabase.rpc("match_memories", {
    query_telegram_id: telegramId,
    query_embedding: `[${embedding.join(",")}]`,
    match_threshold: threshold,
    match_count: limit,
    status_filter: statusFilter,
  });
  if (error) throw error;
  return (data ?? []) as DbMemory[];
}

export async function getPendingMemories(
  telegramId: number,
  typeFilter?: string,
): Promise<DbMemory[]> {
  let query = supabase
    .from("memories")
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("status", "pending");

  if (typeFilter) {
    query = query.eq("type", typeFilter);
  }

  const { data, error } = await query
    .order("due_date", { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as DbMemory[];
}

export async function getOverdueMemories(telegramId: number): Promise<DbMemory[]> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("status", "pending")
    .not("due_date", "is", null)
    .lt("due_date", new Date().toISOString())
    .order("due_date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as DbMemory[];
}

// Escape ILIKE wildcards in user input
function escapeIlike(text: string): string {
  return text.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function searchMemories(
  telegramId: number,
  queryText: string,
): Promise<DbMemory[]> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("telegram_id", telegramId)
    .ilike("description", `%${escapeIlike(queryText)}%`)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw error;
  return (data ?? []) as DbMemory[];
}

// Search pending memories by description for /done command
export async function searchPendingByDescription(
  telegramId: number,
  searchText: string,
): Promise<DbMemory[]> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("status", "pending")
    .ilike("description", `%${escapeIlike(searchText)}%`);
  if (error) throw error;
  return (data ?? []) as DbMemory[];
}

// Query memories within a date range (for "this week", "today", "last Tuesday" queries)
export async function getMemoriesByDateRange(
  telegramId: number,
  dateStart: string,
  dateEnd: string,
  filterField: "due_date" | "created_at" = "due_date",
): Promise<DbMemory[]> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("telegram_id", telegramId)
    .gte(filterField, dateStart)
    .lte(filterField, dateEnd)
    .order(filterField, { ascending: true })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as DbMemory[];
}

// Count completed memories since a given date (for status/progress)
export async function getCompletedSince(
  telegramId: number,
  since: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("memories")
    .select("*", { count: "exact", head: true })
    .eq("telegram_id", telegramId)
    .eq("status", "done")
    .gte("completed_at", since);
  if (error) throw error;
  return count ?? 0;
}

// For send-reminders: get memories where reminder is due
export async function getDueReminders(): Promise<DbMemory[]> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("status", "pending")
    .eq("is_reminded", false)
    .lte("reminder_at", new Date().toISOString())
    .not("reminder_at", "is", null);
  if (error) throw error;
  return (data ?? []) as DbMemory[];
}

// For send-reminders: get memories where pre-reminder (30 min before) is due
export async function getDuePreReminders(): Promise<DbMemory[]> {
  const now = new Date();
  // Fire pre-reminder when due_date is 25-35 min away (not based on reminder_at)
  const min25 = new Date(now.getTime() + 25 * 60 * 1000).toISOString();
  const min35 = new Date(now.getTime() + 35 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("status", "pending")
    .eq("is_pre_reminded", false)
    .not("due_date", "is", null)
    .gte("due_date", min25)
    .lte("due_date", min35);
  if (error) throw error;
  return (data ?? []) as DbMemory[];
}

// TZ_OFFSETS imported from constants.ts

// For send-digest: get pending memories grouped by due date category
export async function getDigestMemories(telegramId: number, timezone = "Asia/Kolkata"): Promise<{
  overdue: DbMemory[];
  today: DbMemory[];
  tomorrow: DbMemory[];
  somedayCount: number;
}> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("status", "pending")
    .order("due_date", { ascending: true });
  if (error) throw error;

  const memories = (data ?? []) as DbMemory[];

  // Calculate day boundaries in user's timezone
  const nowUtc = new Date();
  const offsetMs = (TZ_OFFSETS[timezone] ?? 5.5) * 60 * 60 * 1000;
  const nowLocal = new Date(nowUtc.getTime() + offsetMs);

  const todayStart = new Date(nowLocal);
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartUtc = new Date(todayStart.getTime() - offsetMs);

  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
  const tomorrowStartUtc = new Date(tomorrowStart.getTime() - offsetMs);

  const dayAfterStart = new Date(tomorrowStart);
  dayAfterStart.setUTCDate(dayAfterStart.getUTCDate() + 1);
  const dayAfterStartUtc = new Date(dayAfterStart.getTime() - offsetMs);

  const overdue: DbMemory[] = [];
  const today: DbMemory[] = [];
  const tomorrow: DbMemory[] = [];
  let somedayCount = 0;

  for (const m of memories) {
    if (!m.due_date) {
      somedayCount++;
      continue;
    }
    const due = new Date(m.due_date);
    if (due < todayStartUtc) {
      overdue.push(m);
    } else if (due < tomorrowStartUtc) {
      today.push(m);
    } else if (due < dayAfterStartUtc) {
      tomorrow.push(m);
    }
    // Future items beyond tomorrow are not shown in digest
  }

  return { overdue, today, tomorrow, somedayCount };
}

// ---- Sessions ----

export async function upsertSession(
  telegramId: number,
  shownIds: string[],
  intent: string,
  conversationHistory?: ConversationMessage[],
  sessionId?: string,
): Promise<void> {
  const upsertData: Record<string, unknown> = {
    telegram_id: telegramId,
    last_shown_ids: shownIds,
    last_intent: intent,
    updated_at: new Date().toISOString(),
  };
  if (conversationHistory !== undefined) {
    upsertData.conversation_history = conversationHistory;
  }
  if (sessionId !== undefined) {
    upsertData.session_id = sessionId;
  }
  const { error } = await supabase
    .from("user_sessions")
    .upsert(upsertData);
  if (error) throw error;
}

// ---- Conversation Logs ----

export async function createConversationLog(log: {
  telegram_id: number;
  user_message: string | null;
  message_type: string;
  parsed_intents: unknown | null;
  primary_intent: string | null;
  bot_action: string | null;
  bot_response: string | null;
  session_id: string | null;
  processing_time_ms: number;
  error: string | null;
  user_timezone: string;
}): Promise<void> {
  const { error } = await supabase.from("conversation_logs").insert(log);
  if (error) console.error("Failed to write conversation log:", error);
}

// ---- Feedback ----

export async function createFeedback(feedback: {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  category: string;
  feedback_text: string;
}): Promise<void> {
  const { error } = await supabase.from("feedback").insert(feedback);
  if (error) throw error;
}

// ---- Sessions ----

export async function getSession(
  telegramId: number,
): Promise<{
  last_shown_ids: string[];
  last_intent: string;
  conversation_history: ConversationMessage[];
  session_id: string;
} | null> {
  const { data, error } = await supabase
    .from("user_sessions")
    .select("last_shown_ids, last_intent, conversation_history, updated_at, session_id")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  // TTL: 30 minutes
  const age = Date.now() - new Date(data.updated_at).getTime();
  if (age > 30 * 60 * 1000) return null;
  return {
    last_shown_ids: data.last_shown_ids,
    last_intent: data.last_intent,
    conversation_history: (data.conversation_history ?? []) as ConversationMessage[],
    session_id: data.session_id,
  };
}
