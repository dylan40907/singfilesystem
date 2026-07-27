// supabase/functions/send-sales-reminders/index.ts
//
// Daily follow-up reminders for the Sales CRM (see run_sales_followup_reminders).
//
// The SQL function does the selecting AND the bookkeeping in one transaction, so
// it is safe to call more than once a day — anything already alerted for a given
// next-action date is skipped. It also raises the in-app notification (which
// fans out to mobile push); this function only turns the returned rows into a
// per-person digest email via Resend.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type AlertRow = {
  lead_id: string;
  alert_kind: "due" | "nag";
  parent_name: string;
  action_date: string | null;
  action_type: string | null;
  action_note: string | null;
  recipient_id: string;
  recipient_email: string | null;
  recipient_name: string | null;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fmtDate(d: string | null) {
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return d;
  return `${m}/${day}/${y}`;
}

function verbFor(type: string | null) {
  switch (type) {
    case "call": return "Call";
    case "email": return "Email";
    case "tour": return "Tour with";
    case "text": return "Text";
    default: return "Follow up with";
  }
}

async function resendSend(args: {
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
    body: JSON.stringify({ from: args.from, to: [args.to], subject: args.subject, text: args.text }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Resend error ${res.status}: ${msg}`);
  }
}

Deno.serve(async (req) => {
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
    const RESEND_FROM = Deno.env.get("RESEND_FROM_EMAIL") ?? "SING Sales <reminders@hr.singinchinese.com>";
    const PORTAL_URL = Deno.env.get("PORTAL_URL") ?? "https://www.singlearning.com";

    const CRON_SECRET = (Deno.env.get("CRON_SECRET") ?? "").trim();
    const got = (req.headers.get("x-cron-secret") ?? "").trim();
    if (!CRON_SECRET || got !== CRON_SECRET) return json(401, { error: "Unauthorized" });

    if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: "Server not configured" });

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Claims the due alerts, writes the in-app notifications, and marks them sent.
    const { data, error } = await admin.rpc("run_sales_followup_reminders");
    if (error) return json(500, { error: error.message });

    const rows = (data ?? []) as AlertRow[];
    if (rows.length === 0) {
      return json(200, { alerts: 0, emails_sent: 0, message: "No follow-ups due." });
    }

    // One digest per person rather than one email per lead.
    const byRecipient = new Map<string, AlertRow[]>();
    for (const r of rows) {
      const to = (r.recipient_email ?? "").trim();
      if (!to) continue;
      const list = byRecipient.get(to) ?? [];
      list.push(r);
      byRecipient.set(to, list);
    }

    let emailsSent = 0;
    const failures: string[] = [];

    if (RESEND_API_KEY) {
      for (const [to, list] of byRecipient) {
        const due = list.filter((r) => r.alert_kind === "due");
        const nag = list.filter((r) => r.alert_kind === "nag");

        const lines: string[] = [];
        if (due.length) {
          lines.push("DUE TODAY", "");
          for (const r of due) {
            lines.push(`• ${verbFor(r.action_type)} ${r.parent_name}` + (r.action_note ? ` — ${r.action_note}` : ""));
            lines.push(`  ${PORTAL_URL}/admin/sales/${r.lead_id}`);
          }
          lines.push("");
        }
        if (nag.length) {
          lines.push("OVERDUE — nothing logged yet", "");
          for (const r of nag) {
            lines.push(`• ${r.parent_name} was due ${fmtDate(r.action_date)}. If you did it, log it.`);
            lines.push(`  ${PORTAL_URL}/admin/sales/${r.lead_id}`);
          }
          lines.push("");
        }
        lines.push("— SING Sales");

        const subject =
          due.length && nag.length
            ? `Sales follow-ups: ${due.length} due today, ${nag.length} overdue`
            : due.length
            ? `Sales follow-ups: ${due.length} due today`
            : `Sales follow-ups: ${nag.length} overdue`;

        try {
          await resendSend({ apiKey: RESEND_API_KEY, from: RESEND_FROM, to, subject, text: lines.join("\n") });
          emailsSent += 1;
        } catch (e) {
          // The in-app notification already landed, so a mail failure is not fatal.
          failures.push(`${to}: ${String((e as Error)?.message ?? e)}`);
        }
      }
    }

    return json(200, {
      alerts: rows.length,
      recipients: byRecipient.size,
      emails_sent: emailsSent,
      email_skipped: RESEND_API_KEY ? 0 : byRecipient.size,
      failures,
    });
  } catch (err) {
    console.error(err);
    return json(503, { error: "BOOT_ERROR", message: String((err as Error)?.message ?? err) });
  }
});
