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
//   confirm / request_reschedule { tour_id }     → staff, needs their JWT
//   test_send  { key, to }                       → admins, previews a template
//
// Wording for every email lives in sales_email_templates, edited from
// Sales → Emails. Nothing here hardcodes a message body any more.

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

const PHONE = "(310) 957-2258";

/**
 * Tell the right staff about a tour. Admins hear about every campus; campus
 * admins and supervisors only about their own. Anyone with no campus on their
 * HR record hears nothing — that rule lives in tour_alert_recipients().
 */
async function alertStaff(
  db: any, campusId: string | null, title: string, bodyText: string, tourId: string
) {
  const { data: ids } = await db.rpc("tour_alert_recipients", { target_campus: campusId });
  const rows = (ids ?? []) as { id?: string }[] | string[];
  const userIds = (rows as any[]).map((r) => (typeof r === "string" ? r : r.id)).filter(Boolean);
  if (userIds.length === 0) return;
  await db.from("hr_notifications").insert(
    userIds.map((uid: string) => ({
      user_id: uid, type: "tour", title, body: bodyText,
      data: { tour_id: tourId, url: "/admin/sales/tours" },
    }))
  );
}

/** ICS timestamp: 20260806T170000Z */
function icsStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * A calendar invite the parent (or the campus) can actually add. Google
 * Calendar, Apple Calendar and Outlook all understand .ics, so this needs no
 * Google API.
 *
 * The UID is per booking and stays the same for its whole life, so a later
 * invite with a higher SEQUENCE updates the existing event rather than adding a
 * second one — and METHOD:CANCEL removes it. Anything that changes a booking
 * must therefore bump `sequence`.
 */
function buildIcs(a: {
  uid: string; title: string; start: Date; end: Date; location: string; description: string;
  sequence?: number;
  method?: "REQUEST" | "CANCEL";
}): string {
  const esc = (s: string) => s.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  const method = a.method ?? "REQUEST";
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sing in Chinese//Booking//EN",
    "CALSCALE:GREGORIAN", `METHOD:${method}`, "BEGIN:VEVENT",
    `UID:${a.uid}`,
    `SEQUENCE:${a.sequence ?? 0}`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(a.start)}`,
    `DTEND:${icsStamp(a.end)}`,
    `SUMMARY:${esc(a.title)}`,
    `LOCATION:${esc(a.location)}`,
    `DESCRIPTION:${esc(a.description)}`,
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
}

/**
 * Tours and consultations send the same set of emails but word them
 * differently — a consultation is an online meeting, not a visit. One template
 * key per booking kind, picked here so callers don't each restate the rule.
 */
function tplKey(base: string, isConsult: boolean): string {
  return `${isConsult ? "consult" : "tour"}_${base}`;
}

type MailAttachment = { filename: string; content: string };

async function sendMail(args: {
  to: string; subject: string; text: string; html?: string;
  ics?: string; attachments?: MailAttachment[];
}) {
  const key = Deno.env.get("RESEND_API_KEY") ?? "";
  if (!key) return;
  const from = Deno.env.get("RESEND_FROM_EMAIL") ?? "Sing in Chinese <noreply@hr.singinchinese.com>";
  const payload: Record<string, unknown> = {
    from, to: [args.to], subject: args.subject, text: args.text,
  };
  if (args.html) payload.html = args.html;
  const files: MailAttachment[] = [...(args.attachments ?? [])];
  if (args.ics) {
    files.push({ filename: "invite.ics", content: btoa(unescape(encodeURIComponent(args.ics))) });
  }
  if (files.length) payload.attachments = files;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error("Resend failed:", res.status, await res.text().catch(() => ""));
}

// ── Editable templates ──────────────────────────────────────────────────────
// Wording lives in sales_email_templates so admins can change it from Sales →
// Emails without a deploy. This side is deliberately mechanical: it fills in
// whatever {{tokens}} it has values for and blanks anything it doesn't know,
// so adding a token to the editor's catalogue means adding it here too.

type Tpl = {
  key: string; subject: string; body_html: string;
  attachments: { path: string; filename: string; mime: string }[];
  is_active: boolean;
};

/** A value that reads differently in HTML than in the plain-text fallback. */
type Val = string | { html: string; text: string };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fill(tpl: string, vars: Record<string, Val>, mode: "html" | "text"): string {
  return tpl.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, raw: string) => {
    const v = vars[raw.toLowerCase()];
    if (v === undefined) return "";
    if (typeof v === "string") return mode === "html" ? esc(v) : v;
    return mode === "html" ? v.html : v.text;
  });
}

/** Tokens that came back empty leave holes; close them up rather than ship blank lines. */
function tidyHtml(html: string): string {
  return html
    .replace(/(<br\s*\/?>\s*){2,}/gi, "<br>")
    .replace(/<br\s*\/?>\s*(<\/p>)/gi, "$1")
    .replace(/(<p[^>]*>)\s*(<br\s*\/?>)?\s*(<\/p>)/gi, "");
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/(li|tr)>/gi, "\n")
    // Paragraphs read as paragraphs in the plain-text fallback too.
    .replace(/<\/(p|div|h[1-6])>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function link(url: string, label: string): Val {
  if (!url) return { html: "", text: "" };
  return { html: `<a href="${url}">${esc(label)}</a>`, text: url };
}

const tplCache = new Map<string, Tpl | null>();

async function loadTpl(db: any, key: string): Promise<Tpl | null> {
  if (tplCache.has(key)) return tplCache.get(key) ?? null;
  const { data } = await db.from("sales_email_templates").select("*").eq("key", key).maybeSingle();
  const tpl = (data as Tpl) ?? null;
  tplCache.set(key, tpl);
  return tpl;
}

/**
 * Send one of the editable emails. Returns false when there's nothing to send —
 * no recipient, no template row, or the template has been switched off.
 */
async function sendTemplate(
  db: any,
  args: { key: string; to: string | null | undefined; vars: Record<string, Val>; ics?: string }
): Promise<boolean> {
  if (!args.to) return false;
  const tpl = await loadTpl(db, args.key);
  if (!tpl || !tpl.is_active) {
    if (!tpl) console.error("Missing email template:", args.key);
    return false;
  }

  const html = tidyHtml(fill(tpl.body_html, args.vars, "html"));
  const text = htmlToText(fill(tpl.body_html, args.vars, "text"));

  // Attachments live in a Storage bucket; Resend wants them base64-encoded.
  const files: MailAttachment[] = [];
  for (const a of tpl.attachments ?? []) {
    const { data, error } = await db.storage.from("sales-email-assets").download(a.path);
    if (error || !data) { console.error("Attachment missing:", a.path, error?.message); continue; }
    const bytes = new Uint8Array(await data.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    files.push({ filename: a.filename, content: btoa(bin) });
  }

  await sendMail({
    to: args.to,
    subject: fill(tpl.subject, args.vars, "text"),
    text, html, ics: args.ics, attachments: files,
  });
  return true;
}

/** The address bookings for this campus are copied to, if one is set. */
async function campusEmail(db: any, campusId: string | null): Promise<{ email: string | null; name: string }> {
  if (!campusId) return { email: null, name: "Sing in Chinese" };
  const { data } = await db.from("hr_campuses")
    .select("name, contact_email, parent_campus_id").eq("id", campusId).maybeSingle();
  if (!data) return { email: null, name: "Sing in Chinese" };
  // Bookings point at a real campus, but be forgiving if one ever points at a
  // programme container: fall back to the parent's address.
  if (!data.contact_email && data.parent_campus_id) {
    const { data: parent } = await db.from("hr_campuses")
      .select("name, contact_email").eq("id", data.parent_campus_id).maybeSingle();
    if (parent) return { email: parent.contact_email ?? null, name: parent.name ?? data.name };
  }
  return { email: data.contact_email ?? null, name: data.name ?? "Sing in Chinese" };
}

type TourType = {
  id: string; campus_id: string | null; slug: string; name: string;
  description: string | null; location: string | null;
  duration_minutes: number; buffer_minutes: number; min_notice_hours: number;
  max_days_ahead: number; capacity_per_slot: number; time_zone: string; is_active: boolean;
  /** 'preschool_tour' asks for a lead and staff approval; 'hwc_consult' neither. */
  kind: "preschool_tour" | "hwc_consult";
  meet_url: string | null;
  creates_lead: boolean;
  auto_confirm: boolean;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const PORTAL = Deno.env.get("PORTAL_URL") ?? "https://www.singlearning.com";
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: "Server not configured" });

  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  const body = await req.json().catch(() => ({}));
  const mode = String(body?.mode ?? "slots");

  /** The tokens every family-facing email may use. */
  function baseVars(a: {
    parentName?: string | null; tourName?: string | null; when: string;
    location?: string | null; meet?: string | null;
    manageToken?: string | null; slug?: string | null;
  }): Record<string, Val> {
    const none = { html: "", text: "" };
    return {
      parent_name: a.parentName || "there",
      tour_name: a.tourName || "Sing in Chinese",
      when: a.when,
      location: a.location || "",
      phone: PHONE,
      meet_link: link((a.meet ?? "").trim(), "Join with Google Meet"),
      manage_link: a.manageToken
        ? link(`${PORTAL}/book/manage?t=${a.manageToken}`, "Change or cancel your booking")
        : none,
      book_link: a.slug ? link(`${PORTAL}/book/${a.slug}`, "Book a time") : none,
    };
  }

  /**
   * Copy a booking to the campus it belongs to. Staff already get the portal
   * bell and an app push; this is the calendar-and-inbox copy the campus asked
   * for, and it only goes out when an address has been set in Sales → Settings.
   */
  async function mailCampus(a: {
    key: "staff_booking" | "staff_changed";
    campusId: string | null;
    tour: Record<string, unknown>;
    tourName: string | null; when: string; location?: string | null; meet?: string | null;
    headline?: string;
    ics?: string;
  }): Promise<void> {
    const { email, name } = await campusEmail(db, a.campusId);
    if (!email) return;
    await sendTemplate(db, {
      key: a.key,
      to: email,
      ics: a.ics,
      vars: {
        ...baseVars({
          parentName: (a.tour.parent_name as string) ?? null,
          tourName: a.tourName, when: a.when, location: a.location, meet: a.meet,
          manageToken: (a.tour.manage_token as string) ?? null,
        }),
        campus_name: name,
        parent_email: (a.tour.parent_email as string) || "",
        parent_phone: (a.tour.parent_phone as string) || "",
        child_name: (a.tour.child_name as string) || "",
        notes: (a.tour.notes as string) || "",
        what_changed: a.headline || "",
        portal_link: link(`${PORTAL}/admin/sales/tours`, "Open in the portal"),
      },
    });
  }

  // ── Day-before reminders (cron) ───────────────────────────────────────────
  if (mode === "reminders") {
    const secret = (Deno.env.get("CRON_SECRET") ?? "").trim();
    if (!secret || (req.headers.get("x-cron-secret") ?? "").trim() !== secret) {
      return json(401, { error: "Unauthorized" });
    }
    const now = new Date();

    // ── Nag staff about requests nobody has approved or denied ──────────────
    // Every 24 hours, for as long as it sits unactioned. Requests are never
    // auto-released, so this is the only thing that keeps them from being
    // forgotten while a slot stays held.
    const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const { data: stale } = await db
      .from("sales_tours")
      .select("id, campus_id, parent_name, starts_at, created_at, action_reminded_at, tour_type:sales_tour_types(name, time_zone)")
      .eq("status", "requested")
      .lte("created_at", dayAgo)
      .or(`action_reminded_at.is.null,action_reminded_at.lte.${dayAgo}`);

    let nagged = 0;
    for (const t of stale ?? []) {
      const tt = (t as Record<string, unknown>).tour_type as { name: string; time_zone: string } | null;
      const when = fmtWhen(new Date(t.starts_at), tt?.time_zone ?? "America/Los_Angeles");
      await alertStaff(
        db, t.campus_id,
        `Still waiting: ${tt?.name ?? "tour"} request`,
        `${t.parent_name || "A parent"} asked for ${when} and nobody has confirmed or rescheduled it yet.`,
        t.id
      );
      await db.from("sales_tours").update({ action_reminded_at: now.toISOString() }).eq("id", t.id);
      nagged++;
    }

    // ── Thank-you after the visit ───────────────────────────────────────────
    // Anything confirmed whose end time has passed, within the last two days so
    // a backlog doesn't mail people about tours from weeks ago.
    const { data: finished } = await db
      .from("sales_tours")
      .select("id, parent_name, parent_email, starts_at, ends_at, tour_type:sales_tour_types(name, time_zone, kind)")
      .eq("status", "confirmed")
      .is("followup_sent_at", null)
      .lte("ends_at", now.toISOString())
      .gte("ends_at", new Date(now.getTime() - 48 * 3600 * 1000).toISOString());

    let thanked = 0;
    for (const t of finished ?? []) {
      const ft = (t as Record<string, unknown>).tour_type as { name: string; time_zone: string; kind: string } | null;
      const sent = await sendTemplate(db, {
        key: tplKey("followup", ft?.kind === "hwc_consult"),
        to: t.parent_email,
        vars: baseVars({
          parentName: t.parent_name, tourName: ft?.name ?? null,
          when: fmtWhen(new Date(t.starts_at), ft?.time_zone ?? "America/Los_Angeles"),
        }),
      });
      if (sent) thanked++;
      await db.from("sales_tours").update({ followup_sent_at: now.toISOString() }).eq("id", t.id);
    }

    const soon = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
    const { data: due } = await db
      .from("sales_tours")
      .select("*, tour_type:sales_tour_types(name, location, time_zone, meet_url, kind)")
      .eq("status", "confirmed")
      .is("reminder_sent_at", null)
      .gte("starts_at", new Date().toISOString())
      .lte("starts_at", soon);

    let sent = 0;
    for (const t of due ?? []) {
      const tt = (t as Record<string, unknown>).tour_type as
        { name: string; location: string | null; time_zone: string; meet_url: string | null; kind: string } | null;
      const tz = tt?.time_zone ?? "America/Los_Angeles";
      const ok = await sendTemplate(db, {
        key: tplKey("reminder", tt?.kind === "hwc_consult"),
        to: t.parent_email,
        vars: baseVars({
          parentName: t.parent_name, tourName: tt?.name ?? null,
          when: fmtWhen(new Date(t.starts_at), tz),
          location: tt?.location, meet: tt?.meet_url,
          manageToken: t.manage_token,
        }),
      });
      if (ok) sent++;
      await db.from("sales_tours").update({ reminder_sent_at: new Date().toISOString() }).eq("id", t.id);
    }
    return json(200, { reminded: sent, nagged, thanked });
  }

  /**
   * Preview one of the editable emails with sample values. Admin-only, and it
   * writes nothing — it exists so wording can be checked in a real inbox before
   * a family ever sees it.
   */
  if (mode === "test_send") {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth) return json(401, { error: "Sign in first." });
    const caller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
    const { data: me } = await caller.auth.getUser();
    if (!me?.user) return json(401, { error: "Sign in first." });
    const { data: prof } = await db.from("user_profiles")
      .select("role, is_active").eq("id", me.user.id).maybeSingle();
    if (!prof?.is_active || prof.role !== "admin") return json(403, { error: "Admins only." });

    const to = String(body?.to ?? "").trim();
    const key = String(body?.key ?? "").trim();
    if (!to.includes("@") || !key) return json(400, { error: "Need a template and an address." });

    const sample = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const end = new Date(sample.getTime() + 45 * 60000);
    const sent = await sendTemplate(db, {
      key,
      to,
      vars: {
        ...baseVars({
          parentName: "Sample Parent", tourName: "Sample booking",
          when: fmtWhen(sample, "America/Los_Angeles"),
          location: "1720 W Carson St, Torrance",
          meet: "https://meet.google.com/sample-test-room",
          manageToken: "sample-token", slug: "sample",
        }),
        campus_name: "Torrance PV",
        parent_email: "parent@example.com",
        parent_phone: "(310) 555-0134",
        child_name: "Sample Child",
        notes: "This is a test send — no booking exists.",
        what_changed: "This is a test send.",
        portal_link: link(`${PORTAL}/admin/sales/tours`, "Open in the portal"),
      },
      ics: buildIcs({
        uid: `test-${Date.now()}@singinchinese.com`,
        title: "Sample booking", start: sample, end,
        location: "https://meet.google.com/sample-test-room",
        description: "Test send from Sales → Emails.",
      }),
    });
    if (!sent) return json(400, { error: "That email is switched off or has no template row." });
    return json(200, { ok: true });
  }

  /**
   * Staff approving or denying a request. Called from the Tours tab with the
   * caller's JWT — the database decides whether they may touch this campus, so
   * this can't be driven by anyone who simply knows a tour id.
   */
  if (mode === "confirm" || mode === "request_reschedule") {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth) return json(401, { error: "Sign in first." });
    const caller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
    const { data: me } = await caller.auth.getUser();
    if (!me?.user) return json(401, { error: "Sign in first." });

    const { data: tour } = await db
      .from("sales_tours")
      .select("*, tour_type:sales_tour_types(name, slug, location, time_zone, meet_url, duration_minutes, description)")
      .eq("id", String(body?.tour_id ?? "")).maybeSingle();
    if (!tour) return json(404, { error: "Tour not found." });

    // Same campus rule as the alerts: you can only act on tours you'd be told about.
    const { data: allowed } = await db.rpc("tour_alert_recipients", { target_campus: tour.campus_id });
    const ids = ((allowed ?? []) as any[]).map((r) => (typeof r === "string" ? r : r.id));
    if (!ids.includes(me.user.id)) return json(403, { error: "That tour isn't at your campus." });

    const tt = (tour as Record<string, unknown>).tour_type as {
      name: string; slug: string; location: string | null; time_zone: string;
      meet_url: string | null; description: string | null;
    } | null;
    const tz = tt?.time_zone ?? "America/Los_Angeles";
    const when = fmtWhen(new Date(tour.starts_at), tz);

    if (mode === "confirm") {
      await db.from("sales_tours").update({
        status: "confirmed", confirmed_at: new Date().toISOString(), confirmed_by: me.user.id,
      }).eq("id", tour.id);

      const meet = (tt?.meet_url ?? "").trim();

      // Updates the held event the campus already has (same UID, higher
      // SEQUENCE) rather than adding a second one.
      const invite = buildIcs({
        uid: `${tour.id}@singinchinese.com`,
        title: `${tt?.name ?? "Tour"} — ${tour.parent_name ?? ""}`.trim(),
        start: new Date(tour.starts_at), end: new Date(tour.ends_at),
        location: meet || tt?.location || "Sing in Chinese",
        description: meet ? `Join with Google Meet: ${meet}` : tt?.description ?? "",
        sequence: 1,
      });

      // The family gets one too — a confirmed tour belongs in their calendar,
      // which is what they were used to with Calendly.
      await sendTemplate(db, {
        key: "tour_confirmed",
        to: tour.parent_email,
        vars: baseVars({
          parentName: tour.parent_name, tourName: tt?.name ?? null, when,
          location: tt?.location, meet, manageToken: tour.manage_token, slug: tt?.slug,
        }),
        ics: invite,
      });

      await mailCampus({
        key: "staff_booking", campusId: tour.campus_id, tour, tourName: tt?.name ?? null,
        when, location: tt?.location, meet, ics: invite,
      });

      if (tour.lead_id) {
        await db.from("sales_activities").insert({
          lead_id: tour.lead_id, kind: "tour", activity_date: dayIn(tz, new Date()),
          note: `Tour confirmed for ${when}.`, handled_by: me.user.id,
        });
      }
      return json(200, { ok: true, status: "confirmed" });
    }

    // Reschedule: the slot is released so the family can pick again.
    await db.from("sales_tours").update({
      status: "reschedule_requested", cancelled_at: new Date().toISOString(),
      cancel_reason: String(body?.reason ?? "").trim() || null,
      // cancelled_by is a coarse text flag ('parent' | 'staff'); the actual
      // person goes in confirmed_by, which is a real user reference.
      cancelled_by: "staff", confirmed_by: me.user.id,
    }).eq("id", tour.id);

    await sendTemplate(db, {
      key: "tour_reschedule_asked",
      to: tour.parent_email,
      vars: baseVars({
        parentName: tour.parent_name, tourName: tt?.name ?? null, when,
        location: tt?.location, slug: tt?.slug ?? String(body?.slug ?? ""),
      }),
    });

    // The campus was sent a held event when the request came in; take it back
    // off their calendar now the slot has been released.
    await mailCampus({
      key: "staff_changed", campusId: tour.campus_id, tour,
      tourName: tt?.name ?? null, when, location: tt?.location, meet: tt?.meet_url,
      headline: "This request was declined and the family has been asked to pick another time.",
      ics: buildIcs({
        uid: `${tour.id}@singinchinese.com`,
        title: `${tt?.name ?? "Tour"} — ${tour.parent_name ?? ""}`.trim(),
        start: new Date(tour.starts_at), end: new Date(tour.ends_at),
        location: (tt?.meet_url ?? "").trim() || tt?.location || "Sing in Chinese",
        description: "Request declined.",
        sequence: 9, method: "CANCEL",
      }),
    });

    if (tour.lead_id) {
      await db.from("sales_activities").insert({
        lead_id: tour.lead_id, kind: "tour", activity_date: dayIn(tz, new Date()),
        note: `Asked family to reschedule (was ${when}).`, handled_by: me.user.id,
      });
    }
    return json(200, { ok: true, status: "reschedule_requested" });
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
      // A slot is held the moment it's requested, not just once confirmed —
      // otherwise two families could ask for the same time while it waits.
      db.from("sales_tours").select("starts_at").eq("tour_type_id", tt.id)
        .in("status", ["requested", "scheduled", "confirmed"])
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
        // Drives which questions the booking page asks. The Meet URL itself is
        // deliberately not sent — it goes out in the confirmation email only.
        kind: tt.kind ?? "preschool_tour",
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

    // Consultations don't belong in the sales pipeline — these families are
    // enquiring about classes, not a preschool place — so no lead is created
    // and nothing reaches Mailchimp through this door.
    const makesLead = tt.creates_lead !== false;

    const { data: existing } = makesLead
      ? await db.from("sales_leads").select("id").ilike("email", email).limit(1).maybeSingle()
      : { data: null };

    let leadId = existing?.id as string | undefined;
    if (makesLead && !leadId) {
      const parts = name.split(/\s+/);
      const { data: lead, error: lErr } = await db.from("sales_leads").insert({
        campus_ids: tt.campus_id ? [tt.campus_id] : [],
        status: "active",
        parent_first_name: parts.slice(0, -1).join(" ") || parts[0] || "",
        parent_last_name: parts.length > 1 ? parts[parts.length - 1] : "",
        email,
        phone: String(body?.parent_phone ?? "").trim() || null,
        city: String(body?.city ?? "").trim() || null,
        time_zone: String(body?.time_zone ?? "").trim() || null,
        preferred_language: String(body?.preferred_language ?? "").trim() || null,
        source_id: body?.source_id ?? null,
        source_other: String(body?.source_other ?? "").trim() || null,
        referred_by: String(body?.referred_by ?? "").trim() || null,
        first_contact_type: "scheduled_tour",
        inquiry_date: dayIn(tt.time_zone, new Date()),
        notes: String(body?.notes ?? "").trim() || null,
      }).select("id").single();
      if (lErr) return json(500, { error: lErr.message });
      leadId = lead.id;
    }

    // Children are recorded whether the family is new or already known — a
    // returning parent booking for a second child must not lose that child.
    // Consultations have no lead, so there's nothing to attach them to.
    const kids = !makesLead || !leadId ? [] : Array.isArray(body?.children) && body.children.length
      ? body.children
      : [{
          name: body?.child_name, dob: body?.child_dob, program: body?.program,
          schedule: body?.schedule, desired_start_date: body?.desired_start_date,
          desired_start_note: body?.desired_start_note,
        }];
    // Skip children already on this lead. A parent who retries after an error —
    // or who books a second tour for the same child — must not end up with
    // duplicates, and the lead insert above isn't in the same transaction as
    // the tour insert below, so a retry is a real possibility.
    const { data: already } = await db
      .from("sales_lead_children").select("name").eq("lead_id", leadId);
    const seen = new Set(
      ((already ?? []) as { name: string | null }[])
        .map((c) => (c.name ?? "").trim().toLowerCase()).filter(Boolean)
    );

    let idx = seen.size;
    for (const k of kids as any[]) {
      const kidName = String(k?.name ?? "").trim();
      if (!kidName && !k?.program) continue;
      if (kidName && seen.has(kidName.toLowerCase())) continue;
      if (kidName) seen.add(kidName.toLowerCase());
      await db.from("sales_lead_children").insert({
        lead_id: leadId,
        name: String(k?.name ?? "").trim(),
        dob: k?.dob || null,
        program: k?.program || null,
        schedule: String(k?.schedule ?? "").trim() || null,
        chinese_level: String(k?.chinese_level ?? "").trim() || null,
        desired_start_date: k?.desired_start_date || null,
        desired_start_note: String(k?.desired_start_note ?? "").trim() || null,
        order_index: idx++,
      });
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
      // Preschool tours are a *request* staff must approve. Consultations are
      // confirmed on the spot — there's a standing Meet room, so there's
      // nothing to approve.
      status: tt.auto_confirm ? "confirmed" : "requested",
      confirmed_at: tt.auto_confirm ? new Date().toISOString() : null,
      // The consultation's own questions live here rather than as columns —
      // they belong to that form, not to the schema.
      answers: body?.answers && typeof body.answers === "object" ? body.answers : {},
    }).select("id").single();
    if (tErr) return json(500, { error: tErr.message });

    const when = fmtWhen(startAt, tt.time_zone);

    if (leadId) {
      await db.from("sales_activities").insert({
        lead_id: leadId, kind: "tour", activity_date: dayIn(tt.time_zone, startAt),
        note: `Tour requested online for ${when}.`,
      });
    }

    const meet = (tt.meet_url ?? "").trim();
    const vars = baseVars({
      parentName: name, tourName: tt.name, when,
      location: tt.location, meet, manageToken: manage, slug: tt.slug,
    });
    // The row we hand to the campus copy — the insert only returned an id.
    const forStaff = {
      parent_name: name, parent_email: email,
      parent_phone: String(body?.parent_phone ?? "").trim(),
      child_name: String(body?.child_name ?? "").trim(),
      notes: String(body?.notes ?? "").trim(),
      manage_token: manage,
    };

    // Same event id for the parent and the campus, from request through to
    // confirmation, so later invites update it rather than duplicating it.
    const invite = buildIcs({
      uid: `${tour.id}@singinchinese.com`,
      title: tt.auto_confirm ? tt.name : `${tt.name} — ${name}`,
      start: startAt, end: endAt,
      location: meet || tt.location || (tt.auto_confirm ? "Online" : "Sing in Chinese"),
      description: meet ? `Join with Google Meet: ${meet}` : tt.description ?? "",
    });

    if (tt.auto_confirm) {
      // Consultation: confirmed immediately, with the meeting room and a
      // calendar invite both sides can add in one tap.
      await sendTemplate(db, { key: "consult_booked", to: email, vars, ics: invite });
      await alertStaff(
        db, tt.campus_id,
        `Consultation booked — ${tt.name}`,
        `${name} booked ${when}.` + (meet ? ` Meet: ${meet}` : ""),
        tour.id
      );
      await mailCampus({
        key: "staff_booking", campusId: tt.campus_id, tour: forStaff,
        tourName: tt.name, when, location: tt.location, meet, ics: invite,
      });
    } else {
      await sendTemplate(db, { key: "tour_requested", to: email, vars });
      await alertStaff(
        db, tt.campus_id,
        `Tour request — ${tt.name}`,
        `${name} requested ${when}. Confirm or ask them to reschedule.`,
        tour.id
      );
      // The campus gets the invite straight away so the slot is visibly held.
      // It carries the same UID as the confirmation, so approving updates that
      // event and declining sends a cancellation for it.
      await mailCampus({
        key: "staff_changed", campusId: tt.campus_id, tour: forStaff,
        tourName: tt.name, when, location: tt.location, meet,
        headline: "A tour has been requested and is waiting for you to confirm or reschedule it.",
        ics: invite,
      });
    }

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
    if (!["requested", "scheduled", "confirmed"].includes(tour.status)) {
      return json(400, { error: "That booking isn’t active." });
    }
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
    const isConsult = tt.kind === "hwc_consult";
    const cancelledWhen = fmtWhen(new Date(tour.starts_at), tt.time_zone);
    await sendTemplate(db, {
      key: tplKey("cancelled", isConsult),
      to: tour.parent_email,
      vars: baseVars({
        parentName: tour.parent_name, tourName: tt.name, when: cancelledWhen,
        location: tt.location, meet: tt.meet_url, slug: tt.slug,
      }),
    });
    const noun = isConsult ? "meeting" : "tour";
    await notifyStaff(db, `${isConsult ? "Meeting" : "Tour"} cancelled`, `${tour.parent_name} cancelled their ${cancelledWhen} ${noun}.`, tour.lead_id, tour.id, PORTAL);
    await alertStaff(db, tour.campus_id, "Booking cancelled", `${tour.parent_name} cancelled their ${cancelledWhen} ${noun}.`, tour.id);
    await mailCampus({
      key: "staff_changed", campusId: tour.campus_id, tour,
      tourName: tt.name, when: cancelledWhen, location: tt.location, meet: tt.meet_url,
      headline: `${tour.parent_name || "A family"} cancelled this booking. The slot is free again.`,
      // Takes the event off the campus calendar rather than leaving a ghost.
      ics: buildIcs({
        uid: `${tour.id}@singinchinese.com`,
        title: `${tt.name} — ${tour.parent_name ?? ""}`.trim(),
        start: new Date(tour.starts_at), end: new Date(tour.ends_at),
        location: (tt.meet_url ?? "").trim() || tt.location || "Sing in Chinese",
        description: "Cancelled by the family.",
        sequence: 9, method: "CANCEL",
      }),
    });
    return json(200, { ok: true });
  }

  if (mode === "reschedule") {
    if (!["requested", "scheduled", "confirmed"].includes(tour.status)) {
      return json(400, { error: "That booking isn’t active." });
    }
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
    const movedConsult = tt.kind === "hwc_consult";
    const movedEnd = new Date(startAt.getTime() + tt.duration_minutes * 60000);
    const movedIcs = buildIcs({
      uid: `${tour.id}@singinchinese.com`,
      title: `${tt.name} — ${tour.parent_name ?? ""}`.trim(),
      start: startAt, end: movedEnd,
      location: (tt.meet_url ?? "").trim() || tt.location || "Sing in Chinese",
      description: (tt.meet_url ?? "").trim() ? `Join with Google Meet: ${tt.meet_url}` : tt.description ?? "",
      // Higher than the original invite so calendars move the event instead of
      // adding a second one.
      sequence: 2,
    });

    await sendTemplate(db, {
      key: tplKey("rescheduled", movedConsult),
      to: tour.parent_email,
      vars: baseVars({
        parentName: tour.parent_name, tourName: tt.name, when,
        location: tt.location, meet: tt.meet_url, manageToken: tok, slug: tt.slug,
      }),
      // A meeting the parent joins by link deserves the corrected invite.
      ics: movedConsult ? movedIcs : undefined,
    });
    const movedNoun = movedConsult ? "meeting" : "tour";
    await notifyStaff(db, `${movedConsult ? "Meeting" : "Tour"} rescheduled`, `${tour.parent_name} moved their ${movedNoun} from ${oldWhen} to ${when}.`, tour.lead_id, tour.id, PORTAL);
    await alertStaff(db, tour.campus_id, "Booking moved", `${tour.parent_name} moved their ${movedNoun} from ${oldWhen} to ${when}.`, tour.id);
    await mailCampus({
      key: "staff_changed", campusId: tour.campus_id, tour,
      tourName: tt.name, when, location: tt.location, meet: tt.meet_url,
      headline: `${tour.parent_name || "A family"} moved this booking — it was ${oldWhen}.`,
      ics: movedIcs,
    });
    return json(200, { ok: true, when });
  }

  return json(400, { error: "Unknown request." });
});

/**
 * Tells staff about a booking through the portal bell, which also pushes to the
 * HR app. Deliberately NOT email: not every staff account has an address, so
 * email would reach some people and silently miss others. Parents still get
 * emailed — that's their only channel.
 */
async function notifyStaff(
  db: ReturnType<typeof createClient>,
  title: string, message: string,
  leadId: string | null, tourId: string, _portal: string
) {
  const { data: recips } = await db
    .from("sales_tour_notify")
    .select("user_id, user_profiles(is_active)");

  for (const r of recips ?? []) {
    const p = (r as Record<string, unknown>).user_profiles as { is_active: boolean } | null;
    if (!p?.is_active) continue;
    await db.rpc("app_notify", {
      p_user_id: r.user_id,
      p_type: "sales_tour",
      p_title: title,
      p_body: message,
      p_data: { lead_id: leadId, tour_id: tourId },
    });
  }
}
