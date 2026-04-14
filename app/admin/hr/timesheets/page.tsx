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
  session_date: string;
  session_start: string; // HH:MM:SS scheduled
  session_end: string;
  clocked_in_at: string | null;
  clocked_out_at: string | null;
  notes_in: string | null;
  notes_out: string | null;
  notes_in_resolved: boolean;
  notes_out_resolved: boolean;
};

type ShiftBlock = {
  id: string;
  start_time: string;
  end_time: string;
  block_type: string;
  label: string | null;
  room_name: string;
};

type ModalTarget = {
  employeeId: string;
  employeeName: string;
  dateStr: string;
  dateLabel: string;
};

// ─── Pay period helpers ───────────────────────────────────────────────────────

const ANCHOR_MS = Date.UTC(2026, 2, 30);
const MS_PER_DAY = 86_400_000;
const MS_PER_PERIOD = 14 * MS_PER_DAY;

function getPeriodIndex(date: Date): number {
  const utc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((utc - ANCHOR_MS) / MS_PER_PERIOD);
}
function getPeriodStart(index: number): Date {
  // Use UTC noon so that local date methods in any timezone return the correct calendar date
  return new Date(ANCHOR_MS + index * MS_PER_PERIOD + 12 * 3600000);
}
function getWorkingDays(periodStart: Date): Date[] {
  const days: Date[] = [];
  const base = periodStart.getTime();
  for (let w = 0; w < 2; w++)
    for (let d = 0; d < 5; d++)
      days.push(new Date(base + (w * 7 + d) * MS_PER_DAY));
  return days;
}
function toDateStr(d: Date): string {
  // Use local date methods so dates match the employee's local session_date
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function formatPeriodLabel(s: Date): string {
  const e = new Date(s.getTime() + 13 * MS_PER_DAY);
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
  return `${fmt(s)} – ${fmt(e)}`;
}
const DAY_ABBRS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Mon", "Tue", "Wed", "Thu", "Fri"];

// ─── Formatting helpers ───────────────────────────────────────────────────────

function minsToHHMM(m: number): string {
  if (m < 1) return "--";
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}
function getDisplayName(e: Employee): string {
  const nick = Array.isArray(e.nicknames) && e.nicknames.length > 0 ? e.nicknames[0] : null;
  return `${nick ?? e.legal_first_name} ${e.legal_last_name}`;
}
function isoToTimeInput(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function isoToDisplayTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}
function buildISO(dateStr: string, timeHHMM: string): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, m] = timeHHMM.split(":").map(Number);
  return new Date(y, mo - 1, d, h, m, 0).toISOString();
}
function entryPaidMins(e: ClockEntry): number {
  if (!e.clocked_in_at || !e.clocked_out_at) return 0;
  return Math.ceil((new Date(e.clocked_out_at).getTime() - new Date(e.clocked_in_at).getTime()) / 60_000);
}
function getMondayOfWeek(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const dow = d.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}
function getDayOfWeek(dateStr: string): number {
  const dow = new Date(dateStr + "T12:00:00").getDay();
  return dow === 0 ? 7 : dow;
}
function fmtScheduled(hms: string): string {
  const [h, m] = hms.split(":").map(Number);
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const ampm = h < 12 ? "AM" : "PM";
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// ─── Session Detail Modal ─────────────────────────────────────────────────────

function SessionModal({
  target,
  entries: initialEntries,
  onClose,
  onEntriesChanged,
}: {
  target: ModalTarget;
  entries: ClockEntry[];
  onClose: () => void;
  onEntriesChanged: (updated: ClockEntry[]) => void;
}) {
  const [entries, setEntries] = useState<ClockEntry[]>(initialEntries);
  const [editTimes, setEditTimes] = useState<Record<string, { in: string; out: string }>>(() => {
    const map: Record<string, { in: string; out: string }> = {};
    for (const e of initialEntries) {
      map[e.id] = {
        in: e.clocked_in_at ? isoToTimeInput(e.clocked_in_at) : "",
        out: e.clocked_out_at ? isoToTimeInput(e.clocked_out_at) : "",
      };
    }
    return map;
  });
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [shiftBlocks, setShiftBlocks] = useState<Record<string, ShiftBlock[]>>({});
  const [shiftLoading, setShiftLoading] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<Set<string>>(new Set());

  const totalMins = entries.reduce((s, e) => s + entryPaidMins(e), 0);

  async function toggleShiftDetails(entry: ClockEntry) {
    const key = entry.id;
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); return next; }
      next.add(key);
      return next;
    });
    if (shiftBlocks[key] || shiftLoading.has(key)) return;

    setShiftLoading((prev) => new Set(prev).add(key));
    const monday = getMondayOfWeek(entry.session_date);
    const dow = getDayOfWeek(entry.session_date);

    const { data: sched } = await supabase
      .from("schedules")
      .select("id")
      .eq("week_start", monday)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sched) { setShiftLoading((prev) => { const n = new Set(prev); n.delete(key); return n; }); return; }

    // Fetch ALL blocks for this employee+day (including lunch_break separators)
    const { data: allBlocks } = await supabase
      .from("schedule_blocks")
      .select("id, start_time, end_time, block_type, label, room_id, schedule_rooms(name)")
      .eq("schedule_id", sched.id)
      .eq("employee_id", entry.employee_id)
      .eq("day_of_week", dow)
      .order("start_time");

    // Group into sessions using the same logic as the clock page
    type RawBlock = { id: string; start_time: string; end_time: string; block_type: string; label: string | null; room_id: string; schedule_rooms: { name: string } | { name: string }[] | null };
    const sorted = [...((allBlocks ?? []) as unknown as RawBlock[])].sort(
      (a, b) => a.start_time.localeCompare(b.start_time)
    );
    const sessions: { start: string; end: string; blocks: RawBlock[] }[] = [];
    let cur: RawBlock[] = [];
    for (const b of sorted) {
      if (b.block_type === "lunch_break") {
        if (cur.length > 0) {
          sessions.push({ start: cur[0].start_time, end: cur[cur.length - 1].end_time, blocks: cur });
          cur = [];
        }
      } else {
        cur.push(b);
      }
    }
    if (cur.length > 0) {
      sessions.push({ start: cur[0].start_time, end: cur[cur.length - 1].end_time, blocks: cur });
    }

    // Find the session matching this clock entry
    const matchedSession = sessions.find((s) => s.start === entry.session_start) ?? null;
    const sessionBlocks = matchedSession ? matchedSession.blocks : [];

    const mapped: ShiftBlock[] = sessionBlocks.map((b) => ({
      id: b.id,
      start_time: b.start_time,
      end_time: b.end_time,
      block_type: b.block_type,
      label: b.label,
      room_name: (Array.isArray(b.schedule_rooms) ? b.schedule_rooms[0]?.name : b.schedule_rooms?.name) ?? "—",
    }));
    setShiftBlocks((prev) => ({ ...prev, [key]: mapped }));
    setShiftLoading((prev) => { const n = new Set(prev); n.delete(key); return n; });
  }

  async function saveTime(entryId: string, field: "in" | "out") {
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return;
    const timeVal = editTimes[entryId]?.[field];
    if (!timeVal) return;
    const col = field === "in" ? "clocked_in_at" : "clocked_out_at";
    // Use the LOCAL date from the original ISO so the rebuilt timestamp matches what was displayed
    const originalIso = field === "in" ? entry.clocked_in_at : entry.clocked_out_at;
    let baseDateStr = entry.session_date;
    if (originalIso) {
      const orig = new Date(originalIso);
      baseDateStr = `${orig.getFullYear()}-${String(orig.getMonth() + 1).padStart(2, "0")}-${String(orig.getDate()).padStart(2, "0")}`;
    }
    const iso = buildISO(baseDateStr, timeVal);
    setSaving((prev) => new Set(prev).add(entryId + field));
    const { error } = await supabase.from("clock_entries").update({ [col]: iso }).eq("id", entryId);
    setSaving((prev) => { const n = new Set(prev); n.delete(entryId + field); return n; });
    if (!error) {
      const updated = entries.map((e) =>
        e.id === entryId ? { ...e, [col]: iso } : e
      );
      setEntries(updated);
      onEntriesChanged(updated);
    }
  }

  async function toggleResolved(entryId: string, field: "in" | "out") {
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return;
    const col = field === "in" ? "notes_in_resolved" : "notes_out_resolved";
    const newVal = !(entry as any)[col];
    const { error } = await supabase.from("clock_entries").update({ [col]: newVal }).eq("id", entryId);
    if (!error) {
      const updated = entries.map((e) =>
        e.id === entryId ? { ...e, [col]: newVal } : e
      );
      setEntries(updated);
      onEntriesChanged(updated);
    }
  }

  const blockTypeColor = (t: string) =>
    t === "break" ? "#22c55e" : t === "lunch_break" ? "#f97316" : "#6366f1";
  const blockTypeLabel = (t: string) =>
    t === "break" ? "Break" : t === "lunch_break" ? "Lunch" : "Shift";

  return (
    <>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 300 }} onClick={onClose} />
      <div
        style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
          zIndex: 301, background: "white", borderRadius: 16,
          boxShadow: "0 8px 40px rgba(0,0,0,0.2)",
          width: "min(580px, 95vw)", maxHeight: "92vh",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{target.employeeName}</div>
            <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>{target.dateLabel}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#9ca3af", padding: 4, lineHeight: 1 }}>✕</button>
        </div>

        {/* Sessions */}
        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
          {entries.length === 0 && (
            <div style={{ color: "#6b7280", fontSize: 14 }}>No clock entries for this day.</div>
          )}
          {entries.map((entry, idx) => {
            const mins = entryPaidMins(entry);
            const inTime = editTimes[entry.id]?.in ?? "";
            const outTime = editTimes[entry.id]?.out ?? "";
            const inSaving = saving.has(entry.id + "in");
            const outSaving = saving.has(entry.id + "out");
            const expanded = expandedSessions.has(entry.id);
            const blocks = shiftBlocks[entry.id] ?? [];
            const blocksLoading = shiftLoading.has(entry.id);
            const hasNoteIn = !!entry.notes_in;
            const hasNoteOut = !!entry.notes_out;

            return (
              <div key={entry.id} style={{ border: "1.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
                {/* Session header */}
                <div style={{ padding: "10px 14px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "#374151" }}>
                    Session {idx + 1} — scheduled {fmtScheduled(entry.session_start)} – {fmtScheduled(entry.session_end)}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#6366f1" }}>
                    {mins > 0 ? minsToHHMM(mins) : "—"}
                  </div>
                </div>

                <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                  {/* Clock In */}
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <span style={{ fontSize: 16, lineHeight: "32px" }}>🟢</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", minWidth: 60 }}>Clock In</span>
                        {entry.clocked_in_at ? (
                          <>
                            <input
                              type="time"
                              value={inTime}
                              onChange={(e) => setEditTimes((prev) => ({ ...prev, [entry.id]: { ...prev[entry.id], in: e.target.value } }))}
                              onBlur={() => saveTime(entry.id, "in")}
                              style={{ padding: "3px 8px", borderRadius: 7, border: "1.5px solid #d1d5db", fontSize: 13, fontWeight: 600 }}
                            />
                            <span style={{ fontSize: 12, color: "#9ca3af" }}>
                              {inSaving ? "saving…" : `(${isoToDisplayTime(entry.clocked_in_at)})`}
                            </span>
                          </>
                        ) : (
                          <span style={{ fontSize: 13, color: "#9ca3af" }}>Not clocked in</span>
                        )}
                      </div>
                      {hasNoteIn && (
                        <div style={{ marginTop: 6, padding: "8px 10px", borderRadius: 8, background: entry.notes_in_resolved ? "#f0fdf4" : "#fffbeb", border: `1px solid ${entry.notes_in_resolved ? "#bbf7d0" : "#fde68a"}`, display: "flex", alignItems: "flex-start", gap: 8 }}>
                          <span style={{ fontSize: 13 }}>📝</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, color: "#374151" }}>{entry.notes_in}</div>
                          </div>
                          <button
                            onClick={() => toggleResolved(entry.id, "in")}
                            style={{
                              flexShrink: 0, padding: "3px 10px", borderRadius: 6, border: "1.5px solid",
                              borderColor: entry.notes_in_resolved ? "#86efac" : "#fbbf24",
                              background: entry.notes_in_resolved ? "#dcfce7" : "#fef3c7",
                              color: entry.notes_in_resolved ? "#15803d" : "#92400e",
                              fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
                            }}
                          >
                            {entry.notes_in_resolved ? "✓ Resolved" : "Resolve"}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Clock Out */}
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <span style={{ fontSize: 16, lineHeight: "32px" }}>🔴</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", minWidth: 60 }}>Clock Out</span>
                        {entry.clocked_out_at ? (
                          <>
                            <input
                              type="time"
                              value={outTime}
                              onChange={(e) => setEditTimes((prev) => ({ ...prev, [entry.id]: { ...prev[entry.id], out: e.target.value } }))}
                              onBlur={() => saveTime(entry.id, "out")}
                              style={{ padding: "3px 8px", borderRadius: 7, border: "1.5px solid #d1d5db", fontSize: 13, fontWeight: 600 }}
                            />
                            <span style={{ fontSize: 12, color: "#9ca3af" }}>
                              {outSaving ? "saving…" : `(${isoToDisplayTime(entry.clocked_out_at)})`}
                            </span>
                          </>
                        ) : (
                          <span style={{ fontSize: 13, color: "#9ca3af" }}>Not clocked out</span>
                        )}
                      </div>
                      {hasNoteOut && (
                        <div style={{ marginTop: 6, padding: "8px 10px", borderRadius: 8, background: entry.notes_out_resolved ? "#f0fdf4" : "#fffbeb", border: `1px solid ${entry.notes_out_resolved ? "#bbf7d0" : "#fde68a"}`, display: "flex", alignItems: "flex-start", gap: 8 }}>
                          <span style={{ fontSize: 13 }}>📝</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, color: "#374151" }}>{entry.notes_out}</div>
                          </div>
                          <button
                            onClick={() => toggleResolved(entry.id, "out")}
                            style={{
                              flexShrink: 0, padding: "3px 10px", borderRadius: 6, border: "1.5px solid",
                              borderColor: entry.notes_out_resolved ? "#86efac" : "#fbbf24",
                              background: entry.notes_out_resolved ? "#dcfce7" : "#fef3c7",
                              color: entry.notes_out_resolved ? "#15803d" : "#92400e",
                              fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
                            }}
                          >
                            {entry.notes_out_resolved ? "✓ Resolved" : "Resolve"}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Shift details toggle */}
                  <button
                    onClick={() => toggleShiftDetails(entry)}
                    style={{ alignSelf: "flex-start", background: "none", border: "1px solid #e5e7eb", borderRadius: 7, padding: "4px 12px", fontSize: 12, fontWeight: 700, color: "#6b7280", cursor: "pointer" }}
                  >
                    {expanded ? "▲" : "▼"} Shift Details
                  </button>

                  {expanded && (
                    <div style={{ background: "#f9fafb", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                      {blocksLoading ? (
                        <div style={{ fontSize: 12, color: "#9ca3af" }}>Loading…</div>
                      ) : blocks.length === 0 ? (
                        <div style={{ fontSize: 12, color: "#9ca3af" }}>No published schedule blocks found for this session.</div>
                      ) : blocks.map((b) => (
                        <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                          <div style={{ width: 3, height: 22, borderRadius: 2, background: blockTypeColor(b.block_type), flexShrink: 0 }} />
                          <span style={{ fontWeight: 700, color: "#111827" }}>{fmtScheduled(b.start_time)} – {fmtScheduled(b.end_time)}</span>
                          <span style={{ color: "#6b7280" }}>· {b.room_name}</span>
                          <span style={{ color: blockTypeColor(b.block_type), fontWeight: 600, fontSize: 12 }}>{blockTypeLabel(b.block_type)}</span>
                          {b.label && b.label !== "Unassigned" && <span style={{ color: "#9ca3af", fontSize: 12 }}>· {b.label}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer total */}
        <div style={{ padding: "12px 20px", borderTop: "1.5px solid #e5e7eb", background: "#f9fafb", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#374151" }}>Total paid time</span>
          <span style={{ fontSize: 17, fontWeight: 900, color: "#111827" }}>{minsToHHMM(totalMins)}</span>
        </div>
      </div>
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TimesheetsPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [entries, setEntries] = useState<ClockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [periodIndex, setPeriodIndex] = useState(() => getPeriodIndex(new Date()));
  const [modal, setModal] = useState<ModalTarget | null>(null);

  const periodStart = useMemo(() => getPeriodStart(periodIndex), [periodIndex]);
  const workingDays = useMemo(() => getWorkingDays(periodStart), [periodStart]);
  const dateStrs = useMemo(() => workingDays.map(toDateStr), [workingDays]);

  useEffect(() => {
    supabase
      .from("hr_employees")
      .select("id, legal_first_name, legal_middle_name, legal_last_name, nicknames, rate_type, rate, is_active")
      .eq("is_active", true)
      .order("legal_first_name")
      .then(({ data }) => setEmployees((data as Employee[]) ?? []));
  }, []);

  useEffect(() => {
    setLoading(true);
    supabase
      .from("clock_entries")
      .select("id, employee_id, session_date, session_start, session_end, clocked_in_at, clocked_out_at, notes_in, notes_out, notes_in_resolved, notes_out_resolved")
      .gte("session_date", dateStrs[0])
      .lte("session_date", dateStrs[dateStrs.length - 1])
      .not("clocked_in_at", "is", null)
      .not("clocked_out_at", "is", null)
      .then(({ data }) => {
        setEntries((data as ClockEntry[]) ?? []);
        setLoading(false);
      });
  }, [dateStrs]);

  // employeeId → dateStr → entries[]
  const entriesByEmpDay = useMemo(() => {
    const map = new Map<string, Map<string, ClockEntry[]>>();
    for (const e of entries) {
      if (!map.has(e.employee_id)) map.set(e.employee_id, new Map());
      const dayMap = map.get(e.employee_id)!;
      if (!dayMap.has(e.session_date)) dayMap.set(e.session_date, []);
      dayMap.get(e.session_date)!.push(e);
    }
    return map;
  }, [entries]);

  // employeeId → dateStr → paid minutes
  const minuteMap = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const [empId, dayMap] of entriesByEmpDay) {
      map.set(empId, new Map());
      for (const [dateStr, dayEntries] of dayMap) {
        const mins = dayEntries.reduce((s, e) => s + entryPaidMins(e), 0);
        map.get(empId)!.set(dateStr, mins);
      }
    }
    return map;
  }, [entriesByEmpDay]);

  // employeeId → dateStr → "green" | "yellow"
  const cellColor = useMemo(() => {
    const map = new Map<string, Map<string, "green" | "yellow">>();
    for (const [empId, dayMap] of entriesByEmpDay) {
      map.set(empId, new Map());
      for (const [dateStr, dayEntries] of dayMap) {
        const hasUnresolved = dayEntries.some(
          (e) =>
            (e.notes_in && !e.notes_in_resolved) ||
            (e.notes_out && !e.notes_out_resolved)
        );
        map.get(empId)!.set(dateStr, hasUnresolved ? "yellow" : "green");
      }
    }
    return map;
  }, [entriesByEmpDay]);

  const activeEmployees = useMemo(
    () => employees.filter((e) => minuteMap.has(e.id)),
    [employees, minuteMap]
  );

  const anyHourly = useMemo(
    () => activeEmployees.some((e) => e.rate_type === "hourly" && e.rate),
    [activeEmployees]
  );

  // When modal edits entries, patch the local state
  function handleEntriesChanged(empId: string, dateStr: string, updated: ClockEntry[]) {
    setEntries((prev) => {
      const unchanged = prev.filter((e) => !(e.employee_id === empId && e.session_date === dateStr));
      return [...unchanged, ...updated];
    });
  }

  const cell = (style: React.CSSProperties): React.CSSProperties => ({
    padding: "8px 10px",
    borderRight: "1px solid #e5e7eb",
    borderBottom: "1px solid #e5e7eb",
    fontSize: 13,
    whiteSpace: "nowrap",
    ...style,
  });

  const modalEntries = modal
    ? (entriesByEmpDay.get(modal.employeeId)?.get(modal.dateStr) ?? [])
    : [];

  return (
    <div style={{ padding: "24px 32px", fontFamily: "system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Timesheets</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => setPeriodIndex((i) => i - 1)} style={{ padding: "5px 12px", borderRadius: 8, border: "1.5px solid #e5e7eb", background: "white", cursor: "pointer", fontWeight: 700, fontSize: 14 }}>‹</button>
          <span style={{ fontWeight: 700, fontSize: 15, minWidth: 140, textAlign: "center" }}>{formatPeriodLabel(periodStart)}</span>
          <button onClick={() => setPeriodIndex((i) => i + 1)} style={{ padding: "5px 12px", borderRadius: 8, border: "1.5px solid #e5e7eb", background: "white", cursor: "pointer", fontWeight: 700, fontSize: 14 }}>›</button>
          <button onClick={() => setPeriodIndex(getPeriodIndex(new Date()))} style={{ padding: "5px 12px", borderRadius: 8, border: "1.5px solid #e5e7eb", background: "white", cursor: "pointer", fontSize: 13, color: "#6b7280" }}>Current</button>
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
              {/* Week labels */}
              <tr>
                <th style={cell({ background: "#f9fafb", fontWeight: 800, textAlign: "left", minWidth: 160, position: "sticky", left: 0, zIndex: 2 })} />
                <th colSpan={5} style={cell({ background: "#f0f9ff", fontWeight: 700, textAlign: "center", color: "#0369a1", fontSize: 12 })}>
                  Week 1 · {workingDays[0].toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" })} – {workingDays[4].toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" })}
                </th>
                <th colSpan={5} style={cell({ background: "#f0fdf4", fontWeight: 700, textAlign: "center", color: "#15803d", fontSize: 12 })}>
                  Week 2 · {workingDays[5].toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" })} – {workingDays[9].toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" })}
                </th>
                <th style={cell({ background: "#f9fafb" })} />
                {anyHourly && <><th style={cell({ background: "#fdf2f8" })} /><th style={cell({ background: "#fdf2f8", borderRight: "none" })} /></>}
              </tr>
              {/* Day headers */}
              <tr>
                <th style={cell({ background: "#f9fafb", fontWeight: 800, textAlign: "left", position: "sticky", left: 0, zIndex: 2 })}>Employee</th>
                {workingDays.map((d, i) => (
                  <th key={i} style={cell({ background: i < 5 ? "#f0f9ff" : "#f0fdf4", fontWeight: 700, textAlign: "center", color: i < 5 ? "#0369a1" : "#15803d", minWidth: 72 })}>
                    <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.75 }}>{DAY_ABBRS[i]}</div>
                    <div style={{ fontSize: 13 }}>{d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" })}</div>
                  </th>
                ))}
                <th style={cell({ background: "#f9fafb", fontWeight: 800, textAlign: "center", minWidth: 80 })}>Total</th>
                {anyHourly && (
                  <>
                    <th style={cell({ background: "#fdf2f8", fontWeight: 800, textAlign: "center", minWidth: 72, color: "#9d174d" })}>Rate</th>
                    <th style={cell({ background: "#fdf2f8", fontWeight: 800, textAlign: "center", minWidth: 90, color: "#9d174d", borderRight: "none" })}>Est. Pay</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {activeEmployees.map((emp, rowIdx) => {
                const dayMap = minuteMap.get(emp.id);
                const colorMap = cellColor.get(emp.id);
                const dayMins = dateStrs.map((ds) => dayMap?.get(ds) ?? 0);
                const totalMins = dayMins.reduce((s, m) => s + m, 0);
                const isHourly = emp.rate_type === "hourly" && typeof emp.rate === "number";
                const pay = isHourly ? (totalMins / 60) * emp.rate! : null;
                const rowBg = rowIdx % 2 === 0 ? "white" : "#fafafa";

                return (
                  <tr key={emp.id} style={{ background: rowBg }}>
                    <td style={cell({ fontWeight: 700, position: "sticky", left: 0, background: rowBg, zIndex: 1, color: "#111827" })}>
                      {getDisplayName(emp)}
                    </td>
                    {dateStrs.map((ds, i) => {
                      const mins = dayMins[i];
                      const color = colorMap?.get(ds);
                      const isYellow = color === "yellow";
                      const isGreen = color === "green";
                      // Show button whenever entries exist, even if computed mins ≤ 0 (e.g. after editing times)
                      const hasData = !!color;

                      const dateLabel = `${DAY_ABBRS[i]} ${workingDays[i].toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}`;

                      return (
                        <td key={i} style={cell({ textAlign: "center", padding: "6px 8px" })}>
                          {hasData ? (
                            <button
                              onClick={() => setModal({ employeeId: emp.id, employeeName: getDisplayName(emp), dateStr: ds, dateLabel })}
                              style={{
                                display: "inline-block",
                                background: isYellow ? "#fef3c7" : "#dcfce7",
                                color: isYellow ? "#92400e" : "#15803d",
                                border: `1.5px solid ${isYellow ? "#fde68a" : "#86efac"}`,
                                borderRadius: 8, padding: "4px 10px",
                                fontWeight: 700, fontSize: 13, minWidth: 48,
                                cursor: "pointer",
                              }}
                            >
                              {minsToHHMM(mins)}
                            </button>
                          ) : (
                            <span style={{ color: "#d1d5db", fontSize: 13 }}>--</span>
                          )}
                        </td>
                      );
                    })}
                    <td style={cell({ textAlign: "center", fontWeight: 800, fontSize: 14, color: totalMins > 0 ? "#111827" : "#d1d5db" })}>
                      {minsToHHMM(totalMins)}
                    </td>
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

              {/* Footer totals */}
              <tr style={{ background: "#f9fafb", borderTop: "2px solid #e5e7eb" }}>
                <td style={cell({ fontWeight: 800, position: "sticky", left: 0, background: "#f9fafb", zIndex: 1, color: "#374151" })}>Total</td>
                {dateStrs.map((ds, i) => {
                  const dayTotal = activeEmployees.reduce((s, emp) => s + (minuteMap.get(emp.id)?.get(ds) ?? 0), 0);
                  return (
                    <td key={i} style={cell({ textAlign: "center", fontWeight: 700, color: dayTotal > 0 ? "#374151" : "#d1d5db", fontSize: 12 })}>
                      {minsToHHMM(dayTotal)}
                    </td>
                  );
                })}
                <td style={cell({ textAlign: "center", fontWeight: 800, color: "#111827" })}>
                  {minsToHHMM(activeEmployees.reduce((s, emp) => s + dateStrs.reduce((ds, d) => ds + (minuteMap.get(emp.id)?.get(d) ?? 0), 0), 0))}
                </td>
                {anyHourly && <td style={cell({ borderRight: "none" })} colSpan={2} />}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Day detail modal */}
      {modal && (
        <SessionModal
          target={modal}
          entries={modalEntries}
          onClose={() => setModal(null)}
          onEntriesChanged={(updated) => handleEntriesChanged(modal.employeeId, modal.dateStr, updated)}
        />
      )}
    </div>
  );
}
