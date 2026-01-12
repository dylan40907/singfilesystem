// supabase/functions/send-pto-reminders/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type HrSettings = {
  id: boolean;
  admin_email: string | null;
  reminders_enabled: boolean | null;
  reminders_time: string | null; // "HH:MM:SS"
  reminders_tz: string | null; // e.g. "America/Los_Angeles"
  reminders_last_ran_at: string | null; // timestamptz
};

type Employee = {
  id: string;
  legal_first_name: string;
  legal_last_name: string;
  has_pto: boolean;
  pto_reminder_date: string | null; // date "YYYY-MM-DD"
  pto_reminder_sent_at: string | null;
};

type DueMilestoneReminder = {
  reminder_id: string;
  employee_id: string;
  event_type_name: string;
  event_date: string; // YYYY-MM-DD
  days_before: number;
  due_date: string; // YYYY-MM-DD
  sent_at: string | null;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Get YYYY-MM-DD + HH/MM in a specific IANA time zone using Intl (no deps)
function getZonedParts(now: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = fmt.formatToParts(now);
  const grab = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  const year = grab("year");
  const month = grab("month");
  const day = grab("day");
  const hour = grab("hour");
  const minute = grab("minute");

  const dateKey = `${year}-${month}-${day}`; // YYYY-MM-DD
  return { year, month, day, hour: Number(hour), minute: Number(minute), dateKey };
}

function parseTimeHHMM(timeStr: string) {
  // accepts "HH:MM" or "HH:MM:SS"
  const [hh, mm] = timeStr.split(":");
  return { hh: Number(hh ?? 0), mm: Number(mm ?? 0) };
}

function mmddyyyyFromDate(dateKey: string) {
  // "YYYY-MM-DD" -> "M/D/YYYY" (no leading zeros)
  const [y, m, d] = dateKey.split("-").map((x) => Number(x));
  return `${m}/${d}/${y}`;
}

async function resendSendEmail(args: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: args.from,
      to: [args.to],
      subject: args.subject,
      text: args.text,
    }),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Resend error ${res.status}: ${msg}`);
  }

  return await res.json().catch(() => ({}));
}

Deno.serve(async (req) => {
  try {
    // ---- auth: shared secret header (cron only) ----
    const CRON_SECRET = (Deno.env.get("CRON_SECRET") ?? "").trim();
    const got = (req.headers.get("x-cron-secret") ?? "").trim();
    if (!CRON_SECRET || got !== CRON_SECRET) {
      return json(401, { error: "Unauthorized" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
    const RESEND_FROM = Deno.env.get("RESEND_FROM_EMAIL") ?? "SING HR <reminders@hr.singinchinese.com>";

    const admin = createClient(supabaseUrl, serviceKey);

    // ---- read hr_settings (single row: id=true) ----
    const { data: settings, error: sErr } = await admin
      .from("hr_settings")
      .select("id, admin_email, reminders_enabled, reminders_time, reminders_tz, reminders_last_ran_at")
      .eq("id", true)
      .single();

    if (sErr) return json(500, { error: sErr.message });
    const s = settings as HrSettings;

    if (!s.admin_email) {
      return json(200, { total_sent: 0, message: "hr_settings.admin_email not set" });
    }

    const enabled = s.reminders_enabled ?? false;
    if (!enabled) {
      return json(200, { total_sent: 0, message: "Reminders disabled (hr_settings.reminders_enabled=false)." });
    }

    if (!RESEND_API_KEY) {
      return json(500, { error: "Missing RESEND_API_KEY env var." });
    }

    const tz = s.reminders_tz || "UTC";
    const timeStr = s.reminders_time || "09:00:00";

    const now = new Date();
    const nowLocal = getZonedParts(now, tz);
    const target = parseTimeHHMM(timeStr);

    const nowMin = nowLocal.hour * 60 + nowLocal.minute;
    const targetMin = target.hh * 60 + target.mm;

    // Don't send anything before the scheduled daily time (in org tz)
    if (nowMin < targetMin) {
      return json(200, {
        total_sent: 0,
        message: `Not time yet. Local now=${String(nowLocal.hour).padStart(2, "0")}:${String(nowLocal.minute).padStart(
          2,
          "0"
        )} ${tz}, scheduled=${String(target.hh).padStart(2, "0")}:${String(target.mm).padStart(2, "0")}`,
      });
    }

    const todayKey = nowLocal.dateKey;

    // =========================
    // 1) PTO reminders (due up to today, unsent)
    // =========================
    const { data: ptoDue, error: ptoErr } = await admin
      .from("hr_employees")
      .select("id, legal_first_name, legal_last_name, has_pto, pto_reminder_date, pto_reminder_sent_at")
      .eq("has_pto", true)
      .not("pto_reminder_date", "is", null)
      .lte("pto_reminder_date", todayKey)
      .is("pto_reminder_sent_at", null);

    if (ptoErr) return json(500, { error: ptoErr.message });

    let ptoSent = 0;
    const ptoEmployees = (ptoDue ?? []) as Employee[];

    for (const emp of ptoEmployees) {
      const when = emp.pto_reminder_date ? mmddyyyyFromDate(emp.pto_reminder_date) : mmddyyyyFromDate(todayKey);

      const subject = "SING HR System Message: PTO Reminder";
      const text =
        `SING HR System Message:\n` +
        `Employee: ${emp.legal_first_name} ${emp.legal_last_name}\n` +
        `PTO Reminder for ${when}`;

      await resendSendEmail({
        apiKey: RESEND_API_KEY,
        from: RESEND_FROM,
        to: s.admin_email,
        subject,
        text,
      });

      const { error: markErr } = await admin
        .from("hr_employees")
        .update({ pto_reminder_sent_at: new Date().toISOString() })
        .eq("id", emp.id);

      if (markErr) {
        console.error("Failed to mark PTO sent:", emp.id, markErr.message);
      } else {
        ptoSent += 1;
      }
    }

    // =========================
    // 2) Milestone reminders (due up to today, unsent)
    // =========================
    const { data: dueMilestones, error: mErr } = await admin
      .from("hr_due_event_reminders")
      .select("reminder_id, employee_id, event_type_name, event_date, days_before, due_date, sent_at")
      .is("sent_at", null)
      .lte("due_date", todayKey);

    if (mErr) return json(500, { error: mErr.message });

    const milestoneRows = (dueMilestones ?? []) as unknown as DueMilestoneReminder[];

    // Need employee names for email body
    const employeeIds = Array.from(new Set(milestoneRows.map((r) => r.employee_id)));
    const employeeNameById = new Map<string, { first: string; last: string }>();

    if (employeeIds.length > 0) {
      const { data: empRows, error: empErr } = await admin
        .from("hr_employees")
        .select("id, legal_first_name, legal_last_name")
        .in("id", employeeIds);

      if (empErr) return json(500, { error: empErr.message });

      for (const r of empRows ?? []) {
        employeeNameById.set(r.id, { first: r.legal_first_name, last: r.legal_last_name });
      }
    }

    let milestoneSent = 0;

    for (const r of milestoneRows) {
      const name = employeeNameById.get(r.employee_id);
      const first = name?.first ?? "Unknown";
      const last = name?.last ?? "Employee";

      const eventDateFmt = mmddyyyyFromDate(r.event_date);

      const subject = `SING HR System Message: Milestone Reminder`;
      const text =
        `SING HR System Message:\n` +
        `Employee: ${first} ${last}\n` +
        `Event: ${r.event_type_name}\n` +
        `Event Date: ${eventDateFmt}\n` +
        `Reminder: ${r.days_before} day(s) until this event`;

      await resendSendEmail({
        apiKey: RESEND_API_KEY,
        from: RESEND_FROM,
        to: s.admin_email,
        subject,
        text,
      });

      // mark this reminder sent
      const { error: markRErr } = await admin
        .from("hr_employee_event_reminders")
        .update({ sent_at: new Date().toISOString() })
        .eq("id", r.reminder_id);

      if (markRErr) {
        console.error("Failed to mark milestone reminder sent:", r.reminder_id, markRErr.message);
      } else {
        milestoneSent += 1;
      }
    }

    const totalSent = ptoSent + milestoneSent;

    if (totalSent > 0) {
      await admin.from("hr_settings").update({ reminders_last_ran_at: new Date().toISOString() }).eq("id", true);
    }

    return json(200, {
      total_sent: totalSent,
      pto_sent: ptoSent,
      milestone_sent: milestoneSent,
      timezone: tz,
      ran_for_local_date: todayKey,
      message:
        totalSent === 0
          ? "No due reminders (PTO or milestones)."
          : `Sent ${totalSent} reminder(s).`,
    });
  } catch (err) {
    console.error(err);
    return json(503, { error: "BOOT_ERROR", message: String((err as any)?.message ?? err) });
  }
});
