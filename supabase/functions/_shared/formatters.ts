import { DbMemory, TelegramInlineKeyboardButton } from "./types.ts";
import { escapeHtml } from "./telegram.ts";

const DEFAULT_TZ = "Asia/Kolkata";

const TYPE_EMOJI: Record<string, string> = {
  task: "\u{1F4CB}",
  reminder: "\u{23F0}",
  note: "\u{1F4DD}",
  event: "\u{1F4C5}",
  birthday: "\u{1F382}",
};

function formatDate(isoDate: string | null, tz = DEFAULT_TZ): string {
  if (!isoDate) return "No deadline";
  const d = new Date(isoDate);
  return d.toLocaleString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });
}

function formatDateShort(isoDate: string, tz = DEFAULT_TZ): string {
  const d = new Date(isoDate);
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: tz,
  });
}

function formatTime(isoDate: string, tz = DEFAULT_TZ): string {
  const d = new Date(isoDate);
  return d.toLocaleString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });
}

// ---- Concise confirmation after saving a memory ----

export function formatConfirmation(memory: DbMemory, tz = DEFAULT_TZ): {
  text: string;
  buttons: TelegramInlineKeyboardButton[][];
  needsDate: boolean;
} {
  const emoji = TYPE_EMOJI[memory.type] || "\u{1F4CB}";
  const desc = escapeHtml(memory.description);
  const parts = [`Saved \u{2705} ${emoji} <b>${desc}</b>`];

  if (memory.due_date) {
    parts.push(` \u{2014} ${escapeHtml(formatDate(memory.due_date, tz))}`);
    if (memory.reminder_at) {
      parts.push(`\nI'll remind you at ${escapeHtml(formatTime(memory.reminder_at, tz))}`);
    }
  }

  const needsDate = !memory.due_date && ["task", "reminder", "event"].includes(memory.type);

  if (needsDate) {
    parts.push("\nWhen should I remind you?");
  }

  const buttons: TelegramInlineKeyboardButton[][] = needsDate
    ? [
        [
          { text: "\u{1F305} Tomorrow 9 AM", callback_data: `quickdate:${memory.id}:tomorrow9am` },
          { text: "\u{23F1} In 1 hour", callback_data: `quickdate:${memory.id}:1hour` },
        ],
        [
          { text: "\u{1F6AB} No reminder", callback_data: `quickdate:${memory.id}:noreminder` },
          { text: "\u{2753} Wrong?", callback_data: `wrong:${memory.id}` },
        ],
      ]
    : [
        [
          { text: "\u{2705} Done", callback_data: `done:${memory.id}` },
          { text: "\u{1F5D1} Delete", callback_data: `delete:${memory.id}` },
          { text: "\u{2753} Wrong?", callback_data: `wrong:${memory.id}` },
        ],
      ];

  return { text: parts.join(""), buttons, needsDate };
}

// ---- Query results ----

export function formatQueryResults(memories: DbMemory[], queryText: string, tz = DEFAULT_TZ): string {
  if (memories.length === 0) {
    return `No results found for "${escapeHtml(queryText)}".`;
  }

  const lines = [`Here's what I found for "${escapeHtml(queryText)}":\n`];
  memories.forEach((m, i) => {
    const emoji = TYPE_EMOJI[m.type] || "\u{1F4CB}";
    const status = m.status === "done" ? "\u{2705}" : "\u{23F3}";
    const due = m.due_date ? ` (due: ${escapeHtml(formatDateShort(m.due_date, tz))})` : "";
    lines.push(`${i + 1}. ${emoji} ${status} ${escapeHtml(m.description)}${due}`);
  });

  return lines.join("\n");
}

// ---- Pending tasks list (paginated) ----

const PAGE_SIZE = 10;

export function formatPendingList(
  memories: DbMemory[],
  tz = DEFAULT_TZ,
  offset = 0,
): { text: string; buttons: TelegramInlineKeyboardButton[][] } {
  if (memories.length === 0) {
    return { text: "You have no pending tasks. Enjoy your free time!", buttons: [] };
  }

  const page = memories.slice(offset, offset + PAGE_SIZE);
  const hasMore = offset + PAGE_SIZE < memories.length;
  const showing = offset > 0
    ? `Showing ${offset + 1}\u{2013}${offset + page.length} of <b>${memories.length}</b> pending items:\n`
    : `You have <b>${memories.length}</b> pending items:\n`;

  const lines = [showing];
  page.forEach((m, i) => {
    const emoji = TYPE_EMOJI[m.type] || "\u{1F4CB}";
    const due = m.due_date ? ` \u{2014} due ${escapeHtml(formatDate(m.due_date, tz))}` : "";
    lines.push(`${offset + i + 1}. ${emoji} ${escapeHtml(m.description)}${due}`);
  });

  const buttons: TelegramInlineKeyboardButton[][] = [];
  if (hasMore) {
    buttons.push([{
      text: `\u{25B6}\u{FE0F} Show more (${memories.length - offset - PAGE_SIZE} remaining)`,
      callback_data: `page:${offset + PAGE_SIZE}`,
    }]);
  }

  return { text: lines.join("\n"), buttons };
}

// ---- Ambiguous date options ----

export function formatAmbiguousDate(
  memoryId: string,
  dateOptions: string[],
  tz = DEFAULT_TZ,
): { text: string; buttons: TelegramInlineKeyboardButton[][] } {
  const text = "I'm not sure which date you mean. Which one?";
  const buttons: TelegramInlineKeyboardButton[][] = [
    dateOptions.map((iso) => ({
      text: formatDate(iso, tz),
      callback_data: `date:${memoryId}:${iso}`,
    })),
  ];
  return { text, buttons };
}

// ---- Daily digest ----

export function formatDigest(
  firstName: string | null,
  overdue: DbMemory[],
  today: DbMemory[],
  tomorrow: DbMemory[],
  somedayCount: number,
  tz = DEFAULT_TZ,
  currentStreak = 0,
  longestStreak = 0,
): string {
  const name = escapeHtml(firstName || "there");
  const lines: string[] = [`Good morning, ${name}!\n`];

  if (overdue.length > 0) {
    lines.push("\u{1F6A8} <b>OVERDUE:</b>");
    overdue.forEach((m) => {
      lines.push(`  \u{2022} ${escapeHtml(m.description)} (was due ${escapeHtml(formatDateShort(m.due_date!, tz))})`);
    });
    lines.push("");
  }

  if (today.length > 0) {
    lines.push("\u{1F4CB} <b>DUE TODAY:</b>");
    today.forEach((m) => {
      const time = m.due_date ? ` at ${escapeHtml(formatTime(m.due_date, tz))}` : "";
      lines.push(`  \u{2022} ${escapeHtml(m.description)}${time}`);
    });
    lines.push("");
  }

  if (tomorrow.length > 0) {
    lines.push("\u{1F4C5} <b>COMING TOMORROW:</b>");
    tomorrow.forEach((m) => {
      lines.push(`  \u{2022} ${escapeHtml(m.description)}`);
    });
    lines.push("");
  }

  if (somedayCount > 0) {
    lines.push(`\u{1F4AD} + ${somedayCount} items with no deadline`);
  }

  if (currentStreak > 0) {
    lines.push("");
    lines.push(`\u{1F525} <b>${currentStreak}-day streak!</b>${longestStreak > currentStreak ? ` (best: ${longestStreak})` : currentStreak >= longestStreak ? " \u{2014} personal best!" : ""}`);
  }

  if (overdue.length === 0 && today.length === 0 && tomorrow.length === 0 && somedayCount === 0) {
    return "";
  }

  return lines.join("\n");
}

// ---- Reminder messages ----

export function formatReminder(memory: DbMemory, tz = DEFAULT_TZ): {
  text: string;
  buttons: TelegramInlineKeyboardButton[][];
} {
  const due = memory.due_date ? `\n<b>Due:</b> ${escapeHtml(formatDate(memory.due_date, tz))}` : "";
  const text = `\u{23F0} <b>Reminder:</b> ${escapeHtml(memory.description)}${due}`;
  const buttons: TelegramInlineKeyboardButton[][] = [
    [
      { text: "\u{2705} Done", callback_data: `done:${memory.id}` },
      { text: "\u{23F0} Snooze 1hr", callback_data: `snooze:${memory.id}` },
    ],
  ];
  return { text, buttons };
}

export function formatPreReminder(memory: DbMemory, tz = DEFAULT_TZ): {
  text: string;
  buttons: TelegramInlineKeyboardButton[][];
} {
  const due = memory.due_date ? `\n<b>Due:</b> ${escapeHtml(formatDate(memory.due_date, tz))}` : "";
  const text = `\u{1F514} <b>Heads up \u{2014} in 30 minutes:</b>\n${escapeHtml(memory.description)}${due}`;
  const buttons: TelegramInlineKeyboardButton[][] = [
    [
      { text: "\u{2705} Done", callback_data: `done:${memory.id}` },
      { text: "\u{23F0} Snooze 1hr", callback_data: `snooze:${memory.id}` },
    ],
  ];
  return { text, buttons };
}

// ---- Delete picker ----

export function formatDeleteOptions(
  memories: DbMemory[],
  prompt = "Which task would you like to delete?\n",
): { text: string; buttons: TelegramInlineKeyboardButton[][] } {
  const lines = [prompt];
  const buttons: TelegramInlineKeyboardButton[][] = [];

  memories.forEach((m, i) => {
    lines.push(`${i + 1}. ${escapeHtml(m.description)}`);
    buttons.push([{
      text: `\u{1F5D1} ${i + 1}. ${m.description.slice(0, 30)}`,
      callback_data: `delete:${m.id}`,
    }]);
  });

  return { text: lines.join("\n"), buttons };
}

// ---- Reschedule picker ----

export function formatRescheduleOptions(
  memories: DbMemory[],
  dateOnly: string,
  tz = DEFAULT_TZ,
): { text: string; buttons: TelegramInlineKeyboardButton[][] } {
  const d = new Date(dateOnly + "T12:00:00.000Z"); // noon UTC — safe for any timezone display
  const formatted = d.toLocaleString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: tz,
  });

  const lines = [`Which task would you like to reschedule to ${escapeHtml(formatted)}?\n`];
  const buttons: TelegramInlineKeyboardButton[][] = [];

  memories.slice(0, 5).forEach((m, i) => {
    lines.push(`${i + 1}. ${escapeHtml(m.description)}`);
    buttons.push([{
      text: `\u{1F4C5} ${i + 1}. ${m.description.slice(0, 25)}`,
      callback_data: `rsc:${m.id}:${dateOnly}`,
    }]);
  });

  return { text: lines.join("\n"), buttons };
}

// ---- Done command: multiple match picker ----

export function formatDoneOptions(
  memories: DbMemory[],
  prompt = "Multiple tasks match. Which one did you complete?\n",
): { text: string; buttons: TelegramInlineKeyboardButton[][] } {
  const lines = [prompt];
  const buttons: TelegramInlineKeyboardButton[][] = [];

  memories.forEach((m, i) => {
    lines.push(`${i + 1}. ${escapeHtml(m.description)}`);
    buttons.push([
      { text: `\u{2705} ${i + 1}. ${m.description.slice(0, 30)}`, callback_data: `done:${m.id}` },
    ]);
  });

  return { text: lines.join("\n"), buttons };
}
