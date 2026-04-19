import { TelegramUpdate, TelegramMessage, TelegramCallbackQuery, TelegramInlineQuery, TelegramInlineKeyboardButton, GeminiParsedResponse, DbMemory, DbContact, DbMemoryParticipant, ConversationMessage, InlineQueryResultArticle } from "../_shared/types.ts";
import { TZ_OFFSETS, BOT_HANDLE } from "../_shared/constants.ts";
import {
  sendMessage,
  sendMessageWithButtons,
  editMessageText,
  editMessageWithButtons,
  answerCallbackQuery,
  answerInlineQuery,
  downloadTelegramFile,
  escapeHtml,
} from "../_shared/telegram.ts";
import {
  upsertUser,
  getUser,
  updateUserConsent,
  updateUserTimezone,
  deleteUserData,
  deleteAllMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  getPendingMemories,
  searchMemories,
  searchPendingByDescription,
  getCompletedSince,
  getMemoryById,
  getMemoriesByDateRange,
  semanticSearch,
  getOverdueMemories,
  updateUserStreak,
  upsertSession,
  getSession,
  createConversationLog,
  createFeedback,
  createReferral,
  convertReferral,
  getReferralStats,
  getContactByNickname,
  getContactById,
  getContactsByOwner,
  createContact,
  updateContact,
  createParticipant,
  updateParticipant,
  activateParticipantsForContact,
  declineParticipantsFromSender,
  getReceivedTasks,
  getApprovedSenders,
  getBlockedSenders,
  blockSender,
  unblockSender,
  getAssignedByUser,
  getParticipant,
} from "../_shared/database.ts";
import { parseMessage, transcribeAudio, generateEmbedding } from "../_shared/gemini.ts";
import {
  formatConfirmation,
  formatQueryResults,
  formatPendingList,
  formatReceivedTasks,
  formatAmbiguousDate,
  formatDoneOptions,
  formatDeleteOptions,
  formatRescheduleOptions,
} from "../_shared/formatters.ts";

// Session save wrapper — never crashes the main flow
async function saveSession(
  telegramId: number,
  ids: string[],
  intent: string,
  conversationHistory?: ConversationMessage[],
  sessionId?: string,
): Promise<void> {
  try {
    await upsertSession(telegramId, ids, intent, conversationHistory, sessionId);
  } catch (err) {
    console.error("Session save failed (non-fatal):", err);
  }
}

// TZ_OFFSETS imported from _shared/constants.ts

// Get tomorrow 9 AM in user's timezone as UTC Date
function getTomorrowMorning(timezone: string): Date {
  const offsetHours = TZ_OFFSETS[timezone] ?? 5.5;
  // 9 AM local = (9 - offset) hours UTC
  const utcHour = 9 - offsetHours;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(Math.floor(utcHour), (utcHour % 1) * 60, 0, 0);
  return d;
}

// Build a UTC Date from a local-time hour in a given timezone (handles fractional offsets)
function localHourToUtcDate(year: number, month: number, day: number, localHour: number, timezone: string): Date {
  const offsetHours = TZ_OFFSETS[timezone] ?? 5.5;
  const utcHour = localHour - offsetHours;
  return new Date(Date.UTC(year, month - 1, day, Math.floor(utcHour), Math.round((utcHour % 1) * 60), 0, 0));
}

// Append to conversation history and trim to last 6 entries (3 pairs)
function appendHistory(
  history: ConversationMessage[],
  userMsg: string,
  botSummary: string,
): ConversationMessage[] {
  const updated = [...history];
  updated.push({ role: "user", text: userMsg });
  updated.push({ role: "bot", text: botSummary });
  return updated.slice(-6);
}

// ============================================================
// Main entry point
// ============================================================

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const update: TelegramUpdate = await req.json();
    await handleUpdate(update);
  } catch (error) {
    console.error("Top-level error:", error);
  }
  // Always 200 to prevent Telegram retries
  return new Response("OK", { status: 200 });
});

// ============================================================
// Conversation log helper — never crashes the main flow
// ============================================================

async function logInteraction(log: {
  telegram_id: number;
  user_message: string | null;
  message_type: string;
  parsed_intents?: unknown | null;
  primary_intent?: string | null;
  bot_action?: string | null;
  bot_response?: string | null;
  session_id?: string | null;
  processing_time_ms: number;
  error?: string | null;
  user_timezone?: string;
}): Promise<void> {
  try {
    await createConversationLog({
      telegram_id: log.telegram_id,
      user_message: log.user_message,
      message_type: log.message_type,
      parsed_intents: log.parsed_intents ?? null,
      primary_intent: log.primary_intent ?? null,
      bot_action: log.bot_action ?? null,
      bot_response: log.bot_response ?? null,
      session_id: log.session_id ?? null,
      processing_time_ms: log.processing_time_ms,
      error: log.error ?? null,
      user_timezone: log.user_timezone ?? "Asia/Kolkata",
    });
  } catch (err) {
    console.error("logInteraction failed (non-fatal):", err);
  }
}

// ============================================================
// Celebration messages for task completion
// ============================================================

const DONE_MESSAGES = [
  "\u{2705} Done: {task}",
  "\u{2705} Done: {task} \u{2014} nice work!",
  "\u{2705} Done: {task} \u{2014} keep it up!",
  "\u{2705} Done: {task} \u{2014} one down!",
];

async function getCelebrationMessage(telegramId: number, taskDescription: string): Promise<string> {
  const base = DONE_MESSAGES[Math.floor(Math.random() * DONE_MESSAGES.length)]
    .replace("{task}", escapeHtml(taskDescription));

  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const completedToday = await getCompletedSince(telegramId, todayStart.toISOString());

    if (completedToday === 1) {
      return base + "\n\u{1F4AA} First one today!";
    }
    if (completedToday === 5) {
      return base + "\n\u{1F525} 5 tasks done today!";
    }
    if (completedToday === 10) {
      return base + "\n\u{1F389} Double digits today!";
    }

    // Check if all pending are now done
    const pending = await getPendingMemories(telegramId);
    if (pending.length === 0) {
      return base + "\n\u{1F389} All caught up \u{2014} nothing pending!";
    }
  } catch {
    // Non-fatal — just return base message
  }

  return base;
}

// ============================================================
// Streak tracking — updates user's completion streak
// ============================================================

async function updateStreak(telegramId: number): Promise<void> {
  try {
    const user = await getUser(telegramId);
    if (!user) return;

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const lastDate = user.last_streak_date;

    if (lastDate === today) return; // Already counted today

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let newStreak: number;

    if (lastDate === yesterday) {
      newStreak = (user.current_streak ?? 0) + 1;
    } else {
      newStreak = 1; // streak broken or first day
    }

    const longestStreak = Math.max(newStreak, user.longest_streak ?? 0);

    await updateUserStreak(telegramId, newStreak, longestStreak, today);
  } catch (err) {
    console.error("Streak update failed (non-fatal):", err);
  }
}

// ============================================================
// Update router (order matters — see spec section 6)
// ============================================================

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const startMs = Date.now();

  // Handle inline queries (from /share button — fires when user picks a chat)
  if (update.inline_query) {
    await handleInlineQuery(update.inline_query);
    return;
  }

  if (update.callback_query) {
    const telegramId = update.callback_query.from.id;
    const cbData = update.callback_query.data ?? "";
    try {
      await handleCallbackQuery(update.callback_query);
      await logInteraction({
        telegram_id: telegramId,
        user_message: cbData,
        message_type: "callback",
        primary_intent: cbData.split(":")[0],
        bot_action: `callback:${cbData.split(":")[0]}`,
        processing_time_ms: Date.now() - startMs,
      });
    } catch (err) {
      await logInteraction({
        telegram_id: telegramId,
        user_message: cbData,
        message_type: "callback",
        primary_intent: cbData.split(":")[0],
        error: String(err),
        processing_time_ms: Date.now() - startMs,
      });
      throw err;
    }
    return;
  }

  const message = update.message;
  if (!message) return;

  const telegramId = message.from?.id ?? 0;
  const userText = message.text ?? "";

  if (message.voice) {
    // Logging handled inside handleVoice
    await handleVoice(message, startMs);
    return;
  }

  if (message.forward_date || message.forward_origin) {
    // Logging handled inside handleForward
    await handleForward(message, startMs);
    return;
  }

  if (message.contact) {
    await handleContactShare(message, startMs);
    return;
  }

  if (userText.startsWith("/")) {
    try {
      await handleCommand(message);
      await logInteraction({
        telegram_id: telegramId,
        user_message: userText,
        message_type: "command",
        primary_intent: userText.split(" ")[0].split("@")[0],
        bot_action: `command:${userText.split(" ")[0]}`,
        processing_time_ms: Date.now() - startMs,
      });
    } catch (err) {
      await logInteraction({
        telegram_id: telegramId,
        user_message: userText,
        message_type: "command",
        error: String(err),
        processing_time_ms: Date.now() - startMs,
      });
      throw err;
    }
    return;
  }

  if (message.text) {
    // Logging handled inside handleText
    await handleText(message, startMs);
    return;
  }

  // Unsupported input types — photos, stickers, documents, etc.
  const chatId = message.chat.id;
  await sendMessage(
    chatId,
    "I can only process text and voice messages for now. Try typing or sending a voice note!",
  );
  await logInteraction({
    telegram_id: telegramId,
    user_message: null,
    message_type: "unsupported",
    bot_action: "unsupported_input",
    processing_time_ms: Date.now() - startMs,
  });
}

// ============================================================
// Inline query handler — fires when user picks a chat via /share button
// ============================================================

async function handleInlineQuery(query: TelegramInlineQuery): Promise<void> {
  const telegramId = query.from.id;

  // Only serve registered, consented users
  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await answerInlineQuery(query.id, []);
    return;
  }

  const referralCode = `ref_${telegramId}`;
  const deepLink = `https://t.me/${BOT_HANDLE}?start=${referralCode}`;

  // Log the share event (non-fatal)
  try {
    await createReferral(telegramId);
  } catch (err) {
    console.error("createReferral failed (non-fatal):", err);
  }

  const inviteCard: InlineQueryResultArticle = {
    type: "article",
    id: "share_remindkar",
    title: "Invite to RemindKar",
    description: "AI-powered task & reminder tracker — works right in Telegram",
    input_message_content: {
      message_text:
        `Hey! I've been using <b>RemindKar</b> to track my tasks and reminders \u{2014} it works right here in Telegram.\n\n` +
        `Just text it anything you want to remember and it handles the rest. Try it \u{1F447}`,
      parse_mode: "HTML",
    },
    reply_markup: {
      inline_keyboard: [[{ text: "\u{2728} Try RemindKar", url: deepLink }]],
    },
  };

  await answerInlineQuery(query.id, [inviteCard]);
}

// ============================================================
// Command handlers
// ============================================================

async function handleCommand(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text!;
  const command = text.split(" ")[0].split("@")[0].toLowerCase();
  const args = text.slice(command.length).trim();

  switch (command) {
    case "/start":
      await handleStart(message);
      break;
    case "/help":
      await handleHelp(chatId);
      break;
    case "/privacy":
      await handlePrivacy(chatId);
      break;
    case "/delete":
      await handleDelete(message);
      break;
    case "/done":
      await handleDoneCommand(message, args);
      break;
    case "/pending":
      await handlePending(message);
      break;
    case "/feedback":
      await handleFeedbackCommand(message, args);
      break;
    case "/share":
      await handleShare(message);
      break;
    case "/contacts":
      await handleContacts(message);
      break;
    case "/block":
      await handleBlock(message);
      break;
    case "/unblock":
      await handleUnblock(message);
      break;
    case "/assigned":
      await handleAssigned(message);
      break;
    default:
      await sendMessage(chatId, "Unknown command. Try /help to see what I can do.");
  }
}

async function handleStart(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;
  const username = message.from?.username ?? null;
  const firstName = message.from?.first_name ?? null;

  // Parse deep link payload: "/start ref_123456"
  const payload = message.text?.split(" ")[1] ?? null;

  const user = await upsertUser(telegramId, username, firstName);

  // Handle referral conversion — non-fatal, never blocks onboarding
  if (payload?.startsWith("ref_") && !user.referred_by) {
    try {
      const referrerId = await convertReferral(payload, telegramId);
      if (referrerId) {
        const joinerName = escapeHtml(firstName || "Someone");
        sendMessage(
          referrerId,
          `\u{1F389} <b>${joinerName}</b> just joined RemindKar using your invite link!`,
        ).catch(() => {}); // Referrer may have blocked the bot — non-fatal
      }
    } catch (err) {
      console.error("Referral conversion failed (non-fatal):", err);
    }
  }

  // Handle invite deep link: /start invite_<contact_id>
  if (payload?.startsWith("invite_")) {
    try {
      const contactId = payload.slice(7);
      const contact = await getContactById(contactId);
      if (contact && (!contact.contact_telegram_id || contact.contact_telegram_id === telegramId)) {
        // Update contact with confirmed telegram_id and approved status
        await updateContact(contactId, { status: "approved", contact_telegram_id: telegramId });
        // Activate all queued tasks from this sender
        const activated = await activateParticipantsForContact(contact.owner_telegram_id, telegramId, "pending_invite");
        // Notify sender (non-fatal)
        const joinerName = escapeHtml(firstName || "Someone");
        sendMessage(
          contact.owner_telegram_id,
          `\u{1F389} ${joinerName} joined RemindKar! ${activated.length > 0 ? `Your ${activated.length} task${activated.length > 1 ? "s have" : " has"} been delivered.` : ""}`,
        ).catch(() => {});
      }
    } catch (err) {
      console.error("Invite conversion failed (non-fatal):", err);
    }
  }

  if (user.consent_given) {
    await sendMessage(
      chatId,
      `Welcome back, ${escapeHtml(firstName || "there")}! Just send me a message or voice note and I'll remember it for you.`,
    );
    return;
  }

  const name = escapeHtml(firstName || "there");
  const welcomeText =
    `Hey ${name}! \u{1F44B}\n\n` +
    `I'm RemindKar \u{2014} text or voice me anything you want to remember.\n` +
    `Tasks, deadlines, birthdays \u{2014} I'll organize it and remind you when it matters.\n\n` +
    `Quick peek at your data policy: I store only what you send me. Never shared. Delete anytime with /delete.\n\n` +
    `Ready?`;

  await sendMessageWithButtons(chatId, welcomeText, [
    [
      { text: "\u{2705} Let's go!", callback_data: "consent_yes" },
      { text: "Tell me more", callback_data: "consent_info" },
    ],
  ]);
}

async function handleHelp(chatId: number): Promise<void> {
  const helpText =
    "<b>RemindKar \u{2014} Commands</b>\n\n" +
    "/start \u{2014} Set up or restart the bot\n" +
    "/pending \u{2014} Show all pending tasks\n" +
    "/done &lt;text&gt; \u{2014} Mark a task as done\n" +
    "/share \u{2014} Invite friends to RemindKar\n" +
    "/feedback \u{2014} Share feedback with us\n" +
    "/privacy \u{2014} See privacy info\n" +
    "/delete \u{2014} Delete all your data\n" +
    "/contacts \u{2014} See your linked contacts\n" +
    "/block \u{2014} Block someone from assigning tasks\n" +
    "/unblock \u{2014} Unblock a blocked sender\n" +
    "/assigned \u{2014} See tasks you've assigned to others\n" +
    "/help \u{2014} Show this message\n\n" +
    "<b>Just send me:</b>\n" +
    '\u{2022} A task: "Call Aman tomorrow at 5 PM"\n' +
    '\u{2022} A birthday: "Mom\'s birthday is 15th August"\n' +
    '\u{2022} A question: "Show my pending tasks"\n' +
    "\u{2022} A voice note in any language!";

  await sendMessage(chatId, helpText);
}

async function handlePrivacy(chatId: number): Promise<void> {
  const privacyText =
    "<b>RemindKar Privacy Info:</b>\n\n" +
    "<b>What I store:</b>\n" +
    "\u{2022} Your Telegram ID and first name\n" +
    "\u{2022} Messages you send me (text and voice transcriptions)\n" +
    "\u{2022} Tasks, reminders, and notes I extract from your messages\n\n" +
    "<b>What I DON'T do:</b>\n" +
    "\u{2022} Share your data with anyone\n" +
    "\u{2022} Use your data for training\n" +
    "\u{2022} Store data beyond what you send me\n\n" +
    "<b>Your controls:</b>\n" +
    "\u{2022} /delete \u{2014} permanently erase all your data\n" +
    "\u{2022} Every task has a Delete button\n\n" +
    "Data is stored on Supabase (hosted on AWS).";

  await sendMessage(chatId, privacyText);
}

async function handleDelete(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  await sendMessageWithButtons(
    chatId,
    "\u{26A0}\u{FE0F} <b>Delete ALL your data?</b>\nThis will permanently erase your account, tasks, and memories. This cannot be undone.",
    [[
      { text: "\u{1F5D1} Yes, delete everything", callback_data: "confirm_account_delete" },
      { text: "\u{274C} Cancel", callback_data: "cancel_delete" },
    ]],
  );
}

async function handleDoneCommand(message: TelegramMessage, searchText: string): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  if (!searchText) {
    await sendMessage(chatId, "Tell me which task you completed. Example: /done call Aman");
    return;
  }

  try {
    const matches = await findPendingByDescription(telegramId, searchText);

    if (matches.length === 0) {
      const allPending = await getPendingMemories(telegramId);
      if (allPending.length === 0) {
        await sendMessage(chatId, "You have no pending tasks.");
      } else {
        const shown = allPending.slice(0, 5);
        await saveSession(telegramId, shown.map((m) => m.id), "done_picker");
        const prompt = `Couldn't find "${escapeHtml(searchText)}". Which task did you complete?\n`;
        const { text, buttons } = formatDoneOptions(shown, prompt);
        await sendMessageWithButtons(chatId, text, buttons);
      }
    } else if (matches.length === 1) {
      await updateMemory(matches[0].id, {
        status: "done",
        completed_at: new Date().toISOString(),
      });
      await sendMessage(chatId, `\u{2705} Done: ${escapeHtml(matches[0].description)}`);
    } else {
      const { text, buttons } = formatDoneOptions(matches.slice(0, 5));
      await sendMessageWithButtons(chatId, text, buttons);
    }
  } catch (error) {
    console.error("Done command error:", error);
    await sendMessage(chatId, "Something went wrong. Please try again.");
  }
}

async function handlePending(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  try {
    const user = await getUser(telegramId);
    if (!user?.consent_given) {
      await sendMessage(chatId, "Please send /start first and give consent before I can show your memories.");
      return;
    }
    const memories = await getPendingMemories(telegramId);
    await saveSession(telegramId, memories.map((m) => m.id), "pending");
    const { text, buttons } = formatPendingList(memories, user.timezone);

    // Fetch received (delegated) tasks
    let receivedText = "";
    try {
      const receivedRaw = await getReceivedTasks(telegramId);
      if (receivedRaw.length > 0) {
        const receivedItems: { participant: DbMemoryParticipant; memory: DbMemory; senderName: string }[] = [];
        for (const r of receivedRaw) {
          const senderUser = await getUser(r.memory.telegram_id);
          receivedItems.push({
            participant: r,
            memory: r.memory,
            senderName: senderUser?.first_name || "Someone",
          });
        }
        const receivedLines = formatReceivedTasks(receivedItems, user.timezone, memories.length + 1);
        receivedText = receivedLines.join("\n");
      }
    } catch (err) {
      console.error("getReceivedTasks error (non-fatal):", err);
    }

    const fullText = receivedText ? text + receivedText : text;

    // Add filter row
    const filterRow: TelegramInlineKeyboardButton[] = [
      { text: "\u{1F4CB} Tasks", callback_data: "filter:task" },
      { text: "\u{1F4DD} Notes", callback_data: "filter:note" },
      { text: "\u{1F4C5} Events", callback_data: "filter:event" },
      { text: "\u{1F6A8} Overdue", callback_data: "filter:overdue" },
    ];
    const allButtons = [...buttons, filterRow];
    await sendMessageWithButtons(chatId, fullText, allButtons);
  } catch (error) {
    console.error("Pending error:", error);
    await sendMessage(chatId, "Something went wrong. Please try again.");
  }
}

async function handleFeedbackCommand(message: TelegramMessage, args: string): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  // If user provided feedback text inline: /feedback Great bot!
  if (args.trim()) {
    try {
      const user = await getUser(telegramId);
      await createFeedback({
        telegram_id: telegramId,
        username: message.from?.username ?? null,
        first_name: message.from?.first_name ?? null,
        category: "general",
        feedback_text: args.trim(),
      });
      const response = "Thanks for your feedback! \u{1F64F}";
      await sendMessage(chatId, response);
      await logInteraction({
        telegram_id: telegramId,
        user_message: `/feedback ${args}`,
        message_type: "command",
        primary_intent: "feedback",
        bot_action: "feedback_saved:general",
        bot_response: response,
        processing_time_ms: 0,
        user_timezone: user?.timezone ?? "Asia/Kolkata",
      });
    } catch (error) {
      console.error("Feedback save error:", error);
      await sendMessage(chatId, "Something went wrong saving your feedback. Please try again.");
    }
    return;
  }

  // No args — show category picker
  await sendMessageWithButtons(
    chatId,
    "We'd love to hear from you! Pick a category:",
    [[
      { text: "\u{1F41B} Bug", callback_data: "feedback_bug" },
      { text: "\u{1F4A1} Feature", callback_data: "feedback_feature" },
      { text: "\u{1F4AC} General", callback_data: "feedback_general" },
    ]],
  );
}

async function handleShare(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first to set up RemindKar.");
    return;
  }

  // Show referral stats if any conversions exist
  let statsText = "";
  try {
    const stats = await getReferralStats(telegramId);
    if (stats.conversions > 0) {
      statsText = `\n\nYou've already brought in <b>${stats.conversions}</b> friend${stats.conversions > 1 ? "s" : ""}! \u{1F64F}`;
    }
  } catch {
    // Non-fatal — skip stats line
  }

  const shareText =
    `\u{1F4E8} <b>Share RemindKar</b>\n\n` +
    `Tap the button below, pick a friend or group, and send them an invite card with your personal link.${statsText}`;

  await sendMessageWithButtons(chatId, shareText, [
    [
      {
        text: "\u{1F4E4} Share with a friend",
        switch_inline_query_chosen_chat: {
          query: "",
          allow_user_chats: true,
          allow_group_chats: true,
          allow_channel_chats: false,
          allow_bot_chats: false,
        },
      },
    ],
  ]);
}

// ============================================================
// /contacts — list linked contacts
// ============================================================

async function handleContacts(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first to set up RemindKar.");
    return;
  }

  try {
    const contacts = await getContactsByOwner(telegramId);
    if (contacts.length === 0) {
      await sendMessage(chatId, "You have no linked contacts yet.\n\nTo add a contact, share their Telegram contact card with me.");
      return;
    }

    const statusEmoji: Record<string, string> = {
      approved: "\u{2705}",
      pending: "\u{23F3}",
      blocked: "\u{1F6AB}",
      declined: "\u{274C}",
    };

    const lines = ["<b>Your contacts:</b>\n"];
    contacts.forEach((c, i) => {
      const emoji = statusEmoji[c.status] || "\u{2753}";
      const name = escapeHtml(c.first_name || c.nickname);
      lines.push(`${i + 1}. ${emoji} ${name} (${c.status})`);
    });

    await sendMessage(chatId, lines.join("\n"));
  } catch (error) {
    console.error("Contacts error:", error);
    await sendMessage(chatId, "Something went wrong. Please try again.");
  }
}

// ============================================================
// /block — block a sender from assigning tasks
// ============================================================

async function handleBlock(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first to set up RemindKar.");
    return;
  }

  try {
    const senders = await getApprovedSenders(telegramId);
    if (senders.length === 0) {
      await sendMessage(chatId, "No one is sending you tasks right now.");
      return;
    }

    const buttons: TelegramInlineKeyboardButton[][] = [];
    for (const s of senders) {
      const senderUser = await getUser(s.owner_telegram_id);
      const senderName = senderUser?.first_name || `User ${s.owner_telegram_id}`;
      buttons.push([{
        text: `\u{1F6AB} ${senderName}`,
        callback_data: `block_sender:${s.owner_telegram_id}`,
      }]);
    }

    await sendMessageWithButtons(chatId, "Who would you like to block from sending you tasks?", buttons);
  } catch (error) {
    console.error("Block error:", error);
    await sendMessage(chatId, "Something went wrong. Please try again.");
  }
}

// ============================================================
// /unblock — unblock a blocked sender
// ============================================================

async function handleUnblock(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first to set up RemindKar.");
    return;
  }

  try {
    const blocked = await getBlockedSenders(telegramId);
    if (blocked.length === 0) {
      await sendMessage(chatId, "You haven't blocked anyone.");
      return;
    }

    const buttons: TelegramInlineKeyboardButton[][] = [];
    for (const b of blocked) {
      const blockedUser = await getUser(b.owner_telegram_id);
      const blockedName = blockedUser?.first_name || `User ${b.owner_telegram_id}`;
      buttons.push([{
        text: `\u{2705} ${blockedName}`,
        callback_data: `unblock_sender:${b.owner_telegram_id}`,
      }]);
    }

    await sendMessageWithButtons(chatId, "Who would you like to unblock?", buttons);
  } catch (error) {
    console.error("Unblock error:", error);
    await sendMessage(chatId, "Something went wrong. Please try again.");
  }
}

// ============================================================
// /assigned — tasks you've assigned to others
// ============================================================

async function handleAssigned(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first to set up RemindKar.");
    return;
  }

  try {
    const assigned = await getAssignedByUser(telegramId);
    if (assigned.length === 0) {
      await sendMessage(chatId, "You haven't assigned any tasks to others yet.\n\nTo assign a task, share a contact card with me and then mention their name in a task.");
      return;
    }

    const statusEmoji: Record<string, string> = {
      active: "\u{23F3}",
      done: "\u{2705}",
      pending_consent: "\u{1F4E8}",
      pending_invite: "\u{1F4E8}",
      declined: "\u{274C}",
    };

    const lines = ["<b>Tasks you've assigned:</b>\n"];
    for (const a of assigned) {
      const emoji = statusEmoji[a.status] || "\u{2753}";
      const assigneeUser = await getUser(a.participant_telegram_id);
      const assigneeName = assigneeUser?.first_name || `User ${a.participant_telegram_id}`;
      const due = a.memory.due_date
        ? ` \u{2014} due ${new Date(a.memory.due_date).toLocaleString("en-IN", {
            day: "numeric",
            month: "short",
            timeZone: user.timezone,
          })}`
        : "";
      lines.push(`${emoji} ${escapeHtml(a.memory.description)}${due} \u{2192} <i>${escapeHtml(assigneeName)}</i> (${a.status})`);
    }

    await sendMessage(chatId, lines.join("\n"));
  } catch (error) {
    console.error("Assigned error:", error);
    await sendMessage(chatId, "Something went wrong. Please try again.");
  }
}

// ============================================================
// Callback query handler
// ============================================================

async function handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const data = query.data;
  if (!data) return;

  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  const telegramId = query.from.id;

  try {
    if (data === "consent_yes") {
      await updateUserConsent(telegramId, true);
      await answerCallbackQuery(query.id, "Consent recorded!");

      if (chatId && messageId) {
        await editMessageText(chatId, messageId, "\u{2705} Let's go!");
      }
      if (chatId) {
        await sendMessageWithButtons(chatId, "What timezone are you in?", [
          [
            { text: "\u{1F1EE}\u{1F1F3} India", callback_data: "tz:Asia/Kolkata" },
            { text: "\u{1F1FA}\u{1F1F8} US East", callback_data: "tz:America/New_York" },
          ],
          [
            { text: "\u{1F1FA}\u{1F1F8} US West", callback_data: "tz:America/Los_Angeles" },
            { text: "\u{1F1EC}\u{1F1E7} UK", callback_data: "tz:Europe/London" },
          ],
          [
            { text: "\u{1F1E9}\u{1F1EA} Europe", callback_data: "tz:Europe/Berlin" },
            { text: "\u{1F1E6}\u{1F1EA} Dubai", callback_data: "tz:Asia/Dubai" },
          ],
          [
            { text: "\u{1F1F8}\u{1F1EC} Singapore", callback_data: "tz:Asia/Singapore" },
            { text: "\u{1F1EF}\u{1F1F5} Japan", callback_data: "tz:Asia/Tokyo" },
          ],
          [
            { text: "\u{1F1E6}\u{1F1FA} Australia", callback_data: "tz:Australia/Sydney" },
          ],
        ]);
      }
      return;
    }

    if (data === "consent_info") {
      await answerCallbackQuery(query.id);
      if (chatId) {
        await handlePrivacy(chatId);
      }
      return;
    }

    if (data === "consent_no") {
      await answerCallbackQuery(query.id);
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          "No problem! Feel free to come back anytime. Just send /start to begin again.",
        );
      }
      return;
    }

    // Delegation consent: recipient allows a sender to assign tasks
    if (data.startsWith("consent_allow:")) {
      const contactId = data.slice("consent_allow:".length);
      try {
        const contact = await getContactById(contactId);
        if (!contact) {
          await answerCallbackQuery(query.id, "Contact not found.");
          return;
        }
        await updateContact(contactId, { status: "approved" });
        const senderUser = await getUser(contact.owner_telegram_id);
        const senderName = escapeHtml(senderUser?.first_name || "They");

        await answerCallbackQuery(query.id, "Allowed!");
        if (chatId && messageId) {
          await editMessageText(chatId, messageId, `\u{2705} You've allowed ${senderName} to send you tasks.`);
        }

        // Activate queued tasks
        const activated = await activateParticipantsForContact(contact.owner_telegram_id, telegramId, "pending_consent");
        if (activated.length > 0 && chatId) {
          await sendMessage(chatId, `\u{1F4E5} ${activated.length} task${activated.length > 1 ? "s" : ""} from ${senderName} just landed!`);
        }

        // Notify sender (non-fatal)
        try {
          const recipientName = escapeHtml(query.from.first_name || "Your contact");
          await sendMessage(contact.owner_telegram_id, `\u{2705} ${recipientName} accepted your task connection! You can now assign tasks to them.`);
        } catch {
          // Sender may have blocked the bot
        }
      } catch (err) {
        console.error("consent_allow error:", err);
        await answerCallbackQuery(query.id, "Something went wrong.");
      }
      return;
    }

    // Delegation consent: recipient declines
    if (data.startsWith("consent_decline:")) {
      const contactId = data.slice("consent_decline:".length);
      try {
        const contact = await getContactById(contactId);
        if (!contact) {
          await answerCallbackQuery(query.id, "Contact not found.");
          return;
        }
        await updateContact(contactId, { status: "declined" });

        await answerCallbackQuery(query.id, "Declined.");
        if (chatId && messageId) {
          await editMessageText(chatId, messageId, "Got it \u{2014} they won't be able to send you tasks.");
        }

        // Decline queued tasks
        await declineParticipantsFromSender(contact.owner_telegram_id, telegramId);

        // Notify sender with generic message (non-fatal)
        try {
          await sendMessage(contact.owner_telegram_id, `Your task connection request wasn't accepted. You can try again later.`);
        } catch {
          // Sender may have blocked the bot
        }
      } catch (err) {
        console.error("consent_decline error:", err);
        await answerCallbackQuery(query.id, "Something went wrong.");
      }
      return;
    }

    // Block sender callback
    if (data.startsWith("block_sender:")) {
      const senderTgId = parseInt(data.slice("block_sender:".length), 10);
      await blockSender(senderTgId, telegramId);
      await declineParticipantsFromSender(senderTgId, telegramId);
      await answerCallbackQuery(query.id, "Blocked!");
      if (chatId && messageId) {
        await editMessageText(chatId, messageId, "\u{1F6AB} Blocked. They won't be able to send you tasks anymore.");
      }
      return;
    }

    // Unblock sender callback
    if (data.startsWith("unblock_sender:")) {
      const senderTgId = parseInt(data.slice("unblock_sender:".length), 10);
      await unblockSender(senderTgId, telegramId);
      await answerCallbackQuery(query.id, "Unblocked!");
      if (chatId && messageId) {
        await editMessageText(chatId, messageId, "\u{2705} Unblocked. They can send you tasks again.");
      }
      return;
    }

    // Contact disambiguation picker
    if (data.startsWith("pick_contact:")) {
      const contactId = data.slice("pick_contact:".length);
      try {
        await answerCallbackQuery(query.id, "Selected!");
        const contact = await getContactById(contactId);
        if (!contact) {
          if (chatId && messageId) {
            await editMessageText(chatId, messageId, "Contact not found.");
          }
          return;
        }

        if (chatId && messageId) {
          await editMessageText(chatId, messageId, `\u{2705} Selected: ${escapeHtml(contact.first_name || contact.nickname)}`);
        }

        // Check session for original message
        const pickSession = await getSession(telegramId);
        if (pickSession?.last_intent?.startsWith("awaiting_contact_pick:")) {
          const originalMessage = pickSession.last_intent.slice("awaiting_contact_pick:".length);
          if (originalMessage && chatId) {
            const pickUser = await getUser(telegramId);
            if (pickUser) {
              const parsedItems = await parseMessage(originalMessage, pickSession.conversation_history ?? [], pickUser.timezone);
              for (const parsed of parsedItems) {
                await routeParsedIntent(chatId, telegramId, pickUser.id, originalMessage, parsed, "text", pickUser.timezone);
              }
            }
          }
        }
      } catch (err) {
        console.error("pick_contact error:", err);
        await answerCallbackQuery(query.id, "Something went wrong.");
      }
      return;
    }

    // Timezone selection
    if (data.startsWith("tz:")) {
      const timezone = data.slice(3);
      await updateUserTimezone(telegramId, timezone);
      await answerCallbackQuery(query.id, "Timezone set!");

      if (chatId && messageId) {
        await editMessageText(chatId, messageId, `\u{2705} Timezone: ${timezone}`);
      }
      if (chatId) {
        // Digest runs at 3:30 UTC via pg_cron — compute local time for the user
        const digestUtcHour = 3.5; // 3:30 UTC
        const digestLocalHour = digestUtcHour + (TZ_OFFSETS[timezone] ?? 5.5);
        const digestHr = Math.floor(((digestLocalHour % 24) + 24) % 24);
        const digestMin = Math.round((digestLocalHour % 1) * 60);
        const digestAmPm = digestHr >= 12 ? "PM" : "AM";
        const digestHr12 = digestHr === 0 ? 12 : digestHr > 12 ? digestHr - 12 : digestHr;
        const digestTimeStr = digestMin > 0 ? `${digestHr12}:${String(digestMin).padStart(2, "0")} ${digestAmPm}` : `${digestHr12} ${digestAmPm}`;

        const notifNudgeText =
          `\u{1F514} <b>One quick thing</b> \u{2014} make sure notifications are ON for this chat so you don't miss reminders!\n\n` +
          `\u{1F4F1} <b>iPhone:</b> Tap the bot name at the top \u{2192} Notifications \u{2192} Enable\n` +
          `\u{1F4F1} <b>Android:</b> Tap the bot name at the top \u{2192} Enable Notifications`;

        await sendMessage(chatId, notifNudgeText);

        const onboardingText =
          `Perfect! Every morning at ${digestTimeStr} I'll send you a summary of your day.\n\n` +
          `<b>Try it now</b> \u{2014} type or voice-send something like:\n` +
          `\u{2022} "Remind me to call Mom tomorrow at 5 PM"\n` +
          `\u{2022} "Buy groceries this weekend"\n\n` +
          "Or tap an example below \u{1F447}";

        await sendMessageWithButtons(chatId, onboardingText, [
          [{ text: "\u{1F4DE} Call mom tomorrow 5 PM", callback_data: "example:call_mom" }],
          [{ text: "\u{1F382} Birthday: Aman 15 Aug", callback_data: "example:birthday" }],
          [{ text: "\u{1F6D2} Buy groceries this weekend", callback_data: "example:groceries" }],
        ]);
      }
      return;
    }

    // Example task buttons from onboarding
    if (data.startsWith("example:")) {
      await answerCallbackQuery(query.id);
      const exampleMap: Record<string, string> = {
        "example:call_mom": "Call mom tomorrow 5 PM",
        "example:birthday": "Aman's birthday is 15th August",
        "example:groceries": "Buy groceries this weekend",
      };
      const exampleText = exampleMap[data];
      if (exampleText && chatId) {
        const user = await getUser(telegramId);
        if (user?.consent_given) {
          const parsedItems = await parseMessage(exampleText, [], user.timezone);
          for (const parsed of parsedItems) {
            await routeParsedIntent(chatId, telegramId, user.id, exampleText, parsed, "text", user.timezone);
          }
        }
      }
      return;
    }

    // Quick date buttons for progressive clarification
    if (data.startsWith("quickdate:")) {
      const parts = data.split(":");
      const memoryId = parts[1];
      const option = parts[2];

      if (option === "noreminder") {
        await answerCallbackQuery(query.id, "Got it!");
        if (chatId && messageId) {
          await editMessageText(chatId, messageId, "Saved \u{2705} No reminder set.");
        }
        return;
      }

      const user = await getUser(telegramId);
      const tz = user?.timezone || "Asia/Kolkata";

      let dueDate: Date;
      if (option === "tomorrow9am") {
        // Tomorrow 9 AM in user's timezone
        dueDate = getTomorrowMorning(tz);
      } else if (option === "1hour") {
        dueDate = new Date(Date.now() + 60 * 60 * 1000);
      } else {
        await answerCallbackQuery(query.id);
        return;
      }

      const reminderAt = new Date(dueDate.getTime() - 30 * 60 * 1000).toISOString();
      await updateMemory(memoryId, {
        due_date: dueDate.toISOString(),
        reminder_at: reminderAt,
        is_reminded: false,
        is_pre_reminded: false,
      });

      const formatted = dueDate.toLocaleString("en-IN", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
        timeZone: tz,
      });

      await answerCallbackQuery(query.id, `Set for ${formatted}`);
      if (chatId && messageId) {
        await editMessageText(chatId, messageId, `Set \u{23F0} ${formatted}`);
      }

      // Update session — clear awaiting_date
      await saveSession(telegramId, [memoryId], "date_set");
      return;
    }

    // Pagination for pending list — edit the existing message in place
    if (data.startsWith("page:")) {
      const offset = parseInt(data.slice(5), 10);
      await answerCallbackQuery(query.id);
      const user = await getUser(telegramId);
      const tz = user?.timezone || "Asia/Kolkata";
      const memories = await getPendingMemories(telegramId);
      await saveSession(telegramId, memories.map((m) => m.id), "pending");
      const { text, buttons } = formatPendingList(memories, tz, offset);
      if (chatId && messageId) {
        if (buttons.length > 0) {
          await editMessageWithButtons(chatId, messageId, text, buttons);
        } else {
          await editMessageText(chatId, messageId, text);
        }
      }
      return;
    }

    // Filter pending list by type or overdue
    if (data.startsWith("filter:")) {
      const filterType = data.slice(7);
      await answerCallbackQuery(query.id);
      const user = await getUser(telegramId);
      const tz = user?.timezone || "Asia/Kolkata";

      let memories: DbMemory[];
      let label: string;
      if (filterType === "overdue") {
        memories = await getOverdueMemories(telegramId);
        label = "\u{1F6A8} Overdue";
      } else {
        memories = await getPendingMemories(telegramId, filterType);
        label = filterType.charAt(0).toUpperCase() + filterType.slice(1) + "s";
      }

      await saveSession(telegramId, memories.map((m) => m.id), "pending");
      const { text, buttons } = formatPendingList(memories, tz);
      const headerText = `<b>${label}:</b>\n${text}`;
      const filterRow: TelegramInlineKeyboardButton[] = [
        { text: "\u{1F4CB} Tasks", callback_data: "filter:task" },
        { text: "\u{1F4DD} Notes", callback_data: "filter:note" },
        { text: "\u{1F4C5} Events", callback_data: "filter:event" },
        { text: "\u{1F6A8} Overdue", callback_data: "filter:overdue" },
      ];
      const backRow: TelegramInlineKeyboardButton[] = [
        { text: "\u{25C0}\u{FE0F} All pending", callback_data: "filter:all" },
      ];
      if (chatId && messageId) {
        if (filterType === "all") {
          // Show unfiltered list
          const allMem = await getPendingMemories(telegramId);
          await saveSession(telegramId, allMem.map((m) => m.id), "pending");
          const allResult = formatPendingList(allMem, tz);
          await editMessageWithButtons(chatId, messageId, allResult.text, [...allResult.buttons, filterRow]);
        } else {
          await editMessageWithButtons(chatId, messageId, headerText, [...buttons, backRow]);
        }
      }
      return;
    }

    if (data.startsWith("done:")) {
      const memoryId = data.slice(5);
      const doneMemory = await getMemoryById(memoryId);

      // Check if this is a received (shared) task
      const doneParticipant = await getParticipant(memoryId, telegramId);
      if (doneParticipant && doneParticipant.role === "assignee") {
        // Mark participant as done (not the memory itself)
        await updateParticipant(doneParticipant.id, {
          status: "done",
          completed_at: new Date().toISOString(),
        });
        await answerCallbackQuery(query.id, "Marked as done!");
        if (chatId && messageId) {
          const doneDesc = doneMemory ? escapeHtml(doneMemory.description) : "Task";
          await editMessageText(chatId, messageId, `\u{2705} Done: ${doneDesc}`);
        }
        // Notify creator
        if (doneMemory) {
          try {
            const recipientUser = await getUser(telegramId);
            const recipientName = escapeHtml(recipientUser?.first_name || "Someone");
            await sendMessage(doneMemory.telegram_id,
              `\u{2705} ${recipientName} completed: <b>${escapeHtml(doneMemory.description)}</b>`);
          } catch { /* non-fatal */ }
        }
        return;
      }

      await updateMemory(memoryId, {
        status: "done",
        completed_at: new Date().toISOString(),
      });

      // Update streak
      await updateStreak(telegramId);

      await answerCallbackQuery(query.id, "Marked as done!");
      if (chatId && messageId) {
        const celebrationText = doneMemory
          ? await getCelebrationMessage(telegramId, doneMemory.description)
          : "\u{2705} Task completed!";
        await editMessageWithButtons(chatId, messageId, celebrationText, [
          [{ text: "\u{21A9}\u{FE0F} Undo", callback_data: `undo_done:${memoryId}` }],
        ]);
      }
      return;
    }

    if (data.startsWith("undo_done:")) {
      const memoryId = data.slice(10);
      const memory = await getMemoryById(memoryId);
      if (!memory || memory.status !== "done") {
        await answerCallbackQuery(query.id, "Can't undo \u{2014} task was modified.");
        return;
      }
      // Check 30-second window using completed_at
      const completedAt = memory.completed_at ? new Date(memory.completed_at).getTime() : 0;
      if (Date.now() - completedAt > 30_000) {
        await answerCallbackQuery(query.id, "Undo window expired (30s).");
        return;
      }
      await updateMemory(memoryId, {
        status: "pending",
        completed_at: null,
      });
      await answerCallbackQuery(query.id, "Undone!");
      if (chatId && messageId) {
        await editMessageText(chatId, messageId, `\u{21A9}\u{FE0F} Undone: ${escapeHtml(memory.description)} \u{2014} back to pending.`);
      }
      return;
    }

    if (data.startsWith("snooze:")) {
      const memoryId = data.slice(7);
      await answerCallbackQuery(query.id);

      // Show context-aware snooze options based on current time
      const snzUser = await getUser(telegramId);
      const snzTz = snzUser?.timezone || "Asia/Kolkata";
      const snzOffset = TZ_OFFSETS[snzTz] ?? 5.5;
      const localHour = (new Date().getUTCHours() + snzOffset + 24) % 24;

      let snoozeButtons: TelegramInlineKeyboardButton[][];
      if (localHour >= 6 && localHour < 12) {
        // Morning
        snoozeButtons = [
          [
            { text: "\u{23F1} +1 hour", callback_data: `snz_do:${memoryId}:1h` },
            { text: "\u{2600}\u{FE0F} This afternoon", callback_data: `snz_do:${memoryId}:afternoon` },
          ],
          [
            { text: "\u{1F305} Tomorrow morning", callback_data: `snz_do:${memoryId}:tomorrow` },
          ],
        ];
      } else if (localHour >= 12 && localHour < 18) {
        // Afternoon
        snoozeButtons = [
          [
            { text: "\u{23F1} +1 hour", callback_data: `snz_do:${memoryId}:1h` },
            { text: "\u{1F307} This evening", callback_data: `snz_do:${memoryId}:evening` },
          ],
          [
            { text: "\u{1F305} Tomorrow morning", callback_data: `snz_do:${memoryId}:tomorrow` },
          ],
        ];
      } else {
        // Evening/Night
        snoozeButtons = [
          [
            { text: "\u{23F1} +1 hour", callback_data: `snz_do:${memoryId}:1h` },
            { text: "\u{1F305} Tomorrow morning", callback_data: `snz_do:${memoryId}:tomorrow` },
          ],
          [
            { text: "\u{2600}\u{FE0F} Tomorrow afternoon", callback_data: `snz_do:${memoryId}:tom_afternoon` },
          ],
        ];
      }

      if (chatId && messageId) {
        await editMessageWithButtons(chatId, messageId, "\u{23F0} Snooze until when?", snoozeButtons);
      }
      return;
    }

    if (data.startsWith("snz_do:")) {
      const parts = data.slice(7).split(":");
      const memoryId = parts[0];
      const option = parts[1];

      const snzUser = await getUser(telegramId);
      const snzTz = snzUser?.timezone || "Asia/Kolkata";
      const snzOffset = TZ_OFFSETS[snzTz] ?? 5.5;

      let newReminder: Date;
      let label: string;

      switch (option) {
        case "1h":
          newReminder = new Date(Date.now() + 60 * 60 * 1000);
          label = "in 1 hour";
          break;
        case "afternoon":
          newReminder = new Date();
          newReminder.setUTCHours(Math.floor(14 - snzOffset), Math.round(((14 - snzOffset) % 1) * 60), 0, 0);
          if (newReminder <= new Date()) newReminder = new Date(Date.now() + 60 * 60 * 1000);
          label = "this afternoon";
          break;
        case "evening":
          newReminder = new Date();
          newReminder.setUTCHours(Math.floor(18 - snzOffset), Math.round(((18 - snzOffset) % 1) * 60), 0, 0);
          if (newReminder <= new Date()) newReminder = new Date(Date.now() + 60 * 60 * 1000);
          label = "this evening";
          break;
        case "tomorrow":
          newReminder = getTomorrowMorning(snzTz);
          label = "tomorrow morning";
          break;
        case "tom_afternoon": {
          const tmrw = new Date();
          tmrw.setUTCDate(tmrw.getUTCDate() + 1);
          const utcHour = 14 - snzOffset;
          tmrw.setUTCHours(Math.floor(utcHour), Math.round((utcHour % 1) * 60), 0, 0);
          newReminder = tmrw;
          label = "tomorrow afternoon";
          break;
        }
        default:
          newReminder = new Date(Date.now() + 60 * 60 * 1000);
          label = "in 1 hour";
      }

      // Increment snooze count
      const snzMemory = await getMemoryById(memoryId);
      const snoozeCount = snzMemory?.snooze_count ?? 0;

      await updateMemory(memoryId, {
        reminder_at: newReminder.toISOString(),
        is_reminded: false,
        is_pre_reminded: false,
        snooze_count: snoozeCount + 1,
      });

      await answerCallbackQuery(query.id, `Snoozed ${label}!`);

      let responseText = `\u{23F0} Snoozed ${label}!`;
      if (snoozeCount + 1 >= 3 && snzMemory) {
        responseText = `\u{26A0}\u{FE0F} Snoozed ${snoozeCount + 1} times: ${escapeHtml(snzMemory.description)}\n\nKeep rescheduling, or time to drop it?`;
      }

      if (chatId && messageId) {
        if (snoozeCount + 1 >= 3 && snzMemory) {
          await editMessageWithButtons(chatId, messageId, responseText, [
            [
              { text: "\u{1F4C5} Reschedule", callback_data: `snooze:${memoryId}` },
              { text: "\u{1F5D1} Drop it", callback_data: `delete:${memoryId}` },
            ],
            [
              { text: "\u{2705} Done actually", callback_data: `done:${memoryId}` },
            ],
          ]);
        } else {
          await editMessageText(chatId, messageId, responseText);
        }
      }
      return;
    }

    // "Wrong?" correction flow
    if (data.startsWith("wrong:")) {
      const memoryId = data.slice(6);
      await answerCallbackQuery(query.id);
      if (chatId && messageId) {
        await editMessageWithButtons(chatId, messageId, "What did I get wrong?", [
          [
            { text: "\u{1F3F7} Type", callback_data: `fix_type:${memoryId}` },
            { text: "\u{1F4C5} Date", callback_data: `fix_date:${memoryId}` },
          ],
          [
            { text: "\u{270F}\u{FE0F} Description", callback_data: `fix_desc:${memoryId}` },
            { text: "\u{1F5D1} Delete it", callback_data: `delete:${memoryId}` },
          ],
        ]);
      }
      return;
    }

    if (data.startsWith("fix_type:")) {
      const memoryId = data.slice(9);
      await answerCallbackQuery(query.id);
      if (chatId && messageId) {
        await editMessageWithButtons(chatId, messageId, "What type should it be?", [
          [
            { text: "\u{1F4CB} Task", callback_data: `set_type:${memoryId}:task` },
            { text: "\u{23F0} Reminder", callback_data: `set_type:${memoryId}:reminder` },
            { text: "\u{1F4C5} Event", callback_data: `set_type:${memoryId}:event` },
          ],
          [
            { text: "\u{1F382} Birthday", callback_data: `set_type:${memoryId}:birthday` },
            { text: "\u{1F4DD} Note", callback_data: `set_type:${memoryId}:note` },
          ],
        ]);
      }
      return;
    }

    if (data.startsWith("set_type:")) {
      const parts = data.slice(9).split(":");
      const memoryId = parts[0];
      const newType = parts[1];
      await updateMemory(memoryId, { type: newType });
      await answerCallbackQuery(query.id, `Changed to ${newType}!`);
      if (chatId && messageId) {
        await editMessageText(chatId, messageId, `\u{2705} Updated type to <b>${newType}</b>.`);
      }
      return;
    }

    if (data.startsWith("fix_date:")) {
      const memoryId = data.slice(9);
      await answerCallbackQuery(query.id);
      // Set session to awaiting_date so next message is interpreted as a date
      await saveSession(telegramId, [memoryId], "awaiting_date");
      if (chatId && messageId) {
        await editMessageText(chatId, messageId, "When should it be? Type the date/time (e.g. \"tomorrow 5pm\", \"Friday\").");
      }
      return;
    }

    if (data.startsWith("fix_desc:")) {
      const memoryId = data.slice(9);
      await answerCallbackQuery(query.id);
      // Set session to awaiting edit
      await saveSession(telegramId, [memoryId], "awaiting_description");
      if (chatId && messageId) {
        await editMessageText(chatId, messageId, "Type the correct description:");
      }
      return;
    }

    if (data.startsWith("delete:")) {
      const memoryId = data.slice(7);

      // Check if this is a received task — dismiss participant, don't delete memory
      const delParticipant = await getParticipant(memoryId, telegramId);
      if (delParticipant && delParticipant.role === "assignee") {
        await updateParticipant(delParticipant.id, { status: "declined" });
        await answerCallbackQuery(query.id, "Dismissed!");
        if (chatId && messageId) {
          await editMessageText(chatId, messageId, "\u{1F5D1} Dismissed.");
        }
        return;
      }

      await deleteMemory(memoryId);
      await answerCallbackQuery(query.id, "Deleted!");
      if (chatId && messageId) {
        await editMessageText(chatId, messageId, "\u{1F5D1} Deleted.");
      }
      return;
    }

    // "delete everything" safety confirmation — deletes all memories but keeps account
    if (data === "confirm_delete_all") {
      await deleteAllMemories(telegramId);
      await answerCallbackQuery(query.id, "All tasks deleted.");
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          "\u{1F5D1} All your tasks and memories have been deleted. You can start fresh!",
        );
      }
      return;
    }

    // /delete command confirmation — full account deletion
    if (data === "confirm_account_delete") {
      await deleteUserData(telegramId);
      await answerCallbackQuery(query.id, "Account deleted.");
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          "All your data has been permanently deleted. Send /start if you ever want to use RemindKar again.",
        );
      }
      return;
    }

    if (data === "cancel_delete_all" || data === "cancel_delete") {
      await answerCallbackQuery(query.id, "Cancelled.");
      if (chatId && messageId) {
        await editMessageText(chatId, messageId, "Cancelled \u{2014} nothing was deleted.");
      }
      return;
    }

    // Feedback category selection
    if (data === "feedback_bug" || data === "feedback_feature" || data === "feedback_general") {
      const category = data.replace("feedback_", "");
      const categoryLabel = category === "bug" ? "\u{1F41B} Bug" : category === "feature" ? "\u{1F4A1} Feature" : "\u{1F4AC} General";
      await answerCallbackQuery(query.id, `${categoryLabel} selected`);
      if (chatId && messageId) {
        await editMessageText(chatId, messageId, `${categoryLabel} feedback \u{2014} go ahead, type your feedback:`);
      }
      // Store category in intent string (last_shown_ids is uuid[] so can't store text)
      await saveSession(telegramId, [], `awaiting_feedback:${category}`);

      // Log the callback
      const fbUser = await getUser(telegramId);
      await logInteraction({
        telegram_id: telegramId,
        user_message: null,
        message_type: "callback",
        primary_intent: `feedback_${category}`,
        bot_action: "feedback_category_selected",
        processing_time_ms: 0,
        user_timezone: fbUser?.timezone ?? "Asia/Kolkata",
      });
      return;
    }

    if (data.startsWith("rsc:")) {
      // rsc:memoryId:YYYY-MM-DD
      const parts = data.slice(4).split(":");
      const memoryId = parts[0];
      const dateOnly = parts[1];
      const [year, month, day] = dateOnly.split("-").map(Number);
      const rscUser = await getUser(telegramId);
      const rscTz = rscUser?.timezone || "Asia/Kolkata";
      const newDue = localHourToUtcDate(year, month, day, 24, rscTz).toISOString();
      const newReminder = localHourToUtcDate(year, month, day, 9, rscTz).toISOString();
      await updateMemory(memoryId, {
        due_date: newDue,
        reminder_at: newReminder,
        is_reminded: false,
        is_pre_reminded: false,
      });
      await answerCallbackQuery(query.id, "Rescheduled!");
      if (chatId && messageId) {
        const formatted = new Date(newDue).toLocaleString("en-IN", {
          weekday: "short",
          day: "numeric",
          month: "short",
          timeZone: rscTz,
        });
        await editMessageText(chatId, messageId, `\u{1F4C5} Rescheduled to ${formatted}`);
      }
      return;
    }

    if (data.startsWith("date:")) {
      const parts = data.split(":");
      const memoryId = parts[1];
      const isoDate = parts.slice(2).join(":");
      const dueDate = new Date(isoDate);
      const reminderAt = new Date(dueDate.getTime() - 30 * 60 * 1000).toISOString();
      await updateMemory(memoryId, {
        due_date: isoDate,
        reminder_at: reminderAt,
      });
      const dateUser = await getUser(telegramId);
      const dateTz = dateUser?.timezone || "Asia/Kolkata";
      await answerCallbackQuery(query.id, "Date confirmed!");
      if (chatId && messageId) {
        const formatted = new Date(isoDate).toLocaleString("en-IN", {
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
          timeZone: dateTz,
        });
        await editMessageText(chatId, messageId, `\u{1F4C5} Date set: ${formatted}`);
      }
      return;
    }
  } catch (error) {
    console.error("Callback query error:", error);
    await answerCallbackQuery(query.id, "Something went wrong.");
  }
}

// ============================================================
// Contact share handler
// ============================================================

async function handleContactShare(message: TelegramMessage, startMs = Date.now()): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;
  const contact = message.contact!;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first and give consent before I can save your memories.");
    return;
  }

  const session = await getSession(telegramId);
  const sessionId = session?.session_id ?? crypto.randomUUID();

  try {
    const contactPhone = contact.phone_number;
    const contactTelegramId = contact.user_id ?? null;
    const contactFirstName = contact.first_name;
    const contactLastName = contact.last_name ?? "";
    const contactFullName = contactLastName ? `${contactFirstName} ${contactLastName}` : contactFirstName;

    // Check if contact already exists (by phone) in sender's contacts
    const existingContacts = await getContactsByOwner(telegramId);
    let dbContact: DbContact | null = existingContacts.find((c) => c.contact_phone === contactPhone) ?? null;

    if (dbContact) {
      // Update telegram_id if missing
      if (!dbContact.contact_telegram_id && contactTelegramId) {
        await updateContact(dbContact.id, { contact_telegram_id: contactTelegramId });
        dbContact = { ...dbContact, contact_telegram_id: contactTelegramId };
      }
    } else {
      // Create new contact
      dbContact = await createContact({
        owner_telegram_id: telegramId,
        contact_telegram_id: contactTelegramId,
        contact_phone: contactPhone,
        nickname: contactFirstName.toLowerCase(),
        first_name: contactFullName,
        status: "pending",
      });
    }

    // Check if shared contact is on RemindKar
    const contactUser = contactTelegramId ? await getUser(contactTelegramId) : null;
    const senderName = escapeHtml(user.first_name || "Someone");

    if (contactUser && dbContact.status === "pending") {
      // Contact is on RemindKar — send consent request to contact
      await sendMessageWithButtons(contactTelegramId!, `${senderName} wants to send you tasks and reminders. Allow?`, [
        [
          { text: "\u{2705} Allow", callback_data: `consent_allow:${dbContact.id}` },
          { text: "\u{274C} Decline", callback_data: `consent_decline:${dbContact.id}` },
        ],
      ]);
      await sendMessage(chatId, `\u{1F4E8} I've asked <b>${escapeHtml(contactFullName)}</b> for permission. I'll let you know when they respond.`);
    } else if (contactTelegramId && !contactUser) {
      // Contact has telegram_id but is NOT on RemindKar — send invite
      const inviteUrl = `https://t.me/${BOT_HANDLE}?start=invite_${dbContact.id}`;
      await sendMessageWithButtons(chatId,
        `<b>${escapeHtml(contactFullName)}</b> isn't on RemindKar yet. Send them an invite?`, [
        [{ text: "\u{2728} Send invite", url: inviteUrl }],
      ]);
    } else if (!contactTelegramId) {
      // No telegram_id — can't reach them
      await sendMessage(chatId, `I can only reach Telegram users for now. <b>${escapeHtml(contactFullName)}</b> doesn't have a Telegram account linked to this contact.`);
    } else if (dbContact.status === "approved") {
      await sendMessage(chatId, `\u{2705} <b>${escapeHtml(contactFullName)}</b> is already connected! You can assign tasks to them by name.`);
    } else if (dbContact.status === "declined" || dbContact.status === "blocked") {
      await sendMessage(chatId, `<b>${escapeHtml(contactFullName)}</b> is not accepting tasks right now.`);
    }

    // If session had awaiting_contact:<memoryId>:<names>, link this contact as participant
    if (session?.last_intent?.startsWith("awaiting_contact:")) {
      const parts = session.last_intent.slice("awaiting_contact:".length).split(":");
      const memoryId = parts[0];
      const remainingNames = parts[1] ? parts[1].split(",") : [];

      if (memoryId && dbContact) {
        const participantStatus = dbContact.status === "approved" ? "active"
          : (dbContact.contact_telegram_id ? "pending_consent" : "pending_invite");

        try {
          await createParticipant({
            memory_id: memoryId,
            participant_telegram_id: dbContact.contact_telegram_id || 0,
            role: "assignee",
            status: participantStatus,
          });

          // Notify active recipients immediately
          if (participantStatus === "active" && dbContact.contact_telegram_id) {
            const memory = await getMemoryById(memoryId);
            if (memory) {
              sendMessage(
                dbContact.contact_telegram_id,
                `\u{1F4E5} ${senderName} assigned you: <b>${escapeHtml(memory.description)}</b>`,
              ).catch(() => {});
            }
          }
        } catch (err) {
          console.error("Participant creation from contact share failed (non-fatal):", err);
        }

        // Check if more unknown names remain
        const matchedName = remainingNames.find(
          (n) => n.toLowerCase() === contactFirstName.toLowerCase() || contactFullName.toLowerCase().includes(n.toLowerCase()),
        );
        const stillUnknown = remainingNames.filter((n) => n !== matchedName);

        if (stillUnknown.length > 0) {
          // More contacts to link — keep prompting
          const unknownNames = stillUnknown.join(",");
          await saveSession(telegramId, session.last_shown_ids ?? [], `awaiting_contact:${memoryId}:${unknownNames}`);
          const namesList = stillUnknown.map((n) => `<b>${escapeHtml(n)}</b>`).join(", ");
          await sendMessage(chatId, `Now share a contact for ${namesList}.`);
        } else {
          // All contacts linked — clear the awaiting state
          await saveSession(telegramId, session.last_shown_ids ?? [], "created");
        }
      }
    }

    await logInteraction({
      telegram_id: telegramId,
      user_message: `[contact_share] ${contactFullName}`,
      message_type: "contact",
      primary_intent: "contact_share",
      bot_action: `contact_${dbContact.status === "pending" ? "consent_requested" : dbContact.status}`,
      session_id: sessionId,
      processing_time_ms: Date.now() - startMs,
      user_timezone: user.timezone,
    });
  } catch (error) {
    console.error("Contact share error:", error);
    await sendMessage(chatId, "Something went wrong processing that contact. Please try again.");
    await logInteraction({
      telegram_id: telegramId,
      user_message: `[contact_share]`,
      message_type: "contact",
      error: String(error),
      session_id: sessionId,
      processing_time_ms: Date.now() - startMs,
      user_timezone: user?.timezone ?? "Asia/Kolkata",
    });
  }
}

// ============================================================
// Text message handler
// ============================================================

async function handleText(message: TelegramMessage, startMs = Date.now()): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;
  const text = message.text!;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first and give consent before I can save your memories.");
    return;
  }

  // Get conversation history for context
  const session = await getSession(telegramId);
  const sessionId = session?.session_id ?? crypto.randomUUID();
  const history = session?.conversation_history ?? [];

  try {
    // Progressive clarification: if awaiting a date, try to apply it
    if (session?.last_intent === "awaiting_date" && session.last_shown_ids.length > 0) {
      const memoryId = session.last_shown_ids[0];
      const dateResult = await tryApplyDate(chatId, telegramId, memoryId, text, history, user.timezone);
      if (dateResult) {
        const newHistory = appendHistory(history, text, dateResult);
        await saveSession(telegramId, [memoryId], "date_set", newHistory, sessionId);
        await logInteraction({
          telegram_id: telegramId,
          user_message: text,
          message_type: "text",
          primary_intent: "date_followup",
          bot_action: dateResult,
          bot_response: dateResult,
          session_id: sessionId,
          processing_time_ms: Date.now() - startMs,
          user_timezone: user.timezone,
        });
        return;
      }
      // Not a date response — fall through to normal processing
    }

    // Feedback awaiting: save the text as feedback
    if (session?.last_intent?.startsWith("awaiting_feedback:")) {
      const category = session.last_intent.split(":")[1]; // bug, feature, or general
      try {
        await createFeedback({
          telegram_id: telegramId,
          username: message.from?.username ?? null,
          first_name: message.from?.first_name ?? null,
          category,
          feedback_text: text,
        });
        const response = "Thanks for your feedback! \u{1F64F} We'll use it to make RemindKar better.";
        await sendMessage(chatId, response);
        const newHistory = appendHistory(history, text, "feedback_saved");
        await saveSession(telegramId, [], "feedback_saved", newHistory, sessionId);
        await logInteraction({
          telegram_id: telegramId,
          user_message: text,
          message_type: "text",
          primary_intent: "feedback",
          bot_action: `feedback_saved:${category}`,
          bot_response: response,
          session_id: sessionId,
          processing_time_ms: Date.now() - startMs,
          user_timezone: user.timezone,
        });
        return;
      } catch (error) {
        console.error("Feedback save error:", error);
        await sendMessage(chatId, "Something went wrong saving your feedback. Please try again.");
        return;
      }
    }

    // Description correction: if awaiting_description, update the memory's description
    if (session?.last_intent === "awaiting_description" && session.last_shown_ids.length > 0) {
      const memoryId = session.last_shown_ids[0];
      try {
        await updateMemory(memoryId, { description: text });
        try {
          const newEmbed = await generateEmbedding(text);
          await updateMemory(memoryId, { description_embedding: `[${newEmbed.join(",")}]` });
        } catch { /* non-fatal */ }
        const response = `\u{2705} Updated description to: <b>${escapeHtml(text)}</b>`;
        await sendMessage(chatId, response);
        const newHistory = appendHistory(history, text, "description_updated");
        await saveSession(telegramId, [memoryId], "edited", newHistory, sessionId);
        await logInteraction({
          telegram_id: telegramId,
          user_message: text,
          message_type: "text",
          primary_intent: "fix_description",
          bot_action: "description_updated",
          bot_response: response,
          session_id: sessionId,
          processing_time_ms: Date.now() - startMs,
          user_timezone: user.timezone,
        });
        return;
      } catch (error) {
        console.error("Description update error:", error);
        await sendMessage(chatId, "Something went wrong. Please try again.");
        return;
      }
    }

    const parsedItems = await parseMessage(text, history, user.timezone);
    const botSummaries: string[] = [];
    const botResponses: string[] = [];

    for (const parsed of parsedItems) {
      const { summary, response } = await routeParsedIntent(chatId, telegramId, user.id, text, parsed, "text", user.timezone);
      botSummaries.push(summary);
      botResponses.push(response);
    }

    // Update conversation history
    const newHistory = appendHistory(history, text, botSummaries.join("; "));
    const lastParsed = parsedItems[parsedItems.length - 1];
    const lastIntent = lastParsed?.intent === "task" || lastParsed?.intent === "reminder" || lastParsed?.intent === "event"
      ? (lastParsed.due_date ? "created" : "awaiting_date")
      : (lastParsed?.intent ?? "text");

    // Get current session IDs (may have been updated by routeParsedIntent)
    const currentSession = await getSession(telegramId);

    // Preserve awaiting_contact/awaiting_contact_pick intents set by routeParsedIntent —
    // these must not be overwritten or the contact-linking flow breaks
    const currentIntent = currentSession?.last_intent ?? "";
    const preserveIntent = currentIntent.startsWith("awaiting_contact:") || currentIntent.startsWith("awaiting_contact_pick:");
    await saveSession(
      telegramId,
      currentSession?.last_shown_ids ?? [],
      preserveIntent ? currentIntent : lastIntent,
      newHistory,
      sessionId,
    );

    await logInteraction({
      telegram_id: telegramId,
      user_message: text,
      message_type: "text",
      parsed_intents: parsedItems,
      primary_intent: lastParsed?.intent ?? null,
      bot_action: botSummaries.join("; "),
      bot_response: botResponses.join("\n---\n"),
      session_id: sessionId,
      processing_time_ms: Date.now() - startMs,
      user_timezone: user.timezone,
    });
  } catch (error) {
    console.error("Text handler error:", error);
    await sendMessage(chatId, "I couldn't process that, please try again in a moment.");
    await logInteraction({
      telegram_id: telegramId,
      user_message: text,
      message_type: "text",
      error: String(error),
      session_id: sessionId,
      processing_time_ms: Date.now() - startMs,
      user_timezone: user?.timezone ?? "Asia/Kolkata",
    });
  }
}

// Try to parse a message as a date follow-up for an awaiting task.
// Returns bot summary string if successful, null if not a date response.
async function tryApplyDate(
  chatId: number,
  telegramId: number,
  memoryId: string,
  text: string,
  history: ConversationMessage[],
  timezone = "Asia/Kolkata",
): Promise<string | null> {
  try {
    const parsedItems = await parseMessage(text, history, timezone);
    if (parsedItems.length !== 1) return null;

    const p = parsedItems[0];

    // Check if Gemini interpreted this as editing a date
    if (p.intent === "edit" && p.edit_field === "due_date" && p.edit_value) {
      const dueDate = p.edit_value;
      const reminderAt = new Date(new Date(dueDate).getTime() - 30 * 60 * 1000).toISOString();
      await updateMemory(memoryId, {
        due_date: dueDate,
        reminder_at: reminderAt,
        is_reminded: false,
        is_pre_reminded: false,
      });
      const formatted = new Date(dueDate).toLocaleString("en-IN", {
        weekday: "short", day: "numeric", month: "short",
        hour: "2-digit", minute: "2-digit", hour12: true, timeZone: timezone,
      });
      await sendMessage(chatId, `Set \u{23F0} ${formatted}`);
      return `Set reminder for ${formatted}`;
    }

    // Check if it's a task/reminder with a due_date (Gemini might reinterpret the date as a new task).
    // Only apply if the message is short (≤5 words) — likely just a date/time, not a full new task.
    // Longer messages like "Remind me to take medicine at 8 AM" should create a new item instead.
    if ((p.intent === "task" || p.intent === "reminder") && p.due_date && text.trim().split(/\s+/).length <= 5) {
      const reminderAt = p.reminder_at || new Date(new Date(p.due_date).getTime() - 30 * 60 * 1000).toISOString();
      await updateMemory(memoryId, {
        due_date: p.due_date,
        reminder_at: reminderAt,
        is_reminded: false,
        is_pre_reminded: false,
      });
      const formatted = new Date(p.due_date).toLocaleString("en-IN", {
        weekday: "short", day: "numeric", month: "short",
        hour: "2-digit", minute: "2-digit", hour12: true, timeZone: timezone,
      });
      await sendMessage(chatId, `Set \u{23F0} ${formatted}`);
      return `Set reminder for ${formatted}`;
    }

    // Not a date response
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// Voice message handler
// ============================================================

async function handleVoice(message: TelegramMessage, startMs = Date.now()): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first and give consent before I can save your memories.");
    return;
  }

  const session = await getSession(telegramId);
  const sessionId = session?.session_id ?? crypto.randomUUID();
  const history = session?.conversation_history ?? [];

  // Guard: very short or very long voice notes
  const duration = message.voice!.duration;
  if (duration < 1) {
    await sendMessage(chatId, "That was too short \u{2014} try a longer voice note?");
    return;
  }
  if (duration > 120) {
    await sendMessage(chatId, "\u{26A0}\u{FE0F} That's a long voice note! I'll do my best, but shorter messages work better for accuracy.");
  }

  try {
    const audioBytes = await downloadTelegramFile(message.voice!.file_id);
    if (!audioBytes) {
      await sendMessage(chatId, "I couldn't download your voice note, please try again.");
      return;
    }

    let transcription: string;
    try {
      transcription = await transcribeAudio(audioBytes);
    } catch {
      await sendMessage(chatId, "I couldn't process your voice note \u{2014} could you type it instead?");
      return;
    }

    const parsedItems = await parseMessage(transcription, history, user.timezone);
    await sendMessage(chatId, `\u{1F399} "${escapeHtml(transcription)}"`);

    const botSummaries: string[] = [];
    const botResponses: string[] = [];
    for (const parsed of parsedItems) {
      const { summary, response } = await routeParsedIntent(chatId, telegramId, user.id, transcription, parsed, "voice", user.timezone);
      botSummaries.push(summary);
      botResponses.push(response);
    }

    const newHistory = appendHistory(history, transcription, botSummaries.join("; "));
    const lastParsed = parsedItems[parsedItems.length - 1];
    const lastIntent = lastParsed?.intent === "task" || lastParsed?.intent === "reminder" || lastParsed?.intent === "event"
      ? (lastParsed.due_date ? "created" : "awaiting_date")
      : (lastParsed?.intent ?? "voice");

    const currentSession = await getSession(telegramId);
    await saveSession(
      telegramId,
      currentSession?.last_shown_ids ?? [],
      lastIntent,
      newHistory,
      sessionId,
    );

    await logInteraction({
      telegram_id: telegramId,
      user_message: `[voice] ${transcription}`,
      message_type: "voice",
      parsed_intents: parsedItems,
      primary_intent: lastParsed?.intent ?? null,
      bot_action: botSummaries.join("; "),
      bot_response: botResponses.join("\n---\n"),
      session_id: sessionId,
      processing_time_ms: Date.now() - startMs,
      user_timezone: user.timezone,
    });
  } catch (error) {
    console.error("Voice handler error:", error);
    await sendMessage(chatId, "Something went wrong while saving. Please try again.");
    await logInteraction({
      telegram_id: telegramId,
      user_message: null,
      message_type: "voice",
      error: String(error),
      session_id: sessionId,
      processing_time_ms: Date.now() - startMs,
      user_timezone: user?.timezone ?? "Asia/Kolkata",
    });
  }
}

// ============================================================
// Forward handler
// ============================================================

async function handleForward(message: TelegramMessage, startMs = Date.now()): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first and give consent before I can save your memories.");
    return;
  }

  const text = message.text;
  if (!text) {
    await sendMessage(chatId, "I can only process forwarded text messages for now.");
    return;
  }

  try {
    const session = await getSession(telegramId);
    const sessionId = session?.session_id ?? crypto.randomUUID();
    const history = session?.conversation_history ?? [];
    const parsedItems = await parseMessage(text, history, user.timezone);
    const botSummaries: string[] = [];
    const botResponses: string[] = [];
    for (const parsed of parsedItems) {
      const { summary, response } = await routeParsedIntent(chatId, telegramId, user.id, text, parsed, "forwarded", user.timezone);
      botSummaries.push(summary);
      botResponses.push(response);
    }

    const newHistory = appendHistory(history, `[forwarded] ${text}`, botSummaries.join("; "));
    const currentSession = await getSession(telegramId);
    await saveSession(
      telegramId,
      currentSession?.last_shown_ids ?? [],
      parsedItems[parsedItems.length - 1]?.intent ?? "forwarded",
      newHistory,
      sessionId,
    );

    await logInteraction({
      telegram_id: telegramId,
      user_message: `[forwarded] ${text}`,
      message_type: "forward",
      parsed_intents: parsedItems,
      primary_intent: parsedItems[parsedItems.length - 1]?.intent ?? null,
      bot_action: botSummaries.join("; "),
      bot_response: botResponses.join("\n---\n"),
      session_id: sessionId,
      processing_time_ms: Date.now() - startMs,
      user_timezone: user.timezone,
    });
  } catch (error) {
    console.error("Forward handler error:", error);
    await sendMessage(chatId, "I couldn't process that forwarded message, please try again.");
    await logInteraction({
      telegram_id: telegramId,
      user_message: `[forwarded] ${text}`,
      message_type: "forward",
      error: String(error),
      processing_time_ms: Date.now() - startMs,
      user_timezone: user?.timezone ?? "Asia/Kolkata",
    });
  }
}

// ============================================================
// Resolve target people names to contacts
// ============================================================

async function resolveTargetPeople(
  ownerTelegramId: number,
  targetPeople: string[],
  ownerFirstName: string | null,
): Promise<{
  resolved: DbContact[];
  ambiguous: { name: string; matches: DbContact[] }[];
  unknown: string[];
}> {
  const resolved: DbContact[] = [];
  const ambiguous: { name: string; matches: DbContact[] }[] = [];
  const unknown: string[] = [];

  for (const name of targetPeople) {
    // Skip self-assignment
    if (ownerFirstName && name.toLowerCase() === ownerFirstName.toLowerCase()) {
      continue;
    }

    const matches = await getContactByNickname(ownerTelegramId, name);
    // Filter out blocked/declined
    const activeMatches = matches.filter((c) => c.status !== "blocked" && c.status !== "declined");

    if (activeMatches.length === 1) {
      resolved.push(activeMatches[0]);
    } else if (activeMatches.length > 1) {
      ambiguous.push({ name, matches: activeMatches });
    } else {
      // Check if any were blocked/declined
      const blockedOrDeclined = matches.filter((c) => c.status === "blocked" || c.status === "declined");
      if (blockedOrDeclined.length > 0) {
        unknown.push(`${name} (not accepting)`);
      } else {
        unknown.push(name);
      }
    }
  }

  return { resolved, ambiguous, unknown };
}

// ============================================================
// Shared: route parsed intent to storage or query
// Returns a brief summary of what was done (for conversation history)
// ============================================================

async function routeParsedIntent(
  chatId: number,
  telegramId: number,
  userId: string,
  rawInput: string,
  parsed: GeminiParsedResponse,
  source: string,
  userTimezone = "Asia/Kolkata",
): Promise<{ summary: string; response: string }> {
  switch (parsed.intent) {
    case "greeting": {
      const responseText = "Hey! Send me a task, reminder, or question \u{2014} I'm ready to help.";
      await sendMessage(chatId, responseText);
      return { summary: "Greeted user", response: responseText };
    }

    case "casual": {
      // Casual/social messages — respond warmly, mention pending if relevant
      const pending = await getPendingMemories(telegramId);
      let responseText: string;
      if (pending.length > 0) {
        const tzOffsetMs = (TZ_OFFSETS[userTimezone] ?? 5.5) * 60 * 60 * 1000;
        const nowUtc = new Date();
        const nowLocal = new Date(nowUtc.getTime() + tzOffsetMs);
        const todayStartLocal = new Date(nowLocal);
        todayStartLocal.setUTCHours(0, 0, 0, 0);
        const tomorrowStartUtc = new Date(todayStartLocal.getTime() - tzOffsetMs + 24 * 60 * 60 * 1000);

        const dueToday = pending.filter((m) => {
          if (!m.due_date) return false;
          const due = new Date(m.due_date);
          return due >= nowUtc && due < tomorrowStartUtc;
        });
        if (dueToday.length > 0) {
          responseText = `\u{1F44B} You have ${dueToday.length} thing${dueToday.length > 1 ? "s" : ""} due today \u{2014} I'll remind you when it's time!`;
        } else {
          responseText = `\u{1F44B} You have ${pending.length} pending item${pending.length > 1 ? "s" : ""} \u{2014} I'll send your digest in the morning.`;
        }
      } else {
        responseText = "\u{1F44B} All clear! Text me when you need to remember something.";
      }
      await sendMessage(chatId, responseText);
      return { summary: "Casual response", response: responseText };
    }

    case "query": {
      const responseText = await handleQuery(chatId, telegramId, parsed.query_text || rawInput, rawInput, userTimezone, parsed.query_date_start ?? null, parsed.query_date_end ?? null);
      return { summary: `Query: ${parsed.query_text || rawInput}`, response: responseText };
    }

    case "done": {
      const responseText = await handleDoneIntent(chatId, telegramId, parsed.description, parsed.target_index ?? null);
      return { summary: `Done: ${parsed.description}`, response: responseText };
    }

    case "reschedule": {
      const responseText = await handleRescheduleIntent(chatId, telegramId, parsed.description, parsed.reschedule_to ?? null, parsed.target_index ?? null);
      return { summary: `Reschedule: ${parsed.description}`, response: responseText };
    }

    case "delete": {
      // Safety gate: detect "delete everything/all" type requests
      if (isDeleteAllRequest(parsed.description)) {
        const safetyText = "\u{26A0}\u{FE0F} <b>Delete ALL your data?</b> This is permanent and cannot be undone.";
        await sendMessageWithButtons(chatId, safetyText, [[
          { text: "\u{1F5D1} Yes, delete everything", callback_data: "confirm_delete_all" },
          { text: "\u{274C} Cancel", callback_data: "cancel_delete_all" },
        ]]);
        return { summary: "Delete all safety gate", response: safetyText };
      }
      const responseText = await handleDeleteIntent(chatId, telegramId, parsed.description, parsed.target_index ?? null);
      return { summary: `Delete: ${parsed.description}`, response: responseText };
    }

    case "edit": {
      const responseText = await handleEditIntent(chatId, telegramId, parsed.description, parsed.edit_field ?? null, parsed.edit_value ?? null, parsed.target_index ?? null);
      return { summary: `Edit: ${parsed.description}`, response: responseText };
    }

    case "status": {
      const responseText = await handleStatusIntent(chatId, telegramId);
      return { summary: "Status shown", response: responseText };
    }

    case "unknown": {
      const responseText = "I'm not sure what to do with that. Try sending a task, reminder, or ask me about your saved items.\n\nExamples: \"Call mom tomorrow 5 PM\" or \"What do I have pending?\"";
      await sendMessage(chatId, responseText);
      return { summary: "Unknown intent", response: responseText };
    }

    default: {
      // Storage intents: task, reminder, event, birthday, note
      let embedding: number[] | null = null;
      try {
        embedding = await generateEmbedding(parsed.description);
      } catch (err) {
        console.error("Embedding generation failed (non-fatal):", err);
      }

      // Shared task path: delegate to target people
      if (parsed.target_people && parsed.target_people.length > 0) {
        const ownerUser = await getUser(telegramId);
        const ownerFirstName = ownerUser?.first_name ?? null;
        const { resolved, ambiguous, unknown } = await resolveTargetPeople(telegramId, parsed.target_people, ownerFirstName);

        // Handle ambiguous (multiple matches for same name) — show picker
        // Ambiguous blocks task creation because we don't know which contact to use
        if (ambiguous.length > 0) {
          const first = ambiguous[0];
          const pickerButtons = first.matches.map((c) => [
            { text: `${escapeHtml(c.first_name || c.nickname)} (${c.contact_phone})`, callback_data: `pick_contact:${c.id}` },
          ]);
          const pickerText = `Multiple contacts match "${escapeHtml(first.name)}". Which one?`;
          await sendMessageWithButtons(chatId, pickerText, pickerButtons);
          await saveSession(telegramId, [], `awaiting_contact_pick:${rawInput}`);
          return { summary: `Ambiguous contact: ${first.name}`, response: pickerText };
        }

        // If ALL contacts are blocked/declined and none resolved, abort
        const notAccepting = unknown.filter((n) => n.endsWith("(not accepting)"));
        const trueUnknown = unknown.filter((n) => !n.endsWith("(not accepting)"));
        if (notAccepting.length > 0 && trueUnknown.length === 0 && resolved.length === 0) {
          const names = notAccepting.map((n) => n.replace(" (not accepting)", "")).join(", ");
          const responseText = `<b>${escapeHtml(names)}</b> is not accepting tasks right now.`;
          await sendMessage(chatId, responseText);
          return { summary: `Contact declined: ${names}`, response: responseText };
        }

        // Always create the memory — even if some contacts are unknown.
        // The creator's task should never be lost.
        const memory = await createMemory({
          user_id: userId,
          telegram_id: telegramId,
          type: parsed.intent,
          description: parsed.description,
          raw_input: rawInput,
          due_date: parsed.due_date,
          reminder_at: parsed.reminder_at,
          entities: parsed.entities,
          recurrence: parsed.recurrence,
          source,
          is_shared: true,
          description_embedding: embedding,
        });

        // Add creator as participant if include_creator
        if (parsed.include_creator) {
          try {
            await createParticipant({
              memory_id: memory.id,
              participant_telegram_id: telegramId,
              role: "creator",
              status: "active",
            });
          } catch (err) {
            console.error("Creator participant creation failed (non-fatal):", err);
          }
        }

        // Create participants for each resolved contact
        const assignedNames: string[] = [];
        const senderName = escapeHtml(ownerFirstName || "Someone");
        for (const contact of resolved) {
          let participantStatus: string;
          if (contact.status === "approved") {
            participantStatus = "active";
          } else if (contact.contact_telegram_id) {
            participantStatus = "pending_consent";
          } else {
            participantStatus = "pending_invite";
          }

          try {
            await createParticipant({
              memory_id: memory.id,
              participant_telegram_id: contact.contact_telegram_id || 0,
              role: "assignee",
              status: participantStatus,
            });

            // Notify active recipients immediately
            if (participantStatus === "active" && contact.contact_telegram_id) {
              sendMessage(
                contact.contact_telegram_id,
                `\u{1F4E5} ${senderName} assigned you: <b>${escapeHtml(parsed.description)}</b>`,
              ).catch(() => {});
            }

            assignedNames.push(escapeHtml(contact.first_name || contact.nickname));
          } catch (err) {
            console.error(`Participant creation failed for contact ${contact.id} (non-fatal):`, err);
          }
        }

        // Build confirmation parts
        const confirmParts: string[] = [];
        if (parsed.include_creator) confirmParts.push("you");
        confirmParts.push(...assignedNames);

        // Warn about blocked contacts
        if (notAccepting.length > 0) {
          const names = notAccepting.map((n) => n.replace(" (not accepting)", "")).join(", ");
          await sendMessage(chatId, `Note: <b>${escapeHtml(names)}</b> is not accepting tasks right now.`);
        }

        // Prompt to share unknown contacts, store memory_id for later linking
        if (trueUnknown.length > 0) {
          const unknownNames = trueUnknown.join(",");
          await saveSession(telegramId, [memory.id], `awaiting_contact:${memory.id}:${unknownNames}`);
          const namesList = trueUnknown.map((n) => `<b>${escapeHtml(n)}</b>`).join(", ");
          const savedPart = confirmParts.length > 0
            ? `\u{2705} Saved for ${confirmParts.join(", ")}: <b>${escapeHtml(parsed.description)}</b>\n\n`
            : "";
          const responseText = `${savedPart}I don't have a contact for ${namesList}. Share their Telegram contact so I can add them.`;
          await sendMessage(chatId, responseText);
          return { summary: `Shared ${parsed.intent}: ${parsed.description} (unknown: ${unknownNames})`, response: responseText };
        }

        await saveSession(telegramId, [memory.id], memory.due_date ? "created" : "awaiting_date");

        const namesStr = confirmParts.join(", ");
        const responseText = `\u{2705} Assigned to ${namesStr}: <b>${escapeHtml(parsed.description)}</b>`;
        await sendMessage(chatId, responseText);
        return { summary: `Shared ${parsed.intent}: ${parsed.description} -> ${namesStr}`, response: responseText };
      }

      const memory = await createMemory({
        user_id: userId,
        telegram_id: telegramId,
        type: parsed.intent,
        description: parsed.description,
        raw_input: rawInput,
        due_date: parsed.due_date,
        reminder_at: parsed.reminder_at,
        entities: parsed.entities,
        recurrence: parsed.recurrence,
        source,
        description_embedding: embedding,
      });

      // Save session so "delete this" / "change this" resolves to this item
      await saveSession(telegramId, [memory.id], memory.due_date ? "created" : "awaiting_date");

      if (parsed.ambiguous_date && parsed.date_options.length > 1) {
        const { text, buttons } = formatAmbiguousDate(memory.id, parsed.date_options, userTimezone);
        await sendMessageWithButtons(chatId, text, buttons);
        return { summary: `Saved ${parsed.intent}: ${parsed.description} (ambiguous date)`, response: text };
      }

      const { text, buttons } = formatConfirmation(memory, userTimezone);
      let displayText = text;

      // Entity-linked related items: show related pending items if embedding available
      if (embedding) {
        try {
          const related = await semanticSearch(telegramId, embedding, "pending", 0.75, 3);
          // Filter out the item we just saved
          const others = related.filter((r) => r.id !== memory.id);
          if (others.length > 0) {
            const relatedLines = others.map((r) => `  \u{2022} ${escapeHtml(r.description)}`).join("\n");
            displayText += `\n\n\u{1F517} <b>Related:</b>\n${relatedLines}`;
          }
        } catch {
          // Non-fatal
        }
      }

      const lowConfidence = parsed.confidence < 0.6;
      if (lowConfidence) {
        displayText += "\n\n<i>Not what you meant? Say \"delete this\" or \"edit this\".</i>";
      }
      await sendMessageWithButtons(chatId, displayText, buttons);

      const dueSummary = memory.due_date ? ` due ${new Date(memory.due_date).toLocaleDateString()}` : " (no deadline)";
      return { summary: `Saved ${parsed.intent}: ${parsed.description}${dueSummary}`, response: displayText };
    }
  }
}

// Detect "delete everything/all" type descriptions
function isDeleteAllRequest(description: string): boolean {
  const lower = description.toLowerCase();
  return /\b(everything|all( my)?( tasks| data| items| memories)?|every\s?thing)\b/.test(lower);
}

async function handleQuery(
  chatId: number,
  telegramId: number,
  queryText: string,
  rawInput = "",
  tz = "Asia/Kolkata",
  dateStart: string | null = null,
  dateEnd: string | null = null,
): Promise<string> {
  const lowerQuery = queryText.toLowerCase();
  const lowerRaw = rawInput.toLowerCase();

  // Date-filtered query FIRST: "today", "this week", "what did I add last Tuesday"
  // Must run before pending patterns — "my tasks for today" matches both
  if (dateStart && dateEnd) {
    // Detect if user is asking about creation date vs due date
    const creationPatterns = ["added", "created", "saved", "told you", "sent"];
    const isCreationQuery = creationPatterns.some((p) => lowerRaw.includes(p) || lowerQuery.includes(p));
    const filterField = isCreationQuery ? "created_at" : "due_date";

    const results = await getMemoriesByDateRange(telegramId, dateStart, dateEnd, filterField);
    if (results.length > 0) {
      await saveSession(telegramId, results.map((m) => m.id), "query");
    }
    // Use rawInput for display so user sees their original question, not Gemini's extracted term
    const responseText = formatQueryResults(results, rawInput || queryText, tz);
    await sendMessage(chatId, responseText);
    return responseText;
  }

  const pendingPatterns = ["pending", "all tasks", "my tasks", "show tasks", "list tasks", "what do i have"];
  if (pendingPatterns.some((p) => lowerQuery.includes(p) || lowerRaw.includes(p))) {
    const memories = await getPendingMemories(telegramId);
    await saveSession(telegramId, memories.map((m) => m.id), "pending");
    const { text: pendingText, buttons: pendingButtons } = formatPendingList(memories, tz);
    if (pendingButtons.length > 0) {
      await sendMessageWithButtons(chatId, pendingText, pendingButtons);
    } else {
      await sendMessage(chatId, pendingText);
    }
    return pendingText;
  }

  const results = await findMemories(telegramId, queryText);
  if (results.length > 0) {
    await saveSession(telegramId, results.map((m) => m.id), "query");
  }
  const responseText = formatQueryResults(results, queryText, tz);
  await sendMessage(chatId, responseText);
  return responseText;
}

// ============================================================
// Semantic search helpers (embedding first, ILIKE fallback)
// ============================================================

async function findPendingByDescription(
  telegramId: number,
  description: string,
): Promise<DbMemory[]> {
  try {
    const embedding = await generateEmbedding(description);
    const matches = await semanticSearch(telegramId, embedding, "pending", 0.4, 5);
    if (matches.length > 0) return matches;
  } catch (err) {
    console.error("Semantic search failed, falling back to text:", err);
  }
  return await searchPendingByDescription(telegramId, description);
}

async function findMemories(
  telegramId: number,
  queryText: string,
): Promise<DbMemory[]> {
  try {
    const embedding = await generateEmbedding(queryText);
    const matches = await semanticSearch(telegramId, embedding, null, 0.3, 10);
    if (matches.length > 0) return matches;
  } catch (err) {
    console.error("Semantic search failed, falling back to text:", err);
  }
  return await searchMemories(telegramId, queryText);
}

// Resolve a numbered item — session context first, pending list fallback
async function resolveByIndex(
  telegramId: number,
  targetIndex: number,
): Promise<DbMemory | null> {
  const idx = targetIndex - 1;
  const session = await getSession(telegramId);
  if (session && session.last_shown_ids.length > 0) {
    if (idx < 0 || idx >= session.last_shown_ids.length) return null;
    return await getMemoryById(session.last_shown_ids[idx]);
  }
  const pending = await getPendingMemories(telegramId);
  if (idx < 0 || idx >= pending.length) return null;
  return pending[idx];
}

async function handleDoneIntent(
  chatId: number,
  telegramId: number,
  description: string,
  targetIndex: number | null = null,
): Promise<string> {
  if (targetIndex) {
    const memory = await resolveByIndex(telegramId, targetIndex);
    if (!memory) {
      const r = `No item #${targetIndex} in your list.`;
      await sendMessage(chatId, r);
      return r;
    }
    await updateMemory(memory.id, { status: "done", completed_at: new Date().toISOString() });
    await updateStreak(telegramId);
    const r = await getCelebrationMessage(telegramId, memory.description);
    await sendMessageWithButtons(chatId, r, [
      [{ text: "\u{21A9}\u{FE0F} Undo", callback_data: `undo_done:${memory.id}` }],
    ]);
    return r;
  }

  const matches = await findPendingByDescription(telegramId, description);

  if (matches.length === 0) {
    const allPending = await getPendingMemories(telegramId);
    if (allPending.length === 0) {
      const r = "You have no pending tasks.";
      await sendMessage(chatId, r);
      return r;
    } else {
      const shown = allPending.slice(0, 5);
      await saveSession(telegramId, shown.map((m) => m.id), "done_picker");
      const prompt = `Couldn't find "${escapeHtml(description)}". Which task did you complete?\n`;
      const { text, buttons } = formatDoneOptions(shown, prompt);
      await sendMessageWithButtons(chatId, text, buttons);
      return text;
    }
  } else if (matches.length === 1) {
    await updateMemory(matches[0].id, {
      status: "done",
      completed_at: new Date().toISOString(),
    });
    await updateStreak(telegramId);
    const r = await getCelebrationMessage(telegramId, matches[0].description);
    await sendMessageWithButtons(chatId, r, [
      [{ text: "\u{21A9}\u{FE0F} Undo", callback_data: `undo_done:${matches[0].id}` }],
    ]);
    return r;
  } else {
    const shown = matches.slice(0, 5);
    await saveSession(telegramId, shown.map((m) => m.id), "done_picker");
    const { text, buttons } = formatDoneOptions(shown);
    await sendMessageWithButtons(chatId, text, buttons);
    return text;
  }
}

async function handleRescheduleIntent(
  chatId: number,
  telegramId: number,
  description: string,
  rescheduleTo: string | null,
  targetIndex: number | null = null,
): Promise<string> {
  if (!rescheduleTo) {
    const r = "When would you like to reschedule it to? (e.g. 'reschedule to Friday')";
    await sendMessage(chatId, r);
    return r;
  }

  const rscUser = await getUser(telegramId);
  const tz = rscUser?.timezone || "Asia/Kolkata";

  const dateOnly = rescheduleTo.slice(0, 10);
  const [year, month, day] = dateOnly.split("-").map(Number);
  const newDue = localHourToUtcDate(year, month, day, 24, tz).toISOString();
  const newReminder = localHourToUtcDate(year, month, day, 9, tz).toISOString();

  if (targetIndex) {
    const memory = await resolveByIndex(telegramId, targetIndex);
    if (!memory) {
      const r = `No item #${targetIndex} in your list.`;
      await sendMessage(chatId, r);
      return r;
    }
    await updateMemory(memory.id, {
      due_date: newDue, reminder_at: newReminder,
      is_reminded: false, is_pre_reminded: false,
    });
    const formatted = new Date(newDue).toLocaleString("en-IN", {
      weekday: "short", day: "numeric", month: "short", timeZone: tz,
    });
    const r = `\u{1F4C5} Rescheduled: ${escapeHtml(memory.description)} \u{2192} ${formatted}`;
    await sendMessage(chatId, r);
    return r;
  }

  const matches = description ? await findPendingByDescription(telegramId, description) : [];
  const candidates = matches.length > 0 ? matches : await getPendingMemories(telegramId);

  if (candidates.length === 0) {
    const r = "You have no pending tasks to reschedule.";
    await sendMessage(chatId, r);
    return r;
  }

  if (matches.length === 1) {
    await updateMemory(matches[0].id, {
      due_date: newDue, reminder_at: newReminder,
      is_reminded: false, is_pre_reminded: false,
    });
    const formatted = new Date(newDue).toLocaleString("en-IN", {
      weekday: "short", day: "numeric", month: "short", timeZone: tz,
    });
    const r = `\u{1F4C5} Rescheduled: ${escapeHtml(matches[0].description)} \u{2192} ${formatted}`;
    await sendMessage(chatId, r);
    return r;
  }

  const shown = candidates.slice(0, 5);
  await saveSession(telegramId, shown.map((m) => m.id), "reschedule_picker");
  const { text, buttons } = formatRescheduleOptions(shown, dateOnly);
  await sendMessageWithButtons(chatId, text, buttons);
  return text;
}

async function handleDeleteIntent(
  chatId: number,
  telegramId: number,
  description: string,
  targetIndex: number | null = null,
): Promise<string> {
  if (targetIndex) {
    const memory = await resolveByIndex(telegramId, targetIndex);
    if (!memory) {
      const r = `No item #${targetIndex} in your list.`;
      await sendMessage(chatId, r);
      return r;
    }
    await deleteMemory(memory.id);
    const r = `\u{1F5D1} Deleted: ${escapeHtml(memory.description)}`;
    await sendMessage(chatId, r);
    return r;
  }

  const matches = description ? await findPendingByDescription(telegramId, description) : [];

  if (matches.length === 1) {
    // Single match — confirm before deleting
    const r = `Delete this?\n\u{1F4CB} ${escapeHtml(matches[0].description)}`;
    await sendMessageWithButtons(chatId, r, [[
      { text: "\u{1F5D1} Yes, delete", callback_data: `delete:${matches[0].id}` },
      { text: "\u{274C} No, keep it", callback_data: "cancel_delete" },
    ]]);
    return r;
  }

  const candidates = matches.length > 1 ? matches : await getPendingMemories(telegramId);
  if (candidates.length === 0) {
    const r = "You have no pending tasks to delete.";
    await sendMessage(chatId, r);
    return r;
  }
  const shown = candidates.slice(0, 5);
  await saveSession(telegramId, shown.map((m) => m.id), "delete_picker");
  const prompt = matches.length === 0 && description
    ? `Couldn't find "${escapeHtml(description)}". Which task would you like to delete?\n`
    : "Which task would you like to delete?\n";
  const { text, buttons } = formatDeleteOptions(shown, prompt);
  await sendMessageWithButtons(chatId, text, buttons);
  return text;
}

async function handleEditIntent(
  chatId: number,
  telegramId: number,
  description: string,
  editField: string | null,
  editValue: string | null,
  targetIndex: number | null = null,
): Promise<string> {
  let memory: DbMemory | null = null;

  if (targetIndex) {
    memory = await resolveByIndex(telegramId, targetIndex);
    if (!memory) {
      const r = `No item #${targetIndex} in your list.`;
      await sendMessage(chatId, r);
      return r;
    }
  } else if (description) {
    const matches = await findPendingByDescription(telegramId, description);
    if (matches.length === 1) {
      memory = matches[0];
    } else if (matches.length === 0) {
      // Try session context — last shown item
      const session = await getSession(telegramId);
      if (session && session.last_shown_ids.length === 1) {
        memory = await getMemoryById(session.last_shown_ids[0]);
      }
    }
  }

  if (!memory) {
    const r = "Which task do you want to edit? Try referencing it by number (e.g. 'change 2 to birthday').";
    await sendMessage(chatId, r);
    return r;
  }

  if (!editField || !editValue) {
    const r = "What would you like to change? (e.g. 'change type to birthday', 'update due date to Friday')";
    await sendMessage(chatId, r);
    return r;
  }

  const updates: Record<string, unknown> = {};
  if (editField === "type") {
    updates.type = editValue;
  } else if (editField === "description") {
    updates.description = editValue;
  } else if (editField === "due_date") {
    updates.due_date = editValue;
    const dueDate = new Date(editValue);
    updates.reminder_at = new Date(dueDate.getTime() - 30 * 60 * 1000).toISOString();
    updates.is_reminded = false;
    updates.is_pre_reminded = false;
  }

  await updateMemory(memory.id, updates);
  const r = `\u{270F}\u{FE0F} Updated <b>${escapeHtml(memory.description)}</b>\n${escapeHtml(editField!)} \u{2192} ${escapeHtml(editValue!)}`;
  await sendMessage(chatId, r);
  return r;
}

async function handleStatusIntent(
  chatId: number,
  telegramId: number,
): Promise<string> {
  const statusUser = await getUser(telegramId);
  const tz = statusUser?.timezone || "Asia/Kolkata";
  const tzOffsetMs = (TZ_OFFSETS[tz] ?? 5.5) * 60 * 60 * 1000;

  const pending = await getPendingMemories(telegramId);

  const nowUtc = new Date();
  const nowLocal = new Date(nowUtc.getTime() + tzOffsetMs);
  const dayOfWeek = nowLocal.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStartLocal = new Date(nowLocal);
  weekStartLocal.setUTCDate(weekStartLocal.getUTCDate() - mondayOffset);
  weekStartLocal.setUTCHours(0, 0, 0, 0);
  const weekStartUtc = new Date(weekStartLocal.getTime() - tzOffsetMs);

  const completedCount = await getCompletedSince(telegramId, weekStartUtc.toISOString());

  const overdue = pending.filter((m) => m.due_date && new Date(m.due_date) < nowUtc);

  const todayStartLocal = new Date(nowLocal);
  todayStartLocal.setUTCHours(0, 0, 0, 0);
  const todayStartUtc = new Date(todayStartLocal.getTime() - tzOffsetMs);
  const tomorrowStartUtc = new Date(todayStartUtc.getTime() + 24 * 60 * 60 * 1000);
  const dueToday = pending.filter((m) => {
    if (!m.due_date) return false;
    const due = new Date(m.due_date);
    return due >= todayStartUtc && due < tomorrowStartUtc;
  });

  const lines: string[] = ["Here's how you're doing:\n"];
  if (completedCount > 0) {
    lines.push(`\u{2705} <b>${completedCount}</b> task${completedCount > 1 ? "s" : ""} completed this week`);
  }
  lines.push(`\u{1F4CB} <b>${pending.length}</b> pending`);
  if (overdue.length > 0) {
    lines.push(`\u{1F6A8} <b>${overdue.length}</b> overdue`);
  }
  if (dueToday.length > 0) {
    lines.push(`\u{1F4C5} <b>${dueToday.length}</b> due today`);
  }

  if (overdue.length === 0 && pending.length <= 3) {
    lines.push("\nYou're on top of things!");
  } else if (overdue.length > 0) {
    lines.push("\nLet's tackle those overdue items first.");
  } else {
    lines.push("\nKeep going, you've got this!");
  }

  const r = lines.join("\n");
  await sendMessage(chatId, r);
  return r;
}
