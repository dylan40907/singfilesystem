import { supabase } from "@/lib/supabaseClient";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Program = {
  id: string;
  campus_id: string;
  name: string;
  order_index: number;
  created_at: string;
};

export type Room = {
  id: string;
  campus_id: string;
  name: string;
  capacity: number | null;
  color: string;
  order_index: number;
  created_at: string;
};

/** Preset palette for room colors (matches the course-segment palette). */
export const ROOM_COLORS = ["#e6178d", "#7c3aed", "#2563eb", "#059669", "#d97706", "#dc2626", "#0891b2"];
export const DEFAULT_ROOM_COLOR = "#6b7280";

export type WaitlistStatus = "active" | "admitted" | "removed";

export type WaitlistEntry = {
  id: string;
  campus_id: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  program_id: string | null;
  sibling_name: string | null;
  customer_preferred_start_date: string | null;
  planned_start_date: string | null;
  planned_completion_date: string | null;
  application_received_date: string | null;
  application_fee_paid_date: string | null;
  date_admitted: string | null;
  admitted_room_id: string | null;
  admitted_roster_id: string | null;
  status: WaitlistStatus;
  removed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

export type OfferStatus = "sent" | "accepted" | "denied";

export type WaitlistOffer = {
  id: string;
  waitlist_entry_id: string;
  offer_date: string;
  status: OfferStatus;
  note: string | null;
  created_at: string;
  created_by: string | null;
};

/** A row in the offer log editor — persisted (has id) or a not-yet-saved draft. */
export type OfferDraft = {
  id?: string;
  offer_date: string;
  status: OfferStatus;
  note: string | null;
};

export function offerCounts(list: { status: OfferStatus }[]): { sent: number; accepted: number; denied: number } {
  return {
    sent: list.filter((o) => o.status === "sent").length,
    accepted: list.filter((o) => o.status === "accepted").length,
    denied: list.filter((o) => o.status === "denied").length,
  };
}

export type RosterStatus = "enrolled" | "withdrawn";

export type RosterEntry = {
  id: string;
  campus_id: string;
  room_id: string | null;
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  program_id: string | null;
  sibling_name: string | null;
  customer_preferred_start_date: string | null;
  planned_start_date: string | null;
  planned_completion_date: string | null;
  enrolled_date: string | null;
  source_waitlist_entry_id: string | null;
  status: RosterStatus;
  withdrawn_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

export const APPLICATION_FEE = 100;

export const OFFER_STATUS_LABEL: Record<OfferStatus, string> = {
  sent: "Sent",
  accepted: "Accepted",
  denied: "Denied",
};

// ─── Date / age utilities ────────────────────────────────────────────────────

/** Parse a `YYYY-MM-DD` (date-only) string as a *local* date, avoiding TZ drift. */
export function parseDateOnly(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Short human date, e.g. "Mar 4, 2026". Empty string for null. */
export function fmtDate(s: string | null | undefined): string {
  const d = parseDateOnly(s);
  if (!d) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Age expressed as "X years Y months" between a date of birth and a reference
 * date (defaults to today). Returns "" if either date is missing/invalid.
 */
export function ageYearsMonths(dob: string | null | undefined, at: string | null | undefined): string {
  const birth = parseDateOnly(dob);
  const ref = at ? parseDateOnly(at) : new Date();
  if (!birth || !ref) return "";
  if (ref < birth) return "—";

  let years = ref.getFullYear() - birth.getFullYear();
  let months = ref.getMonth() - birth.getMonth();
  if (ref.getDate() < birth.getDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  const y = `${years} ${years === 1 ? "year" : "years"}`;
  const mo = `${months} ${months === 1 ? "month" : "months"}`;
  if (years <= 0) return mo;
  return `${y} ${mo}`;
}

/** Whole age in months between a DOB and a reference date. Null if either is missing. */
export function ageInMonths(dob: string | null | undefined, at: string | null | undefined): number | null {
  const birth = parseDateOnly(dob);
  const ref = at ? parseDateOnly(at) : new Date();
  if (!birth || !ref) return null;
  let months = (ref.getFullYear() - birth.getFullYear()) * 12 + (ref.getMonth() - birth.getMonth());
  if (ref.getDate() < birth.getDate()) months -= 1;
  return months;
}

/**
 * Waitlist completion date — auto-derived, not manually entered. A waitlist is
 * "complete" only once BOTH the application has been received AND the $100 fee
 * has been paid; the completion date is the later of those two dates. Returns
 * null until both are present.
 */
export function waitlistCompletionDate(
  receivedDate: string | null | undefined,
  feePaidDate: string | null | undefined
): string | null {
  if (!receivedDate || !feePaidDate) return null;
  return receivedDate >= feePaidDate ? receivedDate : feePaidDate;
}

/** Display value for the sibling column — "None" when empty. */
export function siblingLabel(name: string | null | undefined): string {
  const t = (name ?? "").trim();
  return t.length > 0 ? t : "None";
}

// ─── Sorting ─────────────────────────────────────────────────────────────────

export type SortDir = "asc" | "desc";
export type SortState = { key: string; dir: SortDir };

/** Toggle helper for click-to-sort headers: same column flips direction, a new column starts fresh. */
export function nextSort(prev: SortState, key: string, defaultDir: SortDir = "asc"): SortState {
  if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
  return { key, dir: defaultDir };
}

/** Comparator for a single sort key. Empty/null values always sink to the bottom. */
export function compareForSort(
  av: string | number | null | undefined,
  bv: string | number | null | undefined,
  dir: SortDir
): number {
  const aEmpty = av === null || av === undefined || av === "";
  const bEmpty = bv === null || bv === undefined || bv === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  let c: number;
  if (typeof av === "number" && typeof bv === "number") c = av - bv;
  else c = String(av).localeCompare(String(bv));
  return dir === "asc" ? c : -c;
}

export function fullName(e: { first_name: string; last_name: string }): string {
  return `${e.first_name} ${e.last_name}`.trim();
}

/** Today as `YYYY-MM-DD` (local). Handy default for date inputs. */
export function todayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Sort active waitlist entries by planned start date, soonest first. Entries
 * without a planned start date sink to the bottom.
 */
export function sortByPlannedStart(a: WaitlistEntry, b: WaitlistEntry): number {
  const av = a.planned_start_date;
  const bv = b.planned_start_date;
  if (av && bv) return av.localeCompare(bv);
  if (av) return -1;
  if (bv) return 1;
  return fullName(a).localeCompare(fullName(b));
}

// ─── Data helpers ────────────────────────────────────────────────────────────

export async function fetchPrograms(campusId: string): Promise<Program[]> {
  const { data, error } = await supabase
    .from("hr_admissions_programs")
    .select("*")
    .eq("campus_id", campusId)
    .order("order_index")
    .order("name");
  if (error) throw error;
  return (data ?? []) as Program[];
}

export async function fetchRooms(campusId: string): Promise<Room[]> {
  const { data, error } = await supabase
    .from("hr_admissions_rooms")
    .select("*")
    .eq("campus_id", campusId)
    .order("order_index")
    .order("name");
  if (error) throw error;
  return (data ?? []) as Room[];
}

export async function fetchWaitlist(campusId: string): Promise<WaitlistEntry[]> {
  const { data, error } = await supabase
    .from("hr_waitlist_entries")
    .select("*")
    .eq("campus_id", campusId);
  if (error) throw error;
  return (data ?? []) as WaitlistEntry[];
}

export async function fetchOffers(entryIds: string[]): Promise<Record<string, WaitlistOffer[]>> {
  if (entryIds.length === 0) return {};
  const { data, error } = await supabase
    .from("hr_waitlist_offers")
    .select("*")
    .in("waitlist_entry_id", entryIds)
    .order("offer_date", { ascending: false });
  if (error) throw error;
  const map: Record<string, WaitlistOffer[]> = {};
  for (const o of (data ?? []) as WaitlistOffer[]) {
    (map[o.waitlist_entry_id] ??= []).push(o);
  }
  return map;
}

export async function fetchRoster(campusId: string): Promise<RosterEntry[]> {
  const { data, error } = await supabase
    .from("hr_roster_entries")
    .select("*")
    .eq("campus_id", campusId);
  if (error) throw error;
  return (data ?? []) as RosterEntry[];
}

/** Move a waitlist entry onto the roster (into the given room). Returns roster id. */
export async function admitWaitlistEntry(entryId: string, roomId: string | null): Promise<string> {
  const { data, error } = await supabase.rpc("admit_waitlist_entry", {
    p_entry_id: entryId,
    p_room_id: roomId,
  });
  if (error) throw error;
  return data as string;
}
