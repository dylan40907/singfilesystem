import { supabase } from "@/lib/supabaseClient";

/**
 * Sales CRM data layer — the app-side replacement for the "Inquiry Log" sheet.
 *
 * A LEAD is one inquiring family. The sheet repeated the whole parent row once
 * per child (which is why some families' follow-up notes appear twice); here a
 * lead owns a list of CHILDREN instead. Follow-ups are rows in sales_activities
 * rather than the sheet's unbounded "Date / Date / Date" columns.
 */

export type SalesStatus = "active" | "inactive" | "enrolled";

export const SALES_STATUS_LABEL: Record<SalesStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  enrolled: "Enrolled",
};

/** How the family first reached us — the notes' "Call or Scheduled Tour". */
export type FirstContactType =
  | "call" | "scheduled_tour" | "walk_in" | "email" | "web_form" | "event" | "other";

export const FIRST_CONTACT_LABEL: Record<FirstContactType, string> = {
  call: "Call",
  scheduled_tour: "Scheduled Tour",
  walk_in: "Walk-in",
  email: "Email",
  web_form: "Web form",
  event: "Event",
  other: "Other",
};

export type ActionType = "call" | "email" | "tour" | "text" | "other";

export const ACTION_TYPE_LABEL: Record<ActionType, string> = {
  call: "Call",
  email: "Email",
  tour: "Tour",
  text: "Text",
  other: "Other",
};

export type ActivityKind =
  | "call" | "email" | "tour" | "text" | "note" | "status_change" | "imported" | "other";

export const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = {
  call: "Call",
  email: "Email",
  tour: "Tour",
  text: "Text",
  note: "Note",
  status_change: "Status change",
  imported: "Imported",
  other: "Other",
};

export type SalesSource = {
  id: string;
  name: string;
  order_index: number;
  is_active: boolean;
};

/** The programs a family can enquire about. */
export const PROGRAMS = ["Preschool", "HWC", "Language Classes", "Camps"] as const;

export type SalesLeadChild = {
  id: string;
  lead_id: string;
  name: string;
  dob: string | null;
  dob_note: string | null;
  program: string | null;
  /** Siblings often start in different terms, so this lives per child. */
  desired_start_date: string | null;
  desired_start_note: string | null;
  schedule: string | null;
  learned_chinese: string | null;
  previous_school: string | null;
  chinese_level: string | null;
  order_index: number;
};

export type SalesActivity = {
  id: string;
  lead_id: string;
  activity_date: string;
  kind: ActivityKind;
  note: string;
  /** Who actually made the call / sent the email — not necessarily who typed it up. */
  handled_by: string | null;
  created_by: string | null;
  created_at: string;
};

export type SalesLead = {
  id: string;
  /**
   * Every campus this family is considering. Plenty tour both before choosing,
   * and both campuses need to see the lead while that's true.
   */
  campus_ids: string[];
  /** Which campus actually won them, once they enrol. */
  enrolled_campus_id: string | null;
  status: SalesStatus;

  parent_first_name: string;
  parent_last_name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  time_zone: string | null;
  preferred_language: string | null;

  source_id: string | null;
  source_other: string | null;
  /** Who sent them — only meaningful for word-of-mouth style sources. */
  referred_by: string | null;
  /** Siblings split into their own leads share a household id. */
  household_id: string | null;
  first_contact_type: FirstContactType | null;
  inquiry_date: string;
  notes: string | null;
  staff_owner_id: string | null;
  staff_name: string | null;

  next_action_date: string | null;
  next_action_type: ActionType | null;
  next_action_note: string | null;
  /** Who owes this follow-up. Reminders go to them first. */
  next_action_assigned_to: string | null;

  status_changed_at: string | null;
  converted_at: string | null;
  inactive_reason: string | null;

  created_at: string;
  updated_at: string;
  created_by: string | null;
};

/** A lead plus the joined bits every list/detail view needs. */
export type SalesLeadFull = SalesLead & {
  children: SalesLeadChild[];
  source: { id: string; name: string } | null;
};

const LEAD_SELECT =
  "*, source:sales_lead_sources(id,name), children:sales_lead_children(*)";

function normalizeLead(row: Record<string, unknown>): SalesLeadFull {
  const lead = row as unknown as SalesLeadFull;
  const children = [...(lead.children ?? [])].sort((a, b) => a.order_index - b.order_index);
  return { ...lead, children };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function fetchSources(): Promise<SalesSource[]> {
  const { data, error } = await supabase
    .from("sales_lead_sources")
    .select("*")
    .order("order_index")
    .order("name");
  if (error) throw error;
  return (data ?? []) as SalesSource[];
}

/**
 * All leads the caller may see. RLS already scopes campus admins to their own
 * campus; `campusId` narrows further for the admin campus picker.
 */
export async function fetchLeads(campusId?: string | null): Promise<SalesLeadFull[]> {
  let q = supabase.from("sales_leads").select(LEAD_SELECT);
  // `null` means "no campus set yet" — those need an admin to triage them.
  if (campusId === null) q = q.eq("campus_ids", "{}");
  else if (campusId) q = q.contains("campus_ids", [campusId]);

  const { data, error } = await q
    .order("parent_last_name", { ascending: true })
    .order("parent_first_name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => normalizeLead(r as Record<string, unknown>));
}

export async function fetchLead(id: string): Promise<SalesLeadFull | null> {
  const { data, error } = await supabase.from("sales_leads").select(LEAD_SELECT).eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? normalizeLead(data as Record<string, unknown>) : null;
}

export async function fetchActivities(leadId: string): Promise<SalesActivity[]> {
  const { data, error } = await supabase
    .from("sales_activities")
    .select("*")
    .eq("lead_id", leadId)
    .order("activity_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as SalesActivity[];
}

/**
 * Everyone who can own a lead or be assigned a follow-up: admins, campus admins
 * and supervisors. ("App Supervisor" is a supervisor carrying the learning
 * flag, so it's already included.)
 */
export async function fetchAssignableStaff(): Promise<{ id: string; full_name: string | null; role: string }[]> {
  const { data, error } = await supabase
    .from("user_profiles")
    .select("id, full_name, role")
    .eq("is_active", true)
    .in("role", ["admin", "campus_admin", "supervisor"])
    .order("full_name");
  if (error) throw error;
  return (data ?? []) as { id: string; full_name: string | null; role: string }[];
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export type LeadInput = Partial<Omit<SalesLead, "id" | "created_at" | "updated_at">>;

export async function createLead(input: LeadInput): Promise<SalesLead> {
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("sales_leads")
    .insert({ ...input, created_by: auth.user?.id ?? null })
    .select()
    .single();
  if (error) throw error;
  return data as SalesLead;
}

export async function updateLead(id: string, patch: LeadInput): Promise<void> {
  const { error } = await supabase.from("sales_leads").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteLead(id: string): Promise<void> {
  const { error } = await supabase.from("sales_leads").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Move a lead between the three tabs. The transition is also written to the
 * history so the timeline explains itself later.
 */
export async function setLeadStatus(
  id: string,
  status: SalesStatus,
  reason?: string,
  enrolledCampusId?: string | null
): Promise<void> {
  const now = new Date().toISOString();
  const patch: LeadInput = {
    status,
    status_changed_at: now,
    converted_at: status === "enrolled" ? now : null,
    enrolled_campus_id: status === "enrolled" ? (enrolledCampusId ?? null) : null,
    inactive_reason: status === "inactive" ? (reason ?? null) : null,
  };
  // A closed lead has nothing left to chase, so clear the pending action —
  // otherwise the reminder job would keep nagging about a won/lost family.
  if (status !== "active") {
    patch.next_action_date = null;
    patch.next_action_type = null;
    patch.next_action_note = null;
  }
  await updateLead(id, patch);
  await addActivity(id, {
    kind: "status_change",
    note:
      status === "enrolled"
        ? "Converted to enrolled."
        : status === "inactive"
        ? `Marked inactive.${reason ? ` ${reason}` : ""}`
        : "Re-opened as active.",
  });
}

export async function addActivity(
  leadId: string,
  input: { kind: ActivityKind; note: string; activity_date?: string; handled_by?: string | null }
): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase.from("sales_activities").insert({
    lead_id: leadId,
    kind: input.kind,
    note: input.note,
    activity_date: input.activity_date ?? todayLocal(),
    handled_by: input.handled_by ?? null,
    created_by: auth.user?.id ?? null,
  });
  if (error) throw error;
}

/**
 * Record what was done AND what happens next, in one step.
 *
 * A lead that's still in play must always have a next action owned by somebody
 * — that's the whole point of the follow-up reminders. Logging on its own would
 * let a family go quiet the moment the last action was ticked off, so the two
 * are deliberately submitted together and both are required.
 *
 * The next action is written first: if that fails, no activity is recorded and
 * the pending action stays put, rather than the log advancing while the lead
 * silently loses its follow-up.
 */
export async function logActionAndSetNext(
  leadId: string,
  done: { kind: ActivityKind; note: string; activity_date: string; handled_by: string },
  next: { date: string; type: ActionType; note: string; assigned_to: string }
): Promise<void> {
  if (!done.handled_by) throw new Error("Choose who handled this.");
  if (!done.note.trim()) throw new Error("Write what happened.");
  if (!next.date) throw new Error("Set a date for the next action.");
  if (!next.note.trim()) throw new Error("Add a note for the next action.");
  if (!next.assigned_to) throw new Error("Assign the next action to someone.");

  const { error: naErr } = await supabase
    .from("sales_leads")
    .update({
      next_action_date: next.date,
      next_action_type: next.type,
      next_action_note: next.note.trim(),
      next_action_assigned_to: next.assigned_to,
      // Re-arm reminders for the new date.
      last_reminded_on: null,
    })
    .eq("id", leadId);
  if (naErr) throw naErr;

  await addActivity(leadId, {
    kind: done.kind,
    note: done.note.trim(),
    activity_date: done.activity_date,
    handled_by: done.handled_by,
  });
}

export async function deleteActivity(id: string): Promise<void> {
  const { error } = await supabase.from("sales_activities").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Set the next follow-up. Clearing the alert bookkeeping re-arms both reminder
 * emails for the new date (see run_sales_followup_reminders).
 */
export async function setNextAction(
  leadId: string,
  input: { date: string; type: ActionType; note: string; assigned_to: string }
): Promise<void> {
  if (!input.assigned_to) throw new Error("Assign the next action to someone.");
  const { error } = await supabase
    .from("sales_leads")
    .update({
      next_action_date: input.date,
      next_action_type: input.type,
      next_action_note: input.note,
      next_action_assigned_to: input.assigned_to,
      last_reminded_on: null,
    })
    .eq("id", leadId);
  if (error) throw error;
}

/**
 * Only used when a lead is closed out — an active lead always keeps a pending
 * action, otherwise nothing brings it back to anyone's attention.
 */
export async function clearNextAction(leadId: string): Promise<void> {
  const { error } = await supabase
    .from("sales_leads")
    .update({
      next_action_date: null, next_action_type: null,
      next_action_note: null, next_action_assigned_to: null,
      last_reminded_on: null,
    })
    .eq("id", leadId);
  if (error) throw error;
}

// ─── Children ────────────────────────────────────────────────────────────────

export type ChildInput = Partial<Omit<SalesLeadChild, "id" | "lead_id">>;

export async function addChild(leadId: string, input: ChildInput): Promise<void> {
  const { error } = await supabase.from("sales_lead_children").insert({ lead_id: leadId, ...input });
  if (error) throw error;
}

export async function updateChild(id: string, patch: ChildInput): Promise<void> {
  const { error } = await supabase.from("sales_lead_children").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteChild(id: string): Promise<void> {
  const { error } = await supabase.from("sales_lead_children").delete().eq("id", id);
  if (error) throw error;
}

// ─── Derived values ──────────────────────────────────────────────────────────

/** Today as YYYY-MM-DD in the viewer's own timezone (not UTC). */
export function todayLocal(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * The status as a given campus experiences it.
 *
 * A family touring both campuses who enrols at one is a win there and a loss at
 * the other — so the losing campus sees them under Inactive, while a full admin
 * looking across campuses sees a single Enrolled. This keeps one status row per
 * family instead of one per campus, and keeps each campus's conversion rate
 * honest.
 */
export function statusForCampus(l: SalesLead, campusId?: string | null): SalesStatus {
  if (!campusId) return l.status;
  if (l.status === "enrolled" && l.enrolled_campus_id && l.enrolled_campus_id !== campusId) {
    return "inactive";
  }
  return l.status;
}

/** True when this campus lost the family to the other one. */
export function lostToOtherCampus(l: SalesLead, campusId?: string | null): boolean {
  return (
    !!campusId &&
    l.status === "enrolled" &&
    !!l.enrolled_campus_id &&
    l.enrolled_campus_id !== campusId
  );
}

/** Sources where knowing who referred the family is worth recording. */
const REFERRER_SOURCES = new Set(["Word of Mouth", "Sibling / Returning Family"]);

export function sourceWantsReferrer(sourceName: string | null | undefined): boolean {
  return !!sourceName && REFERRER_SOURCES.has(sourceName);
}

/** Time zones families actually move to us from. */
export const TIME_ZONES: { value: string; label: string }[] = [
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Phoenix", label: "Arizona (Phoenix)" },
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
  { value: "Asia/Taipei", label: "Taiwan" },
  { value: "Asia/Shanghai", label: "China" },
  { value: "Asia/Hong_Kong", label: "Hong Kong" },
];

export const PREFERRED_LANGUAGES = ["English", "Mandarin", "Cantonese", "Spanish", "Other"];

/**
 * What time it is for the family right now — so nobody rings a Boston family at
 * 5pm Pacific, which is 8pm to them.
 */
export function localTimeFor(timeZone: string | null | undefined): string | null {
  if (!timeZone) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone, hour: "numeric", minute: "2-digit", weekday: "short",
    }).format(new Date());
  } catch {
    return null; // unrecognised zone — don't break the page over it
  }
}

/** Outside 9am–6pm in the family's own zone. */
export function isAwkwardHourFor(timeZone: string | null | undefined): boolean {
  if (!timeZone) return false;
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(new Date())
    );
    return hour < 9 || hour >= 18;
  } catch {
    return false;
  }
}

/**
 * Split a child onto their own lead, copying the parent across and tying both
 * to one household. Lets one child enrol while a sibling stays in play, without
 * re-typing the family.
 */
export async function splitChildToNewLead(lead: SalesLeadFull, childId: string): Promise<string> {
  const child = lead.children.find((c) => c.id === childId);
  if (!child) throw new Error("That child is no longer on this lead.");

  const householdId = lead.household_id ?? lead.id;
  if (!lead.household_id) await updateLead(lead.id, { household_id: householdId });

  const { data: auth } = await supabase.auth.getUser();
  const { data: created, error } = await supabase
    .from("sales_leads")
    .insert({
      campus_ids: lead.campus_ids,
      status: "active",
      household_id: householdId,
      parent_first_name: lead.parent_first_name,
      parent_last_name: lead.parent_last_name,
      phone: lead.phone,
      email: lead.email,
      city: lead.city,
      time_zone: lead.time_zone,
      preferred_language: lead.preferred_language,
      source_id: lead.source_id,
      source_other: lead.source_other,
      referred_by: lead.referred_by,
      first_contact_type: lead.first_contact_type,
      inquiry_date: lead.inquiry_date,
      staff_owner_id: lead.staff_owner_id,
      staff_name: lead.staff_name,
      notes: lead.notes,
      created_by: auth.user?.id ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;

  // Move the child rather than copying it, so no one is counted twice.
  const { error: mErr } = await supabase
    .from("sales_lead_children")
    .update({ lead_id: created.id, order_index: 0 })
    .eq("id", childId);
  if (mErr) throw mErr;

  const who = child.name || "a child";
  await addActivity(lead.id, { kind: "note", note: `${who} moved to a separate lead.` });
  await addActivity(created.id, { kind: "note", note: `Split from ${leadName(lead)}'s lead.` });

  return created.id;
}

/** Other leads for the same family. */
export async function fetchHousehold(lead: SalesLead): Promise<SalesLeadFull[]> {
  if (!lead.household_id) return [];
  const { data, error } = await supabase
    .from("sales_leads")
    .select(LEAD_SELECT)
    .eq("household_id", lead.household_id)
    .neq("id", lead.id);
  if (error) throw error;
  return (data ?? []).map((r) => normalizeLead(r as Record<string, unknown>));
}

export function leadName(l: Pick<SalesLead, "parent_first_name" | "parent_last_name">): string {
  const n = `${l.parent_last_name ?? ""}, ${l.parent_first_name ?? ""}`.replace(/^,\s*|,\s*$/g, "").trim();
  return n || "(no name)";
}

/** Sort key for "Parent Name" — last name first, matching the sheet. */
export function leadSortName(l: Pick<SalesLead, "parent_first_name" | "parent_last_name">): string {
  return `${(l.parent_last_name ?? "").toLowerCase()} ${(l.parent_first_name ?? "").toLowerCase()}`.trim();
}

/** The programs across a family's children, de-duplicated. */
export function leadPrograms(l: SalesLeadFull): string {
  const set = new Set(l.children.map((c) => (c.program ?? "").trim()).filter(Boolean));
  return [...set].join(", ");
}

export function leadChildNames(l: SalesLeadFull): string {
  return l.children.map((c) => c.name).filter(Boolean).join(", ");
}

export function sourceLabel(l: SalesLeadFull): string {
  if (l.source?.name) {
    return l.source.name === "Other" && l.source_other ? `Other — ${l.source_other}` : l.source.name;
  }
  return l.source_other ?? "";
}

/** Earliest desired start across the family's children. */
export function leadStartDate(l: SalesLeadFull): string | null {
  const dates = l.children.map((c) => c.desired_start_date).filter(Boolean) as string[];
  return dates.length ? dates.sort()[0] : null;
}

/** Free-text start dates ("ASAP", "July or August"), for when no real date is set. */
export function leadStartNote(l: SalesLeadFull): string {
  const notes = l.children.map((c) => (c.desired_start_note ?? "").trim()).filter(Boolean);
  return [...new Set(notes)].join("; ");
}

export type DueState = "none" | "upcoming" | "today" | "overdue";

export function nextActionState(l: SalesLead, today = todayLocal()): DueState {
  if (!l.next_action_date) return "none";
  if (l.next_action_date < today) return "overdue";
  if (l.next_action_date === today) return "today";
  return "upcoming";
}

// ─── Conversion reporting ────────────────────────────────────────────────────

export type ConversionRow = {
  key: string;
  label: string;
  total: number;
  enrolled: number;
  inactive: number;
  active: number;
  rate: number | null; // enrolled / decided; null when nothing has been decided
};

/**
 * Conversion is measured against *decided* leads (enrolled + inactive). Leads
 * still being worked haven't failed yet, so counting them as misses would drag
 * the rate down and make it drift every time a new inquiry arrives.
 */
export function conversionBySource(
  leads: SalesLeadFull[],
  campusId?: string | null
): { overall: ConversionRow; bySource: ConversionRow[] } {
  const mk = (key: string, label: string): ConversionRow => ({
    key, label, total: 0, enrolled: 0, inactive: 0, active: 0, rate: null,
  });

  const overall = mk("__all__", "All leads");
  const map = new Map<string, ConversionRow>();

  for (const l of leads) {
    const key = l.source?.id ?? "__none__";
    const label = l.source?.name ?? "Not recorded";
    const row = map.get(key) ?? mk(key, label);
    // When viewing one campus, a family lost to the other campus counts as a
    // loss here — not as a win.
    const status = statusForCampus(l, campusId);

    for (const r of [row, overall]) {
      r.total += 1;
      if (status === "enrolled") r.enrolled += 1;
      else if (status === "inactive") r.inactive += 1;
      else r.active += 1;
    }
    map.set(key, row);
  }

  const finish = (r: ConversionRow) => {
    const decided = r.enrolled + r.inactive;
    r.rate = decided > 0 ? r.enrolled / decided : null;
    return r;
  };

  finish(overall);
  const bySource = [...map.values()].map(finish).sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.label.localeCompare(b.label);
  });

  return { overall, bySource };
}

export function formatPct(rate: number | null): string {
  if (rate === null) return "—";
  return `${Math.round(rate * 1000) / 10}%`;
}

/**
 * The source that has actually produced the most enrolments — the headline
 * "top producer". Deliberately ranked by enrolments rather than conversion
 * rate: a source with one lead that enrolled shows 100% but produces nothing.
 * Ties break on the better rate, then on lead volume.
 */
export function topProducer(bySource: ConversionRow[]): ConversionRow | null {
  const producing = bySource.filter((r) => r.enrolled > 0);
  if (producing.length === 0) return null;
  return [...producing].sort((a, b) => {
    if (b.enrolled !== a.enrolled) return b.enrolled - a.enrolled;
    if ((b.rate ?? 0) !== (a.rate ?? 0)) return (b.rate ?? 0) - (a.rate ?? 0);
    return b.total - a.total;
  })[0];
}
