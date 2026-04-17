// Telegram bot handle — used for constructing deep links in /share
// Update this if the bot username changes
export const BOT_HANDLE = "RemindKar_bot";

// Single source of truth for timezone offsets (hours from UTC)
// Used by: index.ts, gemini.ts, database.ts
export const TZ_OFFSETS: Record<string, number> = {
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
