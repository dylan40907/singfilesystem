// supabase/functions/tours-public/index.ts
//
// Public tour booking — the in-house Calendly replacement.
//
// This is the ONLY door the public booking page uses. It runs with the service
// role and returns just what a parent needs (free slot times, never other
// families' details), so the sales_tours tables stay closed to anonymous
// clients even though the page itself is public.
//
// Modes:
//   slots      { slug, from, to }                → free start times
//   book       { slug, start, parent… }          → creates lead + tour, emails
//   lookup     { token }                         → the parent's own booking
//   cancel     { token, reason? }
//   reschedule { token, start }
//   reminders  {}  (cron, x-cron-secret)         → day-before emails

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info, x-cron-secret",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ── Time zone helpers ───────────────────────────────────────────────────────
// Availability is stored as wall-clock time ("Wednesdays 09:30–11:30") in the
// tour's own zone. These convert between that and real instants, so bookings
// stay correct across daylight-saving changes.

function partsIn(tz: string, at: Date) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(at)) if (x.type !== "literal") p[x.type] = x.value;
  return p;
}

/** The UTC instant of a wall-clock date+time in `tz`. */
function zonedToUtc(day: string, hhmm: string, tz: string): Date {
  const asIfUtc = new Date(`${day}T${hhmm}:00Z`);
  const p = partsIn(tz, asIfUtc);
  const roundTrip = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(asIfUtc.getTime() + (asIfUtc.getTime() - roundTrip));
}

/** YYYY-MM-DD as it reads in `tz`. */
function dayIn(tz: string, at: Date): string {
  const p = partsIn(tz, at);
  return `${p.year}-${p.month}-${p.day}`;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Day of week for a plain date, 0 = Sunday. */
function dowOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function fmtWhen(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(at);
}

function token(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function sendMail(args: { to: string; subject: string; text: string }) {
  const key = Deno.env.get("RESEND_API_KEY") ?? "";
  if (!key) return;
  const from = Deno.env.get("RESEND_FROM_EMAIL") ?? "Sing in Chinese <noreply@hr.singinchinese.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [args.to], subject: args.subject, text: args.text }),
  });
  if (!res.ok) console.error("Resend failed:", res.status, await res.text().catch(() => ""));
}

type TourType = {
  id: string; campus_id: string | null; slug: string; name: string;
  description: string | null; location: string | null;
  duration_minutes: number; buffer_minutes: number; min_notice_hours: number;
  max_days_ahead: number; capacity_per_slot: number; time_zone: string; is_active: boolean;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const PORTAL = Deno.env.get("PORTAL_URL") ?? "https://www.singlearning.com";
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: "Server not configured" });

  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  const body = await req.json().catch(() => ({}));
  const mode = String(body?.mode ?? "slots");

  // ── Day-before reminders (cron) ───────────────────────────────────────────
  if (mode === "reminders") {
    const secret = (Deno.env.get("CRON_SECRET") ?? "").trim();
    if (!secret || (req.headers.get("x-cron-secret") ?? "").trim() !== secret) {
      return json(401, { error: "Unauthorized" });
    }
    const soon = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
    const { data: due } = await db
      .from("sales_tours")
      .select("*, tour_type:sales_tour_types(name, location, time_zone)")
      .eq("status", "scheduled")
      .is("reminder_sent_at", null)
      .gte("starts_at", new Date().toISOString())
      .lte("starts_at", soon);

    let sent = 0;
    for (const t of due ?? []) {
      const tt = (t as Record<string, unknown>).tour_type as { name: string; location: string | null; time_zone: string } | null;
      const tz = tt?.time_zone ?? "America/Los_Angeles";
      if (t.parent_email) {
        await sendMail({
          to: t.parent_email,
          subject: `Reminder: your tour is ${fmtWhen(new Date(t.starts_at), tz)}`,
          text:
            `Hi ${t.parent_name || "there"},\n\nA quick reminder about your visit:\n\n` +
            `${tt?.name ?? "Tour"}\n${fmtWhen(new Date(t.starts_at), tz)}\n` +
            (tt?.location ? `${tt.location}\n` : "") +
            `\nNeed to change or cancel? ${PORTAL}/book/manage?t=${t.manage_token}\n\n— Sing in Chinese`,
        });
        sent++;
      }
      await db.from("sales_tours").update({ reminder_sent_at: new Date().toISOString() }).eq("id", t.id);
    }
    return json(200, { reminded: sent });
  }

  // ── Load the tour type (everything else needs it, except token lookups) ───
  async function loadType(slug: string): Promise<TourType | null> {
    const { data } = await db.from("sales_tour_types").select("*").eq("slug", slug).eq("is_active", true).maybeSingle();
    return (data as TourType) ?? null;
  }

  /** Free start times between two dates, as ISO instants. */
  async function freeSlots(tt: TourType, fromDay: string, toDay: string): Promise<string[]> {
    const [{ data: windows }, { data: blackouts }, { data: taken }] = await Promise.all([
      db.from("sales_tour_availability").select("*").eq("tour_type_id", tt.id),
      db.from("sales_tour_blackouts").select("day").eq("tour_type_id", tt.id),
      db.from("sales_tours").select("starts_at").eq("tour_type_id", tt.id).eq("status", "scheduled")
        .gte("starts_at", zonedToUtc(fromDay, "00:00", tt.time_zone).toISOString())
        .lte("starts_at", zonedToUtc(addDays(toDay, 1), "00:00", tt.time_zone).toISOString()),
    ]);

    const blocked = new Set((blackouts ?? []).map((b) => b.day as string));
    const takenCount = new Map<string, number>();
    for (const t of taken ?? []) {
      const k = new Date(t.starts_at as string).toISOString();
      takenCount.set(k, (takenCount.get(k) ?? 0) + 1);
    }

    const notBefore = Date.now() + tt.min_notice_hours * 3600 * 1000;
    const lastDay = addDays(dayIn(tt.time_zone, new Date()), tt.max_days_ahead);
    const step = (tt.duration_minutes + tt.buffer_minutes) * 60 * 1000;

    const out: string[] = [];
    for (let day = fromDay; day <= toDay && day <= lastDay; day = addDays(day, 1)) {
      if (blocked.has(day)) continue;
      for (const w of (windows ?? []).filter((x) => x.day_of_week === dowOf(day))) {
        const open = zonedToUtc(day, String(w.start_time).slice(0, 5), tt.time_zone).getTime();
        const close = zonedToUtc(day, String(w.end_time).slice(0, 5), tt.time_zone).getTime();
        for (let s = open; s + tt.duration_minutes * 60000 <= close; s += step) {
          if (s < notBefore) continue;
          const iso = new Date(s).toISOString();
          if ((takenCount.get(iso) ?? 0) >= tt.capacity_per_slot) continue;
          out.push(iso);
        }
      }
    }
    return out.sort();
  }

  if (mode === "slots") {
    const tt = await loadType(String(body?.slug ?? ""));
    if (!tt) return json(404, { error: "That booking page isn't available." });
    const from = String(body?.from ?? dayIn(tt.time_zone, new Date()));
    const to = String(body?.to ?? addDays(from, 45));
    return json(200, {
      tour: {
        name: tt.name, description: tt.description, location: tt.location,
        duration_minutes: tt.duration_minutes, time_zone: tt.time_zone,
      },
      slots: await freeSlots(tt, from, to),
    });
  }

  if (mode === "book") {
    const tt = await loadType(String(body?.slug ?? ""));
    if (!tt) return json(404, { error: "That booking page isn't available." });

    const start = String(body?.start ?? "");
    const name = String(body?.parent_name ?? "").trim();
    const email = String(body?.parent_email ?? "").trim().toLowerCase();
    if (!start || !name || !email.includes("@")) {
      return json(400, { error: "Please give your name, a valid email and pick a time." });
    }
    // Honeypot: bots fill hidden fields, humans don't.
    if (String(body?.website ?? "").trim()) return json(200, { ok: true });

    // Re-check the slot at booking time — someone may have taken it while the
    // page was open.
    const day = dayIn(tt.time_zone, new Date(start));
    const free = await freeSlots(tt, day, day);
    if (!free.includes(new Date(start).toISOString())) {
      return json(409, { error: "Sorry — that time was just taken. Please pick another." });
    }

    const startAt = new Date(start);
    const endAt = new Date(startAt.getTime() + tt.duration_minutes * 60000);

    // Attach to an existing family when the email already exists, so a tour
    // never creates a duplicate lead.
    const { data: existing } = await db
      .from("sales_leads").select("id").ilike("email", email).limit(1).maybeSingle();

    let leadId = existing?.id as string | undefined;
    if (!leadId) {
      const parts = name.split(/\s+/);
      const { data: lead, error: lErr } = await db.from("sales_leads").insert({
        campus_ids: tt.campus_id ? [tt.campus_id] : [],
        status: "active",
        parent_first_name: parts.slice(0, -1).join(" ") || parts[0] || "",
        parent_last_name: parts.length > 1 ? parts[parts.length - 1] : "",
        email,
        phone: String(body?.parent_phone ?? "").trim() || null,
        source_id: body?.source_id ?? null,
        referred_by: String(body?.referred_by ?? "").trim() || null,
        first_contact_type: "scheduled_tour",
        inquiry_date: dayIn(tt.time_zone, new Date()),
        notes: String(body?.notes ?? "").trim() || null,
      }).select("id").single();
      if (lErr) return json(500, { error: lErr.message });
      leadId = lead.id;

      if (String(body?.child_name ?? "").trim() || body?.program) {
        await db.from("sales_lead_children").insert({
          lead_id: leadId,
          name: String(body?.child_name ?? "").trim(),
          dob: body?.child_dob || null,
          program: body?.program || null,
          order_index: 0,
        });
      }
    }

    const manage = token();
    const { data: tour, error: tErr } = await db.from("sales_tours").insert({
      tour_type_id: tt.id, campus_id: tt.campus_id, lead_id: leadId,
      starts_at: startAt.toISOString(), ends_at: endAt.toISOString(),
      parent_name: name, parent_email: email,
      parent_phone: String(body?.parent_phone ?? "").trim() || null,
      child_name: String(body?.child_name ?? "").trim() || null,
      child_dob: body?.child_dob || null,
      program: body?.program || null,
      source_id: body?.source_id ?? null,
      notes: String(body?.notes ?? "").trim() || null,
      manage_token: manage,
    }).select("id").single();
    if (tErr) return json(500, { error: tErr.message });

    const when = fmtWhen(startAt, tt.time_zone);

    await db.from("sales_activities").insert({
      lead_id: leadId, kind: "tour", activity_date: dayIn(tt.time_zone, startAt),
      note: `Tour booked online for ${when}.`,
    });

    await sendMail({
      to: email,
      subject: `You're booked: ${tt.name}`,
      text:
        `Hi ${name},\n\nYour visit is confirmed.\n\n${tt.name}\n${when}\n` +
        (tt.location ? `${tt.location}\n` : "") +
        `\nNeed to change or cancel? ${PORTAL}/book/manage?t=${manage}\n\n` +
        `We look forward to meeting you.\n— Sing in Chinese`,
    });

    await notifyStaff(db, `New tour booked`, `${name} booked ${tt.name} for ${when}.`, leadId!, tour.id, PORTAL);
    return json(200, { ok: true, when, manage_token: manage });
  }

  // ── Parent self-service ───────────────────────────────────────────────────
  const tok = String(body?.token ?? "");
  if (!tok) return json(400, { error: "Missing booking reference." });

  const { data: tour } = await db
    .from("sales_tours")
    .select("*, tour_type:sales_tour_types(*)")
    .eq("manage_token", tok)
    .maybeSingle();
  if (!tour) return json(404, { error: "We couldn't find that booking." });
  const tt = (tour as Record<string, unknown>).tour_type as TourType;

  if (mode === "lookup") {
    return json(200, {
      status: tour.status, starts_at: tour.starts_at,
      when: fmtWhen(new Date(tour.starts_at), tt.time_zone),
      parent_name: tour.parent_name,
      tour: { name: tt.name, location: tt.location, time_zone: tt.time_zone, slug: tt.slug },
    });
  }

  if (mode === "cancel") {
    if (tour.status !== "scheduled") return json(400, { error: "That booking isn't active." });
    await db.from("sales_tours").update({
      status: "cancelled", cancelled_at: new Date().toISOString(),
      cancelled_by: "parent", cancel_reason: String(body?.reason ?? "").trim() || null,
    }).eq("id", tour.id);

    if (tour.lead_id) {
      await db.from("sales_activities").insert({
        lead_id: tour.lead_id, kind: "tour", activity_date: dayIn(tt.time_zone, new Date()),
        note: `Parent cancelled their tour (was ${fmtWhen(new Date(tour.starts_at), tt.time_zone)}).`,
      });
    }
    await sendMail({
      to: tour.parent_email,
      subject: "Your tour has been cancelled",
      text: `Hi ${tour.parent_name},\n\nYour tour on ${fmtWhen(new Date(tour.starts_at), tt.time_zone)} has been cancelled.\n\nYou're welcome to book again any time: ${PORTAL}/book/${tt.slug}\n\n— Sing in Chinese`,
    });
    await notifyStaff(db, "Tour cancelled", `${tour.parent_name} cancelled their ${fmtWhen(new Date(tour.starts_at), tt.time_zone)} tour.`, tour.lead_id, tour.id, PORTAL);
    return json(200, { ok: true });
  }

  if (mode === "reschedule") {
    if (tour.status !== "scheduled") return json(400, { error: "That booking isn't active." });
    const start = String(body?.start ?? "");
    if (!start) return json(400, { error: "Pick a new time." });

    const day = dayIn(tt.time_zone, new Date(start));
    const free = await freeSlots(tt, day, day);
    if (!free.includes(new Date(start).toISOString())) {
      return json(409, { error: "Sorry — that time was just taken. Please pick another." });
    }

    const oldWhen = fmtWhen(new Date(tour.starts_at), tt.time_zone);
    const startAt = new Date(start);
    await db.from("sales_tours").update({
      starts_at: startAt.toISOString(),
      ends_at: new Date(startAt.getTime() + tt.duration_minutes * 60000).toISOString(),
      reminder_sent_at: null, // the new date deserves its own reminder
    }).eq("id", tour.id);

    const when = fmtWhen(startAt, tt.time_zone);
    if (tour.lead_id) {
      await db.from("sales_activities").insert({
        lead_id: tour.lead_id, kind: "tour", activity_date: dayIn(tt.time_zone, new Date()),
        note: `Parent moved their tour from ${oldWhen} to ${when}.`,
      });
    }
    await sendMail({
      to: tour.parent_email,
      subject: `Your tour has moved to ${when}`,
      text: `Hi ${tour.parent_name},\n\nYour visit is now:\n\n${tt.name}\n${when}\n` +
        (tt.location ? `${tt.location}\n` : "") +
        `\nNeed to change again? ${PORTAL}/book/manage?t=${tok}\n\n— Sing in Chinese`,
    });
    await notifyStaff(db, "Tour rescheduled", `${tour.parent_name} moved their tour from ${oldWhen} to ${when}.`, tour.lead_id, tour.id, PORTAL);
    return json(200, { ok: true, when });
  }

  return json(400, { error: "Unknown request." });
});

/** In-app notification (which also pushes to the HR app) + email, to the configured list. */
async function notifyStaff(
  db: ReturnType<typeof createClient>,
  title: string, message: string,
  leadId: string | null, tourId: string, portal: string
) {
  const { data: recips } = await db
    .from("sales_tour_notify")
    .select("user_id, user_profiles(full_name, email, is_active)");

  for (const r of recips ?? []) {
    const p = (r as Record<string, unknown>).user_profiles as { email: string | null; is_active: boolean } | null;
    if (!p?.is_active) continue;
    await db.rpc("app_notify", {
      p_user_id: r.user_id,
      p_type: "sales_tour",
      p_title: title,
      p_body: message,
      p_data: { lead_id: leadId, tour_id: tourId },
    });
    if (p.email) {
      await sendMail({
        to: p.email,
        subject: `${title} — ${message.split(" ")[0]}`,
        text: `${message}\n\n${portal}/admin/sales/tours\n\n— SING Sales`,
      });
    }
  }
}
