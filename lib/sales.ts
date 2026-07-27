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

export type SalesLeadChild = {
  id: string;
  lead_id: string;
  name: string;
  dob: string | null;
  dob_note: string | null;
  program: string | null;
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
  created_by: string | null;
  created_at: string;
};

export type SalesLead = {
  id: string;
  campus_id: string | null;
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
  first_contact_type: FirstContactType | null;
  inquiry_date: string;
  desired_start_date: string | null;
  desired_start_note: string | null;
  notes: string | null;
  staff_owner_id: string | null;
  staff_name: string | null;

  next_action_date: string | null;
  next_action_type: ActionType | null;
  next_action_note: string | null;

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
  if (campusId === null) q = q.is("campus_id", null);
  else if (campusId) q = q.eq("campus_id", campusId);

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

/** Admins and campus admins who can own a lead. */
export async function fetchAssignableStaff(): Promise<{ id: string; full_name: string | null; role: string }[]> {
  const { data, error } = await supabase
    .from("user_profiles")
    .select("id, full_name, role")
    .eq("is_active", true)
    .in("role", ["admin", "campus_admin"])
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
export async function setLeadStatus(id: string, status: SalesStatus, reason?: string): Promise<void> {
  const now = new Date().toISOString();
  const patch: LeadInput = {
    status,
    status_changed_at: now,
    converted_at: status === "enrolled" ? now : null,
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
  input: { kind: ActivityKind; note: string; activity_date?: string }
): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase.from("sales_activities").insert({
    lead_id: leadId,
    kind: input.kind,
    note: input.note,
    activity_date: input.activity_date ?? todayLocal(),
    created_by: auth.user?.id ?? null,
  });
  if (error) throw error;
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
  input: { date: string; type: ActionType; note: string }
): Promise<void> {
  const { error } = await supabase
    .from("sales_leads")
    .update({
      next_action_date: input.date,
      next_action_type: input.type,
      next_action_note: input.note,
      alert_due_sent_for: null,
      alert_nag_sent_for: null,
    })
    .eq("id", leadId);
  if (error) throw error;
}

export async function clearNextAction(leadId: string): Promise<void> {
  const { error } = await supabase
    .from("sales_leads")
    .update({ next_action_date: null, next_action_type: null, next_action_note: null })
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

/** Earliest desired start across the family's children, else the lead's own. */
export function leadStartDate(l: SalesLeadFull): string | null {
  return l.desired_start_date;
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
export function conversionBySource(leads: SalesLeadFull[]): { overall: ConversionRow; bySource: ConversionRow[] } {
  const mk = (key: string, label: string): ConversionRow => ({
    key, label, total: 0, enrolled: 0, inactive: 0, active: 0, rate: null,
  });

  const overall = mk("__all__", "All leads");
  const map = new Map<string, ConversionRow>();

  for (const l of leads) {
    const key = l.source?.id ?? "__none__";
    const label = l.source?.name ?? "Not recorded";
    const row = map.get(key) ?? mk(key, label);

    for (const r of [row, overall]) {
      r.total += 1;
      if (l.status === "enrolled") r.enrolled += 1;
      else if (l.status === "inactive") r.inactive += 1;
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
