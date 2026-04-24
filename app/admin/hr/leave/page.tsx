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
  start_date: string; // YYYY-MM-DD
};

type LeaveBalanceRow = {
  id: string;
  employee_id: string;
  year: number;
  pto_active: boolean;
  pto_plan_hours: number; // 0 | 24 | 32 | 40
  pto_weeks: number; // 48 | 50 | 52
  sick_frontloaded: boolean;
  sick_annual_cap: number;
  pto_initial_balance: number;
  sick_initial_balance: number;
};

type LeaveEntryType = "sick_paid" | "pto" | "unpaid" | "sick_adjustment" | "pto_adjustment";

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

type ClockEntryRow = {
  employee_id: string;
  session_date: string;
  clocked_in_at: string | null;
  clocked_out_at: string | null;
};

const PROBATION_DAYS = 90;

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
  // 1 decimal unless whole number
  const r = Math.round(h * 10) / 10;
  return Number.isInteger(r) ? `${r}` : r.toFixed(1);
}

// Sum clocked hours for an employee, optionally filtered to year [start, end] inclusive.
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

// Default empty-balance shape used before admin saves a row
function defaultBalance(employeeId: string, year: number): LeaveBalanceRow {
  return {
    id: "",
    employee_id: employeeId,
    year,
    pto_active: false,
    pto_plan_hours: 0,
    pto_weeks: 48,
    sick_frontloaded: false,
    sick_annual_cap: 40,
    pto_initial_balance: 0,
    sick_initial_balance: 0,
  };
}

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

  // Log-leave form state
  const [logType, setLogType] = useState<LeaveEntryType>("sick_paid");
  const [logStart, setLogStart] = useState<string>(todayYmd());
  const [logEnd, setLogEnd] = useState<string>(todayYmd());
  const [logHours, setLogHours] = useState<string>("8");
  const [logNotes, setLogNotes] = useState<string>("");
  const [logBusy, setLogBusy] = useState(false);

  // Config edit state (mirrors balance row)
  const [cfgPtoActive, setCfgPtoActive] = useState(false);
  const [cfgPtoPlan, setCfgPtoPlan] = useState<number>(0);
  const [cfgPtoWeeks, setCfgPtoWeeks] = useState<number>(48);
  const [cfgSickFrontloaded, setCfgSickFrontloaded] = useState(false);
  const [cfgSickInitial, setCfgSickInitial] = useState<string>("0");
  const [cfgPtoInitial, setCfgPtoInitial] = useState<string>("0");
  const [cfgBusy, setCfgBusy] = useState(false);

  // ── Load profile and employees ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setMeLoading(true);
      try {
        const p = await fetchMyProfile();
        if (cancelled) return;
        setMe(p);
      } catch {
        if (!cancelled) setMe(null);
      } finally {
        if (!cancelled) setMeLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("hr_employees")
        .select("id, legal_first_name, legal_middle_name, legal_last_name, nicknames, is_active, start_date")
        .order("legal_last_name", { ascending: true })
        .order("legal_first_name", { ascending: true });
      if (cancelled) return;
      if (error) {
        setError(error.message);
        return;
      }
      const rows = (data ?? []) as EmployeeRow[];
      setEmployees(rows);
      if (!selectedEmployeeId && rows.length > 0) {
        setSelectedEmployeeId(rows.find((r) => r.is_active)?.id ?? rows[0].id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load balance + entries + clock entries when employee/year changes ─────
  useEffect(() => {
    if (!selectedEmployeeId) {
      setBalance(null);
      setEntries([]);
      setClockEntries([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const yearStart = `${year}-01-01`;
        const yearEnd = `${year}-12-31`;

        const [balRes, entriesRes, clockRes] = await Promise.all([
          supabase
            .from("hr_leave_balances")
            .select("*")
            .eq("employee_id", selectedEmployeeId)
            .eq("year", year)
            .maybeSingle(),
          supabase
            .from("hr_leave_entries")
            .select("*")
            .eq("employee_id", selectedEmployeeId)
            .gte("start_date", yearStart)
            .lte("start_date", yearEnd)
            .order("start_date", { ascending: false }),
          supabase
            .from("clock_entries")
            .select("employee_id, session_date, clocked_in_at, clocked_out_at")
            .eq("employee_id", selectedEmployeeId)
            .gte("session_date", yearStart)
            .lte("session_date", yearEnd),
        ]);

        if (cancelled) return;

        if (balRes.error) throw balRes.error;
        if (entriesRes.error) throw entriesRes.error;
        if (clockRes.error) throw clockRes.error;

        const b = (balRes.data as LeaveBalanceRow | null) ?? defaultBalance(selectedEmployeeId, year);
        setBalance(b);
        setEntries((entriesRes.data ?? []) as LeaveEntryRow[]);
        setClockEntries((clockRes.data ?? []) as ClockEntryRow[]);

        // Sync config form with loaded balance
        setCfgPtoActive(b.pto_active);
        setCfgPtoPlan(b.pto_plan_hours);
        setCfgPtoWeeks(b.pto_weeks);
        setCfgSickFrontloaded(b.sick_frontloaded);
        setCfgSickInitial(String(b.sick_initial_balance ?? 0));
        setCfgPtoInitial(String(b.pto_initial_balance ?? 0));
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load leave data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedEmployeeId, year]);

  // ── Derived values ────────────────────────────────────────────────────────
  const selectedEmployee = useMemo(
    () => employees.find((e) => e.id === selectedEmployeeId) ?? null,
    [employees, selectedEmployeeId],
  );

  const probation = useMemo(() => {
    if (!selectedEmployee?.start_date) return null;
    const end = addDaysYmd(selectedEmployee.start_date, PROBATION_DAYS);
    const passed = todayYmd() >= end;
    return { endDate: end, passed };
  }, [selectedEmployee]);

  const hoursWorkedYtd = useMemo(
    () => sumClockedHours(clockEntries, `${year}-01-01`, `${year}-12-31`),
    [clockEntries, year],
  );

  const sickCalc = useMemo(() => {
    const cap = balance?.sick_annual_cap ?? 40;
    const accruedRaw = balance?.sick_frontloaded ? cap : Math.floor(hoursWorkedYtd / 30);
    const accrued = Math.min(accruedRaw, cap);
    const used = entries.filter((e) => e.entry_type === "sick_paid").reduce((s, e) => s + Number(e.hours), 0);
    const adjustments = entries
      .filter((e) => e.entry_type === "sick_adjustment")
      .reduce((s, e) => s + Number(e.hours), 0);
    const initial = Number(balance?.sick_initial_balance ?? 0);
    const balanceVal = initial + accrued + adjustments - used;
    return { initial, accrued, accruedRaw, cap, used, adjustments, balance: balanceVal };
  }, [balance, hoursWorkedYtd, entries]);

  const ptoCalc = useMemo(() => {
    const active = balance?.pto_active ?? false;
    const plan = balance?.pto_plan_hours ?? 0;
    const weeks = balance?.pto_weeks ?? 48;
    let accrued = 0;
    let accrualRate = 0;
    if (active && plan > 0) {
      // 1 PTO hour per (weeks * 40 / plan) hours worked
      accrualRate = (weeks * 40) / plan;
      accrued = Math.min(Math.floor(hoursWorkedYtd / accrualRate), plan);
    }
    const used = entries.filter((e) => e.entry_type === "pto").reduce((s, e) => s + Number(e.hours), 0);
    const adjustments = entries
      .filter((e) => e.entry_type === "pto_adjustment")
      .reduce((s, e) => s + Number(e.hours), 0);
    const initial = Number(balance?.pto_initial_balance ?? 0);
    const balanceVal = initial + accrued + adjustments - used;
    return { active, plan, weeks, accrualRate, initial, accrued, used, adjustments, balance: balanceVal };
  }, [balance, hoursWorkedYtd, entries]);

  const unpaidUsed = useMemo(
    () => entries.filter((e) => e.entry_type === "unpaid").reduce((s, e) => s + Number(e.hours), 0),
    [entries],
  );

  // ── Actions ───────────────────────────────────────────────────────────────

  async function ensureBalanceRow(): Promise<LeaveBalanceRow> {
    if (balance && balance.id) return balance;
    const insertRow = {
      employee_id: selectedEmployeeId,
      year,
      pto_active: cfgPtoActive,
      pto_plan_hours: cfgPtoPlan,
      pto_weeks: cfgPtoWeeks,
      sick_frontloaded: cfgSickFrontloaded,
      sick_annual_cap: 40,
      pto_initial_balance: Number(cfgPtoInitial) || 0,
      sick_initial_balance: Number(cfgSickInitial) || 0,
      created_by: me?.id ?? null,
      updated_by: me?.id ?? null,
    };
    const { data, error } = await supabase
      .from("hr_leave_balances")
      .insert(insertRow)
      .select("*")
      .single();
    if (error) throw error;
    const row = data as LeaveBalanceRow;
    setBalance(row);
    return row;
  }

  async function saveConfig() {
    if (!selectedEmployeeId) return;
    setCfgBusy(true);
    try {
      const patch = {
        employee_id: selectedEmployeeId,
        year,
        pto_active: cfgPtoActive,
        pto_plan_hours: cfgPtoPlan,
        pto_weeks: cfgPtoWeeks,
        sick_frontloaded: cfgSickFrontloaded,
        sick_annual_cap: 40,
        pto_initial_balance: Number(cfgPtoInitial) || 0,
        sick_initial_balance: Number(cfgSickInitial) || 0,
        updated_by: me?.id ?? null,
      };
      const { data, error } = await supabase
        .from("hr_leave_balances")
        .upsert({ ...patch, created_by: me?.id ?? null }, { onConflict: "employee_id,year" })
        .select("*")
        .single();
      if (error) throw error;
      setBalance(data as LeaveBalanceRow);
    } catch (e: unknown) {
      await alert(`Could not save config: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setCfgBusy(false);
    }
  }

  async function logLeave() {
    if (!selectedEmployeeId) return;
    const hours = Number(logHours);
    if (!Number.isFinite(hours) || hours === 0) {
      await alert("Hours must be a non-zero number. Use a negative value to remove an adjustment.");
      return;
    }
    if (logType !== "sick_adjustment" && logType !== "pto_adjustment" && hours < 0) {
      await alert("Usage entries cannot be negative. Use an adjustment type to remove hours.");
      return;
    }
    if (logEnd < logStart) {
      await alert("End date must be on or after start date.");
      return;
    }

    // Soft probation warning for paid sick
    if (logType === "sick_paid" && probation && !probation.passed) {
      const ok = await confirm(
        `This employee is still in probation (ends ${fmtYmd(probation.endDate)}). Paid sick leave is only meant to be used after probation. Log anyway?`,
      );
      if (!ok) return;
    }

    setLogBusy(true);
    try {
      // Make sure a balance row exists so config defaults are persisted
      await ensureBalanceRow();

      const { error } = await supabase.from("hr_leave_entries").insert({
        employee_id: selectedEmployeeId,
        entry_type: logType,
        start_date: logStart,
        end_date: logEnd,
        hours,
        notes: logNotes.trim() || null,
        created_by: me?.id ?? null,
      });
      if (error) throw error;

      // Reset form (keep type/dates for fast repeat entry)
      setLogHours("8");
      setLogNotes("");

      // Reload entries
      const yearStart = `${year}-01-01`;
      const yearEnd = `${year}-12-31`;
      const { data, error: reErr } = await supabase
        .from("hr_leave_entries")
        .select("*")
        .eq("employee_id", selectedEmployeeId)
        .gte("start_date", yearStart)
        .lte("start_date", yearEnd)
        .order("start_date", { ascending: false });
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

  // ── Access control ────────────────────────────────────────────────────────
  if (meLoading) {
    return (
      <div className="container" style={{ padding: 24 }}>
        Loading…
      </div>
    );
  }
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

      <div className="row-between" style={{ marginBottom: 16, alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Leave</h1>
          <div className="subtle" style={{ marginTop: 4 }}>
            Track sick and PTO balances, log usage, and adjust totals.
          </div>
        </div>
        <div className="row" style={{ gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ minWidth: 240 }}>
            <FieldLabel>Employee</FieldLabel>
            <Select
              value={selectedEmployeeId}
              onChange={(e) => setSelectedEmployeeId(e.target.value)}
              disabled={employees.length === 0}
            >
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {getDisplayName(e)}
                  {e.is_active ? "" : " (inactive)"}
                </option>
              ))}
            </Select>
          </div>
          <div style={{ width: 110 }}>
            <FieldLabel>Year</FieldLabel>
            <Select value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[year - 1, year, year + 1].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: 12,
            borderRadius: 12,
            background: "#fef2f2",
            color: "#b91c1c",
            border: "1px solid #fecaca",
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {!selectedEmployee ? (
        <div className="subtle">Select an employee to begin.</div>
      ) : (
        <>
          {/* Summary cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
              marginBottom: 16,
            }}
          >
            <BalanceCard
              title="Sick (paid)"
              balance={sickCalc.balance}
              accent="#e6178d"
              lines={[
                ["Initial", fmtHours(sickCalc.initial)],
                [
                  balance?.sick_frontloaded ? "Frontloaded" : "Accrued YTD",
                  `${fmtHours(sickCalc.accrued)}${
                    !balance?.sick_frontloaded && sickCalc.accruedRaw > sickCalc.cap ? ` (capped at ${sickCalc.cap})` : ""
                  }`,
                ],
                ["Used", `−${fmtHours(sickCalc.used)}`],
                ...(sickCalc.adjustments !== 0 ? ([["Adjustments", `${sickCalc.adjustments >= 0 ? "+" : ""}${fmtHours(sickCalc.adjustments)}`]] as Array<[string, string]>) : []),
              ]}
            />
            <BalanceCard
              title={`PTO${ptoCalc.active ? ` (${ptoCalc.plan}h plan, ${ptoCalc.weeks}w)` : " (inactive)"}`}
              balance={ptoCalc.balance}
              accent="#0ea5e9"
              lines={
                ptoCalc.active
                  ? [
                      ["Initial", fmtHours(ptoCalc.initial)],
                      [
                        "Accrued YTD",
                        `${fmtHours(ptoCalc.accrued)}${
                          ptoCalc.accrualRate > 0
                            ? ` (1h per ${fmtHours(ptoCalc.accrualRate)}h worked, cap ${ptoCalc.plan})`
                            : ""
                        }`,
                      ],
                      ["Used", `−${fmtHours(ptoCalc.used)}`],
                      ...(ptoCalc.adjustments !== 0
                        ? ([["Adjustments", `${ptoCalc.adjustments >= 0 ? "+" : ""}${fmtHours(ptoCalc.adjustments)}`]] as Array<[string, string]>)
                        : []),
                    ]
                  : [["", "PTO not activated for this employee/year."]]
              }
            />
            <BalanceCard
              title="Unpaid time off"
              balance={unpaidUsed}
              accent="#6b7280"
              balanceLabel="hrs used YTD"
              lines={[["", "Logged for record-keeping; no balance is tracked."]]}
            />
            <BalanceCard
              title="Hours worked YTD"
              balance={hoursWorkedYtd}
              accent="#16a34a"
              balanceLabel="hrs (timesheet)"
              lines={[
                ["Probation ends", probation ? fmtYmd(probation.endDate) : "—"],
                ["Probation status", probation ? (probation.passed ? "Passed" : "Active") : "—"],
              ]}
            />
          </div>

          {/* Two-column: Log Leave + Config */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
              gap: 16,
              marginBottom: 16,
            }}
          >
            <Card title="Log leave / adjustment">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <FieldLabel>Type</FieldLabel>
                  <Select value={logType} onChange={(e) => setLogType(e.target.value as LeaveEntryType)}>
                    <option value="sick_paid">Sick — paid</option>
                    <option value="pto">PTO</option>
                    <option value="unpaid">Unpaid time off</option>
                    <option value="sick_adjustment">Adjust SICK total (+/−)</option>
                    <option value="pto_adjustment">Adjust PTO total (+/−)</option>
                  </Select>
                </div>
                <div>
                  <FieldLabel>Hours</FieldLabel>
                  <TextInput
                    type="number"
                    step="0.25"
                    value={logHours}
                    onChange={(e) => setLogHours(e.target.value)}
                  />
                </div>
                <div>
                  <FieldLabel>Start date</FieldLabel>
                  <TextInput
                    type="date"
                    value={logStart}
                    onChange={(e) => {
                      setLogStart(e.target.value);
                      if (logEnd < e.target.value) setLogEnd(e.target.value);
                    }}
                  />
                </div>
                <div>
                  <FieldLabel>End date</FieldLabel>
                  <TextInput type="date" value={logEnd} onChange={(e) => setLogEnd(e.target.value)} />
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <FieldLabel>Notes (optional)</FieldLabel>
                  <TextInput
                    type="text"
                    value={logNotes}
                    onChange={(e) => setLogNotes(e.target.value)}
                    placeholder="Reason, ticket #, etc."
                  />
                </div>
              </div>
              <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
                <button
                  className="btn btn-primary"
                  onClick={logLeave}
                  disabled={logBusy || !selectedEmployeeId}
                  style={{ minWidth: 140 }}
                >
                  {logBusy ? "Saving…" : "Save entry"}
                </button>
              </div>
              <div className="subtle" style={{ marginTop: 8, fontSize: 12 }}>
                Adjustment hours can be negative to reduce a balance. Usage hours must be positive.
              </div>
            </Card>

            <Card title={`Config — ${year}`}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ gridColumn: "1 / -1", fontSize: 13, fontWeight: 800, color: "#111827" }}>
                  Sick
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={cfgSickFrontloaded}
                      onChange={(e) => setCfgSickFrontloaded(e.target.checked)}
                    />
                    Frontload 40 hrs upfront (skip accrual, no carryover required)
                  </label>
                </div>
                <div>
                  <FieldLabel>Initial sick balance (hrs)</FieldLabel>
                  <TextInput
                    type="number"
                    step="0.25"
                    value={cfgSickInitial}
                    onChange={(e) => setCfgSickInitial(e.target.value)}
                  />
                </div>
                <div />

                <div style={{ gridColumn: "1 / -1", fontSize: 13, fontWeight: 800, color: "#111827", marginTop: 6 }}>
                  PTO
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={cfgPtoActive}
                      onChange={(e) => setCfgPtoActive(e.target.checked)}
                    />
                    PTO is activated for this employee
                  </label>
                </div>
                <div>
                  <FieldLabel>Plan (hrs/year)</FieldLabel>
                  <Select
                    value={cfgPtoPlan}
                    onChange={(e) => setCfgPtoPlan(Number(e.target.value))}
                    disabled={!cfgPtoActive}
                  >
                    <option value={0}>—</option>
                    <option value={24}>24</option>
                    <option value={32}>32</option>
                    <option value={40}>40</option>
                  </Select>
                </div>
                <div>
                  <FieldLabel>Working weeks/year</FieldLabel>
                  <Select
                    value={cfgPtoWeeks}
                    onChange={(e) => setCfgPtoWeeks(Number(e.target.value))}
                    disabled={!cfgPtoActive}
                  >
                    <option value={48}>48</option>
                    <option value={50}>50</option>
                    <option value={52}>52</option>
                  </Select>
                </div>
                <div>
                  <FieldLabel>Initial PTO balance (hrs)</FieldLabel>
                  <TextInput
                    type="number"
                    step="0.25"
                    value={cfgPtoInitial}
                    onChange={(e) => setCfgPtoInitial(e.target.value)}
                  />
                </div>
              </div>
              <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
                <button className="btn" onClick={saveConfig} disabled={cfgBusy} style={{ minWidth: 140 }}>
                  {cfgBusy ? "Saving…" : "Save config"}
                </button>
              </div>
            </Card>
          </div>

          {/* Entries table */}
          <Card title={`Entries — ${year}`}>
            {loading ? (
              <div className="subtle">Loading…</div>
            ) : entries.length === 0 ? (
              <div className="subtle">No entries logged for {year}.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
                      <Th>Date(s)</Th>
                      <Th>Type</Th>
                      <Th align="right">Hours</Th>
                      <Th>Notes</Th>
                      <Th align="right">Logged</Th>
                      <Th align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr key={e.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                        <Td>{fmtRange(e.start_date, e.end_date)}</Td>
                        <Td>
                          <TypePill type={e.entry_type} />
                        </Td>
                        <Td align="right">
                          {e.entry_type.endsWith("_adjustment") && Number(e.hours) >= 0 ? "+" : ""}
                          {fmtHours(Number(e.hours))}
                        </Td>
                        <Td>{e.notes || <span className="subtle">—</span>}</Td>
                        <Td align="right" subtle>
                          {new Date(e.created_at).toLocaleDateString()}
                        </Td>
                        <Td align="right">
                          <button className="btn" onClick={() => deleteEntry(e.id)} style={{ padding: "4px 10px", fontSize: 12 }}>
                            Delete
                          </button>
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

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 16,
        background: "white",
        padding: 16,
      }}
    >
      <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

function BalanceCard({
  title,
  balance,
  accent,
  lines,
  balanceLabel = "hrs available",
}: {
  title: string;
  balance: number;
  accent: string;
  lines: Array<[string, string]>;
  balanceLabel?: string;
}) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 16,
        background: "white",
        padding: 16,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 800, color: accent, textTransform: "uppercase", letterSpacing: 0.4 }}>
        {title}
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, marginTop: 4 }}>{fmtHours(balance)}</div>
      <div className="subtle" style={{ fontSize: 12, marginBottom: 10 }}>
        {balanceLabel}
      </div>
      {lines.map(([k, v], i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginTop: 2 }}>
          <span className="subtle">{k}</span>
          <span style={{ fontWeight: 600 }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function TypePill({ type }: { type: LeaveEntryType }) {
  const cfg: Record<LeaveEntryType, { label: string; bg: string; fg: string }> = {
    sick_paid: { label: "Sick (paid)", bg: "rgba(230,23,141,0.08)", fg: "#e6178d" },
    pto: { label: "PTO", bg: "rgba(14,165,233,0.08)", fg: "#0369a1" },
    unpaid: { label: "Unpaid", bg: "#f3f4f6", fg: "#374151" },
    sick_adjustment: { label: "Sick adj.", bg: "rgba(230,23,141,0.05)", fg: "#9d174d" },
    pto_adjustment: { label: "PTO adj.", bg: "rgba(14,165,233,0.05)", fg: "#0c4a6e" },
  };
  const c = cfg[type];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {c.label}
    </span>
  );
}

function Th({ children, align }: { children?: React.ReactNode; align?: "right" | "left" }) {
  return (
    <th style={{ textAlign: align ?? "left", padding: "8px 8px", fontSize: 12, fontWeight: 800, color: "#6b7280" }}>
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  subtle,
}: {
  children?: React.ReactNode;
  align?: "right" | "left";
  subtle?: boolean;
}) {
  return (
    <td
      style={{
        textAlign: align ?? "left",
        padding: "8px 8px",
        verticalAlign: "top",
        color: subtle ? "#6b7280" : undefined,
      }}
    >
      {children}
    </td>
  );
}
