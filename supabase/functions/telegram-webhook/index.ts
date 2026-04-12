import { TelegramUpdate, TelegramMessage, TelegramCallbackQuery, GeminiParsedResponse } from "../_shared/types.ts";
import {
  sendMessage,
  sendMessageWithButtons,
  editMessageText,
  answerCallbackQuery,
  downloadTelegramFile,
} from "../_shared/telegram.ts";
import {
  upsertUser,
  getUser,
  updateUserConsent,
  deleteUserData,
  createMemory,
  updateMemory,
  deleteMemory,
  getPendingMemories,
  searchMemories,
  searchPendingByDescription,
} from "../_shared/database.ts";
import { parseMessage, transcribeAudio } from "../_shared/gemini.ts";
import {
  formatConfirmation,
  formatQueryResults,
  formatPendingList,
  formatAmbiguousDate,
  formatDoneOptions,
} from "../_shared/formatters.ts";

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
// Update router (order matters — see spec section 6)
// ============================================================

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  const message = update.message;
  if (!message) return;

  if (message.voice) {
    await handleVoice(message);
    return;
  }

  if (message.forward_date || message.forward_origin) {
    await handleForward(message);
    return;
  }

  if (message.text?.startsWith("/")) {
    await handleCommand(message);
    return;
  }

  if (message.text) {
    await handleText(message);
    return;
  }

  // Anything else (photos, stickers, etc.) — silently ignore
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
      `Welcome back, ${firstName || "there"}! Just send me a message or voice note and I'll remember it for you.`,
    );
    return;
  }

  const name = firstName || "there";
  const welcomeText =
    `Hey ${name}!\n\n` +
    `I'm RemindKar \u{2014} your personal AI memory. Tell me anything you want to remember, and I'll make sure you never forget it.\n\n` +
    `Tasks, deadlines, birthdays, meeting notes, random ideas \u{2014} just text or voice note me. I'll organize everything and remind you when it matters.\n\n` +
    `Before we start, I need your consent to store your messages so I can help you. Your data is private, never shared, and you can delete everything anytime with /delete.`;

  await sendMessageWithButtons(chatId, welcomeText, [
    [
      { text: "\u{2705} I consent", callback_data: "consent_yes" },
      { text: "\u{274C} No thanks", callback_data: "consent_no" },
    ],
  ]);
}

async function handleHelp(chatId: number): Promise<void> {
  const helpText =
    "*RemindKar \u{2014} Commands*\n\n" +
    "/start \u{2014} Set up or restart the bot\n" +
    "/pending \u{2014} Show all pending tasks\n" +
    "/done <text> \u{2014} Mark a task as done\n" +
    "/privacy \u{2014} See privacy info\n" +
    "/delete \u{2014} Delete all your data\n" +
    "/help \u{2014} Show this message\n\n" +
    "*Just send me:*\n" +
    '\u{2022} A task: "Call Aman tomorrow at 5 PM"\n' +
    '\u{2022} A birthday: "Mom\'s birthday is 15th August"\n' +
    '\u{2022} A question: "Show my pending tasks"\n' +
    "\u{2022} A voice note in any language!";

  await sendMessage(chatId, helpText);
}

async function handlePrivacy(chatId: number): Promise<void> {
  const privacyText =
    "*RemindKar Privacy Info:*\n\n" +
    "*What I store:*\n" +
    "\u{2022} Your Telegram ID and first name\n" +
    "\u{2022} Messages you send me (text and voice transcriptions)\n" +
    "\u{2022} Tasks, reminders, and notes I extract from your messages\n\n" +
    "*What I DON'T do:*\n" +
    "\u{2022} Share your data with anyone\n" +
    "\u{2022} Use your data for training\n" +
    "\u{2022} Store data beyond what you send me\n\n" +
    "*Your controls:*\n" +
    "\u{2022} /delete \u{2014} permanently erase all your data\n" +
    "\u{2022} Every task has a Delete button\n\n" +
    "Data is stored on Supabase (hosted on AWS).";

  await sendMessage(chatId, privacyText);
}

async function handleDelete(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  try {
    await deleteUserData(telegramId);
    await sendMessage(
      chatId,
      "All your data has been permanently deleted. Send /start if you ever want to use RemindKar again.",
    );
  } catch (error) {
    console.error("Delete error:", error);
    await sendMessage(chatId, "Something went wrong. Please try again.");
  }
}

async function handleDoneCommand(message: TelegramMessage, searchText: string): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  if (!searchText) {
    await sendMessage(chatId, "Tell me which task you completed. Example: /done call Aman");
    return;
  }

  try {
    const matches = await searchPendingByDescription(telegramId, searchText);

    if (matches.length === 0) {
      await sendMessage(chatId, `No pending task found matching "${searchText}".`);
    } else if (matches.length === 1) {
      await updateMemory(matches[0].id, {
        status: "done",
        completed_at: new Date().toISOString(),
      });
      await sendMessage(chatId, `\u{2705} Done: ${matches[0].description}`);
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
    await sendMessage(chatId, formatPendingList(memories));
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

      const onboardingText =
        "Let's try it out! Send me something \u{2014} a task, a reminder, anything:\n\n" +
        '"Remind me to call Aman tomorrow at 5 PM"\n' +
        '"Mom\'s birthday is on 15th August"\n' +
        '"Send the quarterly report to Priya by Friday EOD"\n\n' +
        "Or just send a voice note \u{2014} I understand Hindi, English, and Hinglish!";

      if (chatId && messageId) {
        await editMessageText(chatId, messageId, "Consent recorded. Let's go!");
      }
      if (chatId) {
        await sendMessage(chatId, onboardingText);
      }
      return;
    }

    if (data === "consent_no") {
      await answerCallbackQuery(query.id);
      if (chatId && messageId) {
        await editMessageText(
          chatId,
          messageId,
          "No problem! I can't store memories without your consent, but feel free to come back anytime. Just send /start to begin again.",
        );
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
      await answerCallbackQuery(query.id, "Date confirmed!");
      if (chatId && messageId) {
        const formatted = new Date(isoDate).toLocaleString("en-IN", {
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
          timeZone: "Asia/Kolkata",
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

async function handleText(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;
  const text = message.text!;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first and give consent before I can save your memories.");
    return;
  }

  try {
    const parsed = await parseMessage(text);
    await routeParsedIntent(chatId, telegramId, user.id, text, parsed, "text");
  } catch (error) {
    console.error("Text handler error:", error);
    await sendMessage(chatId, "I couldn't process that, please try again in a moment.");
  }
}

// ============================================================
// Voice message handler
// ============================================================

async function handleVoice(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const telegramId = message.from!.id;

  const user = await getUser(telegramId);
  if (!user?.consent_given) {
    await sendMessage(chatId, "Please send /start first and give consent before I can save your memories.");
    return;
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

    const parsed = await parseMessage(transcription);
    await sendMessage(chatId, `\u{1F399} I heard: "${transcription}"`);
    await routeParsedIntent(chatId, telegramId, user.id, transcription, parsed, "voice");
  } catch (error) {
    console.error("Voice handler error:", error);
    await sendMessage(chatId, "I couldn't process your voice note \u{2014} could you type it instead?");
  }
}

// ============================================================
// Forward handler
// ============================================================

async function handleForward(message: TelegramMessage): Promise<void> {
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
    const parsed = await parseMessage(text);
    await routeParsedIntent(chatId, telegramId, user.id, text, parsed, "forwarded");
  } catch (error) {
    console.error("Forward handler error:", error);
    await sendMessage(chatId, "I couldn't process that forwarded message, please try again.");
  }
}

// ============================================================
// Shared: route parsed intent to storage or query
// ============================================================

async function routeParsedIntent(
  chatId: number,
  telegramId: number,
  userId: string,
  rawInput: string,
  parsed: GeminiParsedResponse,
  source: string,
): Promise<void> {
  switch (parsed.intent) {
    case "greeting":
      await sendMessage(
        chatId,
        "Hey! Send me a task, reminder, or question \u{2014} I'm ready to help.",
      );
      return;

    case "query":
      await handleQuery(chatId, telegramId, parsed.query_text || rawInput);
      return;

    case "done":
      await handleDoneIntent(chatId, telegramId, parsed.description);
      return;

    case "unknown":
      await sendMessage(
        chatId,
        "I'm not sure what to do with that. Try sending a task, reminder, or ask me a question about your saved items.",
      );
      return;

    default: {
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
      });

      if (parsed.ambiguous_date && parsed.date_options.length > 1) {
        const { text, buttons } = formatAmbiguousDate(memory.id, parsed.date_options);
        await sendMessageWithButtons(chatId, text, buttons);
        return;
      }

      const { text, buttons } = formatConfirmation(memory);
      await sendMessageWithButtons(chatId, text, buttons);
    }
  }
}

async function handleQuery(
  chatId: number,
  telegramId: number,
  queryText: string,
): Promise<void> {
  const results = await searchMemories(telegramId, queryText);
  await sendMessage(chatId, formatQueryResults(results, queryText));
}

async function handleDoneIntent(
  chatId: number,
  telegramId: number,
  description: string,
): Promise<void> {
  const matches = await searchPendingByDescription(telegramId, description);

  if (matches.length === 0) {
    await sendMessage(chatId, `No pending task found matching "${description}".`);
  } else if (matches.length === 1) {
    await updateMemory(matches[0].id, {
      status: "done",
      completed_at: new Date().toISOString(),
    });
    await sendMessage(chatId, `\u{2705} Done: ${matches[0].description}`);
  } else {
    const { text, buttons } = formatDoneOptions(matches.slice(0, 5));
    await sendMessageWithButtons(chatId, text, buttons);
  }
}
