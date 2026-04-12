import { GeminiParsedResponse } from "./types.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

function getCurrentDatetimeIST(): string {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  return ist.toISOString().replace("T", " ").replace("Z", " IST");
}

const PARSE_SYSTEM_PROMPT = `You are a personal memory assistant that extracts structured information from user messages. The user may write in English, Hindi, Hinglish (mixed Hindi-English), or Marathi.

Current date and time: {CURRENT_DATETIME}
User's timezone: Asia/Kolkata

Analyze the user's message and respond with ONLY a JSON object (no markdown, no explanation, no code fences):

{
  "intent": "task" | "reminder" | "event" | "birthday" | "note" | "query" | "greeting" | "done" | "unknown",
  "description": "Clean, concise description of the task/note/event",
  "due_date": "ISO 8601 datetime string or null",
  "reminder_at": "ISO 8601 datetime for when to send reminder, or null. If user specifies a time, set reminder 30 minutes before that time. If only date is given, set reminder to 9:00 AM on that date.",
  "entities": {
    "people": ["list of people mentioned"],
    "projects": ["list of projects/topics"],
    "locations": ["list of locations"]
  },
  "recurrence": "daily" | "weekly" | "yearly" | null,
  "priority": "high" | "medium" | "low",
  "query_text": "If intent is 'query', the search terms to look for. null otherwise.",
  "confidence": 0.0-1.0,
  "ambiguous_date": true | false,
  "date_options": ["If ambiguous_date is true, list possible date interpretations as ISO 8601 strings"]
}

Rules:
- "kal" means tomorrow, "parson" means day after tomorrow, "aaj" means today
- "next Friday" when today is Thursday means the Friday of NEXT week, not tomorrow
- "EOD" means 6:00 PM IST, "EOW" means Friday 6:00 PM IST
- If no date/time is mentioned for a task, set due_date to null (it's a someday task)
- If the user is asking a question about their stored data, set intent to "query"
- If the user says something like "done with X" or "finished X", set intent to "done"
- Birthday: extract the person's name and the date. Set recurrence to "yearly"
- For voice transcriptions, clean up filler words but preserve the core meaning`;

export async function parseMessage(userMessage: string): Promise<GeminiParsedResponse> {
  const systemPrompt = PARSE_SYSTEM_PROMPT.replace(
    "{CURRENT_DATETIME}",
    getCurrentDatetimeIST(),
  );

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userMessage }] }],
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
      return JSON.parse(cleaned) as GeminiParsedResponse;
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
