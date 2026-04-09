"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
// ─── Types ───────────────────────────────────────────────────────────────────

type Employee = {
  id: string;
  legal_first_name: string;
  legal_middle_name: string | null;
  legal_last_name: string;
  nicknames: string[] | null;
  rate_type: string | null;
  rate: number | null;
  is_active: boolean;
};

type ClockEntry = {
  id: string;
  employee_id: string;
  session_date: string; // YYYY-MM-DD
  clocked_in_at: string | null;
  clocked_out_at: string | null;
};

// ─── Pay period helpers ───────────────────────────────────────────────────────

// Bi-weekly anchor: 2026-03-30 (Monday)
const ANCHOR_MS = Date.UTC(2026, 2, 30); // month is 0-indexed
const MS_PER_DAY = 86_400_000;
const MS_PER_PERIOD = 14 * MS_PER_DAY;

function getPeriodIndex(date: Date): number {
  const utcDate = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((utcDate - ANCHOR_MS) / MS_PER_PERIOD);
}

function getPeriodStart(index: number): Date {
  return new Date(ANCHOR_MS + index * MS_PER_PERIOD);
}

/** Returns the 10 Mon–Fri dates for a given period start (UTC midnight dates). */
function getWorkingDays(periodStart: Date): Date[] {
  const days: Date[] = [];
  const base = periodStart.getTime();
  for (let week = 0; week < 2; week++) {
    for (let d = 0; d < 5; d++) {
      days.push(new Date(base + (week * 7 + d) * MS_PER_DAY));
    }
  }
  return days;
}

function toDateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatPeriodLabel(periodStart: Date): string {
  const end = new Date(periodStart.getTime() + 13 * MS_PER_DAY);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" });
  return `${fmt(periodStart)} – ${fmt(end)}`;
}

const DAY_ABBRS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Mon", "Tue", "Wed", "Thu", "Fri"];

// ─── Formatting helpers ───────────────────────────────────────────────────────

function minsToHHMM(totalMins: number): string {
  if (totalMins <= 0) return "--";
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

function minsToDecimalHours(totalMins: number): number {
  return totalMins / 60;
}

function getDisplayName(emp: Employee): string {
  const nick = Array.isArray(emp.nicknames) && emp.nicknames.length > 0 ? emp.nicknames[0] : null;
  const first = nick ?? emp.legal_first_name;
  return `${first} ${emp.legal_last_name}`;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function TimesheetsPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [entries, setEntries] = useState<ClockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [periodIndex, setPeriodIndex] = useState(() => getPeriodIndex(new Date()));

  const periodStart = useMemo(() => getPeriodStart(periodIndex), [periodIndex]);
  const workingDays = useMemo(() => getWorkingDays(periodStart), [periodStart]);
  const dateStrs = useMemo(() => workingDays.map(toDateStr), [workingDays]);

  // Fetch employees once
  useEffect(() => {
    supabase
      .from("hr_employees")
      .select("id, legal_first_name, legal_middle_name, legal_last_name, nicknames, rate_type, rate, is_active")
      .eq("is_active", true)
      .order("legal_first_name")
      .then(({ data }) => setEmployees((data as Employee[]) ?? []));
  }, []);

  // Fetch clock entries for the current period
  useEffect(() => {
    setLoading(true);
    const start = dateStrs[0];
    const end = dateStrs[dateStrs.length - 1];
    supabase
      .from("clock_entries")
      .select("id, employee_id, session_date, clocked_in_at, clocked_out_at")
      .gte("session_date", start)
      .lte("session_date", end)
      .not("clocked_in_at", "is", null)
      .not("clocked_out_at", "is", null)
      .then(({ data }) => {
        setEntries((data as ClockEntry[]) ?? []);
        setLoading(false);
      });
  }, [dateStrs]);

  // Build map: employeeId → dateStr → paid minutes
  const minuteMap = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const e of entries) {
      if (!e.clocked_in_at || !e.clocked_out_at) continue;
      const mins = Math.round(
        (new Date(e.clocked_out_at).getTime() - new Date(e.clocked_in_at).getTime()) / 60_000
      );
      if (mins <= 0) continue;
      if (!map.has(e.employee_id)) map.set(e.employee_id, new Map());
      const dayMap = map.get(e.employee_id)!;
      dayMap.set(e.session_date, (dayMap.get(e.session_date) ?? 0) + mins);
    }
    return map;
  }, [entries]);

  // Only show employees who have at least one entry this period
  const activeEmployees = useMemo(() => {
    return employees.filter((emp) => minuteMap.has(emp.id));
  }, [employees, minuteMap]);

  const anyHourly = useMemo(
    () => activeEmployees.some((e) => e.rate_type === "hourly" && e.rate),
    [activeEmployees]
  );

  const cell = (style: React.CSSProperties) => ({
    padding: "8px 10px",
    borderRight: "1px solid #e5e7eb",
    borderBottom: "1px solid #e5e7eb",
    fontSize: 13,
    whiteSpace: "nowrap" as const,
    ...style,
  });

  return (
    <div style={{ padding: "24px 32px", fontFamily: "system-ui, sans-serif" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
          <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Timesheets</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={() => setPeriodIndex((i) => i - 1)}
              style={{ padding: "5px 12px", borderRadius: 8, border: "1.5px solid #e5e7eb", background: "white", cursor: "pointer", fontWeight: 700, fontSize: 14 }}
            >
              ‹
            </button>
            <span style={{ fontWeight: 700, fontSize: 15, minWidth: 140, textAlign: "center" }}>
              {formatPeriodLabel(periodStart)}
            </span>
            <button
              onClick={() => setPeriodIndex((i) => i + 1)}
              style={{ padding: "5px 12px", borderRadius: 8, border: "1.5px solid #e5e7eb", background: "white", cursor: "pointer", fontWeight: 700, fontSize: 14 }}
            >
              ›
            </button>
            <button
              onClick={() => setPeriodIndex(getPeriodIndex(new Date()))}
              style={{ padding: "5px 12px", borderRadius: 8, border: "1.5px solid #e5e7eb", background: "white", cursor: "pointer", fontSize: 13, color: "#6b7280" }}
            >
              Current
            </button>
          </div>
        </div>

        {loading ? (
          <div style={{ color: "#6b7280", padding: 20 }}>Loading…</div>
        ) : activeEmployees.length === 0 ? (
          <div style={{ color: "#6b7280", padding: 20 }}>No clock entries found for this pay period.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", background: "white", border: "1.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden", minWidth: "max-content" }}>
              <thead>
                {/* Week labels row */}
                <tr>
                  <th style={{ ...cell({ background: "#f9fafb", fontWeight: 800, textAlign: "left", minWidth: 160, position: "sticky", left: 0, zIndex: 2 }), borderBottom: "1px solid #e5e7eb" }}>
                  </th>
                  <th colSpan={5} style={cell({ background: "#f0f9ff", fontWeight: 700, textAlign: "center", color: "#0369a1", fontSize: 12 })}>
                    Week 1 · {workingDays[0].toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" })} – {workingDays[4].toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" })}
                  </th>
                  <th colSpan={5} style={cell({ background: "#f0fdf4", fontWeight: 700, textAlign: "center", color: "#15803d", fontSize: 12 })}>
                    Week 2 · {workingDays[5].toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" })} – {workingDays[9].toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" })}
                  </th>
                  <th style={cell({ background: "#f9fafb", fontWeight: 800, textAlign: "center" })}></th>
                  {anyHourly && (
                    <>
                      <th style={cell({ background: "#fdf2f8", fontWeight: 800, textAlign: "center" })}></th>
                      <th style={cell({ background: "#fdf2f8", fontWeight: 800, textAlign: "center", borderRight: "none" })}></th>
                    </>
                  )}
                </tr>
                {/* Day headers row */}
                <tr>
                  <th style={cell({ background: "#f9fafb", fontWeight: 800, textAlign: "left", position: "sticky", left: 0, zIndex: 2, fontSize: 13 })}>
                    Employee
                  </th>
                  {workingDays.map((d, i) => (
                    <th key={i} style={cell({
                      background: i < 5 ? "#f0f9ff" : "#f0fdf4",
                      fontWeight: 700,
                      textAlign: "center",
                      color: i < 5 ? "#0369a1" : "#15803d",
                      minWidth: 72,
                    })}>
                      <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.75 }}>{DAY_ABBRS[i]}</div>
                      <div style={{ fontSize: 13 }}>
                        {d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" })}
                      </div>
                    </th>
                  ))}
                  <th style={cell({ background: "#f9fafb", fontWeight: 800, textAlign: "center", minWidth: 80 })}>
                    Total
                  </th>
                  {anyHourly && (
                    <>
                      <th style={cell({ background: "#fdf2f8", fontWeight: 800, textAlign: "center", minWidth: 72, color: "#9d174d" })}>
                        Rate
                      </th>
                      <th style={cell({ background: "#fdf2f8", fontWeight: 800, textAlign: "center", minWidth: 90, color: "#9d174d", borderRight: "none" })}>
                        Est. Pay
                      </th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {activeEmployees.map((emp, rowIdx) => {
                  const dayMap = minuteMap.get(emp.id);
                  const dayMins = dateStrs.map((ds) => dayMap?.get(ds) ?? 0);
                  const totalMins = dayMins.reduce((s, m) => s + m, 0);
                  const totalHours = minsToDecimalHours(totalMins);
                  const isHourly = emp.rate_type === "hourly" && typeof emp.rate === "number";
                  const pay = isHourly ? totalHours * emp.rate! : null;

                  return (
                    <tr key={emp.id} style={{ background: rowIdx % 2 === 0 ? "white" : "#fafafa" }}>
                      {/* Name */}
                      <td style={cell({
                        fontWeight: 700,
                        position: "sticky",
                        left: 0,
                        background: rowIdx % 2 === 0 ? "white" : "#fafafa",
                        zIndex: 1,
                        color: "#111827",
                      })}>
                        {getDisplayName(emp)}
                      </td>

                      {/* Day cells */}
                      {dayMins.map((mins, i) => (
                        <td key={i} style={cell({ textAlign: "center", padding: "6px 8px" })}>
                          {mins > 0 ? (
                            <span style={{
                              display: "inline-block",
                              background: i < 5 ? "#dcfce7" : "#d1fae5",
                              color: "#15803d",
                              borderRadius: 8,
                              padding: "4px 10px",
                              fontWeight: 700,
                              fontSize: 13,
                              minWidth: 48,
                            }}>
                              {minsToHHMM(mins)}
                            </span>
                          ) : (
                            <span style={{ color: "#d1d5db", fontSize: 13 }}>--</span>
                          )}
                        </td>
                      ))}

                      {/* Total */}
                      <td style={cell({ textAlign: "center", fontWeight: 800, fontSize: 14, color: totalMins > 0 ? "#111827" : "#d1d5db" })}>
                        {minsToHHMM(totalMins)}
                      </td>

                      {/* Rate + Pay */}
                      {anyHourly && (
                        <>
                          <td style={cell({ textAlign: "center", color: isHourly ? "#9d174d" : "#d1d5db", fontWeight: 600 })}>
                            {isHourly ? `$${emp.rate!.toFixed(2)}/hr` : "--"}
                          </td>
                          <td style={cell({ textAlign: "center", fontWeight: 700, color: pay != null ? "#9d174d" : "#d1d5db", borderRight: "none" })}>
                            {pay != null ? `$${pay.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "--"}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}

                {/* Totals footer */}
                <tr style={{ background: "#f9fafb", borderTop: "2px solid #e5e7eb" }}>
                  <td style={cell({ fontWeight: 800, position: "sticky", left: 0, background: "#f9fafb", zIndex: 1, color: "#374151" })}>
                    Total
                  </td>
                  {dateStrs.map((ds, i) => {
                    const dayTotal = activeEmployees.reduce((s, emp) => {
                      return s + (minuteMap.get(emp.id)?.get(ds) ?? 0);
                    }, 0);
                    return (
                      <td key={i} style={cell({ textAlign: "center", fontWeight: 700, color: dayTotal > 0 ? "#374151" : "#d1d5db", fontSize: 12 })}>
                        {minsToHHMM(dayTotal)}
                      </td>
                    );
                  })}
                  <td style={cell({ textAlign: "center", fontWeight: 800, color: "#111827" })}>
                    {minsToHHMM(
                      activeEmployees.reduce((s, emp) => {
                        const dayMap = minuteMap.get(emp.id);
                        return s + dateStrs.reduce((ds, d) => ds + (dayMap?.get(d) ?? 0), 0);
                      }, 0)
                    )}
                  </td>
                  {anyHourly && (
                    <>
                      <td style={cell({ borderRight: "none" })} colSpan={2}></td>
                    </>
                  )}
                </tr>
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
