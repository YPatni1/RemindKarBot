import { getDueReminders, getDuePreReminders, updateMemory, getUser, getDueSharedReminders, getDueSharedPreReminders, updateParticipant } from "../_shared/database.ts";
import { sendMessageWithButtons, escapeHtml } from "../_shared/telegram.ts";
import { formatReminder, formatPreReminder } from "../_shared/formatters.ts";

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }

    console.log("send-reminders: starting check...");

    // Cache user timezone lookups to avoid repeated DB calls
    const tzCache: Record<number, string> = {};
    async function getUserTz(telegramId: number): Promise<string> {
      if (tzCache[telegramId]) return tzCache[telegramId];
      const user = await getUser(telegramId);
      const tz = user?.timezone || "Asia/Kolkata";
      tzCache[telegramId] = tz;
      return tz;
    }

    // 1. Send pre-reminders (30 min before)
    const preReminders = await getDuePreReminders();
    console.log(`send-reminders: ${preReminders.length} pre-reminders due`);

    for (const memory of preReminders) {
      try {
        const tz = await getUserTz(memory.telegram_id);
        const { text, buttons } = formatPreReminder(memory, tz);
        await sendMessageWithButtons(memory.telegram_id, text, buttons);
        await updateMemory(memory.id, { is_pre_reminded: true });
      } catch (err) {
        console.error(`Failed to send pre-reminder for ${memory.id}:`, err);
      }
    }

    // 2. Send due reminders
    const reminders = await getDueReminders();
    console.log(`send-reminders: ${reminders.length} reminders due`);

    for (const memory of reminders) {
      try {
        const tz = await getUserTz(memory.telegram_id);
        const { text, buttons } = formatReminder(memory, tz);
        await sendMessageWithButtons(memory.telegram_id, text, buttons);
        await updateMemory(memory.id, { is_reminded: true });
      } catch (err) {
        console.error(`Failed to send reminder for ${memory.id}:`, err);
      }
    }

    // 3. Send shared pre-reminders
    const sharedPreReminders = await getDueSharedPreReminders();
    console.log(`send-reminders: ${sharedPreReminders.length} shared pre-reminders due`);

    for (const sp of sharedPreReminders) {
      try {
        const tz = await getUserTz(sp.participant_telegram_id);
        const { text, buttons } = formatPreReminder(sp.memory, tz);
        const senderUser = await getUser(sp.memory.telegram_id);
        const senderName = senderUser?.first_name || "Someone";
        const taggedText = `${text}\n<i>Shared by ${escapeHtml(senderName)}</i>`;
        await sendMessageWithButtons(sp.participant_telegram_id, taggedText, buttons);
        await updateParticipant(sp.id, { is_pre_reminded: true });
      } catch (err) {
        console.error(`Failed to send shared pre-reminder for participant ${sp.id}:`, err);
      }
    }

    // 4. Send shared due reminders
    const sharedReminders = await getDueSharedReminders();
    console.log(`send-reminders: ${sharedReminders.length} shared reminders due`);

    for (const sr of sharedReminders) {
      try {
        const tz = await getUserTz(sr.participant_telegram_id);
        const { text, buttons } = formatReminder(sr.memory, tz);
        const senderUser = await getUser(sr.memory.telegram_id);
        const senderName = senderUser?.first_name || "Someone";
        const taggedText = `${text}\n<i>Shared by ${escapeHtml(senderName)}</i>`;
        await sendMessageWithButtons(sr.participant_telegram_id, taggedText, buttons);
        await updateParticipant(sr.id, { is_reminded: true });
      } catch (err) {
        console.error(`Failed to send shared reminder for participant ${sr.id}:`, err);
      }
    }

    console.log("send-reminders: done");
    return new Response(JSON.stringify({
      pre: preReminders.length,
      reminders: reminders.length,
      shared_pre: sharedPreReminders.length,
      shared_reminders: sharedReminders.length,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("send-reminders error:", error);
    return new Response("Internal error", { status: 500 });
  }
});
