"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useDialog } from "@/components/ui/useDialog";
import {
  RosterEntry, Program, Room,
  fetchRoster, fetchPrograms, fetchRooms,
  ageYearsMonths, fmtDate, fullName, todayISO,
  SortState, nextSort, compareForSort,
} from "@/lib/admissions";
import { Modal, Field, SortTh, th, td } from "@/components/hr/admissions/shared";
import RoomsModal from "@/components/hr/admissions/RoomsModal";
import ProgramsModal from "@/components/hr/admissions/ProgramsModal";

type SubFilter = "enrolled" | "withdrawn";

// Shared style for the inline row selects (room / program) so they read as
// tidy controls in the table rather than raw form widgets.
const inlineSelect: React.CSSProperties = {
  fontSize: 13,
  padding: "6px 10px",
  borderRadius: 8,
  maxWidth: 180,
  background: "#fff",
};

export default function RosterView({ campusId, myUserId }: { campusId: string; myUserId: string | null }) {
  const { confirm, modal: dialog } = useDialog();

  const [entries, setEntries] = useState<RosterEntry[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  const [sub, setSub] = useState<SubFilter>("enrolled");
  const [search, setSearch] = useState("");
  const [roomFilter, setRoomFilter] = useState<string>("all"); // "all" | "unassigned" | roomId
  const [sort, setSort] = useState<SortState>({ key: "room", dir: "asc" });
  const onSort = (key: string) => setSort((prev) => nextSort(prev, key));

  const [entryModal, setEntryModal] = useState<{ mode: "create" | "edit"; entry?: RosterEntry } | null>(null);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const [programsOpen, setProgramsOpen] = useState(false);

  const programById = useMemo(() => Object.fromEntries(programs.map((p) => [p.id, p])), [programs]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [ent, prog, rms] = await Promise.all([fetchRoster(campusId), fetchPrograms(campusId), fetchRooms(campusId)]);
      setEntries(ent); setPrograms(prog); setRooms(rms);
      setStatus("");
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    } finally {
      setLoading(false);
    }
  }, [campusId]);

  useEffect(() => { void reload(); }, [reload]);

  async function patchEntry(id: string, patch: Partial<RosterEntry>) {
    const { data, error } = await supabase
      .from("hr_roster_entries")
      .update({ ...patch, updated_at: new Date().toISOString(), updated_by: myUserId })
      .eq("id", id)
      .select("*")
      .single();
    if (error) { setStatus("Error: " + error.message); return; }
    setEntries((prev) => prev.map((e) => (e.id === id ? (data as RosterEntry) : e)));
  }

  async function withdraw(e: RosterEntry) {
    const ok = await confirm(`Withdraw ${fullName(e)} from the roster?`, { title: "Withdraw", confirmLabel: "Withdraw", danger: true });
    if (!ok) return;
    await patchEntry(e.id, { status: "withdrawn", withdrawn_at: new Date().toISOString() });
  }

  async function restore(e: RosterEntry) {
    await patchEntry(e.id, { status: "enrolled", withdrawn_at: null });
  }

  const enrolledForCounts = useMemo(() => entries.filter((e) => e.status === "enrolled"), [entries]);
  const roomCount = useCallback((roomId: string | null) => enrolledForCounts.filter((e) => e.room_id === roomId).length, [enrolledForCounts]);

  const roomOrder = useMemo(() => new Map(rooms.map((r, i) => [r.id, i])), [rooms]);

  const sortVal = useCallback((e: RosterEntry, key: string): string | number | null => {
    switch (key) {
      case "child": return fullName(e).toLowerCase();
      case "room": return e.room_id ? (roomOrder.get(e.room_id) ?? 999) : null;
      case "program": return (programById[e.program_id ?? ""]?.name ?? "").toLowerCase();
      case "dob": return e.date_of_birth;
      case "enrolled": return e.enrolled_date;
      case "source": return e.source_waitlist_entry_id ? "Waitlist" : "Direct";
      default: return null;
    }
  }, [roomOrder, programById]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = entries.filter((e) => e.status === sub);
    if (roomFilter === "unassigned") list = list.filter((e) => !e.room_id);
    else if (roomFilter !== "all") list = list.filter((e) => e.room_id === roomFilter);
    if (q) list = list.filter((e) => fullName(e).toLowerCase().includes(q));
    return [...list].sort((a, b) => {
      const c = compareForSort(sortVal(a, sort.key), sortVal(b, sort.key), sort.dir);
      return c !== 0 ? c : fullName(a).toLowerCase().localeCompare(fullName(b).toLowerCase());
    });
  }, [entries, sub, roomFilter, search, sort, sortVal]);

  const counts = useMemo(() => ({
    enrolled: entries.filter((e) => e.status === "enrolled").length,
    withdrawn: entries.filter((e) => e.status === "withdrawn").length,
  }), [entries]);

  const isEnrolled = sub === "enrolled";

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
          <input className="input" placeholder="Search name…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 200 }} />
          <button className="btn" onClick={() => setRoomsOpen(true)}>🚪 Manage rooms</button>
          <button className="btn" onClick={() => void reload()}>Refresh</button>
          <button className="btn btn-primary" onClick={() => setEntryModal({ mode: "create" })}>+ Add student</button>
        </div>
      </div>

      {/* Room summary chips (double as room filter) */}
      {isEnrolled && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <RoomChip label="All rooms" count={counts.enrolled} active={roomFilter === "all"} onClick={() => setRoomFilter("all")} />
          {rooms.map((r) => (
            <RoomChip
              key={r.id}
              label={r.name}
              count={roomCount(r.id)}
              capacity={r.capacity}
              color={r.color}
              active={roomFilter === r.id}
              onClick={() => setRoomFilter(r.id)}
            />
          ))}
          <RoomChip label="Unassigned" count={roomCount(null)} active={roomFilter === "unassigned"} onClick={() => setRoomFilter("unassigned")} />
        </div>
      )}

      {loading ? (
        <div className="subtle" style={{ padding: 20 }}>Loading…</div>
      ) : visible.length === 0 ? (
        <div className="card">
          <div style={{ fontWeight: 800 }}>{isEnrolled ? "No students on the roster yet" : "No withdrawn students"}</div>
          {isEnrolled && (
            <div className="subtle" style={{ marginTop: 6 }}>
              Add currently-enrolled students here, or admit them from the Waitlist tab.
            </div>
          )}
          {isEnrolled && (
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => setEntryModal({ mode: "create" })}>+ Add student</button>
          )}
        </div>
      ) : (
        <div style={{ overflow: "auto", maxHeight: "70vh", border: "1.5px solid #e5e7eb", borderRadius: 12 }}>
          <table style={{ borderCollapse: "collapse", background: "white", width: "100%", minWidth: "max-content" }}>
            <thead>
              <tr>
                <SortTh label="Child" sortKey="child" sort={sort} onSort={onSort} style={{ left: 0, zIndex: 2, position: "sticky", boxShadow: "2px 0 5px -2px rgba(0,0,0,0.12)" }} />
                <SortTh label="Room" sortKey="room" sort={sort} onSort={onSort} />
                <SortTh label="Program" sortKey="program" sort={sort} onSort={onSort}>
                  <button
                    className="btn"
                    title="Add / edit programs"
                    onClick={(ev) => { ev.stopPropagation(); setProgramsOpen(true); }}
                    style={{ padding: "1px 7px", fontSize: 11 }}
                  >
                    ✎ Edit
                  </button>
                </SortTh>
                <SortTh label="Date of Birth" sortKey="dob" sort={sort} onSort={onSort} />
                <SortTh label="Enrolled" sortKey="enrolled" sort={sort} onSort={onSort} />
                <SortTh label="Source" sortKey="source" sort={sort} onSort={onSort} />
                <th style={{ ...th, right: 0, position: "sticky", zIndex: 2, boxShadow: "-2px 0 5px -2px rgba(0,0,0,0.12)" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e, i) => {
                const rowBg = i % 2 === 0 ? "white" : "#fafafa";
                return (
                  <tr key={e.id} style={{ background: rowBg }}>
                    <td style={{ ...td, left: 0, position: "sticky", background: rowBg, fontWeight: 700, boxShadow: "2px 0 5px -2px rgba(0,0,0,0.12)" }}>{fullName(e)}</td>
                    <td style={td}>
                      {(() => {
                        const roomColor = rooms.find((r) => r.id === e.room_id)?.color;
                        return isEnrolled ? (
                          <select
                            className="select"
                            value={e.room_id ?? ""}
                            onChange={(ev) => void patchEntry(e.id, { room_id: ev.target.value || null })}
                            style={{ ...inlineSelect, borderLeft: `5px solid ${roomColor ?? "#e5e7eb"}` }}
                          >
                            <option value="">Unassigned</option>
                            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                          </select>
                        ) : (
                          <span className="row" style={{ gap: 8, alignItems: "center" }}>
                            <RoomDot color={roomColor} />
                            {rooms.find((r) => r.id === e.room_id)?.name ?? <span className="subtle">Unassigned</span>}
                          </span>
                        );
                      })()}
                    </td>
                    <td style={td}>
                      {isEnrolled ? (
                        <select className="select" value={e.program_id ?? ""} onChange={(ev) => void patchEntry(e.id, { program_id: ev.target.value || null })} style={inlineSelect}>
                          <option value="">— None —</option>
                          {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      ) : (
                        programById[e.program_id ?? ""]?.name ?? "—"
                      )}
                    </td>
                    <td style={td}>{fmtDate(e.date_of_birth) || "—"}</td>
                    <td style={td}>{fmtDate(e.enrolled_date) || "—"}</td>
                    <td style={td}>{e.source_waitlist_entry_id ? <span className="subtle">Waitlist</span> : <span className="subtle">Direct</span>}</td>
                    <td style={{ ...td, right: 0, position: "sticky", background: rowBg, boxShadow: "-2px 0 5px -2px rgba(0,0,0,0.12)" }}>
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setEntryModal({ mode: "edit", entry: e })}>{isEnrolled ? "Edit" : "View"}</button>
                        {isEnrolled ? (
                          <button className="btn" style={{ padding: "4px 10px", fontSize: 12, color: "#b91c1c" }} onClick={() => void withdraw(e)}>Withdraw</button>
                        ) : (
                          <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => void restore(e)}>Restore</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {entryModal && (
        <RosterEntryModal
          mode={entryModal.mode}
          entry={entryModal.entry}
          campusId={campusId}
          myUserId={myUserId}
          programs={programs}
          rooms={rooms}
          onClose={() => setEntryModal(null)}
          onSaved={() => { setEntryModal(null); void reload(); }}
        />
      )}

      {roomsOpen && (
        <RoomsModal campusId={campusId} onClose={() => setRoomsOpen(false)} onChanged={async () => setRooms(await fetchRooms(campusId))} />
      )}

      {programsOpen && (
        <ProgramsModal campusId={campusId} onClose={() => setProgramsOpen(false)} onChanged={async () => setPrograms(await fetchPrograms(campusId))} />
      )}
    </div>
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

function RoomDot({ color }: { color?: string | null }) {
  return (
    <span style={{
      width: 10, height: 10, borderRadius: 999, flexShrink: 0, display: "inline-block",
      background: color ?? "transparent", border: color ? "none" : "1.5px solid #d1d5db",
    }} />
  );
}

function RoomChip({ label, count, capacity, color, active, onClick }: { label: string; count: number; capacity?: number | null; color?: string; active: boolean; onClick: () => void }) {
  const over = capacity != null && count > capacity;
  return (
    <button onClick={onClick} style={{
      display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 999, cursor: "pointer",
      border: `1.5px solid ${active ? "rgba(230,23,141,0.5)" : "#e5e7eb"}`,
      background: active ? "rgba(230,23,141,0.08)" : "white",
      color: active ? "#e6178d" : "#374151", fontWeight: 700, fontSize: 13,
    }}>
      {color ? <RoomDot color={color} /> : null}
      {label}
      <span style={{ fontSize: 12, fontWeight: 800, color: over ? "#b91c1c" : "#6b7280" }}>
        {count}{capacity != null ? `/${capacity}` : ""}
      </span>
    </button>
  );
}

// ─── Add / edit roster student ───────────────────────────────────────────────
function RosterEntryModal({
  mode, entry, campusId, myUserId, programs, rooms, onClose, onSaved,
}: {
  mode: "create" | "edit";
  entry?: RosterEntry;
  campusId: string;
  myUserId: string | null;
  programs: Program[];
  rooms: Room[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [firstName, setFirstName] = useState(entry?.first_name ?? "");
  const [lastName, setLastName] = useState(entry?.last_name ?? "");
  const [dob, setDob] = useState(entry?.date_of_birth ?? "");
  const [roomId, setRoomId] = useState(entry?.room_id ?? "");
  const [programId, setProgramId] = useState(entry?.program_id ?? "");
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
      campus_id: campusId,
      room_id: roomId || null,
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      date_of_birth: dob || null,
      program_id: programId || null,
      customer_preferred_start_date: prefStart || null,
      enrolled_date: enrolled || null,
      notes: notes.trim() || null,
      updated_at: new Date().toISOString(),
      updated_by: myUserId,
    };
    try {
      if (mode === "create") {
        const { error } = await supabase.from("hr_roster_entries").insert({ ...payload, created_by: myUserId });
        if (error) throw error;
      } else if (entry) {
        const { error } = await supabase.from("hr_roster_entries").update(payload).eq("id", entry.id);
        if (error) throw error;
      }
      onSaved();
    } catch (e: any) {
      setErr(e?.message ?? "Could not save");
      setSaving(false);
    }
  }

  return (
    <Modal
      title={mode === "create" ? "Add student to roster" : `Edit ${fullName(entry!)}`}
      onClose={onClose}
      width={620}
      footer={
        <>
          {err ? <span style={{ color: "#b91c1c", fontSize: 13, fontWeight: 600 }}>{err}</span> : <span />}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : mode === "create" ? "Add student" : "Save changes"}</button>
          </div>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px" }}><Field label="First name"><input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} /></Field></div>
          <div style={{ flex: "1 1 220px" }}><Field label="Last name"><input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} /></Field></div>
        </div>

        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 200px" }}>
            <Field label="Room" optional>
              <select className="select" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                <option value="">Unassigned</option>
                {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ flex: "1 1 200px" }}>
            <Field label="Program" optional>
              <select className="select" value={programId} onChange={(e) => setProgramId(e.target.value)}>
                <option value="">— None —</option>
                {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ flex: "1 1 200px" }}>
            <Field label="Date of birth" hint={agePreview ? `Age: ${agePreview}` : undefined} optional>
              <input className="input" type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
            </Field>
          </div>
        </div>

        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px" }}><Field label="Customer preferred start" optional><input className="input" type="date" value={prefStart} onChange={(e) => setPrefStart(e.target.value)} /></Field></div>
          <div style={{ flex: "1 1 220px" }}><Field label="Enrolled date" optional><input className="input" type="date" value={enrolled} onChange={(e) => setEnrolled(e.target.value)} /></Field></div>
        </div>

        <Field label="Notes" optional>
          <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ resize: "vertical", minHeight: 54, padding: "8px 12px" }} />
        </Field>
      </div>
    </Modal>
  );
}
