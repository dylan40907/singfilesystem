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
  prospective_room_id: string | null;
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
  withdrawal_month: string | null;
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

// ─── Month grid (roster timeline) ────────────────────────────────────────────

/** The roster grid always starts here; the number of months shown is per-campus. */
export const ROSTER_START_MONTH = "2026-06-01";

/** First-of-month ISO for "now" in America/Los_Angeles (months roll over at LA midnight). */
export function currentLAMonthISO(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "2026";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${y}-${m}-01`;
}

export type RoomChange = {
  id: string; campus_id: string;
  roster_entry_id: string | null; waitlist_entry_id: string | null;
  effective_month: string; room_id: string | null;
};
export type ProgramChange = {
  id: string; campus_id: string;
  roster_entry_id: string | null; waitlist_entry_id: string | null;
  effective_month: string; program_id: string | null;
};
export type MonthNoteKind = "admit" | "promote" | "withdraw";
export type MonthNote = {
  id: string; campus_id: string;
  roster_entry_id: string | null; waitlist_entry_id: string | null;
  month: string; kind: MonthNoteKind; note_date: string | null;
};

export const NOTE_STYLE: Record<MonthNoteKind, { label: string; color: string; bg: string; border: string }> = {
  admit:    { label: "Admit",    color: "#15803d", bg: "#ecfdf5", border: "#86efac" },
  promote:  { label: "Promote",  color: "#7c3aed", bg: "#f5f3ff", border: "#c4b5fd" },
  withdraw: { label: "Withdraw", color: "#b91c1c", bg: "#fef2f2", border: "#fca5a5" },
};

/** ISO (YYYY-MM-01) of the month `n` months after `iso`. */
export function addMonthsISO(iso: string, n: number): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

/** First-of-month ISO for the current month. */
export function currentMonthISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

/** Build the list of month ISOs shown in the grid. */
export function buildMonths(count: number, start = ROSTER_START_MONTH): string[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => addMonthsISO(start, i));
}

/** Column key for the second half of a split month (starts on `day`). */
export function secondHalfKey(monthIso: string, day: number): string { return monthIso.slice(0, 8) + String(day).padStart(2, "0"); }
/** True if a column key is a split month's second half (any day other than the 1st). */
export function isSecondHalf(key: string): boolean { return !key.endsWith("-01"); }
/** The day-of-month a column key falls on. */
export function dayOf(key: string): number { return Number(key.slice(8, 10)); }
/** The first-of-month ISO that a column key belongs to. */
export function monthOf(key: string): string { return key.slice(0, 8) + "01"; }

export async function fetchSplitMonths(campusId: string): Promise<{ month: string; day: number }[]> {
  const { data, error } = await supabase.from("hr_admissions_split_months").select("month, split_day").eq("campus_id", campusId);
  if (error) throw error;
  return (data ?? []).map((r) => ({ month: (r as { month: string }).month, day: (r as { split_day: number }).split_day }));
}

/** e.g. "Jul 2026". */
export function monthLabelShort(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
export function monthLabelLong(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** Age like "4 yr. 2 mo." at a given month. Empty before birth. */
export function ageShort(dob: string | null | undefined, atIso: string): string {
  const months = ageInMonths(dob, atIso);
  if (months == null || months < 0) return "";
  return `${Math.floor(months / 12)} yr. ${months % 12} mo.`;
}

/**
 * Resolve a sparse change-point series to a value per month: each month takes
 * the value of the latest change on-or-before it (null before the first change).
 */
export function resolveSeries<T>(changes: { effective_month: string; value: T | null }[], months: string[]): (T | null)[] {
  const sorted = [...changes].sort((a, b) => a.effective_month.localeCompare(b.effective_month));
  const out: (T | null)[] = [];
  let i = 0;
  let cur: T | null = null;
  for (const m of months) {
    while (i < sorted.length && sorted[i].effective_month <= m) { cur = sorted[i].value; i++; }
    out.push(cur);
  }
  return out;
}

export async function fetchRosterMonthCount(campusId: string): Promise<number> {
  const { data } = await supabase.from("hr_campuses").select("roster_month_count").eq("id", campusId).single();
  return (data as { roster_month_count?: number } | null)?.roster_month_count ?? 24;
}

export async function fetchRoomChanges(campusId: string): Promise<RoomChange[]> {
  const { data, error } = await supabase.from("hr_admissions_room_changes").select("*").eq("campus_id", campusId);
  if (error) throw error;
  return (data ?? []) as RoomChange[];
}
export async function fetchProgramChanges(campusId: string): Promise<ProgramChange[]> {
  const { data, error } = await supabase.from("hr_admissions_program_changes").select("*").eq("campus_id", campusId);
  if (error) throw error;
  return (data ?? []) as ProgramChange[];
}
export async function fetchMonthNotes(campusId: string): Promise<MonthNote[]> {
  const { data, error } = await supabase.from("hr_admissions_month_notes").select("*").eq("campus_id", campusId);
  if (error) throw error;
  return (data ?? []) as MonthNote[];
}

// A planning tag being staged in an entry modal. `date` is the exact date the
// user picked; the tag lands in the month cell for `noteColumnKey(date)`.
export type TagItem = { id?: string; kind: MonthNoteKind; date: string; month?: string };

/**
 * The grid column key a date belongs to, honoring split months: if the date's
 * month is split and the date falls on/after the split day, it lands in the
 * second-half column; otherwise the whole-month (or first-half) column.
 */
export function noteColumnKey(date: string, splitMonths?: { month: string; day: number }[]): string {
  const m = monthOf(date);
  const day = splitMonths?.find((s) => s.month === m)?.day;
  if (day != null && Number(date.slice(8, 10)) >= day) return secondHalfKey(m, day);
  return m;
}

/**
 * Auto-promote a roster entry's room for a single cell: sets that cell's room to
 * the NEXT room in the campus hierarchy (orderedRoomIds), based on whatever room
 * is effective at that cell. No-op if there's no current room or no higher room
 * (the cell keeps its existing room). Not a hard constraint — the admin can still
 * change the room afterward.
 */
export async function applyPromoteAutoRoom(
  campusId: string, rosterEntryId: string, columnKey: string, orderedRoomIds: string[], myUserId: string | null,
): Promise<void> {
  if (orderedRoomIds.length === 0) return;
  const { data } = await supabase.from("hr_admissions_room_changes")
    .select("effective_month, room_id").eq("roster_entry_id", rosterEntryId);
  const changes = (data ?? []) as { effective_month: string; room_id: string | null }[];
  // Room effective at columnKey = the latest change with effective_month <= columnKey.
  let curRoom: string | null = null; let best = "";
  for (const c of changes) {
    if (c.effective_month <= columnKey && c.effective_month >= best) { best = c.effective_month; curRoom = c.room_id; }
  }
  if (!curRoom) return;
  const idx = orderedRoomIds.indexOf(curRoom);
  const next = idx >= 0 ? orderedRoomIds[idx + 1] : undefined;
  if (!next) return; // already at the top of the hierarchy → retain
  await supabase.from("hr_admissions_room_changes").delete().eq("roster_entry_id", rosterEntryId).eq("effective_month", columnKey);
  await supabase.from("hr_admissions_room_changes").insert({ campus_id: campusId, roster_entry_id: rosterEntryId, effective_month: columnKey, room_id: next, created_by: myUserId });
}

/**
 * Reconcile a roster entry's planning tags (admit/promote/withdraw notes) from
 * an entry modal. Deletes tags removed since load, and writes newly-added ones —
 * one note per (cell, kind), so multiple kinds can coexist in one cell. New
 * promote tags also auto-promote that cell's room (opts.orderedRoomIds).
 */
export async function saveMonthNoteTags(
  campusId: string,
  rosterEntryId: string,
  tags: TagItem[],
  loaded: TagItem[],
  myUserId: string | null,
  opts?: { splitMonths?: { month: string; day: number }[]; orderedRoomIds?: string[] },
): Promise<void> {
  const keptIds = new Set(tags.filter((t) => t.id).map((t) => t.id));
  const deletedIds = loaded.filter((t) => t.id && !keptIds.has(t.id)).map((t) => t.id as string);
  if (deletedIds.length) {
    const { error } = await supabase.from("hr_admissions_month_notes").delete().in("id", deletedIds);
    if (error) throw error;
  }
  // New tags: one per (column, kind), replacing any existing note of that kind in the cell.
  const byKey = new Map<string, TagItem & { col: string }>();
  for (const t of tags) if (!t.id) { const col = noteColumnKey(t.date, opts?.splitMonths); byKey.set(`${col}|${t.kind}`, { ...t, col }); }
  const uniq = [...byKey.values()];
  for (const t of uniq) {
    const { error: delErr } = await supabase.from("hr_admissions_month_notes")
      .delete().eq("roster_entry_id", rosterEntryId).eq("month", t.col).eq("kind", t.kind);
    if (delErr) throw delErr;
  }
  if (uniq.length) {
    const rows = uniq.map((t) => ({ campus_id: campusId, roster_entry_id: rosterEntryId, month: t.col, note_date: t.date, kind: t.kind, created_by: myUserId }));
    const { error: insErr } = await supabase.from("hr_admissions_month_notes").insert(rows);
    if (insErr) throw insErr;
  }
  // Auto-promote room for any newly-added promote tags (earliest first so bumps cascade).
  if (opts?.orderedRoomIds?.length) {
    for (const t of uniq.filter((x) => x.kind === "promote").sort((a, b) => a.col.localeCompare(b.col))) {
      await applyPromoteAutoRoom(campusId, rosterEntryId, t.col, opts.orderedRoomIds, myUserId);
    }
  }
}

/**
 * Keep a waitlist entry's "admit" planning tag in sync with its planned start
 * date: the tag auto-lands in the cell for that date (split-aware) and moves when
 * the date changes. Cleared when there's no planned start. Carries over to the
 * roster on admit (the admit RPC migrates notes).
 */
export async function syncPlannedStartAdmitTag(
  campusId: string, waitlistEntryId: string, plannedStart: string | null, myUserId: string | null,
): Promise<void> {
  await supabase.from("hr_admissions_month_notes").delete().eq("waitlist_entry_id", waitlistEntryId).eq("kind", "admit");
  if (!plannedStart) return;
  const splits = await fetchSplitMonths(campusId);
  const col = noteColumnKey(plannedStart, splits);
  await supabase.from("hr_admissions_month_notes").insert({
    campus_id: campusId, waitlist_entry_id: waitlistEntryId, month: col, note_date: plannedStart, kind: "admit", created_by: myUserId,
  });
}

/** Move an admitted/added roster child back to the waitlist (returns waitlist id). */
export async function unadmitRosterEntry(rosterId: string): Promise<string> {
  const { data, error } = await supabase.rpc("unadmit_roster_entry", { p_roster_id: rosterId });
  if (error) throw error;
  return data as string;
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
export async function admitWaitlistEntry(entryId: string, roomId: string | null, programId: string | null = null): Promise<string> {
  const { data, error } = await supabase.rpc("admit_waitlist_entry", {
    p_entry_id: entryId,
    p_room_id: roomId,
    p_program_id: programId,
  });
  if (error) throw error;
  return data as string;
}
