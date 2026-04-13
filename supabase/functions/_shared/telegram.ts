import { TelegramInlineKeyboardButton } from "./types.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Escape HTML special characters in user-generated content
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`sendMessage failed: ${res.status} ${err}`);
  }
}

export async function sendMessageWithButtons(
  chatId: number,
  text: string,
  buttons: TelegramInlineKeyboardButton[][],
): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`sendMessageWithButtons failed: ${res.status} ${err}`);
  }
}

export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`editMessageText failed: ${res.status} ${err}`);
  }
}

export async function editMessageWithButtons(
  chatId: number,
  messageId: number,
  text: string,
  buttons: TelegramInlineKeyboardButton[][],
): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`editMessageWithButtons failed: ${res.status} ${err}`);
  }
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
    }),
  });
}

// Returns the file content as a Uint8Array, or null on failure
export async function downloadTelegramFile(fileId: string): Promise<Uint8Array | null> {
  // Step 1: Get file path from Telegram
  const fileRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  if (!fileRes.ok) {
    console.error(`getFile failed: ${fileRes.status}`);
    return null;
  }
  const fileData = await fileRes.json();
  const filePath = fileData.result?.file_path;
  if (!filePath) {
    console.error("getFile returned no file_path");
    return null;
  }

  // Step 2: Download the actual file
  const downloadRes = await fetch(
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`,
  );
  if (!downloadRes.ok) {
    console.error(`File download failed: ${downloadRes.status}`);
    return null;
  }
  const buffer = await downloadRes.arrayBuffer();
  return new Uint8Array(buffer);
}
