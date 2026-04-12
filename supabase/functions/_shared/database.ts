import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DbUser, DbMemory } from "./types.ts";

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

export async function deleteUserData(telegramId: number): Promise<void> {
  // on delete cascade handles memories
  const { error } = await supabase
    .from("users")
    .delete()
    .eq("telegram_id", telegramId);
  if (error) throw error;
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
}): Promise<DbMemory> {
  const { data, error } = await supabase
    .from("memories")
    .insert(memory)
    .select()
    .single();
  if (error) throw error;
  return data as DbMemory;
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

export async function getPendingMemories(telegramId: number): Promise<DbMemory[]> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("status", "pending")
    .order("due_date", { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as DbMemory[];
}

export async function searchMemories(
  telegramId: number,
  queryText: string,
): Promise<DbMemory[]> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("telegram_id", telegramId)
    .ilike("description", `%${queryText}%`)
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
    .ilike("description", `%${searchText}%`);
  if (error) throw error;
  return (data ?? []) as DbMemory[];
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
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("status", "pending")
    .eq("is_pre_reminded", false)
    .gt("reminder_at", now.toISOString()) // reminder hasn't fired yet
    .lte("reminder_at", new Date(now.getTime() + 30 * 60 * 1000).toISOString()); // but within 30 min
  if (error) throw error;
  return (data ?? []) as DbMemory[];
}

// For send-digest: get pending memories grouped by due date category
export async function getDigestMemories(telegramId: number): Promise<{
  overdue: DbMemory[];
  today: DbMemory[];
  tomorrow: DbMemory[];
  somedayCount: number;
}> {
  // All pending memories for this user
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("status", "pending")
    .order("due_date", { ascending: true });
  if (error) throw error;

  const memories = (data ?? []) as DbMemory[];

  // Calculate IST boundaries
  const nowUtc = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const nowIst = new Date(nowUtc.getTime() + istOffset);

  const todayStart = new Date(nowIst);
  todayStart.setHours(0, 0, 0, 0);
  const todayStartUtc = new Date(todayStart.getTime() - istOffset);

  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  const tomorrowStartUtc = new Date(tomorrowStart.getTime() - istOffset);

  const dayAfterStart = new Date(tomorrowStart);
  dayAfterStart.setDate(dayAfterStart.getDate() + 1);
  const dayAfterStartUtc = new Date(dayAfterStart.getTime() - istOffset);

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
