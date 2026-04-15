import { GeminiParsedResponse, ConversationMessage } from "./types.ts";
import { TZ_OFFSETS } from "./constants.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const EMBEDDING_URL = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`;

function getCurrentDatetime(timezone: string): string {
  const now = new Date();
  const utcIso = now.toISOString();
  const offsetHours = TZ_OFFSETS[timezone] ?? 5.5; // fallback IST
  const offset = offsetHours * 60 * 60 * 1000;
  const local = new Date(now.getTime() + offset);
  const localStr = local.toISOString().replace("T", " ").replace("Z", "");
  const sign = offsetHours >= 0 ? "+" : "-";
  const absH = Math.floor(Math.abs(offsetHours));
  const absM = Math.round((Math.abs(offsetHours) % 1) * 60);
  const offsetStr = `${sign}${String(absH).padStart(2, "0")}:${String(absM).padStart(2, "0")}`;
  return `UTC now: ${utcIso} | Local time (${timezone}, UTC${offsetStr}): ${localStr}`;
}

const PARSE_SYSTEM_PROMPT = `You are a personal memory assistant that extracts structured information from user messages. The user may write in English, Hindi, Hinglish (mixed Hindi-English), or Marathi.

Current date and time: {CURRENT_DATETIME}
User's timezone: {USER_TIMEZONE}

CRITICAL — all due_date, reminder_at, reschedule_to, and date_options values MUST be in UTC (Z suffix).
You are given both the current UTC time and the user's local time above.
- For RELATIVE times ("in 10 minutes", "in 1 hour"), add the offset directly to the UTC time shown above — do NOT convert from local time.
- For ABSOLUTE local times ("at 5 PM", "tomorrow 9 AM"), convert to UTC by SUBTRACTING the UTC offset shown above.
  Example: 5:00 PM IST (UTC+05:30) → 5:00 PM − 5h30m = 11:30 AM UTC → "...T11:30:00.000Z"

You may receive prior conversation messages for context. Use them to understand references like "this", "that", "it", pronouns, and follow-up instructions.

Analyze the user's message. If it contains MULTIPLE separate tasks or items, return a JSON ARRAY of objects (one per distinct task/item). If it contains a single item, return a single JSON object. No markdown, no explanation, no code fences.

Each object should have this structure:

{
  "intent": "task" | "reminder" | "event" | "birthday" | "note" | "query" | "greeting" | "done" | "reschedule" | "delete" | "edit" | "status" | "casual" | "unknown",
  "description": "Clean, concise description of the task/note/event",
  "due_date": "ISO 8601 UTC datetime string (Z suffix) or null",
  "reminder_at": "ISO 8601 UTC datetime for when to send reminder, or null. If user specifies a time, set reminder 30 minutes before that time. If only date is given, set reminder to 9:00 AM local time converted to UTC on that date.",
  "entities": {
    "people": ["list of people mentioned"],
    "projects": ["list of projects/topics"],
    "locations": ["list of locations"]
  },
  "recurrence": "daily" | "weekly" | "yearly" | null,
  "priority": "high" | "medium" | "low",
  "query_text": "If intent is 'query', the search terms to look for. null otherwise.",
  "reschedule_to": "If intent is 'reschedule', the new due date as ISO 8601 datetime. null otherwise.",
  "target_index": "If user references a numbered item from a list (e.g. 'delete 2', 'mark 1 done'), the number. null otherwise.",
  "edit_field": "type" | "description" | "due_date" | null — for edit intent, which property to change. null otherwise.",
  "edit_value": "For edit intent, the new value (e.g. 'birthday', 'Call Aman', '2025-04-20'). null otherwise.",
  "confidence": 0.0-1.0,
  "ambiguous_date": true | false,
  "date_options": ["If ambiguous_date is true, list possible date interpretations as ISO 8601 strings"],
  "query_date_start": "If intent is 'query' and the user asks about a date range ('this week', 'today', 'last Tuesday'), ISO 8601 start datetime. null otherwise.",
  "query_date_end": "If intent is 'query' and the user asks about a date range, ISO 8601 end datetime. null otherwise."
}

Rules:

Date & time interpretation:
- If today is X-day and user says "X-day" (same day name), interpret as NEXT week's X-day (7 days), not today. "This X-day" = today.
- "next Friday" = the Friday of NEXT week (never today/tomorrow even if today is Thursday)
- "this Friday" = the closest upcoming Friday (could be today if today is Friday)
- "tomorrow" / "kal" = next calendar day. "day after" / "parson" = 2 days from now.
- Time-of-day defaults (in user's local timezone): "morning" / "subah" = 9:00 AM, "afternoon" / "dopahar" = 2:00 PM, "evening" / "sham" / "sandhyakali" = 6:00 PM, "night" / "raat" = 9:00 PM
- "EOD" / "end of day" = 6:00 PM local time. "EOW" / "end of week" = Friday 6:00 PM local time.
- "next week" = Monday of the following week, 9:00 AM local. "next month" = 1st of next month, 9:00 AM local.
- "weekend" / "this weekend" = Saturday 9:00 AM local.
- If a time is given without AM/PM: 1-6 = PM, 7-11 = AM, 12 = PM (noon).

Hindi / Hinglish temporal expressions:
- "kal" = tomorrow, "parson" / "parso" = day after tomorrow, "aaj" = today, "abhi" = right now
- "agle hafte" / "agla hafta" = next week, "is hafte" = this week
- "mahine ke end mein" = end of month, "agle mahine" = next month
- "subah" = morning (9 AM), "dopahar" = afternoon (2 PM), "sham" / "shaam" = evening (6 PM), "raat" = night (9 PM)
- "ek ghante mein" = in 1 hour, "aadha ghanta" = 30 minutes, "das minute" = 10 minutes
- "somvaar" = Monday, "mangalvaar" = Tuesday, "budhvaar" = Wednesday, "guruvaar" / "brihaspativaar" = Thursday, "shukravaar" = Friday, "shanivaar" = Saturday, "ravivaar" = Sunday

Marathi temporal expressions:
- "udya" = tomorrow, "parva" = day after tomorrow, "aaj" = today
- "pudchya aathavdyat" = next week, "ya aathavdyat" = this week
- "sakaali" = morning, "dupari" = afternoon, "sandhyakali" = evening, "raatri" = night

General rules:
- If no date/time is mentioned for a task, set due_date to null (it's a someday task)
- If the user is asking a question about their stored data, set intent to "query"
- For queries with time filters ("this week", "today", "last Tuesday", "what did I add yesterday"), set query_date_start and query_date_end to define the date range to search within
- If the user says something like "done with X" or "finished X", set intent to "done"
- If the user wants to postpone, reschedule, or move an existing task to a later date ("can't do this today", "reschedule to X", "move to X", "postpone"), set intent to "reschedule". Put the new date in reschedule_to. The description should describe the task being rescheduled (may be vague like "this").
- If the user wants to remove/delete a specific task ("delete 2", "remove that task", "get rid of the reschedule task"), set intent to "delete"
- If the user wants to change a property of an existing task ("1 is birthday not task", "change type to event", "update the description"), set intent to "edit". Set edit_field and edit_value.
- If the user asks about their progress, status, or how they're doing ("how am I doing?", "what's my progress?", "status"), set intent to "status"
- If the user references a numbered item from a list (e.g. "delete 2", "mark 1 done", "reschedule 3 to Friday"), extract the number into target_index
- CRITICAL: When the user is managing, referencing, correcting, or discussing existing data (by number, by name, or by correction), NEVER classify as task/reminder/event/birthday/note — that would create unwanted duplicates. Use done, delete, edit, reschedule, or query instead.
- If the conversation history shows the bot just saved a task/reminder and asked "when should I remind you?", and the user responds with a date/time (e.g. "tomorrow 5pm", "in 2 hours", "Monday"), set intent to "edit" with edit_field "due_date" and edit_value as ISO 8601. Set description to match the task being discussed.
- If the user sends a casual/social message that is NOT a task ("nothing for today", "I'm off", "thanks", "good night", "nice"), set intent to "casual". Do NOT classify as "unknown".
- Birthday: extract the person's name and the date. Set recurrence to "yearly". If user says "remind 2 days before", set reminder_at to 2 days before the birthday, NOT 30 minutes.
- For voice transcriptions, clean up filler words but preserve the core meaning
- IMPORTANT: If the user mentions multiple separate tasks in one message (e.g. "remind me about X, and also Y, and I need to do Z"), create a SEPARATE entry for EACH distinct task. Return a JSON array of objects, one per task. Each gets its own description, due_date, reminder_at, etc.

Few-shot examples (assuming Asia/Kolkata, UTC+05:30):

User: "remind me to call mom"
→ {"intent":"task","description":"Call mom","due_date":null,"reminder_at":null,...}

User: "bday sister 14th may, remind 2 days before"
→ {"intent":"birthday","description":"Sister's birthday","due_date":"2026-05-14T18:30:00.000Z","reminder_at":"2026-05-12T03:30:00.000Z","recurrence":"yearly",...}

[After bot saved "Call mom" and asked when to remind]
User: "tomorrow 5pm"
→ {"intent":"edit","description":"Call mom","edit_field":"due_date","edit_value":"2026-04-14T11:30:00.000Z",...}
(5 PM IST = 5:00 − 5:30 = 11:30 UTC)

[If current UTC is 2026-04-13T18:05:00Z]
User: "remind me in 10 minutes to call Aman"
→ {"intent":"reminder","description":"Call Aman","due_date":"2026-04-13T18:15:00.000Z","reminder_at":"2026-04-13T18:15:00.000Z",...}
(Add 10 min directly to the UTC time: 18:05 + 10 = 18:15 UTC)

User: "nothing for today, I'm off"
→ {"intent":"casual","description":"User taking day off",...}

User: "move the 5 PM meeting to 7"
→ {"intent":"reschedule","description":"5 PM meeting","reschedule_to":"2026-04-13T13:30:00.000Z",...}
(7 PM IST = 7:00 − 5:30 = 13:30 UTC)`;

export async function parseMessage(
  userMessage: string,
  conversationHistory: ConversationMessage[] = [],
  userTimezone = "Asia/Kolkata",
): Promise<GeminiParsedResponse[]> {
  const systemPrompt = PARSE_SYSTEM_PROMPT
    .replace("{CURRENT_DATETIME}", getCurrentDatetime(userTimezone))
    .replace("{USER_TIMEZONE}", userTimezone);

  // Build contents array with conversation history for context
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  for (const msg of conversationHistory) {
    contents.push({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.text }],
    });
  }
  contents.push({ role: "user", parts: [{ text: userMessage }] });

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      response_mime_type: "application/json",
    },
  };

  // Try up to 2 times (initial + 1 retry)
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Gemini API error (attempt ${attempt + 1}): ${res.status} ${errText}`);
      if (attempt === 1) throw new Error(`Gemini API failed: ${res.status}`);
      continue;
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error(`Gemini returned no text (attempt ${attempt + 1})`);
      if (attempt === 1) throw new Error("Gemini returned empty response");
      continue;
    }

    try {
      // Strip any markdown code fences if Gemini adds them despite instructions
      const cleaned = text.replace(/\`\`\`json\n?/g, "").replace(/\`\`\`\n?/g, "").trim();
      const parsed = JSON.parse(cleaned);
      // Normalize: single object → array of one
      return Array.isArray(parsed)
        ? (parsed as GeminiParsedResponse[])
        : [parsed as GeminiParsedResponse];
    } catch (parseErr) {
      console.error(`JSON parse failed (attempt ${attempt + 1}):`, text);
      if (attempt === 1) throw new Error("Gemini returned invalid JSON");
    }
  }

  throw new Error("Gemini parsing failed after retries");
}

export async function transcribeAudio(audioBytes: Uint8Array): Promise<string> {
  // Convert to base64 for Gemini inline_data (chunked to avoid max arguments limit)
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < audioBytes.length; i += chunkSize) {
    const chunk = audioBytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  const base64Audio = btoa(binary);

  const body = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: "audio/ogg",
              data: base64Audio,
            },
          },
          {
            text: "Transcribe this audio accurately. The speaker may use English, Hindi, Hinglish, or Marathi. Output only the transcription, nothing else.",
          },
        ],
      },
    ],
  };

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Gemini transcription error: ${res.status} ${errText}`);
    throw new Error(`Gemini transcription failed: ${res.status}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || text.trim().length === 0) {
    throw new Error("Gemini transcription returned empty");
  }

  return text.trim();
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const body = {
    model: "models/text-embedding-004",
    content: { parts: [{ text }] },
  };

  const res = await fetch(EMBEDDING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Embedding error: ${res.status} ${errText}`);
    throw new Error(`Embedding failed: ${res.status}`);
  }

  const data = await res.json();
  return data.embedding.values;
}
