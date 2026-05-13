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
  is_active: boolean;
};

type ClockEntry = {
  id: string;
  employee_id: string;
  session_date: string;
  session_start: string;
  session_end: string;
  clocked_in_at: string | null;
  clocked_out_at: string | null;
  auto_clocked_out: boolean;
  notes_in: string | null;
  notes_out: string | null;
  notes_in_resolved: boolean;
  notes_out_resolved: boolean;
};

type LeaveEntry = {
  id: string;
  employee_id: string;
  entry_type: string;
  start_date: string;
  end_date: string;
  hours: number;
  notes: string | null;
};

type ClockEditRequest = {
  id: string;
  clock_entry_id: string;
  employee_id: string;
  field: "clocked_in_at" | "clocked_out_at";
  old_value: string | null;
  new_value: string;
  reason: string;
  status: "pending" | "approved" | "denied";
  created_at: string;
  employee_name?: string;
  session_date?: string;
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

type LeaveModalTarget = {
  employeeName: string;
  dateLabel: string;
  entries: LeaveEntry[];
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
function minsToHDecimal(m: number): string {
  if (m <= 0) return "--";
  const h = Math.floor(m / 60);
  const min = m % 60;
  return min === 0 ? `${h}h` : `${h}h ${min}m`;
}
function getDisplayName(e: Employee): string {
  const nick = Array.isArray(e.nicknames) && e.nicknames.length > 0 ? e.nicknames[0] : null;
  return `${nick ?? e.legal_first_name} ${e.legal_last_name}`;
}
function isoToTimeInput(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
function isoToDisplayTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
}
function buildISO(dateStr: string, timeHHMMSS: string): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const parts = timeHHMMSS.split(":").map(Number);
  const [h, m, s] = [parts[0], parts[1], parts[2] ?? 0];
  return new Date(y, mo - 1, d, h, m, s).toISOString();
}
function entryPaidMins(e: ClockEntry): number {
  if (!e.clocked_in_at || !e.clocked_out_at) return 0;
  const totalSeconds = Math.round((new Date(e.clocked_out_at).getTime() - new Date(e.clocked_in_at).getTime()) / 1000);
  return Math.round(totalSeconds / 60);
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
function leaveTypeLabel(t: string): string {
  return t === "sick_paid" ? "Sick" : t === "pto" ? "PTO" : t === "unpaid" ? "Unpaid" : t;
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
  const [entries, setEntries] = useState<ClockEntry[]>(
    [...initialEntries].sort((a, b) => a.session_start.localeCompare(b.session_start))
  );
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
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  // Add-session form
  const [adding, setAdding] = useState(false);
  const [addInTime, setAddInTime] = useState("");
  const [addOutTime, setAddOutTime] = useState("");
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Full-day schedule panel
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [fullDayBlocks, setFullDayBlocks] = useState<ShiftBlock[] | null>(null);
  const [fullDayLoading, setFullDayLoading] = useState(false);

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

    const { data: allBlocks } = await supabase
      .from("schedule_blocks")
      .select("id, start_time, end_time, block_type, label, room_id, schedule_rooms(name)")
      .eq("schedule_id", sched.id)
      .eq("employee_id", entry.employee_id)
      .eq("day_of_week", dow)
      .order("start_time");

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

  async function clockOutNow(entryId: string) {
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return;
    setSaving((prev) => new Set(prev).add(entryId + "out"));
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    // Past day: auto clock-out at 11:59:59 PM on session date. Today: use current time.
    const iso = entry.session_date < todayStr
      ? buildISO(entry.session_date, "23:59:59")
      : new Date().toISOString();
    const { error } = await supabase.from("clock_entries").update({ clocked_out_at: iso, auto_clocked_out: true }).eq("id", entryId);
    setSaving((prev) => { const n = new Set(prev); n.delete(entryId + "out"); return n; });
    if (!error) {
      const updated = entries.map((e) =>
        e.id === entryId ? { ...e, clocked_out_at: iso, auto_clocked_out: true } : e
      );
      setEntries(updated);
      setEditTimes((prev) => ({ ...prev, [entryId]: { ...prev[entryId], out: isoToTimeInput(iso) } }));
      onEntriesChanged(updated);
    }
  }

  async function saveTime(entryId: string, field: "in" | "out") {
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return;
    const timeVal = editTimes[entryId]?.[field];
    if (!timeVal) return;
    const col = field === "in" ? "clocked_in_at" : "clocked_out_at";
    const originalIso = field === "in" ? entry.clocked_in_at : entry.clocked_out_at;
    let baseDateStr = entry.session_date;
    if (originalIso) {
      const orig = new Date(originalIso);
      baseDateStr = `${orig.getFullYear()}-${String(orig.getMonth() + 1).padStart(2, "0")}-${String(orig.getDate()).padStart(2, "0")}`;
    }
    const iso = buildISO(baseDateStr, timeVal);
    if (originalIso && isoToTimeInput(originalIso) === timeVal) return;
    setSaving((prev) => new Set(prev).add(entryId + field));
    const updatePayload: Record<string, unknown> = { [col]: iso };
    if (field === "out") updatePayload.auto_clocked_out = false;
    const { error } = await supabase.from("clock_entries").update(updatePayload).eq("id", entryId);
    setSaving((prev) => { const n = new Set(prev); n.delete(entryId + field); return n; });
    if (!error) {
      const updated = entries.map((e) =>
        e.id === entryId
          ? { ...e, [col]: iso, ...(field === "out" ? { auto_clocked_out: false } : {}) }
          : e
      );
      setEntries(updated);
      onEntriesChanged(updated);
    }
  }

  async function toggleResolved(entryId: string, field: "in" | "out") {
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return;
    const col = field === "in" ? "notes_in_resolved" : "notes_out_resolved";
    const newVal = !(entry as Record<string, unknown>)[col];
    const { error } = await supabase.from("clock_entries").update({ [col]: newVal }).eq("id", entryId);
    if (!error) {
      const updated = entries.map((e) =>
        e.id === entryId ? { ...e, [col]: newVal } : e
      );
      setEntries(updated);
      onEntriesChanged(updated);
    }
  }

  async function deleteEntry(entryId: string) {
    setDeleting((prev) => new Set(prev).add(entryId));
    const { error } = await supabase.from("clock_entries").delete().eq("id", entryId);
    setDeleting((prev) => { const n = new Set(prev); n.delete(entryId); return n; });
    if (!error) {
      const updated = entries.filter((e) => e.id !== entryId);
      setEntries(updated);
      onEntriesChanged(updated);
    }
    setConfirmDelete(null);
  }

  async function toggleFullDaySchedule() {
    setScheduleOpen((v) => !v);
    if (fullDayBlocks !== null || fullDayLoading) return;
    setFullDayLoading(true);
    const monday = getMondayOfWeek(target.dateStr);
    const dow = getDayOfWeek(target.dateStr);

    const { data: sched } = await supabase
      .from("schedules")
      .select("id")
      .eq("week_start", monday)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sched) {
      setFullDayBlocks([]);
      setFullDayLoading(false);
      return;
    }

    const { data: allBlocks } = await supabase
      .from("schedule_blocks")
      .select("id, start_time, end_time, block_type, label, room_id, schedule_rooms(name)")
      .eq("schedule_id", sched.id)
      .eq("employee_id", target.employeeId)
      .eq("day_of_week", dow)
      .order("start_time");

    type RawBlock = { id: string; start_time: string; end_time: string; block_type: string; label: string | null; room_id: string; schedule_rooms: { name: string } | { name: string }[] | null };
    const mapped: ShiftBlock[] = ((allBlocks ?? []) as unknown as RawBlock[]).map((b) => ({
      id: b.id,
      start_time: b.start_time,
      end_time: b.end_time,
      block_type: b.block_type,
      label: b.label,
      room_name: (Array.isArray(b.schedule_rooms) ? b.schedule_rooms[0]?.name : b.schedule_rooms?.name) ?? "—",
    }));
    setFullDayBlocks(mapped);
    setFullDayLoading(false);
  }

  function openAddForm() {
    setAdding(true);
    setAddError(null);
    if (!addInTime) setAddInTime("09:00");
    if (!addOutTime) setAddOutTime("17:00");
  }

  function cancelAdd() {
    setAdding(false);
    setAddError(null);
  }

  async function saveNewSession() {
    setAddError(null);
    if (!addInTime || !addOutTime) {
      setAddError("Enter both clock-in and clock-out times.");
      return;
    }
    const inHHMMSS = addInTime.length === 5 ? `${addInTime}:00` : addInTime;
    const outHHMMSS = addOutTime.length === 5 ? `${addOutTime}:00` : addOutTime;
    if (outHHMMSS <= inHHMMSS) {
      setAddError("Clock-out must be after clock-in.");
      return;
    }
    setAddSaving(true);
    const inIso = buildISO(target.dateStr, inHHMMSS);
    const outIso = buildISO(target.dateStr, outHHMMSS);

    const { data, error } = await supabase
      .from("clock_entries")
      .insert({
        employee_id: target.employeeId,
        session_date: target.dateStr,
        session_start: inHHMMSS,
        session_end: outHHMMSS,
        clocked_in_at: inIso,
        clocked_out_at: outIso,
        auto_clocked_out: false,
      })
      .select("id, employee_id, session_date, session_start, session_end, clocked_in_at, clocked_out_at, auto_clocked_out, notes_in, notes_out, notes_in_resolved, notes_out_resolved")
      .single();

    setAddSaving(false);

    if (error || !data) {
      setAddError(error?.message ?? "Failed to add session.");
      return;
    }
    const newEntry = data as ClockEntry;
    const updated = [...entries, newEntry].sort((a, b) => a.session_start.localeCompare(b.session_start));
    setEntries(updated);
    setEditTimes((prev) => ({
      ...prev,
      [newEntry.id]: {
        in: isoToTimeInput(newEntry.clocked_in_at!),
        out: isoToTimeInput(newEntry.clocked_out_at!),
      },
    }));
    onEntriesChanged(updated);
    setAdding(false);
    setAddInTime("");
    setAddOutTime("");
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
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{target.employeeName}</div>
            <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>{target.dateLabel}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#9ca3af", padding: 4, lineHeight: 1 }}>✕</button>
        </div>

        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Action buttons */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={openAddForm}
              disabled={adding}
              style={{
                padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: adding ? "default" : "pointer",
                border: "1.5px solid #6366f1", background: adding ? "#eef2ff" : "#eef2ff", color: "#4338ca",
                opacity: adding ? 0.5 : 1,
              }}
            >
              + Add Session
            </button>
            <button
              onClick={toggleFullDaySchedule}
              style={{
                padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer",
                border: "1.5px solid #d1d5db", background: "white", color: "#374151",
              }}
            >
              {scheduleOpen ? "▲ Hide" : "▼ View"} Full Day Schedule
            </button>
          </div>

          {/* Add Session inline form */}
          {adding && (
            <div style={{ border: "1.5px solid #c7d2fe", background: "#eef2ff", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#3730a3" }}>New manual session</div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#4338ca" }}>
                  Clock In
                  <input
                    type="time"
                    step="1"
                    value={addInTime}
                    onChange={(e) => setAddInTime(e.target.value)}
                    style={{ padding: "4px 8px", borderRadius: 7, border: "1.5px solid #c7d2fe", fontSize: 13, fontWeight: 600 }}
                  />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#4338ca" }}>
                  Clock Out
                  <input
                    type="time"
                    step="1"
                    value={addOutTime}
                    onChange={(e) => setAddOutTime(e.target.value)}
                    style={{ padding: "4px 8px", borderRadius: 7, border: "1.5px solid #c7d2fe", fontSize: 13, fontWeight: 600 }}
                  />
                </label>
              </div>
              {addError && <div style={{ fontSize: 12, color: "#991b1b", fontWeight: 600 }}>{addError}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={saveNewSession}
                  disabled={addSaving}
                  style={{ padding: "5px 14px", borderRadius: 7, border: "1.5px solid #6366f1", background: "#6366f1", color: "white", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
                >
                  {addSaving ? "Adding…" : "Add"}
                </button>
                <button
                  onClick={cancelAdd}
                  disabled={addSaving}
                  style={{ padding: "5px 14px", borderRadius: 7, border: "1px solid #d1d5db", background: "white", color: "#6b7280", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Full Day Schedule panel */}
          {scheduleOpen && (
            <div style={{ border: "1.5px solid #e5e7eb", borderRadius: 12, padding: "12px 14px", background: "#f9fafb", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#374151" }}>Full Day Schedule</div>
              {fullDayLoading ? (
                <div style={{ fontSize: 12, color: "#9ca3af" }}>Loading…</div>
              ) : !fullDayBlocks || fullDayBlocks.length === 0 ? (
                <div style={{ fontSize: 12, color: "#9ca3af" }}>No published schedule blocks for this day.</div>
              ) : (
                fullDayBlocks.map((b) => (
                  <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                    <div style={{ width: 3, height: 22, borderRadius: 2, background: blockTypeColor(b.block_type), flexShrink: 0 }} />
                    <span style={{ fontWeight: 700, color: "#111827" }}>{fmtScheduled(b.start_time)} – {fmtScheduled(b.end_time)}</span>
                    <span style={{ color: "#6b7280" }}>· {b.room_name}</span>
                    <span style={{ color: blockTypeColor(b.block_type), fontWeight: 600, fontSize: 12 }}>{blockTypeLabel(b.block_type)}</span>
                    {b.label && b.label !== "Unassigned" && <span style={{ color: "#9ca3af", fontSize: 12 }}>· {b.label}</span>}
                  </div>
                ))
              )}
            </div>
          )}

          {entries.length === 0 && !adding && (
            <div style={{ color: "#6b7280", fontSize: 14, padding: "8px 0" }}>
              No timesheet entries for this person today.
            </div>
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
            const isOpen = !entry.clocked_out_at;

            return (
              <div key={entry.id} style={{ border: "1.5px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
                <div style={{ padding: "10px 14px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "#374151" }}>
                    Session {idx + 1} — scheduled {fmtScheduled(entry.session_start)} – {fmtScheduled(entry.session_end)}
                    {isOpen && <span style={{ marginLeft: 8, color: "#0369a1", fontWeight: 800, fontSize: 12 }}>● Currently clocked in</span>}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: isOpen ? "#0369a1" : "#6366f1" }}>
                    {isOpen ? "Active" : mins > 0 ? minsToHHMM(mins) : "—"}
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
                              step="1"
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
                              step="1"
                              value={outTime}
                              onChange={(e) => setEditTimes((prev) => ({ ...prev, [entry.id]: { ...prev[entry.id], out: e.target.value } }))}
                              onBlur={() => saveTime(entry.id, "out")}
                              style={{
                                padding: "3px 8px", borderRadius: 7, fontSize: 13, fontWeight: 600,
                                border: entry.auto_clocked_out ? "1.5px solid #fca5a5" : "1.5px solid #d1d5db",
                                background: entry.auto_clocked_out ? "#fee2e2" : undefined,
                                color: entry.auto_clocked_out ? "#991b1b" : undefined,
                              }}
                            />
                            <span
                              style={{ fontSize: 12, color: entry.auto_clocked_out ? "#991b1b" : "#9ca3af", fontWeight: entry.auto_clocked_out ? 700 : 400 }}
                              title={entry.auto_clocked_out ? `Auto clocked out on ${entry.session_date} — edit to correct` : undefined}
                            >
                              {outSaving ? "saving…" : entry.auto_clocked_out ? `⚠ Auto (${isoToDisplayTime(entry.clocked_out_at)})` : `(${isoToDisplayTime(entry.clocked_out_at)})`}
                            </span>
                          </>
                        ) : (
                          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 13, color: "#0369a1", fontWeight: 700 }}>Still clocked in</span>
                            <button
                              onClick={() => clockOutNow(entry.id)}
                              disabled={saving.has(entry.id + "out")}
                              style={{
                                padding: "4px 12px",
                                borderRadius: 7,
                                border: "1.5px solid #fca5a5",
                                background: "#fee2e2",
                                color: "#991b1b",
                                fontSize: 12,
                                fontWeight: 700,
                                cursor: saving.has(entry.id + "out") ? "default" : "pointer",
                              }}
                            >
                              {saving.has(entry.id + "out") ? "Clocking out…" : "Clock Out Now"}
                            </button>
                          </div>
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

                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <button
                      onClick={() => toggleShiftDetails(entry)}
                      style={{ background: "none", border: "1px solid #e5e7eb", borderRadius: 7, padding: "4px 12px", fontSize: 12, fontWeight: 700, color: "#6b7280", cursor: "pointer" }}
                    >
                      {expanded ? "▲" : "▼"} Shift Details
                    </button>
                    {confirmDelete === entry.id ? (
                      <>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "#991b1b" }}>Delete this session?</span>
                        <button
                          onClick={() => deleteEntry(entry.id)}
                          disabled={deleting.has(entry.id)}
                          style={{ padding: "4px 12px", borderRadius: 7, border: "1.5px solid #fca5a5", background: "#fee2e2", color: "#991b1b", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                        >
                          {deleting.has(entry.id) ? "Deleting…" : "Yes, Delete"}
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          style={{ padding: "4px 12px", borderRadius: 7, border: "1px solid #e5e7eb", background: "white", color: "#6b7280", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(entry.id)}
                        style={{ background: "none", border: "1px solid #fca5a5", borderRadius: 7, padding: "4px 12px", fontSize: 12, fontWeight: 700, color: "#991b1b", cursor: "pointer" }}
                      >
                        Delete
                      </button>
                    )}
                  </div>

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

        <div style={{ padding: "12px 20px", borderTop: "1.5px solid #e5e7eb", background: "#f9fafb", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#374151" }}>Total paid time</span>
          <span style={{ fontSize: 17, fontWeight: 900, color: "#111827" }}>{minsToHHMM(totalMins)}</span>
        </div>
      </div>
    </>
  );
}

// ─── Leave Detail Modal ───────────────────────────────────────────────────────

function LeaveModal({ target, onClose }: { target: LeaveModalTarget; onClose: () => void }) {
  return (
    <>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 300 }} onClick={onClose} />
      <div
        style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
          zIndex: 301, background: "white", borderRadius: 16,
          boxShadow: "0 8px 40px rgba(0,0,0,0.2)",
          width: "min(420px, 95vw)", maxHeight: "80vh", overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{target.employeeName}</div>
            <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>{target.dateLabel} — Leave</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#9ca3af", padding: 4, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
          {target.entries.map((e) => (
            <div key={e.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px" }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{leaveTypeLabel(e.entry_type)}</div>
              <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>
                {e.entry_type === "unpaid"
                  ? `${Math.round(Number(e.hours))} day${Math.round(Number(e.hours)) !== 1 ? "s" : ""}`
                  : `${Number(e.hours)}h`}
              </div>
              {e.notes && <div style={{ fontSize: 13, color: "#374151", marginTop: 4, fontStyle: "italic" }}>{e.notes}</div>}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── Clock Edit Requests Modal ────────────────────────────────────────────────

function EditRequestsModal({
  requests: initialRequests,
  onClose,
  onUpdate,
  onGoTo,
  onRefresh,
}: {
  requests: ClockEditRequest[];
  onClose: () => void;
  onUpdate: (reqId: string, entryId?: string, field?: string, newValue?: string) => void;
  onGoTo: (sessionDate: string) => void;
  onRefresh: () => void;
}) {
  const [requests, setRequests] = useState(initialRequests);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  // Sync when parent refreshes (e.g. after Refresh button)
  useEffect(() => { setRequests(initialRequests); }, [initialRequests]);

  async function approve(req: ClockEditRequest) {
    setBusy((p) => new Set(p).add(req.id));
    const updateFields: Record<string, unknown> = { [req.field]: req.new_value };
    if (req.field === "clocked_out_at") updateFields.auto_clocked_out = false;
    const { error: updateErr } = await supabase
      .from("clock_entries")
      .update(updateFields)
      .eq("id", req.clock_entry_id);
    if (!updateErr) {
      await supabase
        .from("clock_edit_requests")
        .update({ status: "approved", reviewed_at: new Date().toISOString() })
        .eq("id", req.id);
      onUpdate(req.id, req.clock_entry_id, req.field, req.new_value);
    }
    setBusy((p) => { const n = new Set(p); n.delete(req.id); return n; });
  }

  async function deny(req: ClockEditRequest) {
    setBusy((p) => new Set(p).add(req.id));
    await supabase
      .from("clock_edit_requests")
      .update({ status: "denied", reviewed_at: new Date().toISOString() })
      .eq("id", req.id);
    onUpdate(req.id);
    setBusy((p) => { const n = new Set(p); n.delete(req.id); return n; });
  }

  return (
    <>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 300 }} onClick={onClose} />
      <div
        style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
          zIndex: 301, background: "white", borderRadius: 16,
          boxShadow: "0 8px 40px rgba(0,0,0,0.2)",
          width: "min(560px, 95vw)", maxHeight: "88vh", overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>Employee Clock Edit Requests</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={onRefresh}
              style={{ padding: "4px 12px", borderRadius: 8, border: "1.5px solid #e5e7eb", background: "white", cursor: "pointer", fontSize: 13, color: "#6b7280", fontWeight: 600 }}
            >
              Refresh
            </button>
            <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#9ca3af", padding: 4, lineHeight: 1 }}>✕</button>
          </div>
        </div>
        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          {requests.length === 0 ? (
            <div style={{ color: "#6b7280", fontSize: 14 }}>No pending clock edit requests.</div>
          ) : requests.map((req) => {
            const isBusy = busy.has(req.id);
            const fieldLabel = req.field === "clocked_in_at" ? "Clock In" : "Clock Out";
            return (
              <div key={req.id} style={{ border: "1.5px solid #e5e7eb", borderRadius: 12, padding: "12px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 14 }}>{req.employee_name ?? req.employee_id}</div>
                    <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>
                      {req.session_date} · {fieldLabel}
                    </div>
                    <div style={{ fontSize: 13, marginTop: 4 }}>
                      <span style={{ color: "#6b7280", textDecoration: "line-through", marginRight: 6 }}>
                        {req.old_value ? isoToDisplayTime(req.old_value) : "—"}
                      </span>
                      →
                      <span style={{ marginLeft: 6, fontWeight: 700, color: "#111827" }}>{isoToDisplayTime(req.new_value)}</span>
                    </div>
                    <div style={{ fontSize: 13, color: "#374151", marginTop: 4, fontStyle: "italic" }}>{req.reason}</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                      {new Date(req.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
                    {req.session_date && (
                      <button
                        onClick={() => onGoTo(req.session_date!)}
                        style={{ padding: "6px 14px", borderRadius: 8, border: "1.5px solid #d1d5db", background: "white", color: "#374151", fontWeight: 700, fontSize: 13, cursor: "pointer" }}
                      >
                        Go to
                      </button>
                    )}
                    <button
                      onClick={() => approve(req)}
                      disabled={isBusy}
                      style={{ padding: "6px 14px", borderRadius: 8, border: "1.5px solid #86efac", background: "#dcfce7", color: "#15803d", fontWeight: 700, fontSize: 13, cursor: "pointer" }}
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => deny(req)}
                      disabled={isBusy}
                      style={{ padding: "6px 14px", borderRadius: 8, border: "1.5px solid #fca5a5", background: "#fee2e2", color: "#991b1b", fontWeight: 700, fontSize: 13, cursor: "pointer" }}
                    >
                      Deny
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TimesheetsPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [entries, setEntries] = useState<ClockEntry[]>([]);
  const [leaveEntries, setLeaveEntries] = useState<LeaveEntry[]>([]);
  const [editRequests, setEditRequests] = useState<ClockEditRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [periodIndex, setPeriodIndex] = useState(() => getPeriodIndex(new Date()));
  const [modal, setModal] = useState<ModalTarget | null>(null);
  const [leaveModal, setLeaveModal] = useState<LeaveModalTarget | null>(null);
  const [editRequestsOpen, setEditRequestsOpen] = useState(false);

  const periodStart = useMemo(() => getPeriodStart(periodIndex), [periodIndex]);
  const workingDays = useMemo(() => getWorkingDays(periodStart), [periodStart]);
  const dateStrs = useMemo(() => workingDays.map(toDateStr), [workingDays]);

  useEffect(() => {
    supabase
      .from("hr_employees")
      .select("id, legal_first_name, legal_middle_name, legal_last_name, nicknames, is_active")
      .eq("is_active", true)
      .order("legal_first_name")
      .then(({ data }) => setEmployees((data as Employee[]) ?? []));
  }, []);

  async function fetchEditRequests() {
    const { data: reqData } = await supabase
      .from("clock_edit_requests")
      .select("id, clock_entry_id, employee_id, field, old_value, new_value, reason, status, created_at, session_date")
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    if (!reqData) return;
    const empIds = [...new Set(reqData.map((r: Record<string, unknown>) => r.employee_id as string))];
    const { data: empData } = await supabase
      .from("hr_employees")
      .select("id, legal_first_name, legal_last_name, nicknames")
      .in("id", empIds);
    const empMap = new Map((empData ?? []).map((e: Record<string, unknown>) => [
      e.id,
      (() => {
        const nick = Array.isArray(e.nicknames) && (e.nicknames as string[]).length > 0 ? (e.nicknames as string[])[0] : null;
        return `${nick ?? e.legal_first_name} ${e.legal_last_name}`;
      })(),
    ]));
    const enriched = reqData.map((r: Record<string, unknown>) => ({
      ...(r as unknown as ClockEditRequest),
      employee_name: empMap.get(r.employee_id as string) ?? undefined,
    }));
    setEditRequests(enriched as ClockEditRequest[]);
  }

  useEffect(() => { fetchEditRequests(); }, []);

  // Auto-clock-out any entries left open from previous days — across all employees.
  // Runs once on mount so the admin view is self-healing if a teacher never logs in to trigger it.
  const [autoOutDone, setAutoOutDone] = useState(false);
  useEffect(() => {
    (async () => {
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const { data: stale } = await supabase
        .from("clock_entries")
        .select("id, session_date")
        .is("clocked_out_at", null)
        .not("clocked_in_at", "is", null)
        .lt("session_date", todayStr);
      for (const e of (stale ?? []) as { id: string; session_date: string }[]) {
        const [sy, sm, sd] = e.session_date.split("-").map(Number);
        const autoOut = new Date(sy, sm - 1, sd, 23, 59, 59);
        await supabase
          .from("clock_entries")
          .update({ clocked_out_at: autoOut.toISOString(), auto_clocked_out: true })
          .eq("id", e.id);
      }
      setAutoOutDone(true);
    })();
  }, []);

  useEffect(() => {
    if (!autoOutDone) return;
    setLoading(true);
    const start = dateStrs[0];
    const end = dateStrs[dateStrs.length - 1];
    Promise.all([
      supabase
        .from("clock_entries")
        .select("id, employee_id, session_date, session_start, session_end, clocked_in_at, clocked_out_at, auto_clocked_out, notes_in, notes_out, notes_in_resolved, notes_out_resolved")
        .gte("session_date", start)
        .lte("session_date", end)
        .not("clocked_in_at", "is", null),
      supabase
        .from("hr_leave_entries")
        .select("id, employee_id, entry_type, start_date, end_date, hours, notes")
        .gte("start_date", start)
        .lte("start_date", end)
        .in("entry_type", ["sick_paid", "pto", "unpaid"]),
    ]).then(([clockRes, leaveRes]) => {
      setEntries((clockRes.data as ClockEntry[]) ?? []);
      setLeaveEntries((leaveRes.data as LeaveEntry[]) ?? []);
      setLoading(false);
    });
  }, [dateStrs, autoOutDone]);

  // empId → dateStr → ClockEntry[]
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

  // empId → dateStr → paid minutes (completed entries only)
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

  // empId → dateStr → cell status
  const cellColor = useMemo(() => {
    const map = new Map<string, Map<string, "green" | "yellow" | "red" | "open">>();
    for (const [empId, dayMap] of entriesByEmpDay) {
      map.set(empId, new Map());
      for (const [dateStr, dayEntries] of dayMap) {
        const hasOpen = dayEntries.some((e) => !e.clocked_out_at);
        const hasAutoClockOut = dayEntries.some((e) => e.auto_clocked_out);
        const hasUnresolved = dayEntries.some(
          (e) =>
            (e.notes_in && !e.notes_in_resolved) ||
            (e.notes_out && !e.notes_out_resolved)
        );
        const status: "green" | "yellow" | "red" | "open" =
          hasOpen ? "open" :
          hasAutoClockOut ? "red" :
          hasUnresolved ? "yellow" :
          "green";
        map.get(empId)!.set(dateStr, status);
      }
    }
    return map;
  }, [entriesByEmpDay]);

  // empId → dateStr → LeaveEntry[]
  const leaveByEmpDay = useMemo(() => {
    const map = new Map<string, Map<string, LeaveEntry[]>>();
    const dateSet = new Set(dateStrs);
    for (const entry of leaveEntries) {
      // Expand date range across period days
      const [sy, sm, sd] = entry.start_date.split("-").map(Number);
      const [ey, em, ed] = entry.end_date.split("-").map(Number);
      let cur = new Date(Date.UTC(sy, sm - 1, sd));
      const endDate = new Date(Date.UTC(ey, em - 1, ed));
      while (cur <= endDate) {
        const ds = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}-${String(cur.getUTCDate()).padStart(2, "0")}`;
        if (dateSet.has(ds)) {
          if (!map.has(entry.employee_id)) map.set(entry.employee_id, new Map());
          const dayMap = map.get(entry.employee_id)!;
          if (!dayMap.has(ds)) dayMap.set(ds, []);
          dayMap.get(ds)!.push(entry);
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }
    return map;
  }, [leaveEntries, dateStrs]);

  // Per-employee period summaries
  const leaveSummaryByEmp = useMemo(() => {
    const map = new Map<string, { ptoMins: number; sickMins: number }>();
    const dateSet = new Set(dateStrs);
    for (const entry of leaveEntries) {
      if (!dateSet.has(entry.start_date)) continue;
      if (!map.has(entry.employee_id)) map.set(entry.employee_id, { ptoMins: 0, sickMins: 0 });
      const s = map.get(entry.employee_id)!;
      if (entry.entry_type === "pto") s.ptoMins += Math.round(Number(entry.hours) * 60);
      else if (entry.entry_type === "sick_paid") s.sickMins += Math.round(Number(entry.hours) * 60);
    }
    return map;
  }, [leaveEntries, dateStrs]);

  const clockSummaryByEmp = useMemo(() => {
    const map = new Map<string, { regularMins: number; otMins: number }>();
    for (const [empId, dayMap] of entriesByEmpDay) {
      let regularMins = 0; let otMins = 0;
      for (const [, dayEntries] of dayMap) {
        const dayMins = dayEntries.reduce((s, e) => s + entryPaidMins(e), 0);
        regularMins += Math.min(dayMins, 480);
        otMins += Math.max(0, dayMins - 480);
      }
      map.set(empId, { regularMins, otMins });
    }
    return map;
  }, [entriesByEmpDay]);

  // Show all active employees; prioritize ones with entries/leave in this period at the top.
  const sortedEmployees = useMemo(() => {
    const withData: Employee[] = [];
    const withoutData: Employee[] = [];
    for (const e of employees) {
      if (entriesByEmpDay.has(e.id) || leaveByEmpDay.has(e.id)) withData.push(e);
      else withoutData.push(e);
    }
    return [...withData, ...withoutData];
  }, [employees, entriesByEmpDay, leaveByEmpDay]);

  function handleEntriesChanged(empId: string, dateStr: string, updated: ClockEntry[]) {
    setEntries((prev) => {
      const unchanged = prev.filter((e) => !(e.employee_id === empId && e.session_date === dateStr));
      return [...unchanged, ...updated].sort((a, b) => a.session_start.localeCompare(b.session_start));
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
    ? [...(entriesByEmpDay.get(modal.employeeId)?.get(modal.dateStr) ?? [])].sort(
        (a, b) => a.session_start.localeCompare(b.session_start)
      )
    : [];

  const pendingEditCount = editRequests.length;

  return (
    <div style={{ padding: "24px 32px", fontFamily: "system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Timesheets</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => setPeriodIndex((i) => i - 1)} style={{ padding: "5px 12px", borderRadius: 8, border: "1.5px solid #e5e7eb", background: "white", cursor: "pointer", fontWeight: 700, fontSize: 14 }}>‹</button>
          <span style={{ fontWeight: 700, fontSize: 15, minWidth: 140, textAlign: "center" }}>{formatPeriodLabel(periodStart)}</span>
          <button onClick={() => setPeriodIndex((i) => i + 1)} style={{ padding: "5px 12px", borderRadius: 8, border: "1.5px solid #e5e7eb", background: "white", cursor: "pointer", fontWeight: 700, fontSize: 14 }}>›</button>
          <button onClick={() => setPeriodIndex(getPeriodIndex(new Date()))} style={{ padding: "5px 12px", borderRadius: 8, border: "1.5px solid #e5e7eb", background: "white", cursor: "pointer", fontSize: 13, color: "#6b7280" }}>Current</button>
        </div>
        <button
          onClick={() => setEditRequestsOpen(true)}
          style={{
            padding: "6px 14px", borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: "pointer",
            border: pendingEditCount > 0 ? "1.5px solid #fde68a" : "1.5px solid #e5e7eb",
            background: pendingEditCount > 0 ? "#fef3c7" : "white",
            color: pendingEditCount > 0 ? "#92400e" : "#6b7280",
          }}
        >
          Edit Requests{pendingEditCount > 0 ? ` (${pendingEditCount})` : ""}
        </button>
      </div>

      {loading ? (
        <div style={{ color: "#6b7280", padding: 20 }}>Loading…</div>
      ) : sortedEmployees.length === 0 ? (
        <div style={{ color: "#6b7280", padding: 20 }}>No active employees found.</div>
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
                <th colSpan={4} style={cell({ background: "#fdf4ff", fontWeight: 700, textAlign: "center", color: "#7c3aed", fontSize: 12 })}>Hours Breakdown</th>
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
                <th style={cell({ background: "#fdf4ff", fontWeight: 800, textAlign: "center", minWidth: 68, color: "#0369a1" })}>PTO</th>
                <th style={cell({ background: "#fdf4ff", fontWeight: 800, textAlign: "center", minWidth: 68, color: "#e6178d" })}>Sick</th>
                <th style={cell({ background: "#fdf4ff", fontWeight: 800, textAlign: "center", minWidth: 68, color: "#374151" })}>Regular</th>
                <th style={cell({ background: "#fdf4ff", fontWeight: 800, textAlign: "center", minWidth: 68, color: "#b45309", borderRight: "none" })}>OT</th>
              </tr>
            </thead>
            <tbody>
              {sortedEmployees.map((emp, rowIdx) => {
                const colorMap = cellColor.get(emp.id);
                const dayMap = minuteMap.get(emp.id);
                const leave = leaveSummaryByEmp.get(emp.id) ?? { ptoMins: 0, sickMins: 0 };
                const clock = clockSummaryByEmp.get(emp.id) ?? { regularMins: 0, otMins: 0 };
                const totalMins = clock.regularMins + clock.otMins + leave.ptoMins + leave.sickMins;
                const rowBg = rowIdx % 2 === 0 ? "white" : "#fafafa";

                return (
                  <tr key={emp.id} style={{ background: rowBg }}>
                    <td style={cell({ fontWeight: 700, position: "sticky", left: 0, background: rowBg, zIndex: 1, color: "#111827" })}>
                      {getDisplayName(emp)}
                    </td>
                    {dateStrs.map((ds, i) => {
                      const status = colorMap?.get(ds);
                      const mins = dayMap?.get(ds) ?? 0;
                      const dayLeaveEntries = leaveByEmpDay.get(emp.id)?.get(ds);
                      const hasClockData = !!status;
                      const hasLeaveOnly = !hasClockData && !!dayLeaveEntries?.length;
                      const dateLabel = `${DAY_ABBRS[i]} ${workingDays[i].toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}`;

                      return (
                        <td key={i} style={cell({ textAlign: "center", padding: "6px 8px" })}>
                          {hasClockData ? (
                            <button
                              onClick={() => setModal({ employeeId: emp.id, employeeName: getDisplayName(emp), dateStr: ds, dateLabel })}
                              style={{
                                display: "inline-block",
                                background:
                                  status === "open" ? "#dbeafe" :
                                  status === "red" ? "#fee2e2" :
                                  status === "yellow" ? "#fef3c7" :
                                  "#dcfce7",
                                color:
                                  status === "open" ? "#1e40af" :
                                  status === "red" ? "#991b1b" :
                                  status === "yellow" ? "#92400e" :
                                  "#15803d",
                                border: `1.5px solid ${
                                  status === "open" ? "#93c5fd" :
                                  status === "red" ? "#fca5a5" :
                                  status === "yellow" ? "#fde68a" :
                                  "#86efac"
                                }`,
                                borderRadius: 8, padding: "4px 10px",
                                fontWeight: 700, fontSize: 13, minWidth: 48,
                                cursor: "pointer",
                              }}
                            >
                              {status === "open" ? "Clocked in" : minsToHHMM(mins)}
                            </button>
                          ) : hasLeaveOnly ? (
                            <button
                              onClick={() => setLeaveModal({ employeeName: getDisplayName(emp), dateLabel, entries: dayLeaveEntries })}
                              style={{
                                display: "inline-block",
                                background: "#f3f4f6", color: "#374151",
                                border: "1.5px solid #d1d5db",
                                borderRadius: 8, padding: "4px 10px",
                                fontWeight: 700, fontSize: 12,
                                cursor: "pointer",
                              }}
                            >
                              {dayLeaveEntries.length === 1 ? leaveTypeLabel(dayLeaveEntries[0].entry_type) : "Leave"}
                            </button>
                          ) : (
                            <button
                              onClick={() => setModal({ employeeId: emp.id, employeeName: getDisplayName(emp), dateStr: ds, dateLabel })}
                              title="Add session"
                              style={{
                                display: "inline-block",
                                background: "transparent",
                                border: "1.5px dashed #e5e7eb",
                                borderRadius: 8, padding: "4px 10px",
                                color: "#9ca3af", fontSize: 13, fontWeight: 600,
                                cursor: "pointer", minWidth: 48,
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = "#f9fafb";
                                e.currentTarget.style.borderColor = "#c7d2fe";
                                e.currentTarget.style.color = "#6366f1";
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background = "transparent";
                                e.currentTarget.style.borderColor = "#e5e7eb";
                                e.currentTarget.style.color = "#9ca3af";
                              }}
                            >
                              --
                            </button>
                          )}
                        </td>
                      );
                    })}
                    <td style={cell({ textAlign: "center", fontWeight: 800, fontSize: 14, color: totalMins > 0 ? "#111827" : "#d1d5db" })}>
                      {minsToHHMM(totalMins)}
                    </td>
                    <td style={cell({ textAlign: "center", color: leave.ptoMins > 0 ? "#0369a1" : "#d1d5db", fontWeight: 600 })}>
                      {minsToHDecimal(leave.ptoMins)}
                    </td>
                    <td style={cell({ textAlign: "center", color: leave.sickMins > 0 ? "#e6178d" : "#d1d5db", fontWeight: 600 })}>
                      {minsToHDecimal(leave.sickMins)}
                    </td>
                    <td style={cell({ textAlign: "center", color: clock.regularMins > 0 ? "#374151" : "#d1d5db", fontWeight: 600 })}>
                      {minsToHDecimal(clock.regularMins)}
                    </td>
                    <td style={cell({ textAlign: "center", color: clock.otMins > 0 ? "#b45309" : "#d1d5db", fontWeight: 600, borderRight: "none" })}>
                      {minsToHDecimal(clock.otMins)}
                    </td>
                  </tr>
                );
              })}

              {/* Footer totals */}
              <tr style={{ background: "#f9fafb", borderTop: "2px solid #e5e7eb" }}>
                <td style={cell({ fontWeight: 800, position: "sticky", left: 0, background: "#f9fafb", zIndex: 1, color: "#374151" })}>Total</td>
                {dateStrs.map((ds, i) => {
                  const dayTotal = sortedEmployees.reduce((s, emp) => s + (minuteMap.get(emp.id)?.get(ds) ?? 0), 0);
                  return (
                    <td key={i} style={cell({ textAlign: "center", fontWeight: 700, color: dayTotal > 0 ? "#374151" : "#d1d5db", fontSize: 12 })}>
                      {minsToHHMM(dayTotal)}
                    </td>
                  );
                })}
                {(() => {
                  const totPto = sortedEmployees.reduce((s, emp) => s + (leaveSummaryByEmp.get(emp.id)?.ptoMins ?? 0), 0);
                  const totSick = sortedEmployees.reduce((s, emp) => s + (leaveSummaryByEmp.get(emp.id)?.sickMins ?? 0), 0);
                  const totReg = sortedEmployees.reduce((s, emp) => s + (clockSummaryByEmp.get(emp.id)?.regularMins ?? 0), 0);
                  const totOt = sortedEmployees.reduce((s, emp) => s + (clockSummaryByEmp.get(emp.id)?.otMins ?? 0), 0);
                  const grandTotal = totPto + totSick + totReg + totOt;
                  return (
                    <>
                      <td style={cell({ textAlign: "center", fontWeight: 800, color: "#111827" })}>{minsToHHMM(grandTotal)}</td>
                      <td style={cell({ textAlign: "center", fontWeight: 700, color: totPto > 0 ? "#0369a1" : "#d1d5db" })}>{minsToHDecimal(totPto)}</td>
                      <td style={cell({ textAlign: "center", fontWeight: 700, color: totSick > 0 ? "#e6178d" : "#d1d5db" })}>{minsToHDecimal(totSick)}</td>
                      <td style={cell({ textAlign: "center", fontWeight: 700, color: totReg > 0 ? "#374151" : "#d1d5db" })}>{minsToHDecimal(totReg)}</td>
                      <td style={cell({ textAlign: "center", fontWeight: 700, color: totOt > 0 ? "#b45309" : "#d1d5db", borderRight: "none" })}>{minsToHDecimal(totOt)}</td>
                    </>
                  );
                })()}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <SessionModal
          target={modal}
          entries={modalEntries}
          onClose={() => setModal(null)}
          onEntriesChanged={(updated) => handleEntriesChanged(modal.employeeId, modal.dateStr, updated)}
        />
      )}

      {leaveModal && (
        <LeaveModal target={leaveModal} onClose={() => setLeaveModal(null)} />
      )}

      {editRequestsOpen && (
        <EditRequestsModal
          requests={editRequests}
          onClose={() => setEditRequestsOpen(false)}
          onRefresh={() => fetchEditRequests()}
          onGoTo={(sessionDate) => {
            const d = new Date(sessionDate + "T12:00:00");
            setPeriodIndex(getPeriodIndex(d));
            setEditRequestsOpen(false);
          }}
          onUpdate={(reqId, entryId, field, newValue) => {
            // Remove resolved request from parent state (useEffect syncs modal)
            setEditRequests((prev) => prev.filter((r) => r.id !== reqId));
            // Optimistically update the affected entry so grid refreshes immediately
            if (entryId && field && newValue) {
              setEntries((prev) => prev.map((e) =>
                e.id === entryId
                  ? { ...e, [field]: newValue, ...(field === "clocked_out_at" ? { auto_clocked_out: false } : {}) }
                  : e
              ));
            }
            // Also reload from DB to sync
            const start = dateStrs[0];
            const end = dateStrs[dateStrs.length - 1];
            supabase
              .from("clock_entries")
              .select("id, employee_id, session_date, session_start, session_end, clocked_in_at, clocked_out_at, auto_clocked_out, notes_in, notes_out, notes_in_resolved, notes_out_resolved")
              .gte("session_date", start)
              .lte("session_date", end)
              .not("clocked_in_at", "is", null)
              .then(({ data }) => setEntries((data as ClockEntry[]) ?? []));
          }}
        />
      )}
    </div>
  );
}
