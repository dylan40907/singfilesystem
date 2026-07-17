"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import { useDialog } from "@/components/ui/useDialog";
import { applyCampusFilterToQuery, useCampusFilter } from "@/lib/CampusContext";
import { useEscapeKey } from "@/components/ui/useEscapeKey";

// ─── Types ───────────────────────────────────────────────────────────────────

type EmployeeRow = {
  id: string;
  legal_first_name: string;
  legal_middle_name: string | null;
  legal_last_name: string;
  nicknames: string[] | null;
  is_active: boolean;
  start_date: string;
};

type LeaveBalanceRow = {
  id: string;
  employee_id: string;
  year: number;
  pto_active: boolean;
  pto_plan_hours: number;
  pto_weeks: number;
  sick_frontloaded: boolean;
  sick_annual_cap: number;
  pto_initial_balance: number;
  sick_initial_balance: number;
  sick_carryover: number;
  pto_carryover: number;
  hours_worked_override: number | null;
  unpaid_override: number | null;
  sick_accrual_amount: number | null;
  sick_accrual_per: number | null;
  sick_accrual_anchor_hours: number | null;
  sick_accrual_anchor_accrued: number | null;
  pto_accrual_amount: number | null;
  pto_accrual_per: number | null;
  pto_accrual_anchor_hours: number | null;
  pto_accrual_anchor_accrued: number | null;
};

type EditField = "sick" | "pto" | "unpaid" | "hours_worked" | "sick_accrued" | "pto_accrued";

type LogRow = { date: string; activity: string; change: number; hoursWorked: number | null; description: string };

type ManualAdjRow = {
  id: string;
  field: EditField;
  old_value: number;
  new_value: number;
  notes: string | null;
  changed_at: string;
  user_profiles: { full_name: string | null } | null;
};

type LeaveEntryType = "sick_paid" | "pto" | "unpaid" | "sick_adjustment" | "pto_adjustment";
type RequestType = "sick_paid" | "pto" | "unpaid";
type RequestStatus = "pending" | "approved" | "denied";

type LeaveEntryRow = {
  id: string;
  employee_id: string;
  entry_type: LeaveEntryType;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  hours: number;
  notes: string | null;
  created_at: string;
};

type LeaveRequestRow = {
  id: string;
  employee_id: string;
  entry_type: RequestType;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  hours: number;
  notes: string | null;
  status: RequestStatus;
  review_notes: string | null;
  reviewed_at: string | null;
  created_at: string;
};

type ClockEntryRow = {
  employee_id: string;
  session_date: string;
  clocked_in_at: string | null;
  clocked_out_at: string | null;
};

const PROBATION_DAYS = 90;
const MAX_BALANCE = 80;
// Max hours that can be carried into a new year (even if the prior-year balance is higher).
const CARRYOVER_CAP = 40;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>{children}</div>;
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        width: "100%",
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid #e5e7eb",
        outline: "none",
        fontSize: 14,
        ...(props.style ?? {}),
      }}
    />
  );
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      style={{
        width: "100%",
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid #e5e7eb",
        outline: "none",
        fontSize: 14,
        background: "white",
        ...(props.style ?? {}),
      }}
    />
  );
}

function getDisplayName(e: EmployeeRow): string {
  const nick = Array.isArray(e.nicknames) && e.nicknames.length > 0 ? e.nicknames[0] : null;
  return `${nick ?? e.legal_first_name} ${e.legal_last_name}`;
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function fmtYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtRange(s: string, e: string): string {
  if (s === e) return fmtYmd(s);
  return `${fmtYmd(s)} – ${fmtYmd(e)}`;
}

function fmtLeaveTime(hms: string): string {
  const [h, m] = hms.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const ampm = h < 12 ? "AM" : "PM";
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function decToHM(hours: number): [number, number] {
  const totalMins = Math.round(Math.abs(hours) * 60);
  return [Math.floor(totalMins / 60), totalMins % 60];
}
function hmToDec(h: number, m: number): number {
  return h + m / 60;
}

function fmtHours(h: number): string {
  const totalMins = Math.round(h * 60);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs === 0) return `${mins}m`;
  return mins === 0 ? `${hrs}h` : `${hrs}h ${mins}m`;
}

// Supabase's PostgrestError is a plain object (not an Error instance), so
// `e instanceof Error` would hide it as "Unknown error". Pull the message from
// either shape so DB errors (e.g. check-constraint violations) actually surface.
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e && (e as { message?: unknown }).message) {
    return String((e as { message: unknown }).message);
  }
  if (typeof e === "string") return e;
  return "Unknown error";
}

function clockEntryHours(e: ClockEntryRow): number {
  if (!e.clocked_in_at || !e.clocked_out_at) return 0;
  const inMs = new Date(e.clocked_in_at).getTime();
  const outMs = new Date(e.clocked_out_at).getTime();
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || outMs <= inMs) return 0;
  return (outMs - inMs) / 3_600_000;
}

// Monday of the week containing `ymd` (YYYY-MM-DD).
function weekStartYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7; // 0 = Monday
  dt.setUTCDate(dt.getUTCDate() - dow);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function sumClockedHours(entries: ClockEntryRow[], startYmd: string, endYmd: string): number {
  let totalMs = 0;
  for (const e of entries) {
    if (!e.clocked_in_at || !e.clocked_out_at) continue;
    if (e.session_date < startYmd || e.session_date > endYmd) continue;
    const inMs = new Date(e.clocked_in_at).getTime();
    const outMs = new Date(e.clocked_out_at).getTime();
    if (Number.isFinite(inMs) && Number.isFinite(outMs) && outMs > inMs) totalMs += outMs - inMs;
  }
  return totalMs / 3_600_000;
}

// Default sick accrual: 1 hour earned per 30 hours worked.
const DEFAULT_SICK_RATE = 30;

function isOverrideActive(amount: number | null | undefined, per: number | null | undefined): boolean {
  return amount != null && per != null && Number(amount) > 0 && Number(per) > 0;
}

function computeSickBalance(
  bal: LeaveBalanceRow | null,
  hoursWorked: number,
  entries: LeaveEntryRow[],
): { carryover: number; accrued: number; accruedRaw: number; used: number; adjustments: number; balance: number; cap: number; initial: number; overrideActive: boolean; overrideAmount: number; overridePer: number } {
  const cap = bal?.sick_annual_cap ?? 40;
  const carryover = Number(bal?.sick_carryover ?? 0);
  const overrideActive = isOverrideActive(bal?.sick_accrual_amount, bal?.sick_accrual_per);
  const overrideAmount = Number(bal?.sick_accrual_amount ?? 0);
  const overridePer = Number(bal?.sick_accrual_per ?? 0);
  // The anchor is a universal baseline: "at `anchor_hours` worked, accrued was `anchor_accrued`."
  // It's set either when the accrual rate changes (to preserve prior accrual) or when an admin
  // manually edits Accrued YTD. Accrual then continues from that point at the active rate.
  const hasAnchor = bal?.sick_accrual_anchor_accrued != null;
  const anchorHours = Number(bal?.sick_accrual_anchor_hours ?? 0);
  const anchorAccrued = Number(bal?.sick_accrual_anchor_accrued ?? 0);
  let accruedRaw: number;
  if (overrideActive) {
    // Custom rate from the anchor onward. rate = worked-hours per 1 accrued-hour.
    const rate = overridePer / overrideAmount;
    const extra = Math.max(0, hoursWorked - anchorHours);
    accruedRaw = anchorAccrued + Math.floor(extra * 60 / rate) / 60;
  } else if (hasAnchor) {
    // Default rate, continuing from a manually-set Accrued YTD baseline.
    const extra = Math.max(0, hoursWorked - anchorHours);
    accruedRaw = anchorAccrued + Math.floor(extra * 60 / DEFAULT_SICK_RATE) / 60;
  } else if (bal?.sick_frontloaded) {
    accruedRaw = cap;
  } else {
    accruedRaw = Math.floor(hoursWorked * 60 / DEFAULT_SICK_RATE) / 60;
  }
  const accrued = Math.min(accruedRaw, cap);
  const used = entries.filter((e) => e.entry_type === "sick_paid").reduce((s, e) => s + Number(e.hours), 0);
  const adjustments = entries.filter((e) => e.entry_type === "sick_adjustment").reduce((s, e) => s + Number(e.hours), 0);
  const initial = Number(bal?.sick_initial_balance ?? 0);
  const balance = Math.min(carryover + initial + accrued + adjustments - used, MAX_BALANCE);
  return { carryover, accrued, accruedRaw, used, adjustments, balance, cap, initial, overrideActive, overrideAmount, overridePer };
}

function computePtoBalance(
  bal: LeaveBalanceRow | null,
  hoursWorked: number,
  entries: LeaveEntryRow[],
): { active: boolean; plan: number; weeks: number; accrualRate: number; carryover: number; initial: number; accrued: number; used: number; adjustments: number; balance: number; overrideActive: boolean; overrideAmount: number; overridePer: number } {
  const active = bal?.pto_active ?? false;
  const plan = bal?.pto_plan_hours ?? 0;
  const weeks = bal?.pto_weeks ?? 48;
  const carryover = Number(bal?.pto_carryover ?? 0);
  const overrideActive = isOverrideActive(bal?.pto_accrual_amount, bal?.pto_accrual_per);
  const overrideAmount = Number(bal?.pto_accrual_amount ?? 0);
  const overridePer = Number(bal?.pto_accrual_per ?? 0);
  const hasAnchor = bal?.pto_accrual_anchor_accrued != null;
  const anchorHours = Number(bal?.pto_accrual_anchor_hours ?? 0);
  const anchorAccrued = Number(bal?.pto_accrual_anchor_accrued ?? 0);
  let accrued = 0;
  let accrualRate = 0;
  if (active && plan > 0) {
    if (overrideActive) {
      // Custom rate from the anchor onward. weeks is ignored; plan caps the annual total.
      accrualRate = overridePer / overrideAmount;
      const extra = Math.max(0, hoursWorked - anchorHours);
      accrued = Math.min(anchorAccrued + Math.floor(extra * 60 / accrualRate) / 60, plan);
    } else {
      accrualRate = (weeks * 40) / plan;
      // Continue from a manually-set Accrued YTD baseline when one exists.
      const base = hasAnchor ? anchorAccrued : 0;
      const baseHours = hasAnchor ? anchorHours : 0;
      const extra = Math.max(0, hoursWorked - baseHours);
      accrued = Math.min(base + Math.floor(extra * 60 / accrualRate) / 60, plan);
    }
  }
  const used = entries.filter((e) => e.entry_type === "pto").reduce((s, e) => s + Number(e.hours), 0);
  const adjustments = entries.filter((e) => e.entry_type === "pto_adjustment").reduce((s, e) => s + Number(e.hours), 0);
  const initial = Number(bal?.pto_initial_balance ?? 0);
  const balance = Math.min(carryover + initial + accrued + adjustments - used, MAX_BALANCE);
  return { active, plan, weeks, accrualRate, carryover, initial, accrued, used, adjustments, balance, overrideActive, overrideAmount, overridePer };
}

function defaultBalance(employeeId: string, year: number): LeaveBalanceRow {
  return {
    id: "", employee_id: employeeId, year,
    pto_active: false, pto_plan_hours: 0, pto_weeks: 48,
    sick_frontloaded: false, sick_annual_cap: 40,
    pto_initial_balance: 0, sick_initial_balance: 0,
    sick_carryover: 0, pto_carryover: 0,
    hours_worked_override: null, unpaid_override: null,
    sick_accrual_amount: null, sick_accrual_per: null,
    sick_accrual_anchor_hours: null, sick_accrual_anchor_accrued: null,
    pto_accrual_amount: null, pto_accrual_per: null,
    pto_accrual_anchor_hours: null, pto_accrual_anchor_accrued: null,
  };
}

// Build the 4 accrual-override columns for an upsert. When the rate is first enabled
// or changed, it re-anchors at the current hours-worked/accrued so prior accrual is
// preserved and the new rate only applies going forward. Disabled → all NULL.
type OverridePatch = { amount: number | null; per: number | null; anchor_hours: number | null; anchor_accrued: number | null };
function buildOverridePatch(
  enabled: boolean,
  amount: number,
  per: number,
  prev: { amount: number | null; per: number | null; anchor_hours: number | null; anchor_accrued: number | null },
  currentHours: number,
  currentAccrued: number,
): OverridePatch {
  const prevActive = isOverrideActive(prev.amount, prev.per);
  if (!enabled || amount <= 0 || per <= 0) {
    // Turning a previously-active override OFF: preserve accrued-so-far, then continue at
    // the default rate. Otherwise leave any existing anchor (e.g. a manual Accrued YTD
    // baseline) untouched rather than clearing it.
    if (prevActive) return { amount: null, per: null, anchor_hours: currentHours, anchor_accrued: currentAccrued };
    return { amount: null, per: null, anchor_hours: prev.anchor_hours, anchor_accrued: prev.anchor_accrued };
  }
  const rateChanged = !prevActive
    || Math.abs(Number(prev.amount) - amount) > 1e-9
    || Math.abs(Number(prev.per) - per) > 1e-9;
  if (rateChanged) {
    return { amount, per, anchor_hours: currentHours, anchor_accrued: currentAccrued };
  }
  return { amount, per, anchor_hours: prev.anchor_hours ?? currentHours, anchor_accrued: prev.anchor_accrued ?? currentAccrued };
}

const REQUEST_LABELS: Record<RequestType, string> = {
  sick_paid: "Sick (paid)",
  pto: "PTO",
  unpaid: "Unpaid",
};

// ─── Page ────────────────────────────────────────────────────────────────────

export default function LeavePage() {
  const { alert, confirm, modal: dialogModal } = useDialog();

  const [me, setMe] = useState<TeacherProfile | null>(null);
  const [meLoading, setMeLoading] = useState(true);

  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>("");
  const [year, setYear] = useState<number>(new Date().getFullYear());

  const [balance, setBalance] = useState<LeaveBalanceRow | null>(null);
  const [entries, setEntries] = useState<LeaveEntryRow[]>([]);
  const [clockEntries, setClockEntries] = useState<ClockEntryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Pending requests (all employees)
  const [pendingRequests, setPendingRequests] = useState<(LeaveRequestRow & { employee?: EmployeeRow })[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});

  // Log-leave form
  const [logType, setLogType] = useState<LeaveEntryType>("sick_paid");
  const [logStart, setLogStart] = useState<string>(todayYmd());
  const [logEnd, setLogEnd] = useState<string>(todayYmd());
  const [logStartTime, setLogStartTime] = useState<string>("09:00");
  const [logEndTime, setLogEndTime] = useState<string>("17:00");
  const [logHoursH, setLogHoursH] = useState(1);
  const [logHoursM, setLogHoursM] = useState(0);
  const [logHoursSign, setLogHoursSign] = useState<"+" | "-">("+");
  const [logNotes, setLogNotes] = useState<string>("");
  const [logBusy, setLogBusy] = useState(false);

  // Manual edit modal
  const [editField, setEditField] = useState<EditField | null>(null);
  const [editNewH, setEditNewH] = useState(0);
  const [editNewM, setEditNewM] = useState(0);
  const [editNewValue, setEditNewValue] = useState(""); // for unpaid (hours)
  const [editNotes, setEditNotes] = useState("");
  const [editHistory, setEditHistory] = useState<ManualAdjRow[]>([]);
  const [editHistoryLoading, setEditHistoryLoading] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  // Escape closes the manual-balance edit modal (unless a save is in flight).
  useEscapeKey(() => setEditField(null), !!editField && !editBusy);

  // Balance log (accrual/usage/adjustment activity feed)
  const [balLogType, setBalLogType] = useState<"sick" | "pto">("sick");
  const [allAdjustments, setAllAdjustments] = useState<ManualAdjRow[]>([]);

  // Settings (config)
  const [cfgPtoActive, setCfgPtoActive] = useState(false);
  const [cfgPtoPlan, setCfgPtoPlan] = useState<number>(0);
  const [cfgPtoWeeks, setCfgPtoWeeks] = useState<number>(48);
  const [cfgSickFrontloaded, setCfgSickFrontloaded] = useState(false);
  const [cfgSickInitialH, setCfgSickInitialH] = useState(0);
  const [cfgSickInitialM, setCfgSickInitialM] = useState(0);
  const [cfgPtoInitialH, setCfgPtoInitialH] = useState(0);
  const [cfgPtoInitialM, setCfgPtoInitialM] = useState(0);
  const [cfgSickCarryoverH, setCfgSickCarryoverH] = useState(0);
  const [cfgSickCarryoverM, setCfgSickCarryoverM] = useState(0);
  const [cfgPtoCarryoverH, setCfgPtoCarryoverH] = useState(0);
  const [cfgPtoCarryoverM, setCfgPtoCarryoverM] = useState(0);
  // Accrual-rate overrides ("accrue Xh Ym per N hours worked")
  const [cfgSickRateOverride, setCfgSickRateOverride] = useState(false);
  const [cfgSickAccrualH, setCfgSickAccrualH] = useState(1);
  const [cfgSickAccrualM, setCfgSickAccrualM] = useState(0);
  const [cfgSickAccrualPerH, setCfgSickAccrualPerH] = useState<number>(30);
  const [cfgSickAccrualPerM, setCfgSickAccrualPerM] = useState<number>(0);
  const [cfgPtoRateOverride, setCfgPtoRateOverride] = useState(false);
  const [cfgPtoAccrualH, setCfgPtoAccrualH] = useState(1);
  const [cfgPtoAccrualM, setCfgPtoAccrualM] = useState(0);
  const [cfgPtoAccrualPerH, setCfgPtoAccrualPerH] = useState<number>(48);
  const [cfgPtoAccrualPerM, setCfgPtoAccrualPerM] = useState<number>(0);
  const [cfgBusy, setCfgBusy] = useState(false);

  // ── Load profile ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setMeLoading(true);
      try {
        const p = await fetchMyProfile();
        if (!cancelled) setMe(p);
      } catch {
        if (!cancelled) setMe(null);
      } finally {
        if (!cancelled) setMeLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Load employees ────────────────────────────────────────────────────────
  const { filter: campusFilter } = useCampusFilter();
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let q = supabase
        .from("hr_employees")
        .select("id, legal_first_name, legal_middle_name, legal_last_name, nicknames, is_active, start_date, profile_id");
      q = applyCampusFilterToQuery(q, campusFilter);
      const { data, error } = await q
        .order("legal_last_name", { ascending: true })
        .order("legal_first_name", { ascending: true });
      if (cancelled) return;
      if (error) { setError(error.message); return; }
      let rows = (data ?? []) as EmployeeRow[];
      // Campus admins are a level below regular admins → never list admin accounts.
      if (me?.role === "campus_admin") {
        const profIds = rows.map((r) => (r as any).profile_id).filter(Boolean) as string[];
        if (profIds.length) {
          const { data: profs } = await supabase.from("user_profiles").select("id, role").in("id", profIds);
          const adminIds = new Set((profs ?? []).filter((p: any) => p.role === "admin").map((p: any) => p.id));
          rows = rows.filter((r) => !adminIds.has((r as any).profile_id));
        }
      }
      if (cancelled) return;
      setEmployees(rows);
      // Reset/auto-pick selection when campus filter changes
      if (rows.length === 0) {
        setSelectedEmployeeId("");
      } else if (!rows.some((r) => r.id === selectedEmployeeId)) {
        setSelectedEmployeeId(rows.find((r) => r.is_active)?.id ?? rows[0].id);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campusFilter, me?.role]);

  // ── Load pending requests ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPendingLoading(true);
      try {
        const { data, error } = await supabase
          .from("hr_leave_requests")
          .select("*")
          .eq("status", "pending")
          .order("created_at", { ascending: true });
        if (cancelled) return;
        if (error) throw error;
        const rows = (data ?? []) as LeaveRequestRow[];
        if (!cancelled) setPendingRequests(rows);
      } catch {
        // silently ignore pending-request load errors — not critical
      } finally {
        if (!cancelled) setPendingLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Load balance + entries + clock when employee/year changes ─────────────
  useEffect(() => {
    if (!selectedEmployeeId) {
      setBalance(null); setEntries([]); setClockEntries([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true); setError("");
      try {
        const yearStart = `${year}-01-01`;
        const yearEnd = `${year}-12-31`;
        const [balRes, entriesRes, clockRes, adjRes] = await Promise.all([
          supabase.from("hr_leave_balances").select("*").eq("employee_id", selectedEmployeeId).eq("year", year).maybeSingle(),
          supabase.from("hr_leave_entries").select("*").eq("employee_id", selectedEmployeeId).gte("start_date", yearStart).lte("start_date", yearEnd).order("start_date", { ascending: false }),
          supabase.from("clock_entries").select("employee_id, session_date, clocked_in_at, clocked_out_at").eq("employee_id", selectedEmployeeId).gte("session_date", yearStart).lte("session_date", yearEnd),
          supabase.from("hr_leave_manual_adjustments").select("*, user_profiles(full_name)").eq("employee_id", selectedEmployeeId).eq("year", year).order("changed_at", { ascending: false }),
        ]);
        if (cancelled) return;
        if (balRes.error) throw balRes.error;
        if (entriesRes.error) throw entriesRes.error;
        if (clockRes.error) throw clockRes.error;
        setAllAdjustments((adjRes.data ?? []) as ManualAdjRow[]);

        let b = (balRes.data as LeaveBalanceRow | null);

        // If no balance row yet, auto-compute carryover from previous year
        if (!b) {
          const prevYear = year - 1;
          const [prevBalRes, prevEntriesRes, prevClockRes] = await Promise.all([
            supabase.from("hr_leave_balances").select("*").eq("employee_id", selectedEmployeeId).eq("year", prevYear).maybeSingle(),
            supabase.from("hr_leave_entries").select("*").eq("employee_id", selectedEmployeeId).gte("start_date", `${prevYear}-01-01`).lte("start_date", `${prevYear}-12-31`),
            supabase.from("clock_entries").select("employee_id, session_date, clocked_in_at, clocked_out_at").eq("employee_id", selectedEmployeeId).gte("session_date", `${prevYear}-01-01`).lte("session_date", `${prevYear}-12-31`),
          ]);
          if (!cancelled && !prevBalRes.error && !prevEntriesRes.error && !prevClockRes.error) {
            const prevBal = prevBalRes.data as LeaveBalanceRow | null;
            const prevEntries = (prevEntriesRes.data ?? []) as LeaveEntryRow[];
            const prevClock = (prevClockRes.data ?? []) as ClockEntryRow[];
            const prevHours = sumClockedHours(prevClock, `${prevYear}-01-01`, `${prevYear}-12-31`);
            const prevSick = computeSickBalance(prevBal, prevHours, prevEntries);
            const prevPto = computePtoBalance(prevBal, prevHours, prevEntries);
            const sickCarryover = Math.max(0, Math.min(prevSick.balance, CARRYOVER_CAP));
            const ptoCarryover = Math.max(0, Math.min(prevPto.balance, CARRYOVER_CAP));
            b = { ...defaultBalance(selectedEmployeeId, year), sick_carryover: sickCarryover, pto_carryover: ptoCarryover };
          } else {
            b = defaultBalance(selectedEmployeeId, year);
          }
        }

        setBalance(b);
        setEntries((entriesRes.data ?? []) as LeaveEntryRow[]);
        setClockEntries((clockRes.data ?? []) as ClockEntryRow[]);

        setCfgPtoActive(b.pto_active);
        setCfgPtoPlan(b.pto_plan_hours);
        setCfgPtoWeeks(b.pto_weeks);
        setCfgSickFrontloaded(b.sick_frontloaded);
        const [sih, sim] = decToHM(b.sick_initial_balance ?? 0); setCfgSickInitialH(sih); setCfgSickInitialM(sim);
        const [pih, pim] = decToHM(b.pto_initial_balance ?? 0); setCfgPtoInitialH(pih); setCfgPtoInitialM(pim);
        const [sch, scm] = decToHM(b.sick_carryover ?? 0); setCfgSickCarryoverH(sch); setCfgSickCarryoverM(scm);
        const [pch, pcm] = decToHM(b.pto_carryover ?? 0); setCfgPtoCarryoverH(pch); setCfgPtoCarryoverM(pcm);

        const sickOv = isOverrideActive(b.sick_accrual_amount, b.sick_accrual_per);
        setCfgSickRateOverride(sickOv);
        if (sickOv) {
          const [sah, sam] = decToHM(Number(b.sick_accrual_amount)); setCfgSickAccrualH(sah); setCfgSickAccrualM(sam);
          const [sph, spm] = decToHM(Number(b.sick_accrual_per)); setCfgSickAccrualPerH(sph); setCfgSickAccrualPerM(spm);
        } else {
          setCfgSickAccrualH(1); setCfgSickAccrualM(0); setCfgSickAccrualPerH(DEFAULT_SICK_RATE); setCfgSickAccrualPerM(0);
        }
        const ptoOv = isOverrideActive(b.pto_accrual_amount, b.pto_accrual_per);
        setCfgPtoRateOverride(ptoOv);
        if (ptoOv) {
          const [pah, pam] = decToHM(Number(b.pto_accrual_amount)); setCfgPtoAccrualH(pah); setCfgPtoAccrualM(pam);
          const [pph, ppm] = decToHM(Number(b.pto_accrual_per)); setCfgPtoAccrualPerH(pph); setCfgPtoAccrualPerM(ppm);
        } else {
          setCfgPtoAccrualH(1); setCfgPtoAccrualM(0);
          const [pph, ppm] = decToHM(b.pto_plan_hours > 0 ? (b.pto_weeks * 40) / b.pto_plan_hours : 48);
          setCfgPtoAccrualPerH(pph); setCfgPtoAccrualPerM(ppm);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load leave data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedEmployeeId, year]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const selectedEmployee = useMemo(() => employees.find((e) => e.id === selectedEmployeeId) ?? null, [employees, selectedEmployeeId]);

  const probation = useMemo(() => {
    if (!selectedEmployee?.start_date) return null;
    const end = addDaysYmd(selectedEmployee.start_date, PROBATION_DAYS);
    return { endDate: end, passed: todayYmd() >= end };
  }, [selectedEmployee]);

  const hoursWorkedYtdRaw = useMemo(() => sumClockedHours(clockEntries, `${year}-01-01`, `${year}-12-31`), [clockEntries, year]);
  const hoursWorkedYtd = hoursWorkedYtdRaw + (balance?.hours_worked_override ?? 0);

  const sickCalc = useMemo(() => computeSickBalance(balance, hoursWorkedYtd, entries), [balance, hoursWorkedYtd, entries]);
  const ptoCalc = useMemo(() => computePtoBalance(balance, hoursWorkedYtd, entries), [balance, hoursWorkedYtd, entries]);
  const unpaidUsedRaw = useMemo(() => entries.filter((e) => e.entry_type === "unpaid").reduce((s, e) => s + Number(e.hours), 0), [entries]);
  const unpaidUsed = unpaidUsedRaw + (balance?.unpaid_override ?? 0);

  // ── Balance log (accrual / usage / adjustment activity feed for the year) ────
  const balanceLog = useMemo<LogRow[]>(() => {
    if (!balance) return [];
    const isSick = balLogType === "sick";
    const cap = isSick ? (balance.sick_annual_cap ?? 40) : ptoCalc.plan;
    const accruedAt = isSick
      ? (h: number) => computeSickBalance(balance, h, []).accrued
      : (h: number) => computePtoBalance(balance, h, []).accrued;
    const rows: LogRow[] = [];

    // Opening balance (carryover + initial) at the start of the year.
    const carry = isSick ? sickCalc.carryover : ptoCalc.carryover;
    const initial = isSick ? sickCalc.initial : ptoCalc.initial;
    if (carry + initial !== 0) {
      rows.push({
        date: `${year}-01-01`, activity: "Opening", change: carry + initial, hoursWorked: null,
        description: carry > 0 ? `Carryover ${fmtHours(carry)}${initial !== 0 ? ` + initial ${fmtHours(initial)}` : ""}` : "Starting balance",
      });
    }

    // Accrual — frontloaded sick is a single upfront grant; otherwise weekly from the timesheet.
    const frontloadedSick = isSick && balance.sick_frontloaded && !isOverrideActive(balance.sick_accrual_amount, balance.sick_accrual_per);
    if (frontloadedSick) {
      rows.push({ date: `${year}-01-01`, activity: "Frontloaded", change: cap, hoursWorked: null, description: `${fmtHours(cap)} granted upfront` });
    } else if (isSick || ptoCalc.active) {
      const byWeek = new Map<string, number>();
      for (const c of clockEntries) {
        const h = clockEntryHours(c);
        if (h <= 0) continue;
        const ws = weekStartYmd(c.session_date);
        byWeek.set(ws, (byWeek.get(ws) ?? 0) + h);
      }
      let cum = 0;
      for (const ws of [...byWeek.keys()].sort()) {
        const wh = byWeek.get(ws)!;
        const before = accruedAt(cum);
        cum += wh;
        rows.push({ date: ws, activity: "Accrual", change: accruedAt(cum) - before, hoursWorked: wh, description: `Week of ${fmtYmd(ws)}` });
      }
    }

    // Usage + adjustment entries of this type.
    const usedType = isSick ? "sick_paid" : "pto";
    const adjType = isSick ? "sick_adjustment" : "pto_adjustment";
    for (const e of entries) {
      if (e.entry_type === usedType) rows.push({ date: e.start_date, activity: "Used", change: -Number(e.hours), hoursWorked: null, description: e.notes || "Leave taken" });
      else if (e.entry_type === adjType) rows.push({ date: e.start_date, activity: "Adjustment", change: Number(e.hours), hoursWorked: null, description: e.notes || "Manual adjustment" });
    }

    // Manual balance / accrued-YTD edits.
    const fields = isSick ? ["sick", "sick_accrued"] : ["pto", "pto_accrued"];
    for (const a of allAdjustments) {
      if (!fields.includes(a.field)) continue;
      const who = a.user_profiles?.full_name ? ` by ${a.user_profiles.full_name}` : "";
      rows.push({
        date: a.changed_at.slice(0, 10),
        activity: a.field.endsWith("_accrued") ? "Accrued YTD set" : "Balance set",
        change: Number(a.new_value) - Number(a.old_value), hoursWorked: null,
        description: `${fmtHours(Number(a.old_value))} → ${fmtHours(Number(a.new_value))}${who}${a.notes ? ` · ${a.notes}` : ""}`,
      });
    }

    rows.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0)); // newest first
    return rows;
  }, [balance, balLogType, year, clockEntries, entries, allAdjustments, sickCalc, ptoCalc]);

  // Enrich pending requests with employee names
  const enrichedPending = useMemo(() =>
    pendingRequests.map((r) => ({ ...r, employee: employees.find((e) => e.id === r.employee_id) })),
    [pendingRequests, employees]
  );

  // ── Actions ───────────────────────────────────────────────────────────────

  function overridePatches() {
    const prevSick = {
      amount: balance?.sick_accrual_amount ?? null, per: balance?.sick_accrual_per ?? null,
      anchor_hours: balance?.sick_accrual_anchor_hours ?? null, anchor_accrued: balance?.sick_accrual_anchor_accrued ?? null,
    };
    const prevPto = {
      amount: balance?.pto_accrual_amount ?? null, per: balance?.pto_accrual_per ?? null,
      anchor_hours: balance?.pto_accrual_anchor_hours ?? null, anchor_accrued: balance?.pto_accrual_anchor_accrued ?? null,
    };
    const sick = buildOverridePatch(cfgSickRateOverride, hmToDec(cfgSickAccrualH, cfgSickAccrualM), hmToDec(cfgSickAccrualPerH, cfgSickAccrualPerM), prevSick, hoursWorkedYtd, sickCalc.accrued);
    const pto = buildOverridePatch(cfgPtoRateOverride, hmToDec(cfgPtoAccrualH, cfgPtoAccrualM), hmToDec(cfgPtoAccrualPerH, cfgPtoAccrualPerM), prevPto, hoursWorkedYtd, ptoCalc.accrued);
    return {
      sick_accrual_amount: sick.amount, sick_accrual_per: sick.per,
      sick_accrual_anchor_hours: sick.anchor_hours, sick_accrual_anchor_accrued: sick.anchor_accrued,
      pto_accrual_amount: pto.amount, pto_accrual_per: pto.per,
      pto_accrual_anchor_hours: pto.anchor_hours, pto_accrual_anchor_accrued: pto.anchor_accrued,
    };
  }

  async function ensureBalanceRow(): Promise<LeaveBalanceRow> {
    if (balance && balance.id) return balance;
    const insertRow = {
      employee_id: selectedEmployeeId, year,
      pto_active: cfgPtoActive, pto_plan_hours: cfgPtoPlan, pto_weeks: cfgPtoWeeks,
      sick_frontloaded: cfgSickFrontloaded, sick_annual_cap: 40,
      pto_initial_balance: hmToDec(cfgPtoInitialH, cfgPtoInitialM),
      sick_initial_balance: hmToDec(cfgSickInitialH, cfgSickInitialM),
      sick_carryover: Math.min(hmToDec(cfgSickCarryoverH, cfgSickCarryoverM), CARRYOVER_CAP),
      pto_carryover: Math.min(hmToDec(cfgPtoCarryoverH, cfgPtoCarryoverM), CARRYOVER_CAP),
      ...overridePatches(),
      created_by: me?.id ?? null, updated_by: me?.id ?? null,
    };
    const { data, error } = await supabase.from("hr_leave_balances").insert(insertRow).select("*").single();
    if (error) throw error;
    const row = data as LeaveBalanceRow;
    setBalance(row);
    return row;
  }

  async function saveSettings() {
    if (!selectedEmployeeId) return;
    setCfgBusy(true);
    try {
      const patch = {
        employee_id: selectedEmployeeId, year,
        pto_active: cfgPtoActive, pto_plan_hours: cfgPtoPlan, pto_weeks: cfgPtoWeeks,
        sick_frontloaded: cfgSickFrontloaded, sick_annual_cap: 40,
        pto_initial_balance: hmToDec(cfgPtoInitialH, cfgPtoInitialM),
        sick_initial_balance: hmToDec(cfgSickInitialH, cfgSickInitialM),
        sick_carryover: Math.min(hmToDec(cfgSickCarryoverH, cfgSickCarryoverM), CARRYOVER_CAP),
        pto_carryover: Math.min(hmToDec(cfgPtoCarryoverH, cfgPtoCarryoverM), CARRYOVER_CAP),
        ...overridePatches(),
        updated_by: me?.id ?? null,
      };
      const { data, error } = await supabase
        .from("hr_leave_balances")
        .upsert({ ...patch, created_by: me?.id ?? null }, { onConflict: "employee_id,year" })
        .select("*").single();
      if (error) throw error;
      setBalance(data as LeaveBalanceRow);
    } catch (e: unknown) {
      await alert(`Could not save settings: ${errMessage(e)}`);
    } finally {
      setCfgBusy(false);
    }
  }

  async function logLeave() {
    if (!selectedEmployeeId) return;
    // Unpaid now works like sick/pto: a single day with start/end times → hours.
    const isSingleDay = logType === "sick_paid" || logType === "pto" || logType === "unpaid";

    let hours: number;
    if (isSingleDay) {
      if (!logStartTime || !logEndTime) { await alert("Please enter start and end times."); return; }
      const [sh, sm] = logStartTime.split(":").map(Number);
      const [eh, em] = logEndTime.split(":").map(Number);
      hours = (eh * 60 + em - (sh * 60 + sm)) / 60;
      if (hours <= 0) { await alert("End time must be after start time."); return; }
    } else {
      const absHours = hmToDec(logHoursH, logHoursM);
      if (absHours === 0) { await alert("Hours must be non-zero."); return; }
      hours = logHoursSign === "-" ? -absHours : absHours;
      if (logType !== "sick_adjustment" && logType !== "pto_adjustment" && hours < 0) {
        await alert("Usage entries cannot be negative. Use an adjustment type to remove hours.");
        return;
      }
    }

    const effectiveEnd = isSingleDay ? logStart : logEnd;

    if (logType === "sick_paid" && probation && !probation.passed) {
      const ok = await confirm(`This employee is still in probation (ends ${fmtYmd(probation.endDate)}). Log paid sick anyway?`);
      if (!ok) return;
    }

    setLogBusy(true);
    try {
      await ensureBalanceRow();
      const { error } = await supabase.from("hr_leave_entries").insert({
        employee_id: selectedEmployeeId, entry_type: logType,
        start_date: logStart, end_date: effectiveEnd, hours,
        start_time: isSingleDay ? logStartTime : null,
        end_time: isSingleDay ? logEndTime : null,
        notes: logNotes.trim() || null, created_by: me?.id ?? null,
      });
      if (error) throw error;
      setLogHoursH(1); setLogHoursM(0); setLogHoursSign("+"); setLogStartTime("09:00"); setLogEndTime("17:00"); setLogNotes("");
      const yearStart = `${year}-01-01`;
      const yearEnd = `${year}-12-31`;
      const { data, error: reErr } = await supabase.from("hr_leave_entries").select("*").eq("employee_id", selectedEmployeeId).gte("start_date", yearStart).lte("start_date", yearEnd).order("start_date", { ascending: false });
      if (reErr) throw reErr;
      setEntries((data ?? []) as LeaveEntryRow[]);
    } catch (e: unknown) {
      await alert(`Could not log leave: ${errMessage(e)}`);
    } finally {
      setLogBusy(false);
    }
  }

  async function deleteEntry(id: string) {
    const ok = await confirm("Delete this entry? Balances will recalculate.");
    if (!ok) return;
    try {
      const { error } = await supabase.from("hr_leave_entries").delete().eq("id", id);
      if (error) throw error;
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (e: unknown) {
      await alert(`Could not delete: ${errMessage(e)}`);
    }
  }

  async function approveRequest(req: LeaveRequestRow & { employee?: EmployeeRow }) {
    const empName = req.employee ? getDisplayName(req.employee) : req.employee_id;
    const durationStr = fmtHours(Number(req.hours));
    const ok = await confirm(`Approve ${REQUEST_LABELS[req.entry_type]} request for ${empName} (${fmtRange(req.start_date, req.end_date)}, ${durationStr})?`);
    if (!ok) return;
    try {
      // Create a leave entry (deducts from balance)
      const { error: entryErr } = await supabase.from("hr_leave_entries").insert({
        employee_id: req.employee_id, entry_type: req.entry_type,
        start_date: req.start_date, end_date: req.end_date,
        start_time: req.start_time, end_time: req.end_time,
        hours: req.hours, notes: req.notes,
        created_by: me?.id ?? null,
      });
      if (entryErr) throw entryErr;

      // Mark request approved
      const { error: reqErr } = await supabase.from("hr_leave_requests").update({
        status: "approved",
        review_notes: reviewNotes[req.id] || null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: me?.id ?? null,
      }).eq("id", req.id);
      if (reqErr) throw reqErr;

      setPendingRequests((prev) => prev.filter((r) => r.id !== req.id));

      // Refresh entries if this is for the currently selected employee/year
      const reqYear = new Date(req.start_date).getFullYear();
      if (req.employee_id === selectedEmployeeId && reqYear === year) {
        const yearStart = `${year}-01-01`;
        const yearEnd = `${year}-12-31`;
        const { data } = await supabase.from("hr_leave_entries").select("*").eq("employee_id", selectedEmployeeId).gte("start_date", yearStart).lte("start_date", yearEnd).order("start_date", { ascending: false });
        setEntries((data ?? []) as LeaveEntryRow[]);
      }
    } catch (e: unknown) {
      await alert(`Could not approve request: ${errMessage(e)}`);
    }
  }

  async function denyRequest(req: LeaveRequestRow & { employee?: EmployeeRow }) {
    const empName = req.employee ? getDisplayName(req.employee) : req.employee_id;
    const ok = await confirm(`Deny ${REQUEST_LABELS[req.entry_type]} request for ${empName}?`);
    if (!ok) return;
    try {
      const { error } = await supabase.from("hr_leave_requests").update({
        status: "denied",
        review_notes: reviewNotes[req.id] || null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: me?.id ?? null,
      }).eq("id", req.id);
      if (error) throw error;
      setPendingRequests((prev) => prev.filter((r) => r.id !== req.id));
    } catch (e: unknown) {
      await alert(`Could not deny request: ${errMessage(e)}`);
    }
  }

  // ── Manual edit modal ─────────────────────────────────────────────────────

  async function openEditModal(field: EditField) {
    const currentVal =
      field === "sick" ? sickCalc.balance
      : field === "pto" ? ptoCalc.balance
      : field === "sick_accrued" ? sickCalc.accrued
      : field === "pto_accrued" ? ptoCalc.accrued
      : field === "unpaid" ? unpaidUsed
      : hoursWorkedYtd;
    setEditField(field);
    if (field === "unpaid") {
      setEditNewValue(String(Math.round(currentVal)));
    } else {
      const [h, m] = decToHM(currentVal);
      setEditNewH(h); setEditNewM(m);
    }
    setEditNotes("");
    setEditHistory([]);
    setEditHistoryLoading(true);
    const { data } = await supabase
      .from("hr_leave_manual_adjustments")
      .select("*, user_profiles(full_name)")
      .eq("employee_id", selectedEmployeeId)
      .eq("year", year)
      .eq("field", field)
      .order("changed_at", { ascending: false });
    setEditHistory((data ?? []) as ManualAdjRow[]);
    setEditHistoryLoading(false);
  }

  async function saveEdit() {
    if (!editField || !selectedEmployeeId) return;
    const newVal = editField === "unpaid" ? parseFloat(editNewValue) : hmToDec(editNewH, editNewM);
    if (isNaN(newVal) || newVal < 0) { await alert("Enter a valid non-negative number."); return; }
    const oldVal =
      editField === "sick" ? sickCalc.balance
      : editField === "pto" ? ptoCalc.balance
      : editField === "sick_accrued" ? sickCalc.accrued
      : editField === "pto_accrued" ? ptoCalc.accrued
      : editField === "unpaid" ? unpaidUsed
      : hoursWorkedYtd;
    setEditBusy(true);
    try {
      const balRow = await ensureBalanceRow();

      if (editField === "sick") {
        const newInitial = newVal - sickCalc.carryover - sickCalc.accrued - sickCalc.adjustments + sickCalc.used;
        const { data, error } = await supabase
          .from("hr_leave_balances")
          .update({ sick_initial_balance: newInitial })
          .eq("id", balRow.id)
          .select("*").single();
        if (error) throw error;
        setBalance(data as LeaveBalanceRow);
        const [sih, sim] = decToHM(Math.max(0, newInitial)); setCfgSickInitialH(sih); setCfgSickInitialM(sim);
      } else if (editField === "pto") {
        const newInitial = newVal - ptoCalc.carryover - ptoCalc.accrued - ptoCalc.adjustments + ptoCalc.used;
        const { data, error } = await supabase
          .from("hr_leave_balances")
          .update({ pto_initial_balance: newInitial })
          .eq("id", balRow.id)
          .select("*").single();
        if (error) throw error;
        setBalance(data as LeaveBalanceRow);
        const [pih, pim] = decToHM(Math.max(0, newInitial)); setCfgPtoInitialH(pih); setCfgPtoInitialM(pim);
      } else if (editField === "sick_accrued") {
        // Re-base accrual: at the current hours-worked, accrued = newVal (capped at the annual
        // cap). Future worked hours keep accruing from here at the active rate. Shift the initial
        // balance by the accrued delta so the usable total stays put (only future accrual grows it).
        const anchored = Math.min(newVal, sickCalc.cap);
        const newInitial = sickCalc.initial - (anchored - sickCalc.accrued);
        const { data, error } = await supabase
          .from("hr_leave_balances")
          .update({ sick_accrual_anchor_hours: hoursWorkedYtd, sick_accrual_anchor_accrued: anchored, sick_initial_balance: newInitial })
          .eq("id", balRow.id)
          .select("*").single();
        if (error) throw error;
        setBalance(data as LeaveBalanceRow);
        const [sih, sim] = decToHM(Math.max(0, newInitial)); setCfgSickInitialH(sih); setCfgSickInitialM(sim);
      } else if (editField === "pto_accrued") {
        const anchored = ptoCalc.plan > 0 ? Math.min(newVal, ptoCalc.plan) : newVal;
        const newInitial = ptoCalc.initial - (anchored - ptoCalc.accrued);
        const { data, error } = await supabase
          .from("hr_leave_balances")
          .update({ pto_accrual_anchor_hours: hoursWorkedYtd, pto_accrual_anchor_accrued: anchored, pto_initial_balance: newInitial })
          .eq("id", balRow.id)
          .select("*").single();
        if (error) throw error;
        setBalance(data as LeaveBalanceRow);
        const [pih, pim] = decToHM(Math.max(0, newInitial)); setCfgPtoInitialH(pih); setCfgPtoInitialM(pim);
      } else if (editField === "unpaid") {
        const delta = newVal - unpaidUsedRaw;
        const { data, error } = await supabase
          .from("hr_leave_balances")
          .update({ unpaid_override: delta === 0 ? null : delta })
          .eq("id", balRow.id)
          .select("*").single();
        if (error) throw error;
        setBalance(data as LeaveBalanceRow);
      } else if (editField === "hours_worked") {
        const delta = newVal - hoursWorkedYtdRaw;
        const { data, error } = await supabase
          .from("hr_leave_balances")
          .update({ hours_worked_override: delta === 0 ? null : delta })
          .eq("id", balRow.id)
          .select("*").single();
        if (error) throw error;
        setBalance(data as LeaveBalanceRow);
      }

      const { error: logErr } = await supabase.from("hr_leave_manual_adjustments").insert({
        employee_id: selectedEmployeeId,
        year,
        field: editField,
        old_value: oldVal,
        new_value: newVal,
        notes: editNotes.trim() || null,
        changed_by: me?.id ?? null,
      });
      if (logErr) throw logErr;

      setEditField(null);
    } catch (e: unknown) {
      await alert(`Could not save: ${errMessage(e)}`);
    } finally {
      setEditBusy(false);
    }
  }

  // ── Access control ────────────────────────────────────────────────────────
  if (meLoading) return <div className="container" style={{ padding: 24 }}>Loading…</div>;
  if (!me || (me.role !== "admin" && me.role !== "campus_admin") || !me.is_active) {
    return (
      <div className="container" style={{ padding: 24 }}>
        <h1 style={{ marginBottom: 8 }}>Leave</h1>
        <div className="subtle">Admins only.</div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="container" style={{ padding: 24 }}>
      {dialogModal}

      {/* ── Manual Balance Edit Modal ──────────────────────────────────── */}
      {editField && (
        <>
          <div
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 300 }}
            onClick={() => !editBusy && setEditField(null)}
          />
          <div
            style={{
              position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
              zIndex: 301, background: "white", borderRadius: 16,
              boxShadow: "0 8px 40px rgba(0,0,0,0.2)",
              width: "min(480px, 95vw)", maxHeight: "90vh", overflowY: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16 }}>
                  Edit {editField === "sick" ? "Sick Balance" : editField === "pto" ? "PTO Balance" : editField === "sick_accrued" ? "Sick Accrued YTD" : editField === "pto_accrued" ? "PTO Accrued YTD" : editField === "unpaid" ? "Unpaid Hours" : "Hours Worked YTD"}
                </div>
                <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>
                  {selectedEmployee ? getDisplayName(selectedEmployee) : ""} · {year}
                </div>
              </div>
              <button onClick={() => !editBusy && setEditField(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#9ca3af", padding: 4 }}>✕</button>
            </div>

            <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <FieldLabel>
                  {editField === "unpaid" ? "Total unpaid hours used" : editField === "hours_worked" ? "Total hours worked YTD" : editField === "sick_accrued" || editField === "pto_accrued" ? "Accrued YTD" : "New balance"}
                </FieldLabel>
                {editField === "unpaid" ? (
                  <TextInput type="number" min="0" step="0.25" value={editNewValue} onChange={(e) => setEditNewValue(e.target.value)} autoFocus style={{ fontSize: 18, fontWeight: 700 }} />
                ) : (
                  <HMInput h={editNewH} m={editNewM} onChangeH={setEditNewH} onChangeM={setEditNewM} large />
                )}
                {(editField === "sick" || editField === "pto") && (
                  <div style={{ marginTop: 6, fontSize: 12, color: "#6b7280" }}>
                    Setting this adjusts the initial balance so that the computed total matches your entered value. Accruals continue normally.
                  </div>
                )}
                {(editField === "sick_accrued" || editField === "pto_accrued") && (
                  <div style={{ marginTop: 6, fontSize: 12, color: "#6b7280" }}>
                    Re-bases how much has been accrued so far this year (useful when migrating records mid-year). Hours worked from now on keep accruing from this value, up to the annual cap ({editField === "sick_accrued" ? fmtHours(sickCalc.cap) : ptoCalc.plan > 0 ? fmtHours(ptoCalc.plan) : "plan"}).
                  </div>
                )}
                {editField === "hours_worked" && (
                  <div style={{ marginTop: 6, fontSize: 12, color: "#6b7280" }}>
                    Overrides the timesheet-computed total for accrual purposes. Set both to 0 to clear the override.
                  </div>
                )}
              </div>

              <div>
                <FieldLabel>Notes (optional)</FieldLabel>
                <TextInput
                  type="text"
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  placeholder="Reason for manual adjustment…"
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button className="btn" onClick={() => setEditField(null)} disabled={editBusy}>Cancel</button>
                <button className="btn btn-primary" onClick={() => void saveEdit()} disabled={editBusy}>
                  {editBusy ? "Saving…" : "Save"}
                </button>
              </div>

              {/* History */}
              <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 14 }}>
                <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>Change History</div>
                {editHistoryLoading ? (
                  <div style={{ fontSize: 13, color: "#6b7280" }}>Loading…</div>
                ) : editHistory.length === 0 ? (
                  <div style={{ fontSize: 13, color: "#9ca3af" }}>No manual changes recorded yet.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {editHistory.map((h) => (
                      <div key={h.id} style={{ padding: "8px 12px", borderRadius: 10, background: "#f9fafb", border: "1px solid #e5e7eb" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>
                            <span style={{ color: "#6b7280", textDecoration: "line-through", marginRight: 6 }}>{fmtHours(Number(h.old_value))}</span>
                            →
                            <span style={{ marginLeft: 6, color: "#111827" }}>{fmtHours(Number(h.new_value))}</span>
                          </div>
                          <div style={{ fontSize: 11, color: "#9ca3af", whiteSpace: "nowrap" }}>
                            {new Date(h.changed_at).toLocaleString()}
                          </div>
                        </div>
                        {(h.user_profiles?.full_name || h.notes) && (
                          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 3 }}>
                            {h.user_profiles?.full_name && <span>{h.user_profiles.full_name}</span>}
                            {h.user_profiles?.full_name && h.notes && <span> · </span>}
                            {h.notes && <em>{h.notes}</em>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="row-between" style={{ marginBottom: 16, alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Leave</h1>
          <div className="subtle" style={{ marginTop: 4 }}>Track sick and PTO balances, log usage, and adjust totals.</div>
        </div>
        <div className="row" style={{ gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ minWidth: 240 }}>
            <FieldLabel>Employee</FieldLabel>
            <Select value={selectedEmployeeId} onChange={(e) => setSelectedEmployeeId(e.target.value)} disabled={employees.length === 0}>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{getDisplayName(e)}{e.is_active ? "" : " (inactive)"}</option>
              ))}
            </Select>
          </div>
          <div style={{ width: 110 }}>
            <FieldLabel>Year</FieldLabel>
            <Select value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
          </div>
        </div>
      </div>

      {error && (
        <div style={{ padding: 12, borderRadius: 12, background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", marginBottom: 16 }}>{error}</div>
      )}

      {/* ── Pending Requests ─────────────────────────────────────────────── */}
      {(pendingLoading || enrichedPending.length > 0) && (
        <Card title={`Pending Requests${enrichedPending.length > 0 ? ` (${enrichedPending.length})` : ""}`} style={{ marginBottom: 16, borderColor: "#fde68a" }}>
          {pendingLoading ? (
            <div className="subtle">Loading…</div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {enrichedPending.map((req) => (
                <div key={req.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
                  <div className="row-between" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 14 }}>
                        {req.employee ? getDisplayName(req.employee) : "Unknown employee"}
                        <span style={{ marginLeft: 8 }}>
                          <TypePill type={req.entry_type} />
                        </span>
                      </div>
                      <div className="subtle" style={{ fontSize: 13, marginTop: 2 }}>
                        {fmtRange(req.start_date, req.end_date)}{req.start_time && req.end_time ? ` · ${fmtLeaveTime(req.start_time)} – ${fmtLeaveTime(req.end_time)}` : ""} · {fmtHours(Number(req.hours))}
                        {req.notes && <> · <em>{req.notes}</em></>}
                      </div>
                      <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>
                        Requested {new Date(req.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                      <div style={{ minWidth: 200 }}>
                        <FieldLabel>Review notes (optional)</FieldLabel>
                        <TextInput
                          type="text"
                          value={reviewNotes[req.id] ?? ""}
                          onChange={(e) => setReviewNotes((prev) => ({ ...prev, [req.id]: e.target.value }))}
                          placeholder="Optional notes for employee…"
                          style={{ padding: "6px 10px", fontSize: 13 }}
                        />
                      </div>
                      <button className="btn btn-primary" onClick={() => approveRequest(req)} style={{ fontSize: 13, padding: "8px 14px" }}>Approve</button>
                      <button className="btn" onClick={() => denyRequest(req)} style={{ fontSize: 13, padding: "8px 14px", color: "#b91c1c" }}>Deny</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {!selectedEmployee ? (
        <div className="subtle">Select an employee to begin.</div>
      ) : (
        <>
          {/* Summary cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 16 }}>
            <BalanceCard
              title="Sick (paid)"
              balance={sickCalc.balance}
              accent="#e6178d"
              lines={[
                ...(sickCalc.carryover > 0 ? [["Carryover", fmtHours(sickCalc.carryover)] as [string, string]] : []),
                ["Initial", fmtHours(sickCalc.initial)],
                [sickCalc.overrideActive ? "Accrued YTD (custom)" : balance?.sick_frontloaded ? "Frontloaded" : "Accrued YTD",
                  `${fmtHours(sickCalc.accrued)}${
                    sickCalc.overrideActive
                      ? ` (${fmtHours(sickCalc.overrideAmount)} per ${fmtHours(sickCalc.overridePer)})`
                      : !balance?.sick_frontloaded && sickCalc.accruedRaw > sickCalc.cap ? ` (capped at ${sickCalc.cap})` : ""
                  }`,
                  () => void openEditModal("sick_accrued")] as [string, string, () => void],
                ["Used", `−${fmtHours(sickCalc.used)}`],
                ...(sickCalc.adjustments !== 0 ? [[`Adjustments`, `${sickCalc.adjustments >= 0 ? "+" : ""}${fmtHours(sickCalc.adjustments)}`] as [string, string]] : []),
                ...(sickCalc.balance >= MAX_BALANCE ? [["Max balance reached", `(${MAX_BALANCE}h cap)`] as [string, string]] : []),
              ]}
              capAlert={!balance?.sick_frontloaded && sickCalc.accrued >= sickCalc.cap
                ? `Accrued the yearly max (${fmtHours(sickCalc.cap)}) — no longer accruing until ${year + 1}.` : undefined}
              onEdit={() => void openEditModal("sick")}
            />
            <BalanceCard
              title={`PTO${ptoCalc.active ? (ptoCalc.overrideActive ? ` (${ptoCalc.plan}h, custom rate)` : ` (${ptoCalc.plan}h / ${ptoCalc.weeks}w)`) : " (inactive)"}`}
              balance={ptoCalc.balance}
              accent="#0ea5e9"
              lines={ptoCalc.active ? [
                ...(ptoCalc.carryover > 0 ? [["Carryover", fmtHours(ptoCalc.carryover)] as [string, string]] : []),
                ["Initial", fmtHours(ptoCalc.initial)],
                [ptoCalc.overrideActive ? "Accrued YTD (custom)" : "Accrued YTD",
                  `${fmtHours(ptoCalc.accrued)}${
                    ptoCalc.overrideActive
                      ? ` (${fmtHours(ptoCalc.overrideAmount)} per ${fmtHours(ptoCalc.overridePer)}, cap ${ptoCalc.plan}h)`
                      : ptoCalc.accrualRate > 0 ? ` (1h per ${fmtHours(ptoCalc.accrualRate)}, cap ${ptoCalc.plan}h)` : ""
                  }`,
                  () => void openEditModal("pto_accrued")] as [string, string, () => void],
                ["Used", `−${fmtHours(ptoCalc.used)}`],
                ...(ptoCalc.adjustments !== 0 ? [[`Adjustments`, `${ptoCalc.adjustments >= 0 ? "+" : ""}${fmtHours(ptoCalc.adjustments)}`] as [string, string]] : []),
                ...(ptoCalc.balance >= MAX_BALANCE ? [["Max balance reached", `(${MAX_BALANCE}h cap)`] as [string, string]] : []),
              ] : [["", "PTO not activated for this employee/year."]]}
              capAlert={ptoCalc.active && ptoCalc.plan > 0 && ptoCalc.accrued >= ptoCalc.plan
                ? `Accrued the yearly max (${fmtHours(ptoCalc.plan)}) — no longer accruing until ${year + 1}.` : undefined}
              onEdit={() => void openEditModal("pto")}
            />
            <BalanceCard
              title="Unpaid time off"
              balance={unpaidUsed}
              accent="#6b7280"
              balanceLabel="hrs used YTD"
              formatBalance={(n) => fmtHours(n)}
              lines={[
                ["", "Logged for record-keeping; no balance tracked."],
                ...(balance?.unpaid_override != null ? [["Override active", ""] as [string, string]] : []),
              ]}
              onEdit={() => void openEditModal("unpaid")}
            />
            <BalanceCard
              title="Hours worked YTD"
              balance={hoursWorkedYtd}
              accent="#16a34a"
              balanceLabel="worked (timesheet)"
              lines={[
                ["Probation ends", probation ? fmtYmd(probation.endDate) : "—"],
                ["Probation status", probation ? (probation.passed ? "Passed" : "Active") : "—"],
                ...(balance?.hours_worked_override != null ? [["Override active", ""] as [string, string]] : []),
              ]}
              onEdit={() => void openEditModal("hours_worked")}
            />
          </div>

          {/* Log leave + Settings */}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 16, marginBottom: 16 }}>
            <Card title="Log leave / adjustment">
              {(() => {
                const isSingleDay = logType === "sick_paid" || logType === "pto" || logType === "unpaid";
                const isAdjustment = logType === "sick_adjustment" || logType === "pto_adjustment";
                const calcHours = (() => {
                  if (!isSingleDay || !logStartTime || !logEndTime) return null;
                  const [sh, sm] = logStartTime.split(":").map(Number);
                  const [eh, em] = logEndTime.split(":").map(Number);
                  const h = (eh * 60 + em - (sh * 60 + sm)) / 60;
                  return h > 0 ? h : null;
                })();
                return (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <FieldLabel>Type</FieldLabel>
                      <Select value={logType} onChange={(e) => setLogType(e.target.value as LeaveEntryType)}>
                        <option value="sick_paid">Sick — paid</option>
                        <option value="pto">PTO</option>
                        <option value="unpaid">Unpaid time off</option>
                        <option value="sick_adjustment">Adjust SICK total (+/−)</option>
                        <option value="pto_adjustment">Adjust PTO total (+/−)</option>
                      </Select>
                    </div>
                    {isAdjustment && (
                      <div>
                        <FieldLabel>Adjustment</FieldLabel>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <select value={logHoursSign} onChange={(e) => setLogHoursSign(e.target.value as "+" | "-")}
                            style={{ height: 38, border: "1px solid #e5e7eb", borderRadius: 10, padding: "0 8px", fontWeight: 700, fontSize: 15, background: "white" }}>
                            <option value="+">+</option>
                            <option value="-">−</option>
                          </select>
                          <HMInput h={logHoursH} m={logHoursM} onChangeH={setLogHoursH} onChangeM={setLogHoursM} />
                        </div>
                      </div>
                    )}
                    {isSingleDay ? (
                      <>
                        <div style={{ gridColumn: "1 / -1" }}>
                          <FieldLabel>Date</FieldLabel>
                          <TextInput type="date" value={logStart} onChange={(e) => { setLogStart(e.target.value); setLogEnd(e.target.value); }} />
                        </div>
                        <div>
                          <FieldLabel>Start time</FieldLabel>
                          <TextInput type="time" value={logStartTime} onChange={(e) => setLogStartTime(e.target.value)} />
                        </div>
                        <div>
                          <FieldLabel>End time{calcHours !== null ? ` — ${fmtHours(calcHours)}` : ""}</FieldLabel>
                          <TextInput type="time" value={logEndTime} onChange={(e) => setLogEndTime(e.target.value)} />
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          <FieldLabel>Start date</FieldLabel>
                          <TextInput type="date" value={logStart} onChange={(e) => { setLogStart(e.target.value); if (logEnd < e.target.value) setLogEnd(e.target.value); }} />
                        </div>
                        <div>
                          <FieldLabel>End date</FieldLabel>
                          <TextInput type="date" value={logEnd} onChange={(e) => setLogEnd(e.target.value)} />
                        </div>
                      </>
                    )}
                    <div style={{ gridColumn: "1 / -1" }}>
                      <FieldLabel>Notes (optional)</FieldLabel>
                      <TextInput type="text" value={logNotes} onChange={(e) => setLogNotes(e.target.value)} placeholder="Reason, ticket #, etc." />
                    </div>
                  </div>
                );
              })()}
              <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
                <button className="btn btn-primary" onClick={() => void logLeave()} disabled={logBusy || !selectedEmployeeId} style={{ minWidth: 140 }}>
                  {logBusy ? "Saving…" : "Save entry"}
                </button>
              </div>
              <div className="subtle" style={{ marginTop: 8, fontSize: 12 }}>Adjustment hours can be negative to reduce a balance.</div>
            </Card>

            <Card title={`Settings — ${year}`}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ gridColumn: "1 / -1", fontSize: 13, fontWeight: 800, color: "#111827" }}>Sick</div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, opacity: cfgSickRateOverride ? 0.5 : 1 }}>
                    <input type="checkbox" checked={cfgSickFrontloaded} disabled={cfgSickRateOverride} onChange={(e) => setCfgSickFrontloaded(e.target.checked)} />
                    Frontload 40 hrs upfront (no accrual, no carryover required)
                  </label>
                </div>
                <div>
                  <FieldLabel>Sick carryover</FieldLabel>
                  <HMInput h={cfgSickCarryoverH} m={cfgSickCarryoverM} onChangeH={setCfgSickCarryoverH} onChangeM={setCfgSickCarryoverM} />
                </div>
                <div>
                  <FieldLabel>Initial sick balance</FieldLabel>
                  <HMInput h={cfgSickInitialH} m={cfgSickInitialM} onChangeH={setCfgSickInitialH} onChangeM={setCfgSickInitialM} />
                </div>
                <RateOverrideEditor
                  label="Override sick accrual rate"
                  enabled={cfgSickRateOverride}
                  onToggle={setCfgSickRateOverride}
                  h={cfgSickAccrualH} m={cfgSickAccrualM} perH={cfgSickAccrualPerH} perM={cfgSickAccrualPerM}
                  onChangeH={setCfgSickAccrualH} onChangeM={setCfgSickAccrualM} onChangePerH={setCfgSickAccrualPerH} onChangePerM={setCfgSickAccrualPerM}
                  note="Replaces the default 1h-per-30h rule (and frontload) for this employee."
                />

                <div style={{ gridColumn: "1 / -1", fontSize: 13, fontWeight: 800, color: "#111827", marginTop: 6 }}>PTO</div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                    <input type="checkbox" checked={cfgPtoActive} onChange={(e) => setCfgPtoActive(e.target.checked)} />
                    PTO activated for this employee
                  </label>
                </div>
                <div>
                  <FieldLabel>Plan (hrs/year)</FieldLabel>
                  <Select value={cfgPtoPlan} onChange={(e) => setCfgPtoPlan(Number(e.target.value))} disabled={!cfgPtoActive}>
                    <option value={0}>—</option>
                    <option value={16}>16</option>
                    <option value={24}>24</option>
                    <option value={32}>32</option>
                    <option value={40}>40</option>
                  </Select>
                </div>
                <div>
                  <FieldLabel>Working weeks/year{cfgPtoRateOverride ? " (unused)" : ""}</FieldLabel>
                  <Select value={cfgPtoWeeks} onChange={(e) => setCfgPtoWeeks(Number(e.target.value))} disabled={!cfgPtoActive || cfgPtoRateOverride}>
                    <option value={48}>48</option>
                    <option value={50}>50</option>
                    <option value={52}>52</option>
                  </Select>
                </div>
                <div>
                  <FieldLabel>PTO carryover</FieldLabel>
                  <HMInput h={cfgPtoCarryoverH} m={cfgPtoCarryoverM} onChangeH={setCfgPtoCarryoverH} onChangeM={setCfgPtoCarryoverM} />
                </div>
                <div>
                  <FieldLabel>Initial PTO balance</FieldLabel>
                  <HMInput h={cfgPtoInitialH} m={cfgPtoInitialM} onChangeH={setCfgPtoInitialH} onChangeM={setCfgPtoInitialM} />
                </div>
                <RateOverrideEditor
                  label="Override PTO accrual rate"
                  enabled={cfgPtoRateOverride}
                  onToggle={setCfgPtoRateOverride}
                  h={cfgPtoAccrualH} m={cfgPtoAccrualM} perH={cfgPtoAccrualPerH} perM={cfgPtoAccrualPerM}
                  onChangeH={setCfgPtoAccrualH} onChangeM={setCfgPtoAccrualM} onChangePerH={setCfgPtoAccrualPerH} onChangePerM={setCfgPtoAccrualPerM}
                  note="Replaces the weeks/plan rate. PTO must be activated and Plan (hrs/year) still caps the annual total."
                />
              </div>
              <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
                <button className="btn" onClick={saveSettings} disabled={cfgBusy} style={{ minWidth: 140 }}>
                  {cfgBusy ? "Saving…" : "Save settings"}
                </button>
              </div>
            </Card>
          </div>

          {/* Balance log */}
          <div style={{ marginBottom: 16 }}>
            <Card title={`Balance log — ${year}`}>
              <div className="row" style={{ gap: 8, marginBottom: 12, alignItems: "center" }}>
                <div className="row" style={{ gap: 4, background: "#f3f4f6", padding: 4, borderRadius: 10 }}>
                  {(["sick", "pto"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setBalLogType(t)}
                      style={{
                        padding: "6px 16px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 800, fontSize: 13,
                        background: balLogType === t ? "white" : "transparent", color: balLogType === t ? "#e6178d" : "#6b7280",
                        boxShadow: balLogType === t ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
                      }}
                    >
                      {t === "sick" ? "Sick" : "PTO"}
                    </button>
                  ))}
                </div>
                <span className="subtle" style={{ fontSize: 12 }}>Accruals, usage and adjustments. The balance card above is the source of truth.</span>
              </div>
              {loading ? <div className="subtle">Loading…</div>
                : balanceLog.length === 0 ? <div className="subtle">No {balLogType === "sick" ? "sick" : "PTO"} activity for {year}.</div>
                : (
                  <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                      <thead>
                        <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
                          <Th>Date</Th><Th>Activity</Th><Th align="right">Change</Th><Th align="right">Hours worked</Th><Th>Description</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {balanceLog.map((r, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                            <Td>{fmtYmd(r.date)}</Td>
                            <Td><LogActivityPill activity={r.activity} /></Td>
                            <Td align="right">
                              <span style={{ fontWeight: 700, color: r.change > 0 ? "#16a34a" : r.change < 0 ? "#b91c1c" : "#6b7280" }}>
                                {r.change > 0 ? "+" : r.change < 0 ? "−" : ""}{fmtHours(Math.abs(r.change))}
                              </span>
                            </Td>
                            <Td align="right" subtle>{r.hoursWorked != null ? fmtHours(r.hoursWorked) : "—"}</Td>
                            <Td>{r.description || <span className="subtle">—</span>}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </Card>
          </div>

          {/* Entries table */}
          <Card title={`Entries — ${year}`}>
            {loading ? <div className="subtle">Loading…</div>
              : entries.length === 0 ? <div className="subtle">No entries logged for {year}.</div>
              : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                    <thead>
                      <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
                        <Th>Date(s)</Th><Th>Type</Th><Th align="right">Hours</Th><Th>Notes</Th><Th align="right">Logged</Th><Th align="right" />
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((e) => (
                        <tr key={e.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                          <Td>
                            {fmtRange(e.start_date, e.end_date)}
                            {e.start_time && e.end_time && (
                              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{fmtLeaveTime(e.start_time)} – {fmtLeaveTime(e.end_time)}</div>
                            )}
                          </Td>
                          <Td><TypePill type={e.entry_type} /></Td>
                          <Td align="right">{`${e.entry_type.endsWith("_adjustment") && Number(e.hours) >= 0 ? "+" : ""}${fmtHours(Number(e.hours))}`}</Td>
                          <Td>{e.notes || <span className="subtle">—</span>}</Td>
                          <Td align="right" subtle>{new Date(e.created_at).toLocaleDateString()}</Td>
                          <Td align="right">
                            <button className="btn" onClick={() => deleteEntry(e.id)} style={{ padding: "4px 10px", fontSize: 12 }}>Delete</button>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Card>
        </>
      )}
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function HMInput({ h, m, onChangeH, onChangeM, large }: { h: number; m: number; onChangeH: (v: number) => void; onChangeM: (v: number) => void; large?: boolean }) {
  const sz = large ? { height: 44, fontSize: 18, fontWeight: 700 } : { height: 38, fontSize: 14 };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input
          type="number" min="0" value={h}
          onChange={(e) => onChangeH(Math.max(0, parseInt(e.target.value) || 0))}
          style={{ width: 64, border: "1px solid #e5e7eb", borderRadius: 10, padding: "0 8px", outline: "none", background: "white", ...sz }}
        />
        <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 600 }}>h</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input
          type="number" min="0" max="59" value={m}
          onChange={(e) => onChangeM(Math.min(59, Math.max(0, parseInt(e.target.value) || 0)))}
          style={{ width: 56, border: "1px solid #e5e7eb", borderRadius: 10, padding: "0 8px", outline: "none", background: "white", ...sz }}
        />
        <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 600 }}>m</span>
      </div>
    </div>
  );
}

function RateOverrideEditor({
  label, enabled, onToggle, h, m, perH, perM, onChangeH, onChangeM, onChangePerH, onChangePerM, note,
}: {
  label: string;
  enabled: boolean; onToggle: (v: boolean) => void;
  h: number; m: number; perH: number; perM: number;
  onChangeH: (v: number) => void; onChangeM: (v: number) => void;
  onChangePerH: (v: number) => void; onChangePerM: (v: number) => void;
  note?: string;
}) {
  return (
    <div style={{ gridColumn: "1 / -1" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 700 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        {label}
      </label>
      {enabled && (
        <>
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Accrue</span>
            <HMInput h={h} m={m} onChangeH={onChangeH} onChangeM={onChangeM} />
            <span style={{ fontSize: 14, fontWeight: 600 }}>per</span>
            <HMInput h={perH} m={perM} onChangeH={onChangePerH} onChangeM={onChangePerM} />
            <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 600 }}>worked</span>
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: "#6b7280" }}>
            {note ? note + " " : ""}Saving freezes the current balance; the new rate applies only to hours worked from now on. Uncheck to revert to the default rate.
          </div>
        </>
      )}
    </div>
  );
}

function Card({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, background: "white", padding: 16, ...style }}>
      <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

function BalanceCard({ title, balance, accent, lines, balanceLabel = "available", onEdit, formatBalance = fmtHours, capAlert }: {
  title: string; balance: number; accent: string;
  lines: Array<[string, string] | [string, string, () => void]>;
  balanceLabel?: string; onEdit?: () => void; formatBalance?: (n: number) => string; capAlert?: string;
}) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, background: "white", padding: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: accent, textTransform: "uppercase", letterSpacing: 0.4 }}>{title}</div>
      <button
        onClick={onEdit}
        disabled={!onEdit}
        title={onEdit ? "Click to manually adjust" : undefined}
        style={{
          display: "block", fontSize: 28, fontWeight: 800, marginTop: 4,
          background: "none", border: "none", padding: 0,
          color: "#111827", cursor: onEdit ? "pointer" : "default",
          textDecoration: onEdit ? "underline dotted #d1d5db" : "none",
          textUnderlineOffset: 4,
        }}
      >
        {formatBalance(balance)}
      </button>
      <div className="subtle" style={{ fontSize: 12, marginBottom: 10 }}>{balanceLabel}</div>
      {lines.map((line, i) => {
        const [k, v, onClick] = line;
        if (onClick) {
          return (
            <button key={i} onClick={onClick} title="Click to edit accrued YTD"
              style={{ display: "flex", justifyContent: "space-between", width: "100%", fontSize: 12, marginTop: 2, background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
              <span className="subtle">{k}</span>
              <span style={{ fontWeight: 600, textDecoration: "underline dotted #d1d5db", textUnderlineOffset: 3 }}>{v}</span>
            </button>
          );
        }
        return (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginTop: 2 }}>
            <span className="subtle">{k}</span>
            <span style={{ fontWeight: 600 }}>{v}</span>
          </div>
        );
      })}
      {capAlert && (
        <div style={{ marginTop: 10, padding: "7px 10px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", fontSize: 12, fontWeight: 700, lineHeight: 1.35 }}>
          {capAlert}
        </div>
      )}
    </div>
  );
}

function TypePill({ type }: { type: LeaveEntryType | RequestType }) {
  const cfg: Record<string, { label: string; bg: string; fg: string }> = {
    sick_paid:        { label: "Sick (paid)",   bg: "rgba(230,23,141,0.08)", fg: "#e6178d" },
    pto:              { label: "PTO",            bg: "rgba(14,165,233,0.08)", fg: "#0369a1" },
    unpaid:           { label: "Unpaid",         bg: "#f3f4f6",               fg: "#374151" },
    sick_adjustment:  { label: "Sick adj.",      bg: "rgba(230,23,141,0.05)", fg: "#9d174d" },
    pto_adjustment:   { label: "PTO adj.",       bg: "rgba(14,165,233,0.05)", fg: "#0c4a6e" },
  };
  const c = cfg[type] ?? { label: type, bg: "#f3f4f6", fg: "#374151" };
  return (
    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 999, background: c.bg, color: c.fg, fontSize: 12, fontWeight: 700 }}>
      {c.label}
    </span>
  );
}

function LogActivityPill({ activity }: { activity: string }) {
  const cfg: Record<string, { bg: string; fg: string }> = {
    Accrual: { bg: "#ecfdf5", fg: "#15803d" },
    Used: { bg: "rgba(230,23,141,0.08)", fg: "#e6178d" },
    Adjustment: { bg: "#fef3c7", fg: "#b45309" },
    "Manual edit": { bg: "#eef2ff", fg: "#3730a3" },
    "Accrued YTD set": { bg: "#eef2ff", fg: "#3730a3" },
    "Balance set": { bg: "#eef2ff", fg: "#3730a3" },
    Opening: { bg: "#f3f4f6", fg: "#374151" },
    Frontloaded: { bg: "#ecfdf5", fg: "#15803d" },
  };
  const c = cfg[activity] ?? { bg: "#f3f4f6", fg: "#374151" };
  return (
    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 999, background: c.bg, color: c.fg, fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>
      {activity}
    </span>
  );
}

function Th({ children, align }: { children?: React.ReactNode; align?: "right" | "left" }) {
  return <th style={{ textAlign: align ?? "left", padding: "8px 8px", fontSize: 12, fontWeight: 800, color: "#6b7280" }}>{children}</th>;
}

function Td({ children, align, subtle }: { children?: React.ReactNode; align?: "right" | "left"; subtle?: boolean }) {
  return <td style={{ textAlign: align ?? "left", padding: "8px 8px", verticalAlign: "top", color: subtle ? "#6b7280" : undefined }}>{children}</td>;
}
