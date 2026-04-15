import { getActiveConsentedUsers, getDigestMemories } from "../_shared/database.ts";
import { sendMessage } from "../_shared/telegram.ts";
import { formatDigest } from "../_shared/formatters.ts";

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }

    console.log("send-digest: starting...");

    const users = await getActiveConsentedUsers();
    console.log(`send-digest: ${users.length} active users`);

    let sentCount = 0;

    for (const user of users) {
      try {
        const tz = user.timezone || "Asia/Kolkata";
        const { overdue, today, tomorrow, somedayCount } = await getDigestMemories(user.telegram_id, tz);
        const digestText = formatDigest(
          user.first_name, overdue, today, tomorrow, somedayCount, tz,
          user.current_streak ?? 0, user.longest_streak ?? 0,
        );

        // Skip users with nothing pending
        if (!digestText) continue;

        await sendMessage(user.telegram_id, digestText);
        sentCount++;
      } catch (err) {
        console.error(`Failed to send digest to ${user.telegram_id}:`, err);
      }
    }

    console.log(`send-digest: sent to ${sentCount} users`);
    return new Response(JSON.stringify({ users: users.length, sent: sentCount }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("send-digest error:", error);
    return new Response("Internal error", { status: 500 });
  }
});
