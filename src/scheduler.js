require("dotenv").config();
const cron = require("node-cron");
const axios = require("axios");
const sendWhatsAppMessage = require("./sendMessage");
const supabase = require("./supabase");
const { ensureRowExists } = require("./usage");

function getISTComponents() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });

  const [{ value: day }, , { value: month }] = formatter.formatToParts(now);

  const dowFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  });
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dowStr = dowFormatter.format(now).slice(0, 3);

  return {
    day: parseInt(day),
    month: parseInt(month),
    dayOfWeek: dowMap[dowStr],
    todayIST: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
    }).format(now),
    timeStr: new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now),
  };
}

// Guard flags — prevent overlapping executions
let reminderRunning = false;
let routineRunning = false;
let recurringRunning = false;
let emiRunning = false;
let eventAlertRunning = false;

// Heartbeat tracking (in-memory fallback for dashboard)
const lastHeartbeats = {
  "Reminder Dispatch": null,
  "Routine Dispatch": null,
  "Recurring Task Dispatch": null,
  "EMI Dispatch": null,
  "Event Alert": null,
};

async function recordHeartbeat(jobName) {
  const now = new Date().toISOString();
  lastHeartbeats[jobName] = now;
  try {
    await ensureRowExists();
    await supabase
      .from("system_jobs")
      .upsert({ job_name: jobName, last_fired: now, status: "active" }, { onConflict: "job_name" });
  } catch (_) {
    // in-memory fallback already set
  }
}

// -----------------------------------------------------------------------
// Exported dispatch functions — called by both cron AND /api/tick
// -----------------------------------------------------------------------

async function runReminderDispatch() {
  if (reminderRunning) return;
  reminderRunning = true;

  try {
    const now = new Date().toISOString();

    const { data: dueReminders } = await supabase
      .from("personal_reminders")
      .select("*")
      .lte("reminder_time", now)
      .eq("status", "pending");

    for (const reminder of dueReminders || []) {
      // Atomic claim — skips row if already taken by a concurrent dispatcher
      const { data: claimed } = await supabase
        .from("personal_reminders")
        .update({ status: "completed" })
        .eq("id", reminder.id)
        .eq("status", "pending")
        .select("id");
      if (!claimed?.length) continue;

      try {
        await sendWhatsAppMessage(reminder.phone, reminder.message);
      } catch (_) {
        // Revert so it retries next cycle
        await supabase.from("personal_reminders").update({ status: "pending" }).eq("id", reminder.id);
      }
    }
  } catch (_) {
    // DB error — will retry next cycle
  } finally {
    reminderRunning = false;
    await recordHeartbeat("Reminder Dispatch");
  }
}

async function runRoutineDispatch() {
  if (routineRunning) return;
  routineRunning = true;

  try {
    const { timeStr, todayIST } = getISTComponents();

    const { data: routines } = await supabase
      .from("daily_routines")
      .select("*")
      .eq("is_active", true)
      .or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`);

    for (const routine of routines || []) {
      if (timeStr < routine.reminder_time.slice(0, 5)) continue;

      const { data: claimed } = await supabase
        .from("daily_routines")
        .update({ last_fired_date: todayIST })
        .eq("id", routine.id)
        .or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`)
        .select("id");
      if (!claimed?.length) continue;

      try {
        await sendWhatsAppMessage(routine.phone, routine.task_name);
      } catch (_) {
        await supabase.from("daily_routines").update({ last_fired_date: null }).eq("id", routine.id);
      }
    }
  } catch (_) {
    // DB error — will retry next cycle
  } finally {
    routineRunning = false;
    await recordHeartbeat("Routine Dispatch");
  }
}

async function runRecurringDispatch() {
  if (recurringRunning) return;
  recurringRunning = true;

  try {
    const { day, dayOfWeek, timeStr, todayIST } = getISTComponents();

    const { data: tasks } = await supabase
      .from("recurring_tasks")
      .select("*")
      .eq("is_active", true)
      .or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`);

    for (const task of tasks || []) {
      if (timeStr < task.reminder_time.slice(0, 5)) continue;

      let shouldFire = false;
      if (task.recurrence_type === "weekly") {
        shouldFire = task.day_of_week === dayOfWeek;
      } else if (task.recurrence_type === "monthly") {
        const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
        const tomorrowIST = new Date(nowIST);
        tomorrowIST.setDate(tomorrowIST.getDate() + 1);
        const isLastDayOfMonth = tomorrowIST.getDate() === 1;
        shouldFire = (isLastDayOfMonth && task.day_of_month > day) || task.day_of_month === day;
      }

      if (!shouldFire) continue;

      const { data: claimed } = await supabase
        .from("recurring_tasks")
        .update({ last_fired_date: todayIST })
        .eq("id", task.id)
        .or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`)
        .select("id");
      if (!claimed?.length) continue;

      try {
        await sendWhatsAppMessage(task.phone, task.task_name);
      } catch (_) {
        await supabase.from("recurring_tasks").update({ last_fired_date: null }).eq("id", task.id);
      }
    }
  } catch (_) {
    // DB error — will retry next cycle
  } finally {
    recurringRunning = false;
    await recordHeartbeat("Recurring Task Dispatch");
  }
}


async function sendTextBeeSms(phone, message) {
  if (!process.env.TEXTBEE_API_KEY) throw new Error("TEXTBEE_API_KEY is not configured");

  const body = JSON.stringify({
    recipients: [phone],
    message,
    ...(process.env.TEXTBEE_DEVICE_ID ? { deviceId: process.env.TEXTBEE_DEVICE_ID } : {}),
  });

  return new Promise((resolve, reject) => {
    const https = require("https");
    const request = https.request({
      hostname: "api.textbee.dev",
      path: "/api/v1/gateway/send-sms",
      method: "POST",
      headers: {
        "x-api-key": process.env.TEXTBEE_API_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 15000,
    }, (response) => {
      let raw = "";
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch (_) {}
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(new Error(`TextBee HTTP ${response.statusCode}: ${parsed.message || raw || response.statusMessage}`));
        }
      });
    });

    request.on("timeout", () => request.destroy(new Error("TextBee request timed out")));
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function nextMonthlyDueAt(dueAt, now = new Date()) {
  const due = new Date(dueAt);
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(due);
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const year = Number(p.find(x => x.type === "year").value);
  const month = Number(p.find(x => x.type === "month").value);
  const originalDay = Number(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", day: "2-digit"
  }).format(due));
  const days = (y,m) => new Date(Date.UTC(y,m,0)).getUTCDate();
  let y=year, m=month;
  let day=Math.min(originalDay, days(y,m));
  let candidate=new Date(`${y}-${String(m).padStart(2,"0")}-${String(day).padStart(2,"0")}T${clock}:00+05:30`);
  if (candidate <= now) {
    m++;
    if (m===13) {m=1; y++;}
    day=Math.min(originalDay, days(y,m));
    candidate=new Date(`${y}-${String(m).padStart(2,"0")}-${String(day).padStart(2,"0")}T${clock}:00+05:30`);
  }
  return candidate;
}

async function runEmiDispatch() {
  if (emiRunning) return;
  emiRunning = true;
  try {
    const now = new Date();
    const nowMs = now.getTime();
    const { data, error } = await supabase.from("emi_reminders").select("*").eq("is_active", true);
    if (error) throw error;

    for (const emi of data || []) {
      const dueMs = new Date(emi.due_at).getTime();
      if (!Number.isFinite(dueMs)) continue;

      // Reminder times are fixed at 10:00 AM IST on the calendar date
      // that is 48h/24h before the EMI due date. The actual EMI due time is ignored.
      const dueParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date(emi.due_at));
      const dueYear = dueParts.find(p => p.type === "year").value;
      const dueMonth = dueParts.find(p => p.type === "month").value;
      const dueDay = dueParts.find(p => p.type === "day").value;

      const reminderTarget = (daysBefore) => {
        const date = new Date(`${dueYear}-${dueMonth}-${dueDay}T10:00:00+05:30`);
        date.setTime(date.getTime() - daysBefore * 24 * 60 * 60 * 1000);
        return date.getTime();
      };

      const checks = [
        { daysBefore:2, field:"last_48h_sent_for_due", text:`🔔 EMI Reminder — ${emi.lender_name}\n₹${Number(emi.amount).toLocaleString("en-IN")} EMI is due in 2 days.` },
        { daysBefore:1, field:"last_24h_sent_for_due", text:`⏰ EMI Reminder — ${emi.lender_name}\n₹${Number(emi.amount).toLocaleString("en-IN")} EMI is due tomorrow.` },
      ];

      for (const check of checks) {
        const targetMs = reminderTarget(check.daysBefore);
        if (nowMs < targetMs || nowMs >= targetMs + 10*60*1000) continue;
        if (emi[check.field] && new Date(emi[check.field]).getTime() === dueMs) continue;

        const { data: claimed, error: claimError } = await supabase.from("emi_reminders")
          .update({ [check.field]: emi.due_at, updated_at: new Date().toISOString() })
          .eq("id", emi.id).eq("is_active", true).is(check.field, null).select("id");
        if (claimError) throw claimError;
        if (!claimed?.length) continue;

        try {
          await sendTextBeeSms(emi.phone, check.text);
        } catch (err) {
          await supabase.from("emi_reminders")
            .update({ [check.field]: null, updated_at: new Date().toISOString() })
            .eq("id", emi.id);
          console.error(`[emi] SMS failed for ${emi.id} (${check.hours}h):`, err.message);
        }
      }

      if (nowMs >= dueMs) {
        const nextDue = nextMonthlyDueAt(emi.due_at, now);
        await supabase.from("emi_reminders").update({
          due_at: nextDue.toISOString(),
          last_48h_sent_for_due: null,
          last_24h_sent_for_due: null,
          updated_at: new Date().toISOString(),
        }).eq("id", emi.id);
      }
    }
  } catch (err) {
    console.error("[emi] Dispatch error:", err.message);
  } finally {
    emiRunning = false;
    await recordHeartbeat("EMI Dispatch");
  }
}

// -----------------------------------------------------------------------
// Cron jobs — fire every minute.
// /api/tick calls the same functions when the process wakes from sleep.
// -----------------------------------------------------------------------

cron.schedule("* * * * *", runReminderDispatch);
cron.schedule("* * * * *", runRoutineDispatch);
cron.schedule("* * * * *", runRecurringDispatch);
cron.schedule("* * * * *", runEmiDispatch);

// Special event alerts — 08:30 IST (03:00 UTC). Cron-only to avoid duplicates.
cron.schedule("0 3 * * *", async () => {
  if (eventAlertRunning) return;
  eventAlertRunning = true;
  try {
    const { day: todayDay, month: todayMonth } = getISTComponents();

    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowDay = tomorrowDate.getDate();
    const tomorrowMonth = tomorrowDate.getMonth() + 1;

    const { data: events } = await supabase.from("special_events").select("*");
    if (!events) return;

    for (const event of events) {
      const eDate = new Date(event.event_date);
      const eDay = eDate.getDate();
      const eMonth = eDate.getMonth() + 1;

      if (eDay === todayDay && eMonth === todayMonth) {
        await sendWhatsAppMessage(event.phone, `${event.person_name}'s ${event.event_type} is today.`);
      } else if (eDay === tomorrowDay && eMonth === tomorrowMonth) {
        await sendWhatsAppMessage(event.phone, `${event.person_name}'s ${event.event_type} is tomorrow.`);
      }
    }
  } catch (_) {
    // silent
  } finally {
    eventAlertRunning = false;
    await recordHeartbeat("Event Alert");
  }
});

module.exports = {
  getHeartbeats: () => lastHeartbeats,
  runReminderDispatch,
  runRoutineDispatch,
  runRecurringDispatch,
  runEmiDispatch,
  sendTextBeeSms,
};
