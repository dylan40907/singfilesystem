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
const MEET: EmailToken = { key: "meet_link", label: "Meeting link", required: true, hint: "The Google Meet room for this booking type. Blank for in-person tours." };

export const EMAIL_TEMPLATES: EmailTemplateSpec[] = [
  { key: "tour_requested", group: "Tours", tokens: [PARENT, TOUR, WHEN, WHERE, MANAGE] },
  { key: "tour_confirmed", group: "Tours", tokens: [PARENT, TOUR, WHEN, WHERE, MANAGE] },
  { key: "tour_reschedule_asked", group: "Tours", tokens: [PARENT, TOUR, WHEN, PHONE, BOOK] },
  { key: "tour_reminder", group: "Tours", tokens: [PARENT, TOUR, WHEN, WHERE, MEET, MANAGE] },
  { key: "tour_followup", group: "Tours", tokens: [PARENT, TOUR, WHEN, PHONE] },
  { key: "tour_cancelled", group: "Tours", tokens: [PARENT, TOUR, WHEN, BOOK] },
  { key: "tour_rescheduled", group: "Tours", tokens: [PARENT, TOUR, WHEN, WHERE, MEET, MANAGE] },
  { key: "consult_booked", group: "Consultations", tokens: [PARENT, TOUR, WHEN, PHONE, MEET, MANAGE] },
  {
    key: "staff_booking",
    group: "Staff",
    tokens: [
      { key: "campus_name", label: "Campus" },
      TOUR, WHEN, WHERE, MEET,
      PARENT,
      { key: "parent_email", label: "Parent email" },
      { key: "parent_phone", label: "Parent phone" },
      { key: "child_name", label: "Child name" },
      { key: "notes", label: "Notes from the family" },
      { key: "portal_link", label: "Open in the portal", required: true },
    ],
  },
  {
    key: "staff_changed",
    group: "Staff",
    tokens: [
      { key: "what_changed", label: "What happened", hint: "One line saying whether it was requested, cancelled or moved." },
      { key: "campus_name", label: "Campus" },
      TOUR, WHEN, WHERE, MEET,
      PARENT,
      { key: "parent_email", label: "Parent email" },
      { key: "parent_phone", label: "Parent phone" },
      { key: "child_name", label: "Child name" },
      { key: "notes", label: "Notes from the family" },
      { key: "portal_link", label: "Open in the portal", required: true },
    ],
  },
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
 * Inline images have to be fetchable by whatever mail client opens the message,
 * so the bucket is public and we hand back the plain URL. Attachments live in
 * the same place; the edge function downloads and encodes them at send time.
 */
export async function uploadEmailAsset(file: File): Promise<{ url: string; path: string }> {
  const safe = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-80) || "file";
  const path = `${crypto.randomUUID()}-${safe}`;
  const { error } = await supabase.storage
    .from(ASSET_BUCKET)
    .upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw new Error(error.message);
  const { data } = supabase.storage.from(ASSET_BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, path };
}

export async function deleteEmailAsset(path: string): Promise<void> {
  await supabase.storage.from(ASSET_BUCKET).remove([path]);
}
