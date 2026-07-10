"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useDialog } from "@/components/ui/useDialog";
import {
  RosterEntry, WaitlistEntry, WaitlistOffer, Program, Room,
  fetchRoster, fetchPrograms, fetchRooms, fetchWaitlist, fetchOffers,
  ageYearsMonths, ageInMonths, waitlistCompletionDate, fmtDate, siblingLabel, fullName, todayISO, APPLICATION_FEE,
  SortState, nextSort, compareForSort,
} from "@/lib/admissions";
import { Modal, Field, SortTh, RoomDot, inlineSelect, th, td } from "@/components/hr/admissions/shared";
import RoomsModal from "@/components/hr/admissions/RoomsModal";
import ProgramsModal from "@/components/hr/admissions/ProgramsModal";
import { EntryModal as WaitlistEntryModal, AdmitModal, OfferCounters } from "@/components/hr/admissions/WaitlistView";

type SubFilter = "enrolled" | "withdrawn";

const ROSTER_SORT_LABEL: Record<string, string> = {
  child: "Child", room: "Room", program: "Program", dob: "Date of Birth", enrolled: "Enrolled", source: "Source",
};

export default function RosterView({ campusId, myUserId }: { campusId: string; myUserId: string | null }) {
  const { confirm, modal: dialog } = useDialog();

  const [entries, setEntries] = useState<RosterEntry[]>([]);
  const [wlEntries, setWlEntries] = useState<WaitlistEntry[]>([]);
  const [wlOffers, setWlOffers] = useState<Record<string, WaitlistOffer[]>>({});
  const [programs, setPrograms] = useState<Program[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  const [sub, setSub] = useState<SubFilter>("enrolled");
  const [search, setSearch] = useState("");
  const [roomFilter, setRoomFilter] = useState<string>("all"); // "all" | "unassigned" | roomId
  const [sort, setSort] = useState<SortState>({ key: "room", dir: "asc" });
  const onSort = (key: string) => setSort((prev) => nextSort(prev, key));
  // Independent sort for the per-room prospective (waitlist) sub-tables.
  const [wlSort, setWlSort] = useState<SortState>({ key: "planned_start", dir: "asc" });
  const onWlSort = (key: string) => setWlSort((prev) => nextSort(prev, key));

  const [entryModal, setEntryModal] = useState<{ mode: "create" | "edit"; entry?: RosterEntry } | null>(null);
  const [wlEntryModal, setWlEntryModal] = useState<{ entry: WaitlistEntry } | null>(null);
  const [admitFor, setAdmitFor] = useState<WaitlistEntry | null>(null);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const [programsOpen, setProgramsOpen] = useState(false);

  const programById = useMemo(() => Object.fromEntries(programs.map((p) => [p.id, p])), [programs]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [ent, prog, rms, wl] = await Promise.all([
        fetchRoster(campusId), fetchPrograms(campusId), fetchRooms(campusId), fetchWaitlist(campusId),
      ]);
      const wlActive = wl.filter((w) => w.status === "active");
      setEntries(ent); setPrograms(prog); setRooms(rms); setWlEntries(wlActive);
      setWlOffers(await fetchOffers(wlActive.map((w) => w.id)));
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
  const prospectiveCount = useCallback((roomId: string | null) => wlEntries.filter((w) => (w.prospective_room_id ?? null) === roomId).length, [wlEntries]);

  const roomOrder = useMemo(() => new Map(rooms.map((r, i) => [r.id, i])), [rooms]);

  // ── Sort accessors ───────────────────────────────────────────────────────────
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

  const wlSortVal = useCallback((e: WaitlistEntry, key: string): string | number | null => {
    switch (key) {
      case "child": return fullName(e).toLowerCase();
      case "completion": return waitlistCompletionDate(e.application_received_date, e.application_fee_paid_date);
      case "program": return (programById[e.program_id ?? ""]?.name ?? "").toLowerCase();
      case "dob": return e.date_of_birth;
      case "customer_preferred": return e.customer_preferred_start_date;
      case "age_customer": return ageInMonths(e.date_of_birth, e.customer_preferred_start_date);
      case "planned_start": return e.planned_start_date;
      case "age_planned": return ageInMonths(e.date_of_birth, e.planned_start_date);
      case "sibling": return (e.sibling_name ?? "").toLowerCase();
      case "app_received": return e.application_received_date;
      case "fee_paid": return e.application_fee_paid_date;
      case "offers": return wlOffers[e.id]?.length ?? 0;
      default: return null;
    }
  }, [programById, wlOffers]);

  const isEnrolled = sub === "enrolled";
  // Grouped by room (with prospective waitlist sub-tables) only when the roster is
  // sorted by Room. Any other sort collapses to a flat list and hides waitlist tables.
  const grouped = isEnrolled && sort.key === "room";

  // Flat list (used for the withdrawn tab and for enrolled sorted by a non-room column).
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

  // Grouped structure: per-room roster students + prospective waitlist entries.
  const groups = useMemo(() => {
    if (!grouped) return [];
    const q = search.trim().toLowerCase();
    const rosterEnrolled = entries.filter((e) => e.status === "enrolled" && (!q || fullName(e).toLowerCase().includes(q)));
    const wlActive = wlEntries.filter((w) => !q || fullName(w).toLowerCase().includes(q));
    const byName = (a: { first_name: string; last_name: string }, b: { first_name: string; last_name: string }) =>
      fullName(a).toLowerCase().localeCompare(fullName(b).toLowerCase());
    const wlSorted = (list: WaitlistEntry[]) => [...list].sort((a, b) => {
      const c = compareForSort(wlSortVal(a, wlSort.key), wlSortVal(b, wlSort.key), wlSort.dir);
      return c !== 0 ? c : byName(a, b);
    });

    const mk = (room: Room | null) => {
      const rid = room?.id ?? null;
      return {
        key: rid ?? "__unassigned__",
        room,
        roster: rosterEnrolled.filter((e) => (e.room_id ?? null) === rid).sort(byName),
        waitlist: wlSorted(wlActive.filter((w) => (w.prospective_room_id ?? null) === rid)),
      };
    };

    let candidates: (Room | null)[];
    if (roomFilter === "unassigned") candidates = [null];
    else if (roomFilter === "all") candidates = [...rooms, null];
    else candidates = [rooms.find((r) => r.id === roomFilter) ?? null];

    const result = candidates.map(mk);
    if (roomFilter === "all") return result.filter((g) => g.roster.length > 0 || g.waitlist.length > 0);
    return result;
  }, [grouped, entries, wlEntries, rooms, roomFilter, search, wlSort, wlSortVal]);

  const counts = useMemo(() => ({
    enrolled: entries.filter((e) => e.status === "enrolled").length,
    withdrawn: entries.filter((e) => e.status === "withdrawn").length,
  }), [entries]);

  const rosterHandlers = {
    isEnrolled, rooms, programs, programById,
    onPatch: patchEntry,
    onEdit: (e: RosterEntry) => setEntryModal({ mode: "edit", entry: e }),
    onWithdraw: withdraw,
    onRestore: restore,
  };

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

      {/* Room summary chips — enrolled count (room color) + prospective count (gray) */}
      {isEnrolled && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <RoomChip label="All rooms" enrolled={counts.enrolled} prospective={wlEntries.length} active={roomFilter === "all"} onClick={() => setRoomFilter("all")} />
          {rooms.map((r) => (
            <RoomChip key={r.id} label={r.name} enrolled={roomCount(r.id)} prospective={prospectiveCount(r.id)} capacity={r.capacity} color={r.color} active={roomFilter === r.id} onClick={() => setRoomFilter(r.id)} />
          ))}
          <RoomChip label="Unassigned" enrolled={roomCount(null)} prospective={prospectiveCount(null)} active={roomFilter === "unassigned"} onClick={() => setRoomFilter("unassigned")} />
        </div>
      )}

      {/* Flat-mode hint (enrolled, sorted by a non-room column) */}
      {isEnrolled && !grouped && (
        <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "8px 12px" }}>
          <span style={{ fontSize: 13, color: "#92400e" }}>
            Sorted by <b>{ROSTER_SORT_LABEL[sort.key] ?? sort.key}</b> — prospective waitlist entries are hidden while sorting by a non-room column.
          </span>
          <button className="btn" onClick={() => setSort({ key: "room", dir: "asc" })}>Sort by Room to show them</button>
        </div>
      )}

      {loading ? (
        <div className="subtle" style={{ padding: 20 }}>Loading…</div>
      ) : grouped ? (
        groups.length === 0 ? (
          <EmptyRoster onAdd={() => setEntryModal({ mode: "create" })} />
        ) : (
          <div className="stack" style={{ gap: 16 }}>
            {groups.map((g) => (
              <RoomSection
                key={g.key}
                group={g}
                sort={sort} onSort={onSort} onEditPrograms={() => setProgramsOpen(true)}
                rosterHandlers={rosterHandlers}
                wlSort={wlSort} onWlSort={onWlSort} wlOffers={wlOffers}
                onAdmit={(e) => setAdmitFor(e)} onWlEdit={(e) => setWlEntryModal({ entry: e })}
              />
            ))}
          </div>
        )
      ) : visible.length === 0 ? (
        <EmptyRoster withdrawn={!isEnrolled} onAdd={() => setEntryModal({ mode: "create" })} />
      ) : (
        <div style={{ overflow: "auto", maxHeight: "70vh", border: "1.5px solid #e5e7eb", borderRadius: 12 }}>
          <table style={{ borderCollapse: "collapse", background: "white", width: "100%", minWidth: "max-content" }}>
            <RosterHead sort={sort} onSort={onSort} onEditPrograms={() => setProgramsOpen(true)} sticky />
            <tbody>
              <RosterRows entries={visible} sticky {...rosterHandlers} />
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

      {wlEntryModal && (
        <WaitlistEntryModal
          mode="edit"
          entry={wlEntryModal.entry}
          campusId={campusId}
          myUserId={myUserId}
          programs={programs}
          rooms={rooms}
          onManagePrograms={() => setProgramsOpen(true)}
          onClose={() => { setWlEntryModal(null); void reload(); }}
          onSaved={() => { setWlEntryModal(null); void reload(); }}
        />
      )}

      {admitFor && (
        <AdmitModal
          entry={admitFor}
          rooms={rooms}
          onClose={() => setAdmitFor(null)}
          onAdmitted={() => { setAdmitFor(null); void reload(); }}
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

// ─── Roster table pieces (shared by flat table + per-room sections) ───────────

type RosterHandlers = {
  isEnrolled: boolean;
  rooms: Room[];
  programs: Program[];
  programById: Record<string, Program>;
  onPatch: (id: string, patch: Partial<RosterEntry>) => void | Promise<void>;
  onEdit: (e: RosterEntry) => void;
  onWithdraw: (e: RosterEntry) => void | Promise<void>;
  onRestore: (e: RosterEntry) => void | Promise<void>;
};

function RosterHead({ sort, onSort, onEditPrograms, sticky }: { sort: SortState; onSort: (k: string) => void; onEditPrograms: () => void; sticky?: boolean }) {
  const childStyle: React.CSSProperties = sticky ? { left: 0, zIndex: 2, position: "sticky", boxShadow: "2px 0 5px -2px rgba(0,0,0,0.12)" } : {};
  const actStyle: React.CSSProperties = sticky ? { right: 0, position: "sticky", zIndex: 2, boxShadow: "-2px 0 5px -2px rgba(0,0,0,0.12)" } : {};
  return (
    <thead>
      <tr>
        <SortTh label="Child" sortKey="child" sort={sort} onSort={onSort} style={childStyle} />
        <SortTh label="Room" sortKey="room" sort={sort} onSort={onSort} />
        <SortTh label="Program" sortKey="program" sort={sort} onSort={onSort}>
          <button className="btn" title="Add / edit programs" onClick={(ev) => { ev.stopPropagation(); onEditPrograms(); }} style={{ padding: "1px 7px", fontSize: 11 }}>✎ Edit</button>
        </SortTh>
        <SortTh label="Date of Birth" sortKey="dob" sort={sort} onSort={onSort} />
        <SortTh label="Enrolled" sortKey="enrolled" sort={sort} onSort={onSort} />
        <SortTh label="Source" sortKey="source" sort={sort} onSort={onSort} />
        <th style={{ ...th, ...actStyle }}>Actions</th>
      </tr>
    </thead>
  );
}

function RosterRows({ entries, sticky, isEnrolled, rooms, programs, programById, onPatch, onEdit, onWithdraw, onRestore }: RosterHandlers & { entries: RosterEntry[]; sticky?: boolean }) {
  return (
    <>
      {entries.map((e, i) => {
        const rowBg = i % 2 === 0 ? "white" : "#fafafa";
        const roomColor = rooms.find((r) => r.id === e.room_id)?.color;
        const childStyle: React.CSSProperties = sticky ? { left: 0, position: "sticky", boxShadow: "2px 0 5px -2px rgba(0,0,0,0.12)" } : {};
        const actStyle: React.CSSProperties = sticky ? { right: 0, position: "sticky", boxShadow: "-2px 0 5px -2px rgba(0,0,0,0.12)" } : {};
        return (
          <tr key={e.id} style={{ background: rowBg }}>
            <td style={{ ...td, ...childStyle, background: rowBg, fontWeight: 700 }}>{fullName(e)}</td>
            <td style={td}>
              {isEnrolled ? (
                <select className="select" value={e.room_id ?? ""} onChange={(ev) => void onPatch(e.id, { room_id: ev.target.value || null })} style={{ ...inlineSelect, borderLeft: `5px solid ${roomColor ?? "#e5e7eb"}` }}>
                  <option value="">Unassigned</option>
                  {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              ) : (
                <span className="row" style={{ gap: 8, alignItems: "center" }}>
                  <RoomDot color={roomColor} />
                  {rooms.find((r) => r.id === e.room_id)?.name ?? <span className="subtle">Unassigned</span>}
                </span>
              )}
            </td>
            <td style={td}>
              {isEnrolled ? (
                <select className="select" value={e.program_id ?? ""} onChange={(ev) => void onPatch(e.id, { program_id: ev.target.value || null })} style={inlineSelect}>
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
            <td style={{ ...td, ...actStyle, background: rowBg }}>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => onEdit(e)}>{isEnrolled ? "Edit" : "View"}</button>
                {isEnrolled ? (
                  <button className="btn" style={{ padding: "4px 10px", fontSize: 12, color: "#b91c1c" }} onClick={() => void onWithdraw(e)}>Withdraw</button>
                ) : (
                  <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => void onRestore(e)}>Restore</button>
                )}
              </div>
            </td>
          </tr>
        );
      })}
    </>
  );
}

// ─── One room group: enrolled roster table + dimmed prospective waitlist table ─

type RoomGroup = { key: string; room: Room | null; roster: RosterEntry[]; waitlist: WaitlistEntry[] };

function RoomSection({
  group, sort, onSort, onEditPrograms, rosterHandlers, wlSort, onWlSort, wlOffers, onAdmit, onWlEdit,
}: {
  group: RoomGroup;
  sort: SortState;
  onSort: (k: string) => void;
  onEditPrograms: () => void;
  rosterHandlers: RosterHandlers;
  wlSort: SortState;
  onWlSort: (k: string) => void;
  wlOffers: Record<string, WaitlistOffer[]>;
  onAdmit: (e: WaitlistEntry) => void;
  onWlEdit: (e: WaitlistEntry) => void;
}) {
  const { room, roster, waitlist } = group;
  const cap = room?.capacity;
  const over = cap != null && roster.length > cap;
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="row" style={{ gap: 10, alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #eee", background: "#fafafa", flexWrap: "wrap" }}>
        <RoomDot color={room?.color} />
        <span style={{ fontWeight: 800, fontSize: 15 }}>{room?.name ?? "Unassigned"}</span>
        <span className="subtle" style={{ fontSize: 12 }}>
          <b style={{ color: over ? "#b91c1c" : "#374151" }}>{roster.length}{cap != null ? `/${cap}` : ""}</b> enrolled · <b>{waitlist.length}</b> prospective
        </span>
      </div>

      {roster.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", background: "white", width: "100%", minWidth: "max-content" }}>
            <RosterHead sort={sort} onSort={onSort} onEditPrograms={onEditPrograms} />
            <tbody>
              <RosterRows entries={roster} {...rosterHandlers} />
            </tbody>
          </table>
        </div>
      ) : (
        <div className="subtle" style={{ padding: "12px 14px", fontSize: 13 }}>No enrolled students in this room yet.</div>
      )}

      {waitlist.length > 0 && (
        <WaitlistSubTable entries={waitlist} wlOffers={wlOffers} programById={rosterHandlers.programById} sort={wlSort} onSort={onWlSort} onAdmit={onAdmit} onEdit={onWlEdit} />
      )}
    </div>
  );
}

// ─── Prospective (waitlist) sub-table — full waitlist fields, dimmed, own sort ─

function WaitlistSubTable({
  entries, wlOffers, programById, sort, onSort, onAdmit, onEdit,
}: {
  entries: WaitlistEntry[];
  wlOffers: Record<string, WaitlistOffer[]>;
  programById: Record<string, Program>;
  sort: SortState;
  onSort: (k: string) => void;
  onAdmit: (e: WaitlistEntry) => void;
  onEdit: (e: WaitlistEntry) => void;
}) {
  return (
    <div style={{ background: "#f9fafb", borderTop: "2px dashed #e5e7eb" }}>
      <div className="row" style={{ gap: 8, alignItems: "center", padding: "8px 14px 4px", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 800, fontSize: 12, color: "#6b7280" }}>🕒 Prospective — from the waitlist ({entries.length})</span>
        <span className="subtle" style={{ fontSize: 11 }}>Not yet admitted. Sort these independently of the roster.</span>
      </div>
      <div style={{ overflowX: "auto", opacity: 0.78 }}>
        <table style={{ borderCollapse: "collapse", minWidth: "max-content", background: "transparent" }}>
          <thead>
            <tr>
              <SortTh label="Child" sortKey="child" sort={sort} onSort={onSort} style={{ background: "#f3f4f6" }} />
              <SortTh label="Waitlist Completion" sortKey="completion" sort={sort} onSort={onSort} style={{ background: "#f3f4f6" }} />
              <SortTh label="Program" sortKey="program" sort={sort} onSort={onSort} style={{ background: "#f3f4f6" }} />
              <SortTh label="Date of Birth" sortKey="dob" sort={sort} onSort={onSort} style={{ background: "#f3f4f6" }} />
              <SortTh label="Customer Preferred Start" sortKey="customer_preferred" sort={sort} onSort={onSort} style={{ background: "#f3f4f6" }} />
              <SortTh label="Age @ Customer Preferred Start" sortKey="age_customer" sort={sort} onSort={onSort} style={{ background: "#f3f4f6" }} />
              <SortTh label="Planned Start" sortKey="planned_start" sort={sort} onSort={onSort} style={{ background: "#f3f4f6" }} />
              <SortTh label="Age @ Planned Start" sortKey="age_planned" sort={sort} onSort={onSort} style={{ background: "#f3f4f6" }} />
              <SortTh label="Sibling" sortKey="sibling" sort={sort} onSort={onSort} style={{ background: "#f3f4f6" }} />
              <SortTh label="Application Received" sortKey="app_received" sort={sort} onSort={onSort} style={{ background: "#f3f4f6" }} />
              <SortTh label={`Fee Paid ($${APPLICATION_FEE})`} sortKey="fee_paid" sort={sort} onSort={onSort} style={{ background: "#f3f4f6" }} />
              <SortTh label="Offer Log" sortKey="offers" sort={sort} onSort={onSort} style={{ background: "#f3f4f6" }} />
              <th style={{ ...th, background: "#f3f4f6" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => {
              const rowBg = i % 2 === 0 ? "transparent" : "#f1f2f4";
              const comp = waitlistCompletionDate(e.application_received_date, e.application_fee_paid_date);
              return (
                <tr key={e.id} style={{ background: rowBg }}>
                  <td style={{ ...td, fontWeight: 700, fontStyle: "italic" }}>{fullName(e)}</td>
                  <td style={td}>{comp ? <span style={{ color: "#15803d", fontWeight: 700 }}>{fmtDate(comp)}</span> : <span className="subtle">—</span>}</td>
                  <td style={td}>{programById[e.program_id ?? ""]?.name ?? "—"}</td>
                  <td style={td}>{fmtDate(e.date_of_birth) || "—"}</td>
                  <td style={td}>{fmtDate(e.customer_preferred_start_date) || "—"}</td>
                  <td style={td}>{ageYearsMonths(e.date_of_birth, e.customer_preferred_start_date) || "—"}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{fmtDate(e.planned_start_date) || "—"}</td>
                  <td style={td}>{ageYearsMonths(e.date_of_birth, e.planned_start_date) || "—"}</td>
                  <td style={td}>{siblingLabel(e.sibling_name)}</td>
                  <td style={td}>{fmtDate(e.application_received_date) || "—"}</td>
                  <td style={td}>{fmtDate(e.application_fee_paid_date) || "—"}</td>
                  <td style={td}><OfferCounters offers={wlOffers[e.id] ?? []} /></td>
                  <td style={td}>
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn btn-primary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => onAdmit(e)}>Admit</button>
                      <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => onEdit(e)}>Edit</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmptyRoster({ withdrawn, onAdd }: { withdrawn?: boolean; onAdd: () => void }) {
  return (
    <div className="card">
      <div style={{ fontWeight: 800 }}>{withdrawn ? "No withdrawn students" : "No students on the roster yet"}</div>
      {!withdrawn && (
        <>
          <div className="subtle" style={{ marginTop: 6 }}>Add currently-enrolled students here, or admit them from the Waitlist tab.</div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={onAdd}>+ Add student</button>
        </>
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

function RoomChip({ label, enrolled, prospective, capacity, color, active, onClick }: { label: string; enrolled: number; prospective: number; capacity?: number | null; color?: string; active: boolean; onClick: () => void }) {
  const over = capacity != null && enrolled > capacity;
  return (
    <button onClick={onClick} style={{
      display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 999, cursor: "pointer",
      border: `1.5px solid ${active ? "rgba(230,23,141,0.5)" : "#e5e7eb"}`,
      background: active ? "rgba(230,23,141,0.08)" : "white",
      color: active ? "#e6178d" : "#374151", fontWeight: 700, fontSize: 13,
    }}>
      {color ? <RoomDot color={color} /> : null}
      {label}
      <span title="Enrolled" style={{ fontSize: 12, fontWeight: 800, color: over ? "#b91c1c" : (color ?? "#374151") }}>
        {enrolled}{capacity != null ? `/${capacity}` : ""}
      </span>
      <span title="Prospective (waitlist)" style={{ fontSize: 12, fontWeight: 800, color: "#9ca3af" }}>+{prospective}</span>
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
