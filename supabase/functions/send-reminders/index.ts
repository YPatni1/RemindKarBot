import { getDueReminders, getDuePreReminders, updateMemory } from "../_shared/database.ts";
import { sendMessageWithButtons } from "../_shared/telegram.ts";
import { formatReminder, formatPreReminder } from "../_shared/formatters.ts";

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }

    console.log("send-reminders: starting check...");

    // 1. Send pre-reminders (30 min before)
    const preReminders = await getDuePreReminders();
    console.log(`send-reminders: ${preReminders.length} pre-reminders due`);

    for (const memory of preReminders) {
      try {
        const { text, buttons } = formatPreReminder(memory);
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
        const { text, buttons } = formatReminder(memory);
        await sendMessageWithButtons(memory.telegram_id, text, buttons);
        await updateMemory(memory.id, { is_reminded: true });
      } catch (err) {
        console.error(`Failed to send reminder for ${memory.id}:`, err);
      }
    }

    console.log("send-reminders: done");
    return new Response(JSON.stringify({ pre: preReminders.length, reminders: reminders.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("send-reminders error:", error);
    return new Response("Internal error", { status: 500 });
  }
});
