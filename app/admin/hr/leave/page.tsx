"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import { useDialog } from "@/components/ui/useDialog";

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
};

type EditField = "sick" | "pto" | "unpaid" | "hours_worked";

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

function fmtHours(h: number): string {
  const totalMins = Math.round(h * 60);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs === 0) return `${mins}m`;
  return mins === 0 ? `${hrs}h` : `${hrs}h ${mins}m`;
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

function computeSickBalance(
  bal: LeaveBalanceRow | null,
  hoursWorked: number,
  entries: LeaveEntryRow[],
): { carryover: number; accrued: number; accruedRaw: number; used: number; adjustments: number; balance: number; cap: number; initial: number } {
  const cap = bal?.sick_annual_cap ?? 40;
  const carryover = Number(bal?.sick_carryover ?? 0);
  const accruedRaw = bal?.sick_frontloaded ? cap : Math.floor(hoursWorked / 30);
  const accrued = Math.min(accruedRaw, cap);
  const used = entries.filter((e) => e.entry_type === "sick_paid").reduce((s, e) => s + Number(e.hours), 0);
  const adjustments = entries.filter((e) => e.entry_type === "sick_adjustment").reduce((s, e) => s + Number(e.hours), 0);
  const initial = Number(bal?.sick_initial_balance ?? 0);
  const balance = Math.min(carryover + initial + accrued + adjustments - used, MAX_BALANCE);
  return { carryover, accrued, accruedRaw, used, adjustments, balance, cap, initial };
}

function computePtoBalance(
  bal: LeaveBalanceRow | null,
  hoursWorked: number,
  entries: LeaveEntryRow[],
): { active: boolean; plan: number; weeks: number; accrualRate: number; carryover: number; initial: number; accrued: number; used: number; adjustments: number; balance: number } {
  const active = bal?.pto_active ?? false;
  const plan = bal?.pto_plan_hours ?? 0;
  const weeks = bal?.pto_weeks ?? 48;
  const carryover = Number(bal?.pto_carryover ?? 0);
  let accrued = 0;
  let accrualRate = 0;
  if (active && plan > 0) {
    accrualRate = (weeks * 40) / plan;
    accrued = Math.min(Math.floor(hoursWorked / accrualRate), plan);
  }
  const used = entries.filter((e) => e.entry_type === "pto").reduce((s, e) => s + Number(e.hours), 0);
  const adjustments = entries.filter((e) => e.entry_type === "pto_adjustment").reduce((s, e) => s + Number(e.hours), 0);
  const initial = Number(bal?.pto_initial_balance ?? 0);
  const balance = Math.min(carryover + initial + accrued + adjustments - used, MAX_BALANCE);
  return { active, plan, weeks, accrualRate, carryover, initial, accrued, used, adjustments, balance };
}

function defaultBalance(employeeId: string, year: number): LeaveBalanceRow {
  return {
    id: "", employee_id: employeeId, year,
    pto_active: false, pto_plan_hours: 0, pto_weeks: 48,
    sick_frontloaded: false, sick_annual_cap: 40,
    pto_initial_balance: 0, sick_initial_balance: 0,
    sick_carryover: 0, pto_carryover: 0,
    hours_worked_override: null, unpaid_override: null,
  };
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
  const [logHours, setLogHours] = useState<string>("8");
  const [logNotes, setLogNotes] = useState<string>("");
  const [logBusy, setLogBusy] = useState(false);

  // Manual edit modal
  const [editField, setEditField] = useState<EditField | null>(null);
  const [editNewValue, setEditNewValue] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editHistory, setEditHistory] = useState<ManualAdjRow[]>([]);
  const [editHistoryLoading, setEditHistoryLoading] = useState(false);
  const [editBusy, setEditBusy] = useState(false);

  // Settings (config)
  const [cfgPtoActive, setCfgPtoActive] = useState(false);
  const [cfgPtoPlan, setCfgPtoPlan] = useState<number>(0);
  const [cfgPtoWeeks, setCfgPtoWeeks] = useState<number>(48);
  const [cfgSickFrontloaded, setCfgSickFrontloaded] = useState(false);
  const [cfgSickInitial, setCfgSickInitial] = useState<string>("0");
  const [cfgPtoInitial, setCfgPtoInitial] = useState<string>("0");
  const [cfgSickCarryover, setCfgSickCarryover] = useState<string>("0");
  const [cfgPtoCarryover, setCfgPtoCarryover] = useState<string>("0");
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
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("hr_employees")
        .select("id, legal_first_name, legal_middle_name, legal_last_name, nicknames, is_active, start_date")
        .order("legal_last_name", { ascending: true })
        .order("legal_first_name", { ascending: true });
      if (cancelled) return;
      if (error) { setError(error.message); return; }
      const rows = (data ?? []) as EmployeeRow[];
      setEmployees(rows);
      if (!selectedEmployeeId && rows.length > 0)
        setSelectedEmployeeId(rows.find((r) => r.is_active)?.id ?? rows[0].id);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        const [balRes, entriesRes, clockRes] = await Promise.all([
          supabase.from("hr_leave_balances").select("*").eq("employee_id", selectedEmployeeId).eq("year", year).maybeSingle(),
          supabase.from("hr_leave_entries").select("*").eq("employee_id", selectedEmployeeId).gte("start_date", yearStart).lte("start_date", yearEnd).order("start_date", { ascending: false }),
          supabase.from("clock_entries").select("employee_id, session_date, clocked_in_at, clocked_out_at").eq("employee_id", selectedEmployeeId).gte("session_date", yearStart).lte("session_date", yearEnd),
        ]);
        if (cancelled) return;
        if (balRes.error) throw balRes.error;
        if (entriesRes.error) throw entriesRes.error;
        if (clockRes.error) throw clockRes.error;

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
            const sickCarryover = Math.max(0, Math.min(prevSick.balance, MAX_BALANCE));
            const ptoCarryover = Math.max(0, Math.min(prevPto.balance, MAX_BALANCE));
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
        setCfgSickInitial(String(b.sick_initial_balance ?? 0));
        setCfgPtoInitial(String(b.pto_initial_balance ?? 0));
        setCfgSickCarryover(String(b.sick_carryover ?? 0));
        setCfgPtoCarryover(String(b.pto_carryover ?? 0));
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

  // Enrich pending requests with employee names
  const enrichedPending = useMemo(() =>
    pendingRequests.map((r) => ({ ...r, employee: employees.find((e) => e.id === r.employee_id) })),
    [pendingRequests, employees]
  );

  // ── Actions ───────────────────────────────────────────────────────────────

  async function ensureBalanceRow(): Promise<LeaveBalanceRow> {
    if (balance && balance.id) return balance;
    const insertRow = {
      employee_id: selectedEmployeeId, year,
      pto_active: cfgPtoActive, pto_plan_hours: cfgPtoPlan, pto_weeks: cfgPtoWeeks,
      sick_frontloaded: cfgSickFrontloaded, sick_annual_cap: 40,
      pto_initial_balance: Number(cfgPtoInitial) || 0,
      sick_initial_balance: Number(cfgSickInitial) || 0,
      sick_carryover: Number(cfgSickCarryover) || 0,
      pto_carryover: Number(cfgPtoCarryover) || 0,
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
        pto_initial_balance: Number(cfgPtoInitial) || 0,
        sick_initial_balance: Number(cfgSickInitial) || 0,
        sick_carryover: Number(cfgSickCarryover) || 0,
        pto_carryover: Number(cfgPtoCarryover) || 0,
        updated_by: me?.id ?? null,
      };
      const { data, error } = await supabase
        .from("hr_leave_balances")
        .upsert({ ...patch, created_by: me?.id ?? null }, { onConflict: "employee_id,year" })
        .select("*").single();
      if (error) throw error;
      setBalance(data as LeaveBalanceRow);
    } catch (e: unknown) {
      await alert(`Could not save settings: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setCfgBusy(false);
    }
  }

  async function logLeave() {
    if (!selectedEmployeeId) return;
    const isUnpaid = logType === "unpaid";
    const isSingleDay = logType === "sick_paid" || logType === "pto";

    let hours: number;
    if (isUnpaid) {
      if (!logStart || !logEnd) { await alert("Please select start and end dates."); return; }
      if (logEnd < logStart) { await alert("End date must be on or after start date."); return; }
      const startD = new Date(logStart + "T12:00:00");
      const endD = new Date(logEnd + "T12:00:00");
      hours = Math.round((endD.getTime() - startD.getTime()) / 86400000) + 1;
    } else if (isSingleDay) {
      if (!logStartTime || !logEndTime) { await alert("Please enter start and end times."); return; }
      const [sh, sm] = logStartTime.split(":").map(Number);
      const [eh, em] = logEndTime.split(":").map(Number);
      hours = (eh * 60 + em - (sh * 60 + sm)) / 60;
      if (hours <= 0) { await alert("End time must be after start time."); return; }
    } else {
      hours = Number(logHours);
      if (!Number.isFinite(hours) || hours === 0) {
        await alert("Hours must be a non-zero number.");
        return;
      }
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
        notes: logNotes.trim() || null, created_by: me?.id ?? null,
      });
      if (error) throw error;
      setLogHours("8"); setLogStartTime("09:00"); setLogEndTime("17:00"); setLogNotes("");
      const yearStart = `${year}-01-01`;
      const yearEnd = `${year}-12-31`;
      const { data, error: reErr } = await supabase.from("hr_leave_entries").select("*").eq("employee_id", selectedEmployeeId).gte("start_date", yearStart).lte("start_date", yearEnd).order("start_date", { ascending: false });
      if (reErr) throw reErr;
      setEntries((data ?? []) as LeaveEntryRow[]);
    } catch (e: unknown) {
      await alert(`Could not log leave: ${e instanceof Error ? e.message : "Unknown error"}`);
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
      await alert(`Could not delete: ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  }

  async function approveRequest(req: LeaveRequestRow & { employee?: EmployeeRow }) {
    const empName = req.employee ? getDisplayName(req.employee) : req.employee_id;
    const durationStr = req.entry_type === "unpaid" ? `${Math.round(Number(req.hours))} day${Math.round(Number(req.hours)) !== 1 ? "s" : ""}` : fmtHours(Number(req.hours));
    const ok = await confirm(`Approve ${REQUEST_LABELS[req.entry_type]} request for ${empName} (${fmtRange(req.start_date, req.end_date)}, ${durationStr})?`);
    if (!ok) return;
    try {
      // Create a leave entry (deducts from balance)
      const { error: entryErr } = await supabase.from("hr_leave_entries").insert({
        employee_id: req.employee_id, entry_type: req.entry_type,
        start_date: req.start_date, end_date: req.end_date,
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
      await alert(`Could not approve request: ${e instanceof Error ? e.message : "Unknown error"}`);
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
      await alert(`Could not deny request: ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  }

  // ── Manual edit modal ─────────────────────────────────────────────────────

  async function openEditModal(field: EditField) {
    const currentVal =
      field === "sick" ? sickCalc.balance
      : field === "pto" ? ptoCalc.balance
      : field === "unpaid" ? unpaidUsed
      : hoursWorkedYtd;
    setEditField(field);
    setEditNewValue(String(Math.round(currentVal * 10) / 10));
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
    const newVal = parseFloat(editNewValue);
    if (isNaN(newVal) || newVal < 0) { await alert("Enter a valid non-negative number."); return; }
    const oldVal =
      editField === "sick" ? sickCalc.balance
      : editField === "pto" ? ptoCalc.balance
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
        setCfgSickInitial(String(newInitial));
      } else if (editField === "pto") {
        const newInitial = newVal - ptoCalc.carryover - ptoCalc.accrued - ptoCalc.adjustments + ptoCalc.used;
        const { data, error } = await supabase
          .from("hr_leave_balances")
          .update({ pto_initial_balance: newInitial })
          .eq("id", balRow.id)
          .select("*").single();
        if (error) throw error;
        setBalance(data as LeaveBalanceRow);
        setCfgPtoInitial(String(newInitial));
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
      await alert(`Could not save: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setEditBusy(false);
    }
  }

  // ── Access control ────────────────────────────────────────────────────────
  if (meLoading) return <div className="container" style={{ padding: 24 }}>Loading…</div>;
  if (!me || me.role !== "admin" || !me.is_active) {
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
                  Edit {editField === "sick" ? "Sick Balance" : editField === "pto" ? "PTO Balance" : editField === "unpaid" ? "Unpaid Days" : "Hours Worked YTD"}
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
                  {editField === "unpaid" ? "Total unpaid days used" : editField === "hours_worked" ? "Total hours worked YTD" : "New balance (hours)"}
                </FieldLabel>
                <TextInput
                  type="number"
                  step="0.5"
                  min="0"
                  value={editNewValue}
                  onChange={(e) => setEditNewValue(e.target.value)}
                  autoFocus
                  style={{ fontSize: 18, fontWeight: 700 }}
                />
                {(editField === "sick" || editField === "pto") && (
                  <div style={{ marginTop: 6, fontSize: 12, color: "#6b7280" }}>
                    Setting this adjusts the initial balance so that the computed total matches your entered value. Accruals continue normally.
                  </div>
                )}
                {editField === "hours_worked" && (
                  <div style={{ marginTop: 6, fontSize: 12, color: "#6b7280" }}>
                    Overrides the timesheet-computed total for accrual purposes. Set to 0 to clear the override.
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
                        {fmtRange(req.start_date, req.end_date)} · {req.entry_type === "unpaid" ? `${Math.round(Number(req.hours))} day${Math.round(Number(req.hours)) !== 1 ? "s" : ""}` : fmtHours(Number(req.hours))}
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
                [balance?.sick_frontloaded ? "Frontloaded" : "Accrued YTD",
                  `${fmtHours(sickCalc.accrued)}${!balance?.sick_frontloaded && sickCalc.accruedRaw > sickCalc.cap ? ` (capped at ${sickCalc.cap})` : ""}`],
                ["Used", `−${fmtHours(sickCalc.used)}`],
                ...(sickCalc.adjustments !== 0 ? [[`Adjustments`, `${sickCalc.adjustments >= 0 ? "+" : ""}${fmtHours(sickCalc.adjustments)}`] as [string, string]] : []),
                ...(sickCalc.balance >= MAX_BALANCE ? [["Max balance reached", `(${MAX_BALANCE}h cap)`] as [string, string]] : []),
              ]}
              onEdit={() => void openEditModal("sick")}
            />
            <BalanceCard
              title={`PTO${ptoCalc.active ? ` (${ptoCalc.plan}h / ${ptoCalc.weeks}w)` : " (inactive)"}`}
              balance={ptoCalc.balance}
              accent="#0ea5e9"
              lines={ptoCalc.active ? [
                ...(ptoCalc.carryover > 0 ? [["Carryover", fmtHours(ptoCalc.carryover)] as [string, string]] : []),
                ["Initial", fmtHours(ptoCalc.initial)],
                ["Accrued YTD", `${fmtHours(ptoCalc.accrued)}${ptoCalc.accrualRate > 0 ? ` (1h per ${fmtHours(ptoCalc.accrualRate)}, cap ${ptoCalc.plan}h)` : ""}`],
                ["Used", `−${fmtHours(ptoCalc.used)}`],
                ...(ptoCalc.adjustments !== 0 ? [[`Adjustments`, `${ptoCalc.adjustments >= 0 ? "+" : ""}${fmtHours(ptoCalc.adjustments)}`] as [string, string]] : []),
                ...(ptoCalc.balance >= MAX_BALANCE ? [["Max balance reached", `(${MAX_BALANCE}h cap)`] as [string, string]] : []),
              ] : [["", "PTO not activated for this employee/year."]]}
              onEdit={() => void openEditModal("pto")}
            />
            <BalanceCard
              title="Unpaid time off"
              balance={unpaidUsed}
              accent="#6b7280"
              balanceLabel="days used YTD"
              formatBalance={(n) => String(Math.round(n))}
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
                const isSingleDay = logType === "sick_paid" || logType === "pto";
                const isUnpaidType = logType === "unpaid";
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
                        <FieldLabel>Hours (+/−)</FieldLabel>
                        <TextInput type="number" step="0.25" value={logHours} onChange={(e) => setLogHours(e.target.value)} />
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
                        <div style={{ gridColumn: isUnpaidType ? "1 / 2" : undefined }}>
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
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                    <input type="checkbox" checked={cfgSickFrontloaded} onChange={(e) => setCfgSickFrontloaded(e.target.checked)} />
                    Frontload 40 hrs upfront (no accrual, no carryover required)
                  </label>
                </div>
                <div>
                  <FieldLabel>Sick carryover (hrs)</FieldLabel>
                  <TextInput type="number" step="0.25" value={cfgSickCarryover} onChange={(e) => setCfgSickCarryover(e.target.value)} />
                </div>
                <div>
                  <FieldLabel>Initial sick balance (hrs)</FieldLabel>
                  <TextInput type="number" step="0.25" value={cfgSickInitial} onChange={(e) => setCfgSickInitial(e.target.value)} />
                </div>

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
                  <FieldLabel>Working weeks/year</FieldLabel>
                  <Select value={cfgPtoWeeks} onChange={(e) => setCfgPtoWeeks(Number(e.target.value))} disabled={!cfgPtoActive}>
                    <option value={48}>48</option>
                    <option value={50}>50</option>
                    <option value={52}>52</option>
                  </Select>
                </div>
                <div>
                  <FieldLabel>PTO carryover (hrs)</FieldLabel>
                  <TextInput type="number" step="0.25" value={cfgPtoCarryover} onChange={(e) => setCfgPtoCarryover(e.target.value)} />
                </div>
                <div>
                  <FieldLabel>Initial PTO balance (hrs)</FieldLabel>
                  <TextInput type="number" step="0.25" value={cfgPtoInitial} onChange={(e) => setCfgPtoInitial(e.target.value)} />
                </div>
              </div>
              <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
                <button className="btn" onClick={saveSettings} disabled={cfgBusy} style={{ minWidth: 140 }}>
                  {cfgBusy ? "Saving…" : "Save settings"}
                </button>
              </div>
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
                          <Td>{fmtRange(e.start_date, e.end_date)}</Td>
                          <Td><TypePill type={e.entry_type} /></Td>
                          <Td align="right">{e.entry_type === "unpaid" ? `${Math.round(Number(e.hours))} day${Math.round(Number(e.hours)) !== 1 ? "s" : ""}` : `${e.entry_type.endsWith("_adjustment") && Number(e.hours) >= 0 ? "+" : ""}${fmtHours(Number(e.hours))}`}</Td>
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

function Card({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, background: "white", padding: 16, ...style }}>
      <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

function BalanceCard({ title, balance, accent, lines, balanceLabel = "available", onEdit, formatBalance = fmtHours }: {
  title: string; balance: number; accent: string; lines: Array<[string, string]>; balanceLabel?: string; onEdit?: () => void; formatBalance?: (n: number) => string;
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
      {lines.map(([k, v], i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginTop: 2 }}>
          <span className="subtle">{k}</span>
          <span style={{ fontWeight: 600 }}>{v}</span>
        </div>
      ))}
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

function Th({ children, align }: { children?: React.ReactNode; align?: "right" | "left" }) {
  return <th style={{ textAlign: align ?? "left", padding: "8px 8px", fontSize: 12, fontWeight: 800, color: "#6b7280" }}>{children}</th>;
}

function Td({ children, align, subtle }: { children?: React.ReactNode; align?: "right" | "left"; subtle?: boolean }) {
  return <td style={{ textAlign: align ?? "left", padding: "8px 8px", verticalAlign: "top", color: subtle ? "#6b7280" : undefined }}>{children}</td>;
}
