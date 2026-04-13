import { TelegramUpdate, TelegramMessage, TelegramCallbackQuery, GeminiParsedResponse, DbMemory, ConversationMessage } from "../_shared/types.ts";
import {
  sendMessage,
  sendMessageWithButtons,
  editMessageText,
  editMessageWithButtons,
  answerCallbackQuery,
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
  upsertSession,
  getSession,
  createConversationLog,
} from "../_shared/database.ts";
import { parseMessage, transcribeAudio, generateEmbedding } from "../_shared/gemini.ts";
import {
  formatConfirmation,
  formatQueryResults,
  formatPendingList,
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
): Promise<void> {
  try {
    await upsertSession(telegramId, ids, intent, conversationHistory);
  } catch (err) {
    console.error("Session save failed (non-fatal):", err);
  }
}

// Timezone offset map (mirrors gemini.ts)
const TZ_OFFSETS: Record<string, number> = {
  "Asia/Kolkata": 5.5,
  "America/New_York": -5,
  "America/Chicago": -6,
  "America/Denver": -7,
  "America/Los_Angeles": -8,
  "Europe/London": 0,
  "Europe/Berlin": 1,
  "Asia/Dubai": 4,
  "Asia/Singapore": 8,
  "Asia/Tokyo": 9,
  "Australia/Sydney": 11,
};

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
      processing_time_ms: log.processing_time_ms,
      error: log.error ?? null,
      user_timezone: log.user_timezone ?? "Asia/Kolkata",
    });
  } catch (err) {
    console.error("logInteraction failed (non-fatal):", err);
  }
}

// ============================================================
// Update router (order matters — see spec section 6)
// ============================================================

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const startMs = Date.now();

  if (update.callback_query) {
    const telegramId = update.callback_query.from.id;
    const cbData = update.callback_query.data ?? "";
    try {
      await handleCallbackQuery(update.callback_query);
      await logInteraction({
        telegram_id: telegramId,
        user_message: cbData,
        message_type: "callback",
        bot_action: `callback:${cbData.split(":")[0]}`,
        processing_time_ms: Date.now() - startMs,
      });
    } catch (err) {
      await logInteraction({
        telegram_id: telegramId,
        user_message: cbData,
        message_type: "callback",
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
    default:
      await sendMessage(chatId, "Unknown command. Try /help to see what I can do.");
  }
}

async function handleStart(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;
  const username = message.from?.username ?? null;
  const firstName = message.from?.first_name ?? null;

  const user = await upsertUser(telegramId, username, firstName);

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
    "/privacy \u{2014} See privacy info\n" +
    "/delete \u{2014} Delete all your data\n" +
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
    if (buttons.length > 0) {
      await sendMessageWithButtons(chatId, text, buttons);
    } else {
      await sendMessage(chatId, text);
    }
  } catch (error) {
    console.error("Pending error:", error);
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

        const onboardingText =
          `Perfect! Every morning at ${digestTimeStr} I'll send you a summary of your day.\n\n` +
          "Let's try it \u{2014} tell me something you need to remember.\n" +
          "Or just tap an example:";

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

    if (data.startsWith("done:")) {
      const memoryId = data.slice(5);
      await updateMemory(memoryId, {
        status: "done",
        completed_at: new Date().toISOString(),
      });
      await answerCallbackQuery(query.id, "Marked as done!");
      if (chatId && messageId) {
        await editMessageText(chatId, messageId, "\u{2705} Task completed!");
      }
      return;
    }

    if (data.startsWith("snooze:")) {
      const memoryId = data.slice(7);
      const newReminder = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await updateMemory(memoryId, {
        reminder_at: newReminder,
        is_reminded: false,
        is_pre_reminded: false,
      });
      await answerCallbackQuery(query.id, "Snoozed for 1 hour!");
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          "\u{23F0} Snoozed! I'll remind you again in 1 hour.",
        );
      }
      return;
    }

    if (data.startsWith("delete:")) {
      const memoryId = data.slice(7);
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
  const history = session?.conversation_history ?? [];

  try {
    // Progressive clarification: if awaiting a date, try to apply it
    if (session?.last_intent === "awaiting_date" && session.last_shown_ids.length > 0) {
      const memoryId = session.last_shown_ids[0];
      const dateResult = await tryApplyDate(chatId, telegramId, memoryId, text, history, user.timezone);
      if (dateResult) {
        const newHistory = appendHistory(history, text, dateResult);
        await saveSession(telegramId, [memoryId], "date_set", newHistory);
        await logInteraction({
          telegram_id: telegramId,
          user_message: text,
          message_type: "text",
          primary_intent: "date_followup",
          bot_action: dateResult,
          processing_time_ms: Date.now() - startMs,
          user_timezone: user.timezone,
        });
        return;
      }
      // Not a date response — fall through to normal processing
    }

    const parsedItems = await parseMessage(text, history, user.timezone);
    const botSummaries: string[] = [];

    for (const parsed of parsedItems) {
      const summary = await routeParsedIntent(chatId, telegramId, user.id, text, parsed, "text", user.timezone);
      botSummaries.push(summary);
    }

    // Update conversation history
    const newHistory = appendHistory(history, text, botSummaries.join("; "));
    const lastParsed = parsedItems[parsedItems.length - 1];
    const lastIntent = lastParsed?.intent === "task" || lastParsed?.intent === "reminder" || lastParsed?.intent === "event"
      ? (lastParsed.due_date ? "created" : "awaiting_date")
      : (lastParsed?.intent ?? "text");

    // Get current session IDs (may have been updated by routeParsedIntent)
    const currentSession = await getSession(telegramId);
    await saveSession(
      telegramId,
      currentSession?.last_shown_ids ?? [],
      lastIntent,
      newHistory,
    );

    await logInteraction({
      telegram_id: telegramId,
      user_message: text,
      message_type: "text",
      parsed_intents: parsedItems,
      primary_intent: lastParsed?.intent ?? null,
      bot_action: botSummaries.join("; "),
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

    // Check if it's a task/reminder with a due_date (Gemini might reinterpret the date as a new task)
    if ((p.intent === "task" || p.intent === "reminder") && p.due_date) {
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
  const history = session?.conversation_history ?? [];

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
    for (const parsed of parsedItems) {
      const summary = await routeParsedIntent(chatId, telegramId, user.id, transcription, parsed, "voice", user.timezone);
      botSummaries.push(summary);
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
    );

    await logInteraction({
      telegram_id: telegramId,
      user_message: `[voice] ${transcription}`,
      message_type: "voice",
      parsed_intents: parsedItems,
      primary_intent: lastParsed?.intent ?? null,
      bot_action: botSummaries.join("; "),
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
    const history = session?.conversation_history ?? [];
    const parsedItems = await parseMessage(text, history, user.timezone);
    const botSummaries: string[] = [];
    for (const parsed of parsedItems) {
      const summary = await routeParsedIntent(chatId, telegramId, user.id, text, parsed, "forwarded", user.timezone);
      botSummaries.push(summary);
    }

    const newHistory = appendHistory(history, `[forwarded] ${text}`, botSummaries.join("; "));
    const currentSession = await getSession(telegramId);
    await saveSession(
      telegramId,
      currentSession?.last_shown_ids ?? [],
      parsedItems[parsedItems.length - 1]?.intent ?? "forwarded",
      newHistory,
    );

    await logInteraction({
      telegram_id: telegramId,
      user_message: `[forwarded] ${text}`,
      message_type: "forward",
      parsed_intents: parsedItems,
      primary_intent: parsedItems[parsedItems.length - 1]?.intent ?? null,
      bot_action: botSummaries.join("; "),
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
): Promise<string> {
  switch (parsed.intent) {
    case "greeting":
      await sendMessage(
        chatId,
        "Hey! Send me a task, reminder, or question \u{2014} I'm ready to help.",
      );
      return "Greeted user";

    case "casual": {
      // Casual/social messages — respond warmly, mention pending if relevant
      const pending = await getPendingMemories(telegramId);
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
          await sendMessage(chatId, `\u{1F44B} You have ${dueToday.length} thing${dueToday.length > 1 ? "s" : ""} due today \u{2014} I'll remind you when it's time!`);
        } else {
          await sendMessage(chatId, `\u{1F44B} You have ${pending.length} pending item${pending.length > 1 ? "s" : ""} \u{2014} I'll send your digest in the morning.`);
        }
      } else {
        await sendMessage(chatId, "\u{1F44B} All clear! Text me when you need to remember something.");
      }
      return "Casual response";
    }

    case "query":
      await handleQuery(chatId, telegramId, parsed.query_text || rawInput, rawInput, userTimezone, parsed.query_date_start ?? null, parsed.query_date_end ?? null);
      return `Query: ${parsed.query_text || rawInput}`;

    case "done":
      await handleDoneIntent(chatId, telegramId, parsed.description, parsed.target_index ?? null);
      return `Done: ${parsed.description}`;

    case "reschedule":
      await handleRescheduleIntent(chatId, telegramId, parsed.description, parsed.reschedule_to ?? null, parsed.target_index ?? null);
      return `Reschedule: ${parsed.description}`;

    case "delete":
      // Safety gate: detect "delete everything/all" type requests
      if (isDeleteAllRequest(parsed.description)) {
        await sendMessageWithButtons(chatId,
          "\u{26A0}\u{FE0F} <b>Delete ALL your data?</b> This is permanent and cannot be undone.",
          [[
            { text: "\u{1F5D1} Yes, delete everything", callback_data: "confirm_delete_all" },
            { text: "\u{274C} Cancel", callback_data: "cancel_delete_all" },
          ]],
        );
        return "Delete all safety gate";
      }
      await handleDeleteIntent(chatId, telegramId, parsed.description, parsed.target_index ?? null);
      return `Delete: ${parsed.description}`;

    case "edit":
      await handleEditIntent(chatId, telegramId, parsed.description, parsed.edit_field ?? null, parsed.edit_value ?? null, parsed.target_index ?? null);
      return `Edit: ${parsed.description}`;

    case "status":
      await handleStatusIntent(chatId, telegramId);
      return "Status shown";

    case "unknown":
      await sendMessage(
        chatId,
        "I'm not sure what to do with that. Try sending a task, reminder, or ask me about your saved items.\n\nExamples: \"Call mom tomorrow 5 PM\" or \"What do I have pending?\"",
      );
      return "Unknown intent";

    default: {
      // Storage intents: task, reminder, event, birthday, note
      let embedding: number[] | null = null;
      try {
        embedding = await generateEmbedding(parsed.description);
      } catch (err) {
        console.error("Embedding generation failed (non-fatal):", err);
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
        return `Saved ${parsed.intent}: ${parsed.description} (ambiguous date)`;
      }

      const { text, buttons } = formatConfirmation(memory, userTimezone);
      await sendMessageWithButtons(chatId, text, buttons);

      const dueSummary = memory.due_date ? ` due ${new Date(memory.due_date).toLocaleDateString()}` : " (no deadline)";
      return `Saved ${parsed.intent}: ${parsed.description}${dueSummary}`;
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
): Promise<void> {
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
    await sendMessage(chatId, formatQueryResults(results, rawInput || queryText, tz));
    return;
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
    return;
  }

  const results = await findMemories(telegramId, queryText);
  if (results.length > 0) {
    await saveSession(telegramId, results.map((m) => m.id), "query");
  }
  await sendMessage(chatId, formatQueryResults(results, queryText, tz));
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
): Promise<void> {
  if (targetIndex) {
    const memory = await resolveByIndex(telegramId, targetIndex);
    if (!memory) {
      await sendMessage(chatId, `No item #${targetIndex} in your list.`);
      return;
    }
    await updateMemory(memory.id, { status: "done", completed_at: new Date().toISOString() });
    await sendMessage(chatId, `\u{2705} Done: ${escapeHtml(memory.description)}`);
    return;
  }

  const matches = await findPendingByDescription(telegramId, description);

  if (matches.length === 0) {
    const allPending = await getPendingMemories(telegramId);
    if (allPending.length === 0) {
      await sendMessage(chatId, "You have no pending tasks.");
    } else {
      const shown = allPending.slice(0, 5);
      await saveSession(telegramId, shown.map((m) => m.id), "done_picker");
      const prompt = `Couldn't find "${escapeHtml(description)}". Which task did you complete?\n`;
      const { text, buttons } = formatDoneOptions(shown, prompt);
      await sendMessageWithButtons(chatId, text, buttons);
    }
    return;
  } else if (matches.length === 1) {
    await updateMemory(matches[0].id, {
      status: "done",
      completed_at: new Date().toISOString(),
    });
    await sendMessage(chatId, `\u{2705} Done: ${escapeHtml(matches[0].description)}`);
  } else {
    const shown = matches.slice(0, 5);
    await saveSession(telegramId, shown.map((m) => m.id), "done_picker");
    const { text, buttons } = formatDoneOptions(shown);
    await sendMessageWithButtons(chatId, text, buttons);
  }
}

async function handleRescheduleIntent(
  chatId: number,
  telegramId: number,
  description: string,
  rescheduleTo: string | null,
  targetIndex: number | null = null,
): Promise<void> {
  if (!rescheduleTo) {
    await sendMessage(chatId, "When would you like to reschedule it to? (e.g. 'reschedule to Friday')");
    return;
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
      await sendMessage(chatId, `No item #${targetIndex} in your list.`);
      return;
    }
    await updateMemory(memory.id, {
      due_date: newDue, reminder_at: newReminder,
      is_reminded: false, is_pre_reminded: false,
    });
    const formatted = new Date(newDue).toLocaleString("en-IN", {
      weekday: "short", day: "numeric", month: "short", timeZone: tz,
    });
    await sendMessage(chatId, `\u{1F4C5} Rescheduled: ${escapeHtml(memory.description)} \u{2192} ${formatted}`);
    return;
  }

  const matches = description ? await findPendingByDescription(telegramId, description) : [];
  const candidates = matches.length > 0 ? matches : await getPendingMemories(telegramId);

  if (candidates.length === 0) {
    await sendMessage(chatId, "You have no pending tasks to reschedule.");
    return;
  }

  if (matches.length === 1) {
    await updateMemory(matches[0].id, {
      due_date: newDue, reminder_at: newReminder,
      is_reminded: false, is_pre_reminded: false,
    });
    const formatted = new Date(newDue).toLocaleString("en-IN", {
      weekday: "short", day: "numeric", month: "short", timeZone: tz,
    });
    await sendMessage(chatId, `\u{1F4C5} Rescheduled: ${escapeHtml(matches[0].description)} \u{2192} ${formatted}`);
    return;
  }

  const shown = candidates.slice(0, 5);
  await saveSession(telegramId, shown.map((m) => m.id), "reschedule_picker");
  const { text, buttons } = formatRescheduleOptions(shown, dateOnly);
  await sendMessageWithButtons(chatId, text, buttons);
}

async function handleDeleteIntent(
  chatId: number,
  telegramId: number,
  description: string,
  targetIndex: number | null = null,
): Promise<void> {
  if (targetIndex) {
    const memory = await resolveByIndex(telegramId, targetIndex);
    if (!memory) {
      await sendMessage(chatId, `No item #${targetIndex} in your list.`);
      return;
    }
    await deleteMemory(memory.id);
    await sendMessage(chatId, `\u{1F5D1} Deleted: ${escapeHtml(memory.description)}`);
    return;
  }

  const matches = description ? await findPendingByDescription(telegramId, description) : [];

  if (matches.length === 1) {
    // Single match — confirm before deleting
    await sendMessageWithButtons(chatId,
      `Delete this?\n\u{1F4CB} ${escapeHtml(matches[0].description)}`,
      [[
        { text: "\u{1F5D1} Yes, delete", callback_data: `delete:${matches[0].id}` },
        { text: "\u{274C} No, keep it", callback_data: "cancel_delete" },
      ]],
    );
    return;
  }

  const candidates = matches.length > 1 ? matches : await getPendingMemories(telegramId);
  if (candidates.length === 0) {
    await sendMessage(chatId, "You have no pending tasks to delete.");
    return;
  }
  const shown = candidates.slice(0, 5);
  await saveSession(telegramId, shown.map((m) => m.id), "delete_picker");
  const prompt = matches.length === 0 && description
    ? `Couldn't find "${escapeHtml(description)}". Which task would you like to delete?\n`
    : "Which task would you like to delete?\n";
  const { text, buttons } = formatDeleteOptions(shown, prompt);
  await sendMessageWithButtons(chatId, text, buttons);
}

async function handleEditIntent(
  chatId: number,
  telegramId: number,
  description: string,
  editField: string | null,
  editValue: string | null,
  targetIndex: number | null = null,
): Promise<void> {
  let memory: DbMemory | null = null;

  if (targetIndex) {
    memory = await resolveByIndex(telegramId, targetIndex);
    if (!memory) {
      await sendMessage(chatId, `No item #${targetIndex} in your list.`);
      return;
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
    await sendMessage(chatId, "Which task do you want to edit? Try referencing it by number (e.g. 'change 2 to birthday').");
    return;
  }

  if (!editField || !editValue) {
    await sendMessage(chatId, "What would you like to change? (e.g. 'change type to birthday', 'update due date to Friday')");
    return;
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
  await sendMessage(
    chatId,
    `\u{270F}\u{FE0F} Updated <b>${escapeHtml(memory.description)}</b>\n${escapeHtml(editField!)} \u{2192} ${escapeHtml(editValue!)}`,
  );
}

async function handleStatusIntent(
  chatId: number,
  telegramId: number,
): Promise<void> {
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

  await sendMessage(chatId, lines.join("\n"));
}
