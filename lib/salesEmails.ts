/**
 * The sales emails an admin can reword, and the tokens each one may use.
 *
 * Bodies are stored as HTML containing `{{token}}` placeholders. The editor
 * shows those as locked chips so they can't be half-deleted, and refuses to
 * save when a `required` token has gone missing — a confirmation email without
 * its manage link would strand the family with no way to change their booking.
 *
 * The edge function does the substitution mechanically: it fills in whatever
 * tokens it has values for and blanks the rest. It deliberately does NOT know
 * this catalogue, so adding a token here means adding it there too.
 */

import { supabase } from "./supabaseClient";

export type EmailToken = {
  key: string;
  label: string;
  /** Must survive editing — the editor blocks a save without it. */
  required?: boolean;
  hint?: string;
};

export type EmailTemplateSpec = {
  key: string;
  /** Rough order the family receives them in, for the sidebar. */
  group: "Tours" | "Consultations" | "Staff";
  tokens: EmailToken[];
};

const PARENT: EmailToken = { key: "parent_name", label: "Parent name" };
const TOUR: EmailToken = { key: "tour_name", label: "Booking type", hint: "e.g. Torrance PV Tour" };
const WHEN: EmailToken = { key: "when", label: "Date & time" };
const WHERE: EmailToken = { key: "location", label: "Location" };
const PHONE: EmailToken = { key: "phone", label: "Phone number" };
const MANAGE: EmailToken = { key: "manage_link", label: "Change / cancel link", required: true, hint: "The family's private link to reschedule or cancel." };
const BOOK: EmailToken = { key: "book_link", label: "Booking page link", required: true };
/**
 * Never required: an in-person tour has no meeting room, so insisting on it
 * blocked saves on emails where it can only ever render as nothing.
 */
const MEET: EmailToken = { key: "meet_link", label: "Meeting link", hint: "The Google Meet room. Renders as nothing on in-person tours." };
const CHILD: EmailToken = { key: "child_name", label: "Child name" };
const CHILD_DOB: EmailToken = { key: "child_dob", label: "Child's date of birth" };
const CHILD_START: EmailToken = { key: "child_start_date", label: "Child's desired start date" };
const PORTAL: EmailToken = { key: "portal_link", label: "Open in the portal" };

/** The family details every campus copy lists. */
const STAFF_DETAIL: EmailToken[] = [
  { key: "campus_name", label: "Campus" },
  TOUR, WHEN, WHERE, MEET,
  PARENT,
  { key: "parent_email", label: "Parent email" },
  { key: "parent_phone", label: "Parent phone" },
  CHILD, CHILD_DOB, CHILD_START,
  { key: "notes", label: "Notes from the family" },
  PORTAL,
];

const WHAT_CHANGED: EmailToken = {
  key: "what_changed", label: "What happened",
  hint: "One line saying whether it was requested, cancelled or moved.",
};

export const EMAIL_TEMPLATES: EmailTemplateSpec[] = [
  { key: "tour_requested", group: "Tours", tokens: [PARENT, TOUR, WHEN, WHERE, CHILD, CHILD_DOB, CHILD_START, MANAGE] },
  { key: "tour_confirmed", group: "Tours", tokens: [PARENT, TOUR, WHEN, WHERE, CHILD, CHILD_DOB, CHILD_START, MANAGE] },
  { key: "tour_reschedule_asked", group: "Tours", tokens: [PARENT, TOUR, WHEN, PHONE, CHILD, BOOK] },
  { key: "tour_reminder", group: "Tours", tokens: [PARENT, TOUR, WHEN, WHERE, CHILD, CHILD_DOB, CHILD_START, MANAGE] },
  { key: "tour_followup", group: "Tours", tokens: [PARENT, TOUR, WHEN, PHONE, CHILD] },
  { key: "tour_cancelled", group: "Tours", tokens: [PARENT, TOUR, WHEN, CHILD, BOOK] },
  { key: "tour_rescheduled", group: "Tours", tokens: [PARENT, TOUR, WHEN, WHERE, CHILD, MANAGE] },

  { key: "consult_booked", group: "Consultations", tokens: [PARENT, TOUR, WHEN, PHONE, CHILD, MEET, MANAGE] },
  { key: "consult_reminder", group: "Consultations", tokens: [PARENT, TOUR, WHEN, PHONE, CHILD, MEET, MANAGE] },
  { key: "consult_rescheduled", group: "Consultations", tokens: [PARENT, TOUR, WHEN, PHONE, CHILD, MEET, MANAGE] },
  { key: "consult_cancelled", group: "Consultations", tokens: [PARENT, TOUR, WHEN, PHONE, CHILD, BOOK] },
  { key: "consult_followup", group: "Consultations", tokens: [PARENT, TOUR, WHEN, PHONE, CHILD] },

  // Tours and meetings read differently to staff too — a tour needs the door
  // and the child's details, a meeting needs the room link.
  { key: "staff_tour_booking", group: "Staff", tokens: STAFF_DETAIL },
  { key: "staff_tour_changed", group: "Staff", tokens: [WHAT_CHANGED, ...STAFF_DETAIL] },
  { key: "staff_consult_booking", group: "Staff", tokens: STAFF_DETAIL },
  { key: "staff_consult_changed", group: "Staff", tokens: [WHAT_CHANGED, ...STAFF_DETAIL] },
];

export function specFor(key: string): EmailTemplateSpec | undefined {
  return EMAIL_TEMPLATES.find((t) => t.key === key);
}

export type EmailAttachment = { path: string; filename: string; size: number; mime: string };

export type EmailTemplateRow = {
  key: string;
  name: string;
  description: string | null;
  subject: string;
  body_html: string;
  attachments: EmailAttachment[];
  is_active: boolean;
  updated_at: string;
};

export type EmailOverrideRow = {
  key: string;
  campus_id: string;
  subject: string;
  body_html: string;
  attachments: EmailAttachment[];
  updated_at: string;
};

/**
 * What one campus actually sends for one email.
 *
 * The primary campus edits `sales_email_templates` directly. Every other campus
 * inherits that wording until someone unlocks the email for them, which writes
 * a row into `sales_email_overrides` — so "locked" is simply the absence of a
 * row, and a locked campus picks up edits to the primary automatically with no
 * syncing to go wrong.
 */
export function resolveTemplate(
  base: EmailTemplateRow,
  override: EmailOverrideRow | undefined
): { subject: string; body_html: string; attachments: EmailAttachment[]; locked: boolean } {
  if (!override) {
    return { subject: base.subject, body_html: base.body_html, attachments: base.attachments ?? [], locked: true };
  }
  return {
    subject: override.subject,
    body_html: override.body_html,
    attachments: override.attachments ?? [],
    locked: false,
  };
}

/** Every `{{token}}` currently in a subject + body. */
export function tokensIn(...parts: string[]): Set<string> {
  const found = new Set<string>();
  for (const p of parts) {
    for (const m of p.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) found.add(m[1].toLowerCase());
  }
  return found;
}

/**
 * Required tokens that the edit dropped. The subject counts too — a token can
 * legitimately live there instead of in the body.
 */
export function missingRequired(key: string, subject: string, bodyHtml: string): EmailToken[] {
  const spec = specFor(key);
  if (!spec) return [];
  const have = tokensIn(subject, bodyHtml);
  return spec.tokens.filter((t) => t.required && !have.has(t.key));
}

// ── Editor ↔ storage ────────────────────────────────────────────────────────
// Stored form is `{{token}}`. Editing form is a chip the browser treats as one
// indivisible character, which is what stops a stray backspace from leaving
// `{{meet_lin}}` behind.

export function toEditorHtml(stored: string, spec: EmailTemplateSpec | undefined): string {
  return stored.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, raw: string) => {
    const key = raw.toLowerCase();
    const label = spec?.tokens.find((t) => t.key === key)?.label ?? key;
    return (
      `<span class="etok" data-tok="${key}" contenteditable="false">${escapeHtml(label)}</span>`
    );
  });
}

export function fromEditorHtml(editor: string): string {
  // Chips are always `<span … data-tok="x" …>label</span>` — written by us, and
  // never nested, so a non-greedy match is enough.
  return editor
    .replace(/<span[^>]*data-tok="([a-z0-9_]+)"[^>]*>.*?<\/span>/gi, (_m, key: string) => `{{${key}}}`)
    .replace(/<span[^>]*data-tok='([a-z0-9_]+)'[^>]*>.*?<\/span>/gi, (_m, key: string) => `{{${key}}}`);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Assets ──────────────────────────────────────────────────────────────────

const ASSET_BUCKET = "sales-email-assets";

/**
 * The public URL for an email asset.
 *
 * Served through our own route rather than a presigned link: an email sits in
 * an inbox for months and a presigned URL would expire, leaving broken images
 * in a message already sent. Old assets still carry a bare Supabase key and
 * keep using the Supabase public URL until they're repointed.
 */
export function emailAssetUrl(path: string): string {
  if (path.startsWith("sales-email/")) return `/api/email-asset/${path}`;
  return supabase.storage.from(ASSET_BUCKET).getPublicUrl(path).data.publicUrl;
}

async function assetAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${data.session?.access_token ?? ""}`,
  };
}

/**
 * Upload an inline image or attachment to R2.
 *
 * The returned `url` is absolute on purpose — it is pasted straight into email
 * HTML, where a relative path would resolve against the recipient's mail
 * client rather than against us.
 */
export async function uploadEmailAsset(file: File): Promise<{ url: string; path: string }> {
  const presign = await fetch("/api/r2/media-presign", {
    method: "POST",
    headers: await assetAuthHeaders(),
    body: JSON.stringify({
      scope: "email",
      filename: file.name || "file",
      contentType: file.type || "application/octet-stream",
    }),
  });
  const signed = await presign.json();
  if (!presign.ok || !signed?.uploadUrl) throw new Error(signed?.error ?? "Could not start the upload.");

  const put = await fetch(signed.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!put.ok) throw new Error(`Upload failed (${put.status}).`);

  const path: string = signed.objectKey;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return { url: `${origin}/api/email-asset/${path}`, path };
}

export async function deleteEmailAsset(path: string): Promise<void> {
  if (path.startsWith("sales-email/")) {
    await fetch("/api/r2/media-delete", {
      method: "POST",
      headers: await assetAuthHeaders(),
      body: JSON.stringify({ keys: [path] }),
    });
    return;
  }
  await supabase.storage.from(ASSET_BUCKET).remove([path]);
}
