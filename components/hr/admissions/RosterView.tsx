"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useDialog } from "@/components/ui/useDialog";
import {
  RosterEntry, WaitlistEntry, Program, Room,
  RoomChange, ProgramChange, MonthNote, MonthNoteKind, NOTE_STYLE,
  fetchRoster, fetchWaitlist, fetchPrograms, fetchRooms,
  fetchRoomChanges, fetchProgramChanges, fetchMonthNotes, fetchRosterMonthCount, fetchSplitMonths,
  secondHalfKey, isSecondHalf, monthOf,
  buildMonths, monthLabelShort, monthLabelLong, ageShort, resolveSeries, currentMonthISO, currentLAMonthISO,
  ageYearsMonths, fmtDate, fullName, todayISO,
  SortState, nextSort, compareForSort,
} from "@/lib/admissions";
import { Modal, Field, SortTh, RoomDot, th, td } from "@/components/hr/admissions/shared";
import RoomsModal from "@/components/hr/admissions/RoomsModal";
import ProgramsModal from "@/components/hr/admissions/ProgramsModal";
import { EntryModal as WaitlistEntryModal } from "@/components/hr/admissions/WaitlistView";

type SubFilter = "enrolled" | "withdrawn";
type Row = { kind: "roster"; entry: RosterEntry } | { kind: "prospective"; entry: WaitlistEntry };

// Frozen left column widths.
const NAME_W = 156, DOB_W = 94, ENR_W = 100, MONTH_W = 138;
const PROSPECTIVE_BG = "#c6ccd6"; // distinctly grey so waitlist rows stand out
const frozenPad: React.CSSProperties = { padding: "7px 9px" };

// Cell background. Normal cells show a vibrant room tint; prospective cells and
// any cell with a pending "promote" note show the faint tint instead (the dim
// state), keeping the room hue but clearly lighter than their neighbours.
function cellBackground(roomColor: string | undefined, prospective: boolean, promote: boolean): string | undefined {
  const dimmed = prospective || promote;
  if (!roomColor) return dimmed ? "#eef1f4" : undefined;
  return roomColor + (dimmed ? "22" : "55"); // hex alpha: ~13% (dim) vs ~33% (vibrant)
}

export default function RosterView({ campusId, myUserId }: { campusId: string; myUserId: string | null }) {
  const { confirm, modal: dialog } = useDialog();

  const [entries, setEntries] = useState<RosterEntry[]>([]);
  const [wlEntries, setWlEntries] = useState<WaitlistEntry[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomChanges, setRoomChanges] = useState<RoomChange[]>([]);
  const [programChanges, setProgramChanges] = useState<ProgramChange[]>([]);
  const [monthNotes, setMonthNotes] = useState<MonthNote[]>([]);
  const [splitMonths, setSplitMonths] = useState<Set<string>>(new Set());
  const [monthCount, setMonthCount] = useState(24);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  const [sub, setSub] = useState<SubFilter>("enrolled");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "dob", dir: "asc" });
  const onSort = (key: string) => setSort((prev) => nextSort(prev, key));
  // Remembers the last frozen-column sort so a room-by-month sort keeps it as the
  // secondary sort within each room (e.g. sort by DOB, then group by room).
  const [baseSort, setBaseSort] = useState<SortState>({ key: "dob", dir: "asc" });
  useEffect(() => { if (!sort.key.startsWith("room:")) setBaseSort(sort); }, [sort]);
  const [showPast, setShowPast] = useState(false);

  const [entryModal, setEntryModal] = useState<{ entry?: RosterEntry } | null>(null);
  const [wlEntryModal, setWlEntryModal] = useState<{ entry: WaitlistEntry } | null>(null);
  const [cell, setCell] = useState<{ row: Row; monthIso: string } | null>(null);
  const [withdrawFor, setWithdrawFor] = useState<RosterEntry | null>(null);
  const [addMonthsOpen, setAddMonthsOpen] = useState(false);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const [programsOpen, setProgramsOpen] = useState(false);

  const programById = useMemo(() => Object.fromEntries(programs.map((p) => [p.id, p])), [programs]);
  const roomById = useMemo(() => Object.fromEntries(rooms.map((r) => [r.id, r])), [rooms]);
  const roomOrder = useMemo(() => new Map(rooms.map((r, i) => [r.id, i])), [rooms]);
  const months = useMemo(() => buildMonths(monthCount), [monthCount]);
  // A split month contributes two columns: the 1st and the 16th.
  const columns = useMemo(() => {
    const out: string[] = [];
    for (const m of months) { out.push(m); if (splitMonths.has(m)) out.push(secondHalfKey(m)); }
    return out;
  }, [months, splitMonths]);
  const laMonth = useMemo(() => currentLAMonthISO(), []);
  const colIndex = useMemo(() => new Map(columns.map((k, i) => [k, i])), [columns]);
  // Columns whose month is before the current LA month are hidden by default.
  const visibleCols = useMemo(() => columns.filter((k) => showPast || monthOf(k) >= laMonth), [columns, showPast, laMonth]);
  const pastCount = useMemo(() => months.filter((m) => m < laMonth).length, [months, laMonth]);

  const reloadTimelines = useCallback(async () => {
    const [rc, pc, mn] = await Promise.all([fetchRoomChanges(campusId), fetchProgramChanges(campusId), fetchMonthNotes(campusId)]);
    setRoomChanges(rc); setProgramChanges(pc); setMonthNotes(mn);
  }, [campusId]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [ent, prog, rms, wl, mc, split] = await Promise.all([
        fetchRoster(campusId), fetchPrograms(campusId), fetchRooms(campusId), fetchWaitlist(campusId), fetchRosterMonthCount(campusId), fetchSplitMonths(campusId),
      ]);
      setEntries(ent); setPrograms(prog); setRooms(rms);
      setWlEntries(wl.filter((w) => w.status === "active"));
      setMonthCount(mc);
      setSplitMonths(new Set(split));
      await reloadTimelines();
      setStatus("");
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    } finally {
      setLoading(false);
    }
  }, [campusId, reloadTimelines]);

  useEffect(() => { void reload(); }, [reload]);

  // ── Resolved timelines per entry ─────────────────────────────────────────────
  const seriesByEntry = useMemo(() => {
    const roomByE = new Map<string, RoomChange[]>();
    for (const c of roomChanges) { const k = c.roster_entry_id ?? c.waitlist_entry_id!; (roomByE.get(k) ?? roomByE.set(k, []).get(k)!).push(c); }
    const progByE = new Map<string, ProgramChange[]>();
    for (const c of programChanges) { const k = c.roster_entry_id ?? c.waitlist_entry_id!; (progByE.get(k) ?? progByE.set(k, []).get(k)!).push(c); }
    const noteByE = new Map<string, Map<string, MonthNote>>();
    for (const n of monthNotes) { const k = n.roster_entry_id ?? n.waitlist_entry_id!; const m = noteByE.get(k) ?? noteByE.set(k, new Map()).get(k)!; m.set(n.month, n); }

    const map = new Map<string, { room: (string | null)[]; program: (string | null)[]; notes: Map<string, MonthNote>; withdrawFrom: string | null }>();
    const ids = [...entries.map((e) => e.id), ...wlEntries.map((e) => e.id)];
    for (const id of ids) {
      const room = resolveSeries((roomByE.get(id) ?? []).map((c) => ({ effective_month: c.effective_month, value: c.room_id })), columns);
      const program = resolveSeries((progByE.get(id) ?? []).map((c) => ({ effective_month: c.effective_month, value: c.program_id })), columns);
      const notes = noteByE.get(id) ?? new Map<string, MonthNote>();
      let withdrawFrom: string | null = null;
      for (const [mo, n] of notes) if (n.kind === "withdraw" && (!withdrawFrom || mo < withdrawFrom)) withdrawFrom = mo;
      map.set(id, { room, program, notes, withdrawFrom });
    }
    return map;
  }, [roomChanges, programChanges, monthNotes, entries, wlEntries, columns]);

  const rows = useMemo<Row[]>(() => {
    const q = search.trim().toLowerCase();
    const rosterRows: Row[] = entries.filter((e) => e.status === sub).map((e) => ({ kind: "roster", entry: e }));
    const prospective: Row[] = sub === "enrolled" ? wlEntries.map((e) => ({ kind: "prospective", entry: e })) : [];
    let all = [...rosterRows, ...prospective];
    if (q) all = all.filter((r) => fullName(r.entry).toLowerCase().includes(q));
    const sortValue = (r: Row, key: string): string | number => {
      if (key.startsWith("room:")) {
        const mi = colIndex.get(key.slice(5));
        const roomId = (mi != null ? seriesByEntry.get(r.entry.id)?.room[mi] : null) ?? null;
        return roomId ? (roomOrder.get(roomId) ?? 9998) : 9999; // no room sorts last
      }
      if (key === "name") return fullName(r.entry).toLowerCase();
      if (key === "dob") return r.entry.date_of_birth ?? "";
      return r.kind === "roster" ? (r.entry.enrolled_date ?? "") : "";
    };
    return all.sort((a, b) => {
      let c = compareForSort(sortValue(a, sort.key), sortValue(b, sort.key), sort.dir);
      // Within a room group, fall back to the last frozen-column sort (e.g. DOB).
      if (c === 0 && sort.key.startsWith("room:")) c = compareForSort(sortValue(a, baseSort.key), sortValue(b, baseSort.key), baseSort.dir);
      return c !== 0 ? c : fullName(a.entry).toLowerCase().localeCompare(fullName(b.entry).toLowerCase());
    });
  }, [entries, wlEntries, sub, search, sort, baseSort, colIndex, seriesByEntry, roomOrder]);

  const rowWithdrawMonth = (r: Row): string | null => (r.kind === "roster" ? (r.entry as RosterEntry).withdrawal_month : null);
  const cellActive = (r: Row, monthIso: string) => { const wd = rowWithdrawMonth(r); return !wd || monthIso <= wd; };

  // Per-column per-room counts (from visible rows, respecting withdrawal cutoff).
  const monthCounts = useMemo(() => {
    const res = columns.map(() => new Map<string, { enrolled: number; prospective: number }>());
    for (const r of rows) {
      const s = seriesByEntry.get(r.entry.id); if (!s) continue;
      columns.forEach((m, mi) => {
        if (!cellActive(r, m)) return;
        if (s.withdrawFrom && m > s.withdrawFrom) return; // planned-withdrawn → not counted after
        const roomId = s.room[mi]; if (!roomId) return;
        const cur = res[mi].get(roomId) ?? { enrolled: 0, prospective: 0 };
        if (r.kind === "roster") cur.enrolled++; else cur.prospective++;
        res[mi].set(roomId, cur);
      });
    }
    return res;
  }, [rows, seriesByEntry, columns]);

  const counts = useMemo(() => ({
    enrolled: entries.filter((e) => e.status === "enrolled").length + wlEntries.length,
    withdrawn: entries.filter((e) => e.status === "withdrawn").length,
  }), [entries, wlEntries]);

  // ── Timeline mutations ───────────────────────────────────────────────────────
  function subjCol(r: Row) { return r.kind === "roster" ? "roster_entry_id" : "waitlist_entry_id"; }

  async function setRoom(r: Row, monthIso: string, roomId: string | null) {
    const col = subjCol(r);
    await supabase.from("hr_admissions_room_changes").delete().eq(col, r.entry.id).eq("effective_month", monthIso);
    const { error } = await supabase.from("hr_admissions_room_changes").insert({ campus_id: campusId, [col]: r.entry.id, effective_month: monthIso, room_id: roomId, created_by: myUserId });
    if (error) { setStatus("Error: " + error.message); return; }
    await reloadTimelines();
  }
  async function clearRoomChange(r: Row, monthIso: string) {
    await supabase.from("hr_admissions_room_changes").delete().eq(subjCol(r), r.entry.id).eq("effective_month", monthIso);
    await reloadTimelines();
  }
  async function setProgram(r: Row, monthIso: string, programId: string | null) {
    const col = subjCol(r);
    await supabase.from("hr_admissions_program_changes").delete().eq(col, r.entry.id).eq("effective_month", monthIso);
    const { error } = await supabase.from("hr_admissions_program_changes").insert({ campus_id: campusId, [col]: r.entry.id, effective_month: monthIso, program_id: programId, created_by: myUserId });
    if (error) { setStatus("Error: " + error.message); return; }
    await reloadTimelines();
  }
  async function clearProgramChange(r: Row, monthIso: string) {
    await supabase.from("hr_admissions_program_changes").delete().eq(subjCol(r), r.entry.id).eq("effective_month", monthIso);
    await reloadTimelines();
  }
  async function setNote(r: Row, monthIso: string, kind: MonthNoteKind, noteDate: string) {
    const col = subjCol(r);
    await supabase.from("hr_admissions_month_notes").delete().eq(col, r.entry.id).eq("month", monthIso);
    const { error } = await supabase.from("hr_admissions_month_notes").insert({ campus_id: campusId, [col]: r.entry.id, month: monthIso, kind, note_date: noteDate || null, created_by: myUserId });
    if (error) { setStatus("Error: " + error.message); return; }
    await reloadTimelines();
  }
  async function clearNote(r: Row, monthIso: string) {
    await supabase.from("hr_admissions_month_notes").delete().eq(subjCol(r), r.entry.id).eq("month", monthIso);
    await reloadTimelines();
  }

  async function admitProspective(e: WaitlistEntry) {
    const ok = await confirm(
      `Admit ${fullName(e)} to the roster? Their planned months (rooms, programs, notes) carry over as a real roster entry.`,
      { title: "Admit to roster", confirmLabel: "Admit" }
    );
    if (!ok) return;
    const { error } = await supabase.rpc("admit_waitlist_entry", { p_entry_id: e.id, p_room_id: null });
    if (error) { setStatus("Error: " + error.message); return; }
    await reload();
  }

  async function doWithdraw(e: RosterEntry, monthIso: string) {
    const { error } = await supabase.from("hr_roster_entries").update({
      status: "withdrawn", withdrawal_month: monthIso, withdrawn_at: new Date().toISOString(), updated_at: new Date().toISOString(), updated_by: myUserId,
    }).eq("id", e.id);
    if (error) { setStatus("Error: " + error.message); return; }
    setWithdrawFor(null);
    await reload();
  }
  async function restore(e: RosterEntry) {
    await supabase.from("hr_roster_entries").update({ status: "enrolled", withdrawal_month: null, withdrawn_at: null, updated_at: new Date().toISOString(), updated_by: myUserId }).eq("id", e.id);
    await reload();
  }

  async function addMonths(n: number) {
    const next = monthCount + n;
    await supabase.from("hr_campuses").update({ roster_month_count: next }).eq("id", campusId);
    setMonthCount(next);
    setAddMonthsOpen(false);
  }

  async function toggleSplit(monthIso: string, isSplit: boolean) {
    if (!isSplit) {
      const ok = await confirm(`Split ${monthLabelLong(monthIso)} into two halves (1–15 and 16+)? You can then set each half's room, program and notes separately.`, { title: "Split month", confirmLabel: "Split" });
      if (!ok) return;
      const { error } = await supabase.from("hr_admissions_split_months").insert({ campus_id: campusId, month: monthIso, created_by: myUserId });
      if (error) { setStatus("Error: " + error.message); return; }
    } else {
      const ok = await confirm(`Undo the split for ${monthLabelLong(monthIso)}? All second-half cells will be deleted — only the first half is kept.`, { title: "Undo split", confirmLabel: "Undo split", danger: true });
      if (!ok) return;
      const half2 = secondHalfKey(monthIso);
      await supabase.from("hr_admissions_split_months").delete().eq("campus_id", campusId).eq("month", monthIso);
      await supabase.from("hr_admissions_room_changes").delete().eq("campus_id", campusId).eq("effective_month", half2);
      await supabase.from("hr_admissions_program_changes").delete().eq("campus_id", campusId).eq("effective_month", half2);
      await supabase.from("hr_admissions_month_notes").delete().eq("campus_id", campusId).eq("month", half2);
    }
    setSplitMonths(new Set(await fetchSplitMonths(campusId)));
    await reloadTimelines();
  }

  // current values for the open cell
  const cellCtx = useMemo(() => {
    if (!cell) return null;
    const s = seriesByEntry.get(cell.row.entry.id);
    const mi = months.indexOf(cell.monthIso);
    return {
      roomId: s?.room[mi] ?? null,
      programId: s?.program[mi] ?? null,
      note: s?.notes.get(cell.monthIso) ?? null,
    };
  }, [cell, seriesByEntry, months]);

  return (
    <div className="stack" style={{ gap: 14 }}>
      {dialog}

      <div className="row-between" style={{ flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <div className="row" style={{ gap: 4, background: "#f3f4f6", padding: 4, borderRadius: 10 }}>
          <SubTab active={sub === "enrolled"} onClick={() => setSub("enrolled")}>Enrolled · {counts.enrolled}</SubTab>
          <SubTab active={sub === "withdrawn"} onClick={() => setSub("withdrawn")}>Withdrawn · {counts.withdrawn}</SubTab>
        </div>
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {status ? <span className="badge">{status}</span> : null}
          <input className="input" placeholder="Search name…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 150 }} />
          <button className="btn" onClick={() => setRoomsOpen(true)}>🚪 Rooms</button>
          <button className="btn" onClick={() => setProgramsOpen(true)}>📋 Programs</button>
          {pastCount > 0 && (
            <button className="btn" onClick={() => setShowPast((p) => !p)}>{showPast ? "Hide past" : `Show past · ${pastCount}`}</button>
          )}
          <button className="btn" onClick={() => void reload()}>Refresh</button>
          <button className="btn btn-primary" onClick={() => setEntryModal({})}>+ Add student</button>
        </div>
      </div>

      {sub === "enrolled" && (
        <div className="subtle" style={{ fontSize: 12 }}>
          Each column is a month (age auto-calculated). Click a cell to set the room / program / note for that month onward. Grey rows are prospective waitlist entries.
        </div>
      )}

      {loading ? (
        <div className="subtle" style={{ padding: 20 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card">
          <div style={{ fontWeight: 800 }}>{sub === "enrolled" ? "No students yet" : "No withdrawn students"}</div>
          {sub === "enrolled" && <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => setEntryModal({})}>+ Add student</button>}
        </div>
      ) : (
        <div style={{ overflow: "auto", maxHeight: "76vh", border: "1.5px solid #e5e7eb", borderRadius: 12 }}>
          <table style={{ borderCollapse: "collapse", background: "white", minWidth: "max-content" }}>
            <thead>
              <tr>
                <SortTh label="Name" sortKey="name" sort={sort} onSort={onSort} style={{ left: 0, width: NAME_W, minWidth: NAME_W, zIndex: 6, boxShadow: undefined }} />
                <SortTh label="DOB" sortKey="dob" sort={sort} onSort={onSort} style={{ left: NAME_W, width: DOB_W, minWidth: DOB_W, zIndex: 6 }} />
                <SortTh label="Enrolled" sortKey="enrolled" sort={sort} onSort={onSort} style={{ left: NAME_W + DOB_W, width: ENR_W, minWidth: ENR_W, zIndex: 6, boxShadow: "2px 0 5px -2px rgba(0,0,0,0.12)" }} />
                {visibleCols.map((m) => {
                  const mi = colIndex.get(m)!;
                  const roomSortActive = sort.key === `room:${m}`;
                  const m1 = monthOf(m);
                  const split = splitMonths.has(m1);
                  const secondHalf = isSecondHalf(m);
                  return (
                    <th key={m} style={{ ...th, minWidth: MONTH_W, width: MONTH_W, verticalAlign: "top" }}>
                      <div className="row-between" style={{ gap: 4, alignItems: "flex-start" }}>
                        <MonthHeader label={monthLabelShort(m1)} sublabel={split ? (secondHalf ? "2nd half (16+)" : "1st half (1–15)") : undefined} counts={monthCounts[mi]} rooms={rooms} />
                        <div className="stack" style={{ gap: 3, alignItems: "center", flexShrink: 0 }}>
                          <button
                            title="Group students by room for this month"
                            onClick={() => onSort(`room:${m}`)}
                            style={{ border: "none", background: "none", cursor: "pointer", padding: 0, fontSize: 12, lineHeight: 1, color: roomSortActive ? "#e6178d" : "#cbd5e1" }}
                          >
                            {roomSortActive ? (sort.dir === "asc" ? "☰↑" : "☰↓") : "☰"}
                          </button>
                          {!secondHalf && (
                            <button
                              title={split ? "Undo split for this month" : "Split this month into two halves"}
                              onClick={() => void toggleSplit(m1, split)}
                              style={{ border: "none", background: "none", cursor: "pointer", padding: 0, fontSize: 13, lineHeight: 1, color: split ? "#e6178d" : "#cbd5e1" }}
                            >
                              ◫
                            </button>
                          )}
                        </div>
                      </div>
                    </th>
                  );
                })}
                <th style={{ ...th, minWidth: 120, verticalAlign: "top" }}>
                  <button className="btn" style={{ fontSize: 12 }} onClick={() => setAddMonthsOpen(true)}>+ Add months</button>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => {
                const faded = r.kind === "prospective";
                // The row stays white so semi-transparent month tints composite over
                // white (matching promote cells); only the frozen columns go grey.
                const rowBg = ri % 2 === 0 ? "white" : "#fafafa";
                const frozenBg = faded ? PROSPECTIVE_BG : rowBg;
                const s = seriesByEntry.get(r.entry.id);
                const wd = rowWithdrawMonth(r);
                return (
                  <tr key={r.entry.id} style={{ background: rowBg }}>
                    {/* Name (frozen) */}
                    <td style={{ ...td, ...frozenPad, position: "sticky", left: 0, width: NAME_W, minWidth: NAME_W, background: frozenBg, zIndex: 3 }}>
                      <div style={{ fontWeight: 700 }}>{fullName(r.entry)}</div>
                      <div className="row" style={{ gap: 6, marginTop: 4 }}>
                        <button className="btn" style={{ padding: "2px 9px", fontSize: 11 }} onClick={() => (r.kind === "roster" ? setEntryModal({ entry: r.entry }) : setWlEntryModal({ entry: r.entry }))}>Edit</button>
                        {r.kind === "prospective" ? (
                          <button className="btn btn-primary" style={{ padding: "2px 9px", fontSize: 11 }} onClick={() => void admitProspective(r.entry)}>Admit</button>
                        ) : sub === "withdrawn" ? (
                          <button className="btn" style={{ padding: "2px 9px", fontSize: 11 }} onClick={() => void restore(r.entry)}>Restore</button>
                        ) : (
                          <button className="btn" style={{ padding: "2px 9px", fontSize: 11, color: "#b91c1c" }} onClick={() => setWithdrawFor(r.entry)}>Withdraw</button>
                        )}
                      </div>
                    </td>
                    {/* DOB (frozen) */}
                    <td style={{ ...td, ...frozenPad, position: "sticky", left: NAME_W, width: DOB_W, minWidth: DOB_W, background: frozenBg, zIndex: 3 }}>{fmtDate(r.entry.date_of_birth) || "—"}</td>
                    {/* Enrolled (frozen) */}
                    <td style={{ ...td, ...frozenPad, position: "sticky", left: NAME_W + DOB_W, width: ENR_W, minWidth: ENR_W, background: frozenBg, zIndex: 3, boxShadow: "2px 0 5px -2px rgba(0,0,0,0.12)" }}>
                      {r.kind === "prospective" ? <span className="subtle" style={{ fontStyle: "italic" }}>On waitlist</span>
                        : sub === "withdrawn" ? <span className="subtle">← {wd ? monthLabelShort(wd) : "—"}</span>
                        : (fmtDate(r.entry.enrolled_date) || "—")}
                    </td>
                    {/* Month cells */}
                    {visibleCols.map((m) => {
                      const mi = colIndex.get(m)!;
                      if (!cellActive(r, m)) return <td key={m} style={{ ...td, minWidth: MONTH_W, width: MONTH_W, background: faded ? PROSPECTIVE_BG : "#fbfbfb" }} />;
                      // Months after a planned "Withdraw" note: projected out (empty, faint red).
                      if (s?.withdrawFrom && m > s.withdrawFrom) {
                        return (
                          <td key={m} onClick={() => setCell({ row: r, monthIso: m })}
                            style={{ ...td, minWidth: MONTH_W, width: MONTH_W, cursor: "pointer", background: "#fdeaea", textAlign: "center", color: "#f08a8a", fontSize: 10, fontWeight: 700 }}>
                            withdrawn
                          </td>
                        );
                      }
                      const roomId = s?.room[mi] ?? null;
                      const roomColor = roomById[roomId ?? ""]?.color;
                      const progName = programById[s?.program[mi] ?? ""]?.name;
                      const note = s?.notes.get(m);
                      const age = ageShort(r.entry.date_of_birth, m);
                      return (
                        <td
                          key={m}
                          onClick={() => setCell({ row: r, monthIso: m })}
                          style={{ ...td, minWidth: MONTH_W, width: MONTH_W, cursor: "pointer", background: cellBackground(roomColor, faded, note?.kind === "promote"), verticalAlign: "top", padding: "6px 7px" }}
                        >
                          <div className="row" style={{ gap: 5, alignItems: "center", flexWrap: "nowrap" }}>
                            <RoomDot color={roomColor} />
                            <span style={{ fontSize: 12, fontWeight: 600, color: "#374151", whiteSpace: "nowrap" }}>{age || "—"}</span>
                            {progName && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 6, background: "#eef2ff", color: "#3730a3", whiteSpace: "nowrap", flexShrink: 0 }}>{progName}</span>}
                          </div>
                          {note && <div style={{ marginTop: 3 }}><NoteTag kind={note.kind} date={note.note_date} /></div>}
                        </td>
                      );
                    })}
                    <td style={{ ...td }} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {entryModal && (
        <RosterEntryModal entry={entryModal.entry} campusId={campusId} myUserId={myUserId}
          onClose={() => setEntryModal(null)} onSaved={() => { setEntryModal(null); void reload(); }} />
      )}

      {wlEntryModal && (
        <WaitlistEntryModal mode="edit" entry={wlEntryModal.entry} campusId={campusId} myUserId={myUserId}
          programs={programs} onManagePrograms={() => setProgramsOpen(true)}
          onClose={() => { setWlEntryModal(null); void reload(); }} onSaved={() => { setWlEntryModal(null); void reload(); }} />
      )}

      {cell && cellCtx && (
        <CellEditor
          name={fullName(cell.row.entry)} monthIso={cell.monthIso}
          rooms={rooms} programs={programs}
          roomId={cellCtx.roomId} programId={cellCtx.programId} note={cellCtx.note}
          onSetRoom={(id) => setRoom(cell.row, cell.monthIso, id)}
          onClearRoom={() => clearRoomChange(cell.row, cell.monthIso)}
          onSetProgram={(id) => setProgram(cell.row, cell.monthIso, id)}
          onClearProgram={() => clearProgramChange(cell.row, cell.monthIso)}
          onSetNote={(kind, d) => setNote(cell.row, cell.monthIso, kind, d)}
          onClearNote={() => clearNote(cell.row, cell.monthIso)}
          onManageRooms={() => setRoomsOpen(true)} onManagePrograms={() => setProgramsOpen(true)}
          onClose={() => setCell(null)}
        />
      )}

      {withdrawFor && (
        <WithdrawModal entry={withdrawFor} months={months} onClose={() => setWithdrawFor(null)} onConfirm={(m) => doWithdraw(withdrawFor, m)} />
      )}

      {addMonthsOpen && <AddMonthsModal months={months} onClose={() => setAddMonthsOpen(false)} onAdd={addMonths} />}

      {roomsOpen && <RoomsModal campusId={campusId} onClose={() => setRoomsOpen(false)} onChanged={async () => setRooms(await fetchRooms(campusId))} />}
      {programsOpen && <ProgramsModal campusId={campusId} onClose={() => setProgramsOpen(false)} onChanged={async () => setPrograms(await fetchPrograms(campusId))} />}
    </div>
  );
}

// ─── Month header (label + compact per-room counts) ───────────────────────────
function MonthHeader({ label, sublabel, counts, rooms }: { label: string; sublabel?: string; counts: Map<string, { enrolled: number; prospective: number }>; rooms: Room[] }) {
  const shown = rooms.filter((r) => { const c = counts.get(r.id); return c && (c.enrolled > 0 || c.prospective > 0); });
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div style={{ fontWeight: 800, fontSize: 12 }}>{label}</div>
      {sublabel && <div style={{ fontSize: 9.5, fontWeight: 700, color: "#e6178d" }}>{sublabel}</div>}
      {shown.length > 0 && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {shown.map((r) => {
            const c = counts.get(r.id)!;
            return (
              <span key={r.id} title={r.name} className="row" style={{ gap: 3, alignItems: "center", fontWeight: 700, fontSize: 11 }}>
                <RoomDot color={r.color} />
                <span style={{ color: r.color }}>{c.enrolled}</span>
                <span style={{ color: "#9ca3af" }}>+{c.prospective}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NoteTag({ kind, date }: { kind: MonthNoteKind; date: string | null }) {
  const s = NOTE_STYLE[kind];
  return (
    <span style={{ fontSize: 10, fontWeight: 800, padding: "1px 6px", borderRadius: 6, color: s.color, background: s.bg, border: `1px solid ${s.border}` }}>
      {s.label}{date ? ` ${fmtDate(date)}` : ""}
    </span>
  );
}

function SubTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 800, fontSize: 13,
      background: active ? "white" : "transparent", color: active ? "#e6178d" : "#6b7280",
      boxShadow: active ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
    }}>{children}</button>
  );
}

// ─── Cell editor (room / program for this month onward + planning note) ───────
function CellEditor({
  name, monthIso, rooms, programs, roomId, programId, note,
  onSetRoom, onClearRoom, onSetProgram, onClearProgram, onSetNote, onClearNote, onManageRooms, onManagePrograms, onClose,
}: {
  name: string; monthIso: string;
  rooms: Room[]; programs: Program[];
  roomId: string | null; programId: string | null; note: MonthNote | null;
  onSetRoom: (id: string | null) => void | Promise<void>;
  onClearRoom: () => void | Promise<void>;
  onSetProgram: (id: string | null) => void | Promise<void>;
  onClearProgram: () => void | Promise<void>;
  onSetNote: (kind: MonthNoteKind, date: string) => void | Promise<void>;
  onClearNote: () => void | Promise<void>;
  onManageRooms: () => void; onManagePrograms: () => void;
  onClose: () => void;
}) {
  const [noteDate, setNoteDate] = useState(note?.note_date ?? monthIso);
  return (
    <Modal title={name} subtitle={`${monthLabelLong(monthOf(monthIso))}${isSecondHalf(monthIso) ? " · 2nd half (16+)" : ""} — applies from this point onward`} onClose={onClose} width={460}>
      <div className="stack" style={{ gap: 16 }}>
        {/* Room */}
        <div className="stack" style={{ gap: 8 }}>
          <div className="row-between"><span style={{ fontWeight: 800, fontSize: 13 }}>Room</span>
            <button className="btn" style={{ padding: "1px 8px", fontSize: 11 }} onClick={onManageRooms}>✎ Edit rooms</button>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <ChipBtn active={roomId === null} onClick={() => onSetRoom(null)}>Unassigned</ChipBtn>
            {rooms.map((r) => (
              <ChipBtn key={r.id} active={roomId === r.id} onClick={() => onSetRoom(r.id)}>
                <RoomDot color={r.color} /> {r.name}
              </ChipBtn>
            ))}
          </div>
          <button className="btn" style={{ alignSelf: "flex-start", padding: "2px 8px", fontSize: 11 }} onClick={onClearRoom}>↩ Clear this month&apos;s change (inherit previous)</button>
        </div>

        <div className="hr" />

        {/* Program */}
        <div className="stack" style={{ gap: 8 }}>
          <div className="row-between"><span style={{ fontWeight: 800, fontSize: 13 }}>Program</span>
            <button className="btn" style={{ padding: "1px 8px", fontSize: 11 }} onClick={onManagePrograms}>✎ Edit programs</button>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <ChipBtn active={programId === null} onClick={() => onSetProgram(null)}>None</ChipBtn>
            {programs.map((p) => (
              <ChipBtn key={p.id} active={programId === p.id} onClick={() => onSetProgram(p.id)}>{p.name}</ChipBtn>
            ))}
          </div>
          <button className="btn" style={{ alignSelf: "flex-start", padding: "2px 8px", fontSize: 11 }} onClick={onClearProgram}>↩ Clear this month&apos;s change (inherit previous)</button>
        </div>

        <div className="hr" />

        {/* Note */}
        <div className="stack" style={{ gap: 8 }}>
          <span style={{ fontWeight: 800, fontSize: 13 }}>Note <span className="subtle" style={{ fontWeight: 400 }}>(a plan to flag — visual only)</span></span>
          <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {(["admit", "promote", "withdraw"] as MonthNoteKind[]).map((k) => {
              const s = NOTE_STYLE[k];
              const active = note?.kind === k;
              return (
                <button key={k} onClick={() => onSetNote(k, noteDate)}
                  style={{ padding: "5px 12px", borderRadius: 8, cursor: "pointer", fontWeight: 800, fontSize: 12,
                    color: active ? "#fff" : s.color, background: active ? s.color : s.bg, border: `1.5px solid ${s.border}` }}>
                  {s.label}
                </button>
              );
            })}
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <span className="subtle" style={{ fontSize: 12 }}>On</span>
            <input className="input" type="date" value={noteDate} onChange={(e) => setNoteDate(e.target.value)} style={{ maxWidth: 170 }} />
            {note && <button className="btn" style={{ padding: "3px 10px", fontSize: 12, color: "#b91c1c" }} onClick={onClearNote}>Clear note</button>}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ChipBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="row" style={{
      gap: 6, alignItems: "center", padding: "5px 12px", borderRadius: 999, cursor: "pointer", fontSize: 13, fontWeight: 700,
      border: `1.5px solid ${active ? "rgba(230,23,141,0.5)" : "#e5e7eb"}`,
      background: active ? "rgba(230,23,141,0.08)" : "white", color: active ? "#e6178d" : "#374151",
    }}>{children}</button>
  );
}

// ─── Withdraw modal (choose the withdrawal month) ─────────────────────────────
function WithdrawModal({ entry, months, onClose, onConfirm }: { entry: RosterEntry; months: string[]; onClose: () => void; onConfirm: (monthIso: string) => void | Promise<void> }) {
  const cur = currentMonthISO();
  const [month, setMonth] = useState(months.includes(cur) ? cur : (months[0] ?? cur));
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Withdraw ${fullName(entry)}`} onClose={onClose} width={440}
      footer={<>
        <span />
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={async () => { setBusy(true); await onConfirm(month); }} disabled={busy}>{busy ? "Withdrawing…" : "Withdraw"}</button>
        </div>
      </>}>
      <div className="stack" style={{ gap: 12 }}>
        <Field label="Withdrawal month" hint="Cells up to and including this month are kept in the Withdrawn log; later months are cleared.">
          <select className="select" value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{monthLabelLong(m)}</option>)}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

// ─── Add-months modal ─────────────────────────────────────────────────────────
function AddMonthsModal({ months, onClose, onAdd }: { months: string[]; onClose: () => void; onAdd: (n: number) => void | Promise<void> }) {
  const last = months[months.length - 1];
  const [n, setN] = useState(12);
  return (
    <Modal title="Add months" subtitle={last ? `Extends past ${monthLabelLong(last)}` : undefined} onClose={onClose} width={400}
      footer={<>
        <span />
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void onAdd(n)}>Add {n} months</button>
        </div>
      </>}>
      <Field label="How many more months?">
        <select className="select" value={n} onChange={(e) => setN(Number(e.target.value))}>
          {[6, 12, 18, 24].map((x) => <option key={x} value={x}>{x} months</option>)}
        </select>
      </Field>
    </Modal>
  );
}

// ─── Simplified roster child edit modal (name / DOB / dates / notes) ──────────
function RosterEntryModal({ entry, campusId, myUserId, onClose, onSaved }: {
  entry?: RosterEntry; campusId: string; myUserId: string | null; onClose: () => void; onSaved: () => void;
}) {
  const mode = entry ? "edit" : "create";
  const [firstName, setFirstName] = useState(entry?.first_name ?? "");
  const [lastName, setLastName] = useState(entry?.last_name ?? "");
  const [dob, setDob] = useState(entry?.date_of_birth ?? "");
  const [prefStart, setPrefStart] = useState(entry?.customer_preferred_start_date ?? "");
  const [enrolled, setEnrolled] = useState(entry?.enrolled_date ?? (mode === "create" ? todayISO() : ""));
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const agePreview = ageYearsMonths(dob, todayISO());

  async function save() {
    if (!firstName.trim() || !lastName.trim()) { setErr("First and last name are required."); return; }
    setSaving(true); setErr("");
    const payload = {
      campus_id: campusId, first_name: firstName.trim(), last_name: lastName.trim(),
      date_of_birth: dob || null, customer_preferred_start_date: prefStart || null,
      enrolled_date: enrolled || null, notes: notes.trim() || null,
      updated_at: new Date().toISOString(), updated_by: myUserId,
    };
    try {
      if (mode === "create") {
        const { error } = await supabase.from("hr_roster_entries").insert({ ...payload, status: "enrolled", created_by: myUserId });
        if (error) throw error;
      } else if (entry) {
        const { error } = await supabase.from("hr_roster_entries").update(payload).eq("id", entry.id);
        if (error) throw error;
      }
      onSaved();
    } catch (e: any) { setErr(e?.message ?? "Could not save"); setSaving(false); }
  }

  return (
    <Modal title={mode === "create" ? "Add student to roster" : `Edit ${fullName(entry!)}`} onClose={onClose} width={560}
      footer={<>
        {err ? <span style={{ color: "#b91c1c", fontSize: 13, fontWeight: 600 }}>{err}</span> : <span />}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : mode === "create" ? "Add student" : "Save changes"}</button>
        </div>
      </>}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 200px" }}><Field label="First name"><input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} /></Field></div>
          <div style={{ flex: "1 1 200px" }}><Field label="Last name"><input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} /></Field></div>
        </div>
        <Field label="Date of birth" hint={agePreview ? `Age: ${agePreview}` : undefined} optional>
          <input className="input" type="date" value={dob} onChange={(e) => setDob(e.target.value)} style={{ maxWidth: 220 }} />
        </Field>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 200px" }}><Field label="Customer preferred start" optional><input className="input" type="date" value={prefStart} onChange={(e) => setPrefStart(e.target.value)} /></Field></div>
          <div style={{ flex: "1 1 200px" }}><Field label="Enrolled date" optional><input className="input" type="date" value={enrolled} onChange={(e) => setEnrolled(e.target.value)} /></Field></div>
        </div>
        <Field label="Notes" optional>
          <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ resize: "vertical", minHeight: 54, padding: "8px 12px" }} />
        </Field>
        <div className="subtle" style={{ fontSize: 12 }}>Room &amp; program are set per-month in the grid — click a month cell.</div>
      </div>
    </Modal>
  );
}
