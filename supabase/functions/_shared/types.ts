// ============================================================
// Telegram Bot API types (subset we use)
// ============================================================

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  inline_query?: TelegramInlineQuery;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  voice?: TelegramVoice;
  forward_date?: number;
  forward_origin?: unknown;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramInlineQuery {
  id: string;
  from: TelegramUser;
  query: string;
  offset: string;
}

export interface InlineQueryResultArticle {
  type: "article";
  id: string;
  title: string;
  description?: string;
  input_message_content: {
    message_text: string;
    parse_mode?: string;
  };
  reply_markup?: {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
}

export type TelegramInlineKeyboardButton =
  | { text: string; callback_data: string }
  | { text: string; url: string }
  | { text: string; switch_inline_query_chosen_chat: {
      query: string;
      allow_user_chats: boolean;
      allow_group_chats: boolean;
      allow_channel_chats: boolean;
      allow_bot_chats: boolean;
    }
  };

// ============================================================
// Gemini API types
// ============================================================

export interface GeminiParsedResponse {
  intent: "task" | "reminder" | "event" | "birthday" | "note" | "query" | "greeting" | "done" | "reschedule" | "delete" | "edit" | "status" | "casual" | "unknown";
  description: string;
  due_date: string | null;
  reminder_at: string | null;
  entities: {
    people: string[];
    projects: string[];
    locations: string[];
  };
  recurrence: "daily" | "weekly" | "yearly" | null;
  priority: "high" | "medium" | "low";
  query_text: string | null;
  reschedule_to: string | null;
  target_index: number | null;
  edit_field: "type" | "description" | "due_date" | null;
  edit_value: string | null;
  confidence: number;
  ambiguous_date: boolean;
  date_options: string[];
  query_date_start: string | null;
  query_date_end: string | null;
}

// ============================================================
// Database types
// ============================================================

export interface DbUser {
  id: string;
  telegram_id: number;
  telegram_username: string | null;
  first_name: string | null;
  consent_given: boolean;
  consent_given_at: string | null;
  created_at: string;
  timezone: string;
  is_active: boolean;
  last_active_at: string;
  current_streak: number;
  longest_streak: number;
  last_streak_date: string | null;
  referral_code: string | null;
  referred_by: number | null;
}

export interface DbMemory {
  id: string;
  user_id: string;
  telegram_id: number;
  type: string;
  description: string;
  raw_input: string;
  due_date: string | null;
  reminder_at: string | null;
  entities: Record<string, unknown>;
  recurrence: string | null;
  status: string;
  is_reminded: boolean;
  is_pre_reminded: boolean;
  source: string;
  created_at: string;
  completed_at: string | null;
}

// ============================================================
// Conversation history (stored in user_sessions)
// ============================================================

export interface ConversationMessage {
  role: "user" | "bot";
  text: string;
}
