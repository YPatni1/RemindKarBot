import { DbMemory, TelegramInlineKeyboardButton } from "./types.ts";

const TYPE_EMOJI: Record<string, string> = {
  task: "\u{1F4CB}",
  reminder: "\u{23F0}",
  note: "\u{1F4DD}",
  event: "\u{1F4C5}",
  birthday: "\u{1F382}",
};

function formatDate(isoDate: string | null): string {
  if (!isoDate) return "No deadline";
  const d = new Date(isoDate);
  return d.toLocaleString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function formatDateShort(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
}

function formatTime(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

// ---- Confirmation after saving a memory ----

export function formatConfirmation(memory: DbMemory): {
  text: string;
  buttons: TelegramInlineKeyboardButton[][];
} {
  const emoji = TYPE_EMOJI[memory.type] || "\u{1F4CB}";
  const lines = [
    "Got it! Here's what I saved:\n",
    `${emoji} *${memory.type.charAt(0).toUpperCase() + memory.type.slice(1)}:* ${memory.description}`,
  ];

  if (memory.due_date) {
    lines.push(`\u{1F4C6} *Due:* ${formatDate(memory.due_date)}`);
  } else {
    lines.push(`\u{1F4C6} *Due:* No deadline`);
  }

  if (memory.reminder_at) {
    lines.push(`\u{1F514} *Reminder:* ${formatDate(memory.reminder_at)}`);
  }

  const entities = memory.entities as { people?: string[] } | null;
  if (entities?.people && entities.people.length > 0) {
    lines.push(`\u{1F465} *People:* ${entities.people.join(", ")}`);
  }

  const buttons: TelegramInlineKeyboardButton[][] = [
    [
      { text: "\u{2705} Done", callback_data: `done:${memory.id}` },
      { text: "\u{23F0} Snooze 1hr", callback_data: `snooze:${memory.id}` },
      { text: "\u{1F5D1} Delete", callback_data: `delete:${memory.id}` },
    ],
  ];

  return { text: lines.join("\n"), buttons };
}

// ---- Query results ----

export function formatQueryResults(memories: DbMemory[], queryText: string): string {
  if (memories.length === 0) {
    return `No results found for "${queryText}".`;
  }

  const lines = [`Here's what I found for "${queryText}":\n`];
  memories.forEach((m, i) => {
    const emoji = TYPE_EMOJI[m.type] || "\u{1F4CB}";
    const status = m.status === "done" ? "\u{2705}" : "\u{23F3}";
    const due = m.due_date ? ` (due: ${formatDateShort(m.due_date)})` : "";
    lines.push(`${i + 1}. ${emoji} ${status} ${m.description}${due}`);
  });

  return lines.join("\n");
}

// ---- Pending tasks list ----

export function formatPendingList(memories: DbMemory[]): string {
  if (memories.length === 0) {
    return "You have no pending tasks. Enjoy your free time!";
  }

  const lines = [`You have *${memories.length}* pending items:\n`];
  memories.forEach((m, i) => {
    const emoji = TYPE_EMOJI[m.type] || "\u{1F4CB}";
    const due = m.due_date ? ` \u{2014} due ${formatDate(m.due_date)}` : "";
    lines.push(`${i + 1}. ${emoji} ${m.description}${due}`);
  });

  return lines.join("\n");
}

// ---- Ambiguous date options ----

export function formatAmbiguousDate(
  memoryId: string,
  dateOptions: string[],
): { text: string; buttons: TelegramInlineKeyboardButton[][] } {
  const text = "I'm not sure which date you mean. Which one?";
  const buttons: TelegramInlineKeyboardButton[][] = [
    dateOptions.map((iso) => ({
      text: formatDate(iso),
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
): string {
  const name = firstName || "there";
  const lines: string[] = [`Good morning, ${name}!\n`];

  if (overdue.length > 0) {
    lines.push("\u{1F6A8} *OVERDUE:*");
    overdue.forEach((m) => {
      lines.push(`  \u{2022} ${m.description} (was due ${formatDateShort(m.due_date!)})`);
    });
    lines.push("");
  }

  if (today.length > 0) {
    lines.push("\u{1F4CB} *DUE TODAY:*");
    today.forEach((m) => {
      const time = m.due_date ? ` at ${formatTime(m.due_date)}` : "";
      lines.push(`  \u{2022} ${m.description}${time}`);
    });
    lines.push("");
  }

  if (tomorrow.length > 0) {
    lines.push("\u{1F4C5} *COMING TOMORROW:*");
    tomorrow.forEach((m) => {
      lines.push(`  \u{2022} ${m.description}`);
    });
    lines.push("");
  }

  if (somedayCount > 0) {
    lines.push(`\u{1F4AD} + ${somedayCount} items with no deadline`);
  }

  if (overdue.length === 0 && today.length === 0 && tomorrow.length === 0 && somedayCount === 0) {
    return ""; // Empty string signals "skip this user" to the digest sender
  }

  return lines.join("\n");
}

// ---- Reminder messages ----

export function formatReminder(memory: DbMemory): {
  text: string;
  buttons: TelegramInlineKeyboardButton[][];
} {
  const due = memory.due_date ? `\n*Due:* ${formatDate(memory.due_date)}` : "";
  const text = `\u{23F0} *Reminder:* ${memory.description}${due}`;
  const buttons: TelegramInlineKeyboardButton[][] = [
    [
      { text: "\u{2705} Done", callback_data: `done:${memory.id}` },
      { text: "\u{23F0} Snooze 1hr", callback_data: `snooze:${memory.id}` },
    ],
  ];
  return { text, buttons };
}

export function formatPreReminder(memory: DbMemory): {
  text: string;
  buttons: TelegramInlineKeyboardButton[][];
} {
  const text = `\u{1F514} *Heads up \u{2014} in 30 minutes:*\n${memory.description}`;
  const buttons: TelegramInlineKeyboardButton[][] = [
    [
      { text: "\u{2705} Done", callback_data: `done:${memory.id}` },
      { text: "\u{23F0} Snooze 1hr", callback_data: `snooze:${memory.id}` },
    ],
  ];
  return { text, buttons };
}

// ---- Done command: multiple match picker ----

export function formatDoneOptions(
  memories: DbMemory[],
): { text: string; buttons: TelegramInlineKeyboardButton[][] } {
  const lines = ["Multiple tasks match. Which one did you complete?\n"];
  const buttons: TelegramInlineKeyboardButton[][] = [];

  memories.forEach((m, i) => {
    lines.push(`${i + 1}. ${m.description}`);
    buttons.push([
      { text: `\u{2705} ${i + 1}. ${m.description.slice(0, 30)}`, callback_data: `done:${m.id}` },
    ]);
  });

  return { text: lines.join("\n"), buttons };
}
