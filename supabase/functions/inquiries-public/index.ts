// supabase/functions/inquiries-public/index.ts
//
// The public enquiry forms on singinchinese.com — the replacement for the
// Squarespace form blocks.
//
// Squarespace can only deliver a submission to email, Google Drive, Mailchimp
// or Zapier; it cannot POST to us. So we host the form ourselves (iframed into
// the Squarespace page) and this is the door it posts through. Runs on the
// service role and returns only the form's own definition, so sales_leads stays
// closed to anonymous clients while the page itself is public.
//
// Modes:
//   form   { slug }            → the form definition to render
//   submit { slug, answers }   → creates the lead (+ child) and alerts staff

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

type Field = {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  half?: boolean;
  options?: string[];
  placeholder?: string;
};

/** Keys we map onto real columns; everything else is kept in the notes. */
const LEAD_KEYS = new Set([
  "parent_first_name", "parent_last_name", "email", "phone", "city",
  "accepts_marketing", "notes", "heard_about_us", "campus",
]);
const CHILD_KEYS = new Set([
  "child_first_name", "child_last_name", "child_dob", "chinese_level",
  "previous_school", "schedule", "program",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: "Server not configured" });

  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  const body = await req.json().catch(() => ({}));
  const mode = String(body?.mode ?? "form");
  const slug = String(body?.slug ?? "").trim();

  const { data: form } = await db
    .from("sales_inquiry_forms")
    .select("*")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();
  if (!form) return json(404, { error: "That form isn't available." });

  if (mode === "form") {
    return json(200, {
      form: {
        slug: form.slug,
        name: form.name,
        headline: form.headline,
        intro: form.intro,
        fields: form.fields,
        submit_label: form.submit_label,
        thank_you: form.thank_you,
      },
    });
  }

  if (mode !== "submit") return json(400, { error: "Unknown request." });

  // Honeypot: bots fill hidden fields, humans don't.
  if (String(body?.website ?? "").trim()) return json(200, { ok: true });

  const answers = (body?.answers ?? {}) as Record<string, unknown>;
  const str = (k: string) => String(answers[k] ?? "").trim();
  const fields = (form.fields ?? []) as Field[];

  // Server-side validation — the browser's `required` is a convenience, not a
  // guarantee, and this endpoint is public.
  for (const f of fields) {
    if (f.required && f.type !== "checkbox" && !str(f.key)) {
      return json(400, { error: `Please fill in "${f.label}".` });
    }
  }
  const email = str("email").toLowerCase();
  if (!email.includes("@")) return json(400, { error: "Please give a valid email address." });

  // Keep the raw submission first: if anything below fails, the enquiry still
  // exists and can be recovered rather than being lost.
  const { data: submission } = await db
    .from("sales_inquiry_submissions")
    .insert({ form_id: form.id, answers })
    .select("id")
    .single();

  try {
    // Anything without a column of its own still reaches the team, appended to
    // the notes with its question, so no answer is silently dropped.
    const extraLines = fields
      .filter((f) => !LEAD_KEYS.has(f.key) && !CHILD_KEYS.has(f.key))
      .map((f) => {
        const v = f.type === "checkbox" ? (answers[f.key] ? "Yes" : "No") : str(f.key);
        return v ? `${f.label}: ${v}` : "";
      })
      .filter(Boolean);

    const notes = [str("notes"), ...extraLines].filter(Boolean).join("\n");

    // Which campus the family picked, matched to a real campus row.
    const campusName = str("campus");
    let campusIds: string[] = [];
    if (form.campus_id) campusIds = [form.campus_id];
    else if (campusName) {
      const { data: c } = await db
        .from("hr_campuses")
        .select("id")
        .eq("admissions_only", false)
        .ilike("name", campusName)
        .maybeSingle();
      if (c) campusIds = [c.id];
    }

    // Match the "How did you hear about us?" answer to a configured source so
    // the conversion-by-source report keeps working.
    let sourceId: string | null = null;
    const heard = str("heard_about_us");
    if (heard) {
      const { data: src } = await db
        .from("sales_lead_sources").select("id").ilike("name", heard).maybeSingle();
      sourceId = src?.id ?? null;
    }

    // An existing family enquiring again shouldn't become a second lead.
    const { data: existing } = await db
      .from("sales_leads").select("id").ilike("email", email).limit(1).maybeSingle();

    let leadId = existing?.id as string | undefined;
    if (!leadId) {
      const { data: lead, error: lErr } = await db.from("sales_leads").insert({
        campus_ids: campusIds,
        status: "active",
        parent_first_name: str("parent_first_name"),
        parent_last_name: str("parent_last_name"),
        email,
        phone: str("phone") || null,
        source_id: sourceId,
        source_other: sourceId ? null : (heard || null),
        first_contact_type: form.first_contact_type,
        inquiry_date: new Date().toISOString().slice(0, 10),
        notes: notes || null,
      }).select("id").single();
      if (lErr) throw new Error(lErr.message);
      leadId = lead.id;
    } else {
      // Returning family: append rather than overwrite what's already recorded.
      const { data: prev } = await db.from("sales_leads").select("notes").eq("id", leadId).maybeSingle();
      const stamp = new Date().toISOString().slice(0, 10);
      await db.from("sales_leads").update({
        notes: [prev?.notes, `— ${form.name}, ${stamp} —`, notes].filter(Boolean).join("\n"),
      }).eq("id", leadId);
    }

    const childName = [str("child_first_name"), str("child_last_name")].filter(Boolean).join(" ");
    if (childName) {
      // Don't duplicate a child the family has already told us about.
      const { data: kids } = await db
        .from("sales_lead_children").select("name").eq("lead_id", leadId);
      const known = new Set(((kids ?? []) as { name: string | null }[])
        .map((k) => (k.name ?? "").trim().toLowerCase()).filter(Boolean));
      if (!known.has(childName.toLowerCase())) {
        await db.from("sales_lead_children").insert({
          lead_id: leadId,
          name: childName,
          dob: str("child_dob") || null,
          chinese_level: str("chinese_level") || null,
          previous_school: str("previous_school") || null,
          schedule: str("schedule") || null,
          program: str("program") || null,
          order_index: known.size,
        });
      }
    }

    await db.from("sales_activities").insert({
      lead_id: leadId,
      kind: "note",
      activity_date: new Date().toISOString().slice(0, 10),
      note: `Enquiry submitted through the website (${form.name}).`,
    });

    if (submission) {
      await db.from("sales_inquiry_submissions").update({ lead_id: leadId }).eq("id", submission.id);
    }

    // Tell the campus's staff, same rule the tour alerts use.
    const { data: ids } = await db.rpc("tour_alert_recipients", {
      target_campus: campusIds[0] ?? null,
    });
    const userIds = ((ids ?? []) as any[]).map((r) => (typeof r === "string" ? r : r.id)).filter(Boolean);
    if (userIds.length) {
      await db.from("hr_notifications").insert(
        userIds.map((uid: string) => ({
          user_id: uid,
          type: "sales_lead",
          title: `New enquiry — ${form.name}`,
          body: `${str("parent_first_name")} ${str("parent_last_name")}`.trim() + ` · ${email}`,
          data: { lead_id: leadId, url: `/admin/sales/${leadId}` },
        }))
      );
    }

    return json(200, { ok: true, thank_you: form.thank_you });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    if (submission) {
      await db.from("sales_inquiry_submissions").update({ error: message }).eq("id", submission.id);
    }
    console.error("Inquiry submit failed:", message);
    // The family shouldn't see a stack trace, and their answers are saved.
    return json(500, { error: "Something went wrong saving your enquiry. Please call us and we'll take the details." });
  }
});
