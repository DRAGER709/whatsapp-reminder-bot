const { GoogleGenerativeAI } = require("@google/generative-ai");
const { OpenAI } = require("openai");
const { getUsage, track, LIMITS } = require("./usage");
require("dotenv").config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Tier 1: Gemini 3 Flash Preview
const gemini3Json = genAI.getGenerativeModel({
  model: "gemini-3-flash-preview",
  generationConfig: { responseMimeType: "application/json" },
});
const gemini3Text = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

// Tier 2: Gemini 2.5 Flash
const gemini25Json = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { responseMimeType: "application/json" },
});
const gemini25Text = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Tier 3: Groq — Llama 3.3 (free)
const groqAI = process.env.GROQ_API_KEY
  ? new OpenAI({
      baseURL: "https://api.groq.com/openai/v1",
      apiKey: process.env.GROQ_API_KEY,
    })
  : null;

// Tier 4: OpenRouter — GPT-4o-mini (paid fallback)
const backupAI = process.env.OPENROUTER_API_KEY
  ? new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
    })
  : null;

// ---------------------------------------------------------
// Feature 2: WhatsApp Markdown Formatter
// Runs only on summary/chat responses (isSummaryRequest = true).
// Converts standard Markdown to WhatsApp-compatible formatting.
// Intent JSON responses are never touched by this.
// ---------------------------------------------------------
function formatForWhatsApp(text) {
  return text
    // ## Heading / ### Heading → *HEADING*
    // Must run before bold so the * in the output isn't re-processed
    .replace(/^#{1,3}\s+(.+)$/gm, (_, heading) => `*${heading.toUpperCase()}*`)
    // **bold** or __bold__ → *bold*
    // Must run before the strikethrough/code passes — no italic conversion:
    // WhatsApp _italic_ is already correct in AI output; converting lone *italic*
    // would re-match the *bold* we just produced and break it
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    // ~~strikethrough~~ → ~strikethrough~
    .replace(/~~(.+?)~~/g, "~$1~")
    // `inline code` → ```inline code```
    .replace(/`([^`]+)`/g, "```$1```")
    // Horizontal rules --- or *** → blank line
    .replace(/^[-*]{3,}\s*$/gm, "")
    // Collapse 3+ consecutive blank lines to 2
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 4-Tier AI Waterfall Router
 *
 * Intent requests  (isSummaryRequest=false): returns parsed JSON with ai_meta field
 * Summary requests (isSummaryRequest=true):  returns { text: string, ai_meta: string }
 *                                            text is WhatsApp-formatted before return
 */
async function analyzeMessage(userMessage, isSummaryRequest = false, history = []) {
  const usageStats = await getUsage();
  const currentIST = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
    hour12: false,
  });

  const systemPrompt = `
  You are the intelligent brain of a personal WhatsApp assistant named Manvi.
  Your owner is Viswanath. You are currently talking to a user via WhatsApp.

  CRITICAL CONTEXT:
  The current date and time is: ${currentIST}.
  If the user provides a relative time like "in 5 minutes", calculate the exact HH:MM:SS from this reference.

  Your job is to extract the user's intent and return a JSON object.
  Respond with ONLY a valid raw JSON object. No markdown. No explanation.

  IMPORTANT RULES:
- "event": Use ONLY when the user is ASKING TO SAVE or ADD a new birthday, anniversary, or special date to the database. Do NOT use this if the user explicitly asks to be "reminded" of something.
- "query_birthday": Use ONLY when the user is ASKING FOR INFORMATION about an existing birthday (e.g., 'When is Manu's birthday?'). Do NOT use this if they are trying to save a date.
- "instant_message": Use to forward messages.
- "routine" intent is ONLY for fixed daily time (e.g., "every day at 9 AM"). NOT for interval-based reminders.
- "interval_reminder": Use when the user says "every X minutes", "every X hours". Extract intervalMinutes and durationHours (default 8).
- "weekly_reminder": Use when the user says "every Monday", "every Tuesday night", "each week on Friday". Extract dayOfWeek as a number (0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday).
- "monthly_reminder": Use when the user says "every month on the 1st", "on the 15th of every month", "remind me monthly". Extract dayOfMonth as a number (1-31).
- "delete_task": extract ONLY the core task name. Strip words like "routine", "reminder", "task", "event" from taskOrMessage.
- "reminder" intent: Use whenever the user explicitly asks to be "reminded" of something. taskOrMessage must be the actual task description.
- "edit_task": Use when the user wants to CHANGE, UPDATE, or CORRECT a previously set reminder/task. Examples: "Actually make that 6 PM", "Change the buy eggs reminder to 7 PM", "Move that to tomorrow". Extract the NEW time in the "time" field. Extract the task name being edited in the "editTarget" field (use context from conversation history). Extract new date in "date" if mentioned.
- Vague queries like "list all", "show everything" should be classified as "chat".
- MISSING TIME REQUIRED: When generating a "reminder", "routine", or "event" intent, you MUST extract the required time (or date for event). If there is NO time specified for a reminder/routine, or NO date specified for an event, DO NOT USE those intents. Instead, output intent "chat" with taskOrMessage "When would you like me to set this?".
- VAGUE TIME DEFAULTS: If the user says "morning" with no specific time, use 09:00:00. If they say "afternoon", use 14:00:00. If they say "evening" or "tonight", use 18:00:00. If they say "night", use 21:00:00. When you apply a default, you MUST append the resolved time to taskOrMessage so the confirmation reply surfaces it. Example: taskOrMessage: "Drink water (set for 9:00 AM)".

  JSON structure:
  {
  "intent": "reminder" | "routine" | "interval_reminder" | "weekly_reminder" | "monthly_reminder" | "event" | "instant_message" | "chat" | "query_birthday" | "query_schedule" | "query_routines" | "query_contacts" | "query_reminders" | "query_events" | "delete_task" | "edit_task" | "save_contact" | "web_search" | "unknown",
  "targetName": "you" (if message is for Viswanath) OR the extracted name,
  "time": "HH:MM:SS" (24-hour format, IST timezone, or null),
  "date": "YYYY-MM-DD" (if a date is mentioned or calculable, or null),
  "taskOrMessage": "For chat intent: provide a direct response. For save_contact: the extracted name. For all others: extract the task or search query.",
  "phone": "digits only for save_contact (no spaces, no +, no dashes), null for all others",
  "intervalMinutes": "number of minutes between repeats for interval_reminder, null for all others",
  "durationHours": "how many hours to keep repeating for interval_reminder (default 8), null for all others",
  "dayOfWeek": "0-6 for weekly_reminder (0=Sunday), null for all others",
  "dayOfMonth": "1-31 for monthly_reminder, null for all others",
  "editTarget": "the core task name being edited for edit_task (from context), null for all others"
}

  Examples:
  Message: "What was the recent F1 grand prix and who won?"
  JSON: {"intent": "web_search", "targetName": "you", "time": null, "date": null, "taskOrMessage": "recent F1 grand prix winner and location"}

  Message: "Remind me to pay rent on the 1st of every month at 9 AM"
  JSON: {"intent": "monthly_reminder", "targetName": "you", "time": "09:00:00", "date": null, "taskOrMessage": "pay rent", "dayOfMonth": 1}

  Message: "Remind me to take out the trash every Tuesday at 8 PM"
  JSON: {"intent": "weekly_reminder", "targetName": "you", "time": "20:00:00", "date": null, "taskOrMessage": "take out the trash", "dayOfWeek": 2}

  Message: "Actually make that 6 PM" (after setting a reminder for "buy eggs" at 5 PM)
  JSON: {"intent": "edit_task", "targetName": "you", "time": "18:00:00", "date": null, "taskOrMessage": "buy eggs", "editTarget": "buy eggs"}

  Message: "Change the buy eggs reminder to 7 PM"
  JSON: {"intent": "edit_task", "targetName": "you", "time": "19:00:00", "date": null, "taskOrMessage": "buy eggs", "editTarget": "buy eggs"}

  Message: "Remind me tomorrow morning to call the doctor"
  JSON: {"intent": "reminder", "targetName": "you", "time": "09:00:00", "date": "2026-03-16", "taskOrMessage": "call the doctor (set for 9:00 AM)"}

  Message: "What contacts do you have?"
  JSON: {"intent": "query_contacts", "targetName": "you", "time": null, "date": null, "taskOrMessage": null}

  Message: "Show me all active reminders"
  JSON: {"intent": "query_reminders", "targetName": "you", "time": null, "date": null, "taskOrMessage": null}

  Message: "List my daily routines"
  JSON: {"intent": "query_routines", "targetName": "you", "time": null, "date": null, "taskOrMessage": null}

  Message: "When is Mom's birthday?"
  JSON: {"intent": "query_birthday", "targetName": "Mom", "time": null, "date": null, "taskOrMessage": null}

  Message: "Remind me in 5 minutes to check logs"
  JSON: {"intent": "reminder", "targetName": "you", "time": "14:12:00", "date": null, "taskOrMessage": "check logs"}

  Message: "Tell me a joke"
  JSON: {"intent": "chat", "targetName": null, "time": null, "date": null, "taskOrMessage": "Why do programmers prefer dark mode? Because light attracts bugs."}

  Message: "Delete the reminder to drink water"
  JSON: {"intent": "delete_task", "targetName": "you", "time": null, "date": null, "taskOrMessage": "drink water", "phone": null}

  Message: "Remind me every 30 minutes to drink water"
  JSON: {"intent": "interval_reminder", "targetName": "you", "time": null, "date": null, "taskOrMessage": "drink water", "intervalMinutes": 30, "durationHours": 8}

  Message: "Save mom as 919876543210"
  JSON: {"intent": "save_contact", "targetName": "Mom", "time": null, "date": null, "taskOrMessage": "Mom", "phone": "919876543210"}

  ${
    history.length > 0
      ? `CONVERSATION HISTORY (last ${history.length} turns, oldest first):
${history.map((h, i) => `Turn ${i + 1}:\n  User: ${h.userMessage}\n  Manvi: ${h.botResponse}`).join("\n")}

Use this history ONLY to understand follow-up context (e.g. "who was the captain?" after a cricket question, or "actually make that 6 PM" after setting a reminder). Do not re-execute past intents. For edit_task, use the history to identify which task is being referenced in "editTarget".`
      : ""
  }

  Message: "${userMessage}"
  `;

  const promptToSend = isSummaryRequest
    ? `Summarize the following search results concisely in plain text. No JSON, no markdown:\n\n${userMessage}`
    : systemPrompt;

  const openAIMessages = [
    {
      role: "system",
      content: isSummaryRequest
        ? "You are Manvi. Summarize search results concisely in plain text."
        : systemPrompt,
    },
    { role: "user", content: userMessage },
  ];

  // --- TIER 1 & 2: GOOGLE GEMINI ---
  let googleResponseText = null;
  let activeBrain = "Gemini 3 Flash";

  if (usageStats.gemini < LIMITS.gemini) {
    try {
      const model = isSummaryRequest ? gemini3Text : gemini3Json;
      const result = await model.generateContent(promptToSend);
      googleResponseText = result.response.text();
    } catch {
      console.warn("[gemini] Tier 1 failed, cascading to Tier 2");
      try {
        const model = isSummaryRequest ? gemini25Text : gemini25Json;
        const result = await model.generateContent(promptToSend);
        googleResponseText = result.response.text();
        activeBrain = "Gemini 2.5 Flash";
      } catch {
        console.warn("[gemini] Tier 2 failed, cascading to Groq");
      }
    }
  }

  if (googleResponseText) {
    await track("gemini");
    const remaining = LIMITS.gemini - (usageStats.gemini + 1);
    const ai_meta = `${activeBrain} — ${remaining} remaining`;

    if (isSummaryRequest) return { text: formatForWhatsApp(googleResponseText), ai_meta };

    const match = googleResponseText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in Gemini response");

    const parsed = JSON.parse(match[0]);
    parsed.ai_meta = ai_meta;
    return parsed;
  }

  // --- TIER 3: GROQ (FREE — LLAMA 3.3) ---
  if (groqAI) try {
    console.log("[groq] Routing to Tier 3");
    const response = await groqAI.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: openAIMessages,
      ...(!isSummaryRequest && { response_format: { type: "json_object" } }),
    });

    await track("groq");
    const text = response.choices[0].message.content;
    const remaining = LIMITS.groq - (usageStats.groq + 1);
    const ai_meta = `Groq Llama 3.3 — ${remaining} remaining`;

    if (isSummaryRequest) return { text: formatForWhatsApp(text), ai_meta };

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in Groq response");

    const parsed = JSON.parse(match[0]);
    parsed.ai_meta = ai_meta;
    return parsed;
  } catch (err) {
    console.warn("[groq] Tier 3 failed, cascading to OpenRouter:", err.message);
  }

  // --- TIER 4: OPENROUTER (PAID — GPT-4o-mini) ---
  if (backupAI) try {
    console.log("[openrouter] Routing to Tier 4");
    const response = await backupAI.chat.completions.create({
      model: "openai/gpt-4o-mini",
      messages: openAIMessages,
      ...(!isSummaryRequest && { response_format: { type: "json_object" } }),
    });

    await track("openrouter");
    const text = response.choices[0].message.content;
    const ai_meta = `OpenRouter GPT-4o-mini`;

    if (isSummaryRequest) return { text: formatForWhatsApp(text), ai_meta };

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in OpenRouter response");

    const parsed = JSON.parse(match[0]);
    parsed.ai_meta = ai_meta;
    return parsed;
  } catch (err) {
    console.error("[openrouter] All tiers exhausted:", err.message);
    await track("error");
    return {
      intent: "api_error",
      targetName: "you",
      time: null,
      date: null,
      taskOrMessage: "All AI models are currently offline or daily limits have been reached.",
    };
  }
}

module.exports = { analyzeMessage };