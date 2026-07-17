"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useDialog } from "@/components/ui/useDialog";
import {
  WaitlistEntry, WaitlistOffer, OfferDraft, Program, Room, OfferStatus, OFFER_STATUS_LABEL, offerCounts,
  fetchWaitlist, fetchOffers, fetchPrograms, fetchRooms, fetchSplitMonths, admitWaitlistEntry,
  ageYearsMonths, ageInMonths, waitlistCompletionDate, fmtDate, siblingLabel, fullName,
  SortState, nextSort, compareForSort, todayISO, APPLICATION_FEE,
  TagItem, saveMonthNoteTags, syncPlannedStartAdmitTag,
} from "@/lib/admissions";
import { Modal, Field, Pill, SortTh, TagListEditor, th, td } from "@/components/hr/admissions/shared";
import ProgramsModal from "@/components/hr/admissions/ProgramsModal";
import RoomsModal from "@/components/hr/admissions/RoomsModal";

type SubFilter = "active" | "admitted" | "removed";

const OFFER_PILL: Record<OfferStatus, { color: string; bg: string; border: string }> = {
  sent: { color: "#a16207", bg: "#fefce8", border: "#fde047" },
  accepted: { color: "#15803d", bg: "#ecfdf5", border: "#86efac" },
  denied: { color: "#b91c1c", bg: "#fef2f2", border: "#fca5a5" },
};

export default function WaitlistView({ campusId, myUserId }: { campusId: string; myUserId: string | null }) {
  const { confirm, modal: dialog } = useDialog();

  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [splitMonths, setSplitMonths] = useState<{ month: string; day: number }[]>([]);
  const [offers, setOffers] = useState<Record<string, WaitlistOffer[]>>({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  const [sub, setSub] = useState<SubFilter>("active");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "planned_start", dir: "asc" });

  // Each sub-view gets a sensible default sort; the user can then click any header.
  useEffect(() => {
    if (sub === "active") setSort({ key: "planned_start", dir: "asc" });
    else if (sub === "admitted") setSort({ key: "date_admitted", dir: "desc" });
    else setSort({ key: "removed_at", dir: "desc" });
  }, [sub]);
  const onSort = (key: string) => setSort((prev) => nextSort(prev, key));

  const [entryModal, setEntryModal] = useState<{ mode: "create" | "edit"; entry?: WaitlistEntry } | null>(null);
  const [offersFor, setOffersFor] = useState<WaitlistEntry | null>(null);
  const [admitFor, setAdmitFor] = useState<WaitlistEntry | null>(null);
  const [programsOpen, setProgramsOpen] = useState(false);
  const [roomsOpen, setRoomsOpen] = useState(false);

  const programById = useMemo(() => Object.fromEntries(programs.map((p) => [p.id, p])), [programs]);
  const roomById = useMemo(() => Object.fromEntries(rooms.map((r) => [r.id, r])), [rooms]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [ent, prog, rms, splits] = await Promise.all([fetchWaitlist(campusId), fetchPrograms(campusId), fetchRooms(campusId), fetchSplitMonths(campusId)]);
      setEntries(ent);
      setPrograms(prog);
      setRooms(rms);
      setSplitMonths(splits);
      setOffers(await fetchOffers(ent.map((e) => e.id)));
      setStatus("");
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    } finally {
      setLoading(false);
    }
  }, [campusId]);

  useEffect(() => { void reload(); }, [reload]);

  async function patchEntry(id: string, patch: Partial<WaitlistEntry>) {
    const { data, error } = await supabase
      .from("hr_waitlist_entries")
      .update({ ...patch, updated_at: new Date().toISOString(), updated_by: myUserId })
      .eq("id", id)
      .select("*")
      .single();
    if (error) { setStatus("Error: " + error.message); return; }
    setEntries((prev) => prev.map((e) => (e.id === id ? (data as WaitlistEntry) : e)));
  }

  async function removeFromWaitlist(e: WaitlistEntry) {
    const ok = await confirm(
      `Remove ${fullName(e)} from the waitlist entirely? This does not admit them. The entry moves to the "Removed" log.`,
      { title: "Remove from waitlist", confirmLabel: "Remove", danger: true }
    );
    if (!ok) return;
    await patchEntry(e.id, { status: "removed", removed_at: new Date().toISOString() });
  }

  async function restoreEntry(e: WaitlistEntry) {
    await patchEntry(e.id, { status: "active", removed_at: null });
  }

  const sortVal = useCallback((e: WaitlistEntry, key: string): string | number | null => {
    switch (key) {
      case "child": return fullName(e).toLowerCase();
      case "completion": return waitlistCompletionDate(e.application_received_date, e.application_fee_paid_date);
      case "program": return (programById[e.program_id ?? ""]?.name ?? "").toLowerCase();
      case "starting_room": return (roomById[e.prospective_room_id ?? ""]?.name ?? "").toLowerCase();
      case "dob": return e.date_of_birth;
      case "customer_preferred": return e.customer_preferred_start_date;
      case "age_customer": return ageInMonths(e.date_of_birth, e.customer_preferred_start_date);
      case "planned_start": return e.planned_start_date;
      case "age_planned": return ageInMonths(e.date_of_birth, e.planned_start_date);
      case "sibling": return (e.sibling_name ?? "").toLowerCase();
      case "app_received": return e.application_received_date;
      case "fee_paid": return e.application_fee_paid_date;
      case "offers": return offers[e.id]?.length ?? 0;
      case "date_admitted": return e.date_admitted;
      case "admitted_room": return (roomById[e.admitted_room_id ?? ""]?.name ?? "").toLowerCase();
      case "removed_at": return e.removed_at;
      default: return null;
    }
  }, [programById, roomById, offers]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = entries.filter((e) => e.status === sub);
    if (q) list = list.filter((e) => fullName(e).toLowerCase().includes(q));
    return [...list].sort((a, b) => {
      const c = compareForSort(sortVal(a, sort.key), sortVal(b, sort.key), sort.dir);
      return c !== 0 ? c : fullName(a).toLowerCase().localeCompare(fullName(b).toLowerCase());
    });
  }, [entries, sub, search, sort, sortVal]);

  const counts = useMemo(() => ({
    active: entries.filter((e) => e.status === "active").length,
    admitted: entries.filter((e) => e.status === "admitted").length,
    removed: entries.filter((e) => e.status === "removed").length,
  }), [entries]);

  const isActive = sub === "active";

  return (
    <div className="stack" style={{ gap: 14 }}>
      {dialog}

      <div className="row-between" style={{ flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <div className="row" style={{ gap: 4, background: "#f3f4f6", padding: 4, borderRadius: 10 }}>
          <SubTab active={sub === "active"} onClick={() => setSub("active")}>Waitlist · {counts.active}</SubTab>
          <SubTab active={sub === "admitted"} onClick={() => setSub("admitted")}>Admitted · {counts.admitted}</SubTab>
          <SubTab active={sub === "removed"} onClick={() => setSub("removed")}>Removed · {counts.removed}</SubTab>
        </div>
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {status ? <span className="badge">{status}</span> : null}
          <input
            className="input"
            placeholder="Search name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 150 }}
          />
          <button className="btn" onClick={() => setRoomsOpen(true)}>🚪 Manage rooms</button>
          <button className="btn" onClick={() => void reload()}>Refresh</button>
          <button className="btn btn-primary" onClick={() => setEntryModal({ mode: "create" })}>+ Add to waitlist</button>
        </div>
      </div>

      {sub === "admitted" && (
        <div className="subtle" style={{ fontSize: 12 }}>
          Log of admitted students&apos; original waitlist entries — including when their application and ${APPLICATION_FEE} fee were received.
        </div>
      )}

      {loading ? (
        <div className="subtle" style={{ padding: 20 }}>Loading…</div>
      ) : visible.length === 0 ? (
        <div className="card">
          <div style={{ fontWeight: 800 }}>
            {sub === "active" ? "No one on the waitlist yet" : sub === "admitted" ? "No admitted entries yet" : "Nothing removed"}
          </div>
          {sub === "active" && (
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => setEntryModal({ mode: "create" })}>
              + Add the first student
            </button>
          )}
        </div>
      ) : (
        <div style={{ overflow: "auto", maxHeight: "70vh", border: "1.5px solid #e5e7eb", borderRadius: 12 }}>
          <table style={{ borderCollapse: "collapse", background: "white", minWidth: "max-content" }}>
            <thead>
              <tr>
                <SortTh label="Child" sortKey="child" sort={sort} onSort={onSort} style={{ left: 0, zIndex: 2, boxShadow: "2px 0 5px -2px rgba(0,0,0,0.12)", position: "sticky" }} />
                <SortTh label="Waitlist Completion" sortKey="completion" sort={sort} onSort={onSort} />
                <SortTh label="Starting Program" sortKey="program" sort={sort} onSort={onSort}>
                  <button
                    className="btn"
                    title="Add / edit programs"
                    onClick={(ev) => { ev.stopPropagation(); setProgramsOpen(true); }}
                    style={{ padding: "1px 7px", fontSize: 11 }}
                  >
                    ✎ Edit
                  </button>
                </SortTh>
                <SortTh label="Starting Room" sortKey="starting_room" sort={sort} onSort={onSort}>
                  <button
                    className="btn"
                    title="Add / edit rooms"
                    onClick={(ev) => { ev.stopPropagation(); setRoomsOpen(true); }}
                    style={{ padding: "1px 7px", fontSize: 11 }}
                  >
                    ✎ Edit
                  </button>
                </SortTh>
                <SortTh label="Date of Birth" sortKey="dob" sort={sort} onSort={onSort} />
                <SortTh label="Customer Preferred Start" sortKey="customer_preferred" sort={sort} onSort={onSort} />
                <SortTh label="Age @ Customer Preferred Start" sortKey="age_customer" sort={sort} onSort={onSort} />
                <SortTh label="Planned Start" sortKey="planned_start" sort={sort} onSort={onSort} />
                <SortTh label="Age @ Planned Start" sortKey="age_planned" sort={sort} onSort={onSort} />
                <SortTh label="Sibling" sortKey="sibling" sort={sort} onSort={onSort} />
                <SortTh label="Application Received" sortKey="app_received" sort={sort} onSort={onSort} />
                <SortTh label={`Fee Paid ($${APPLICATION_FEE})`} sortKey="fee_paid" sort={sort} onSort={onSort} />
                <SortTh label="Offer Log" sortKey="offers" sort={sort} onSort={onSort} />
                {sub === "active" ? (
                  <th style={{ ...th, right: 0, position: "sticky", zIndex: 2, boxShadow: "-2px 0 5px -2px rgba(0,0,0,0.12)" }}>Actions</th>
                ) : (
                  <>
                    {sub === "admitted"
                      ? <SortTh label="Date Admitted" sortKey="date_admitted" sort={sort} onSort={onSort} />
                      : <SortTh label="Removed" sortKey="removed_at" sort={sort} onSort={onSort} />}
                    {sub === "admitted" && <SortTh label="Admitted To" sortKey="admitted_room" sort={sort} onSort={onSort} />}
                    <th style={{ ...th, right: 0, position: "sticky", zIndex: 2 }}>Actions</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {visible.map((e, i) => {
                const rowBg = i % 2 === 0 ? "white" : "#fafafa";
                const entryOffers = offers[e.id] ?? [];
                return (
                  <tr key={e.id} style={{ background: rowBg }}>
                    <td style={{ ...td, left: 0, position: "sticky", background: rowBg, fontWeight: 700, boxShadow: "2px 0 5px -2px rgba(0,0,0,0.12)" }}>
                      {fullName(e)}
                    </td>
                    <td style={td}>
                      {(() => {
                        const comp = waitlistCompletionDate(e.application_received_date, e.application_fee_paid_date);
                        return comp
                          ? <span style={{ color: "#15803d", fontWeight: 700 }}>{fmtDate(comp)}</span>
                          : <span className="subtle">—</span>;
                      })()}
                    </td>
                    <td style={td}>
                      {isActive ? (
                        <select
                          className="select"
                          value={e.program_id ?? ""}
                          onChange={(ev) => void patchEntry(e.id, { program_id: ev.target.value || null })}
                          style={{ fontSize: 12, padding: "4px 6px", maxWidth: 170 }}
                        >
                          <option value="">—</option>
                          {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      ) : (
                        programById[e.program_id ?? ""]?.name ?? "—"
                      )}
                    </td>
                    <td style={td}>
                      {isActive ? (
                        <select
                          className="select"
                          value={e.prospective_room_id ?? ""}
                          onChange={(ev) => void patchEntry(e.id, { prospective_room_id: ev.target.value || null })}
                          style={{ fontSize: 12, padding: "4px 6px", maxWidth: 170 }}
                        >
                          <option value="">Unassigned</option>
                          {rooms.map((rm) => <option key={rm.id} value={rm.id}>{rm.name}</option>)}
                        </select>
                      ) : (
                        roomById[e.prospective_room_id ?? ""]?.name ?? "—"
                      )}
                    </td>
                    <td style={td}>{fmtDate(e.date_of_birth)}</td>
                    <td style={td}>{fmtDate(e.customer_preferred_start_date) || "—"}</td>
                    <td style={td}>{ageYearsMonths(e.date_of_birth, e.customer_preferred_start_date) || "—"}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{fmtDate(e.planned_start_date) || "—"}</td>
                    <td style={td}>{ageYearsMonths(e.date_of_birth, e.planned_start_date) || "—"}</td>
                    <td style={td}>{siblingLabel(e.sibling_name)}</td>
                    <td style={td}>
                      {isActive ? (
                        <DateCell value={e.application_received_date} onChange={(v) => patchEntry(e.id, { application_received_date: v })} />
                      ) : (
                        fmtDate(e.application_received_date) || "—"
                      )}
                    </td>
                    <td style={td}>
                      {isActive ? (
                        <DateCell value={e.application_fee_paid_date} onChange={(v) => patchEntry(e.id, { application_fee_paid_date: v })} />
                      ) : (
                        fmtDate(e.application_fee_paid_date) || "—"
                      )}
                    </td>
                    <td style={td}>
                      <button
                        className="btn"
                        onClick={() => setOffersFor(e)}
                        title="Open the offer log"
                        style={{ padding: "4px 10px", fontSize: 12 }}
                      >
                        <OfferCounters offers={entryOffers} />
                      </button>
                    </td>

                    {sub === "active" ? (
                      <td style={{ ...td, right: 0, position: "sticky", background: rowBg, boxShadow: "-2px 0 5px -2px rgba(0,0,0,0.12)" }}>
                        <div className="row" style={{ gap: 6 }}>
                          <button className="btn btn-primary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setAdmitFor(e)}>Admit</button>
                          <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setEntryModal({ mode: "edit", entry: e })}>Edit</button>
                          <button className="btn" style={{ padding: "4px 10px", fontSize: 12, color: "#b91c1c" }} onClick={() => void removeFromWaitlist(e)}>Remove</button>
                        </div>
                      </td>
                    ) : (
                      <>
                        <td style={td}>{sub === "admitted" ? fmtDate(e.date_admitted) : fmtDate(e.removed_at?.slice(0, 10) ?? null)}</td>
                        {sub === "admitted" && <td style={td}>{roomById[e.admitted_room_id ?? ""]?.name ?? <span className="subtle">Unassigned</span>}</td>}
                        <td style={{ ...td, right: 0, position: "sticky", background: rowBg }}>
                          <div className="row" style={{ gap: 6 }}>
                            <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setEntryModal({ mode: "edit", entry: e })}>View</button>
                            {sub === "removed" && (
                              <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => void restoreEntry(e)}>Restore</button>
                            )}
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {entryModal && (
        <EntryModal
          mode={entryModal.mode}
          entry={entryModal.entry}
          campusId={campusId}
          myUserId={myUserId}
          programs={programs}
          rooms={rooms}
          onManagePrograms={() => setProgramsOpen(true)}
          onManageRooms={() => setRoomsOpen(true)}
          onClose={async () => { setEntryModal(null); setOffers(await fetchOffers(entries.map((e) => e.id))); }}
          onSaved={() => { setEntryModal(null); void reload(); }}
        />
      )}

      {offersFor && (
        <OffersModal
          entry={offersFor}
          myUserId={myUserId}
          offers={offers[offersFor.id] ?? []}
          onClose={() => setOffersFor(null)}
          onChanged={async () => setOffers(await fetchOffers(entries.map((e) => e.id)))}
        />
      )}

      {admitFor && (
        <AdmitModal
          entry={admitFor}
          rooms={rooms}
          programs={programs}
          splitMonths={splitMonths}
          campusId={campusId}
          myUserId={myUserId}
          onClose={() => setAdmitFor(null)}
          onAdmitted={() => { setAdmitFor(null); void reload(); }}
        />
      )}

      {programsOpen && (
        <ProgramsModal
          campusId={campusId}
          onClose={() => setProgramsOpen(false)}
          onChanged={async () => setPrograms(await fetchPrograms(campusId))}
        />
      )}

      {roomsOpen && (
        <RoomsModal
          campusId={campusId}
          onClose={() => setRoomsOpen(false)}
          onChanged={async () => setRooms(await fetchRooms(campusId))}
        />
      )}
    </div>
  );
}

// ─── Inline date cell (native picker, saves on change; clearable) ────────────
function DateCell({ value, onChange }: { value: string | null; onChange: (v: string | null) => void | Promise<void> }) {
  return (
    <input
      type="date"
      className="input"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      style={{ fontSize: 12, padding: "4px 6px", maxWidth: 148, background: value ? "#ecfdf5" : "white" }}
      title={value ? "Set — click to change or clear" : "Not yet"}
    />
  );
}

function YesNoButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "6px 18px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 800, fontSize: 13,
        background: active ? "white" : "transparent", color: active ? "#e6178d" : "#6b7280",
        boxShadow: active ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
      }}
    >
      {children}
    </button>
  );
}

function SubTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 800, fontSize: 13,
        background: active ? "white" : "transparent", color: active ? "#e6178d" : "#6b7280",
        boxShadow: active ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
      }}
    >
      {children}
    </button>
  );
}

// ─── Add / edit waitlist entry ───────────────────────────────────────────────
export function EntryModal({
  mode, entry, campusId, myUserId, programs, rooms, onManagePrograms, onManageRooms, onClose, onSaved,
}: {
  mode: "create" | "edit";
  entry?: WaitlistEntry;
  campusId: string;
  myUserId: string | null;
  programs: Program[];
  rooms: Room[];
  onManagePrograms: () => void;
  onManageRooms: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const readOnlyLog = mode === "edit" && entry && entry.status !== "active";
  const [firstName, setFirstName] = useState(entry?.first_name ?? "");
  const [lastName, setLastName] = useState(entry?.last_name ?? "");
  const [dob, setDob] = useState(entry?.date_of_birth ?? "");
  const [programId, setProgramId] = useState(entry?.program_id ?? "");
  const [roomId, setRoomId] = useState(entry?.prospective_room_id ?? "");
  const [prefStart, setPrefStart] = useState(entry?.customer_preferred_start_date ?? "");
  const [plannedStart, setPlannedStart] = useState(entry?.planned_start_date ?? "");
  const [siblingHas, setSiblingHas] = useState<boolean>(!!(entry?.sibling_name && entry.sibling_name.trim()));
  const [sibling, setSibling] = useState(entry?.sibling_name ?? "");
  const [appReceived, setAppReceived] = useState(entry?.application_received_date ?? "");
  const [feePaid, setFeePaid] = useState(entry?.application_fee_paid_date ?? "");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // Offer log. In edit mode it reads/writes the DB live; in create mode offers
  // are staged locally and inserted after the entry is created.
  const [offers, setOffers] = useState<OfferDraft[]>([]);
  useEffect(() => {
    if (mode === "edit" && entry) {
      fetchOffers([entry.id]).then((m) => setOffers(m[entry.id] ?? [])).catch(() => {});
    }
  }, [mode, entry]);

  const sortOffers = (list: OfferDraft[]) => [...list].sort((a, b) => b.offer_date.localeCompare(a.offer_date));

  async function addOffer(date: string, status: OfferStatus, note: string) {
    const noteVal = note.trim() || null;
    if (mode === "edit" && entry) {
      const { data, error } = await supabase
        .from("hr_waitlist_offers")
        .insert({ waitlist_entry_id: entry.id, offer_date: date, status, note: noteVal, created_by: myUserId })
        .select("*")
        .single();
      if (error) { setErr(error.message); return; }
      setOffers((prev) => sortOffers([...prev, data as WaitlistOffer]));
    } else {
      setOffers((prev) => sortOffers([...prev, { offer_date: date, status, note: noteVal }]));
    }
  }

  async function deleteOffer(o: OfferDraft) {
    if (mode === "edit" && o.id) {
      const { error } = await supabase.from("hr_waitlist_offers").delete().eq("id", o.id);
      if (error) { setErr(error.message); return; }
    }
    setOffers((prev) => prev.filter((x) => (o.id ? x.id !== o.id : x !== o)));
  }

  async function editOffer(o: OfferDraft, note: string) {
    const noteVal = note.trim() || null;
    if (mode === "edit" && o.id) {
      const { error } = await supabase.from("hr_waitlist_offers").update({ note: noteVal }).eq("id", o.id);
      if (error) { setErr(error.message); return; }
      setOffers((prev) => prev.map((x) => (x.id === o.id ? { ...x, note: noteVal } : x)));
    } else {
      setOffers((prev) => prev.map((x) => (x === o ? { ...x, note: noteVal } : x)));
    }
  }

  const agePreview = ageYearsMonths(dob, plannedStart);

  async function save() {
    if (!firstName.trim() || !lastName.trim()) { setErr("First and last name are required."); return; }
    if (!dob) { setErr("Date of birth is required (used to calculate age)."); return; }
    if (siblingHas && !sibling.trim()) { setErr("Enter the sibling's name, or choose No."); return; }
    setSaving(true); setErr("");
    const payload = {
      campus_id: campusId,
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      date_of_birth: dob,
      program_id: programId || null,
      prospective_room_id: roomId || null,
      customer_preferred_start_date: prefStart || null,
      planned_start_date: plannedStart || null,
      sibling_name: siblingHas ? sibling.trim() : null,
      application_received_date: appReceived || null,
      application_fee_paid_date: feePaid || null,
      notes: notes.trim() || null,
      updated_at: new Date().toISOString(),
      updated_by: myUserId,
    };
    try {
      let entryId: string;
      if (mode === "create") {
        const { data, error } = await supabase
          .from("hr_waitlist_entries")
          .insert({ ...payload, created_by: myUserId })
          .select("id")
          .single();
        if (error) throw error;
        entryId = (data as { id: string }).id;
        if (offers.length > 0) {
          const { error: offErr } = await supabase.from("hr_waitlist_offers").insert(
            offers.map((o) => ({ waitlist_entry_id: entryId, offer_date: o.offer_date, status: o.status, note: o.note, created_by: myUserId }))
          );
          if (offErr) throw offErr;
        }
      } else if (entry) {
        entryId = entry.id;
        const { error } = await supabase.from("hr_waitlist_entries").update(payload).eq("id", entryId);
        if (error) throw error;
      } else {
        return;
      }
      // Keep the auto "admit" tag in sync with the planned start date (moves the
      // tag in the roster grid; carries over when the child is admitted).
      await syncPlannedStartAdmitTag(campusId, entryId, plannedStart || null, myUserId);
      onSaved();
    } catch (e: any) {
      setErr(e?.message ?? "Could not save");
      setSaving(false);
    }
  }

  return (
    <Modal
      title={mode === "create" ? "Add to waitlist" : readOnlyLog ? `${fullName(entry!)} (log)` : `Edit ${fullName(entry!)}`}
      subtitle={readOnlyLog ? "This entry has left the active waitlist. You can still correct its details." : undefined}
      onClose={onClose}
      width={620}
      footer={
        <>
          {err ? <span style={{ color: "#b91c1c", fontSize: 13, fontWeight: 600 }}>{err}</span> : <span />}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : mode === "create" ? "Add to waitlist" : "Save changes"}
            </button>
          </div>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px" }}>
            <Field label="First name"><input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} /></Field>
          </div>
          <div style={{ flex: "1 1 220px" }}>
            <Field label="Last name"><input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} /></Field>
          </div>
        </div>

        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px" }}>
            <Field label="Date of birth" hint={agePreview ? `Age at planned start: ${agePreview}` : "Used to calculate age at planned start"}>
              <input className="input" type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
            </Field>
          </div>
          <div style={{ flex: "1 1 220px" }}>
            <Field label="Starting program" hint="Carries over as the starting program when admitted." optional>
              <div className="row" style={{ gap: 6 }}>
                <select className="select" value={programId} onChange={(e) => setProgramId(e.target.value)} style={{ flex: 1 }}>
                  <option value="">— None —</option>
                  {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button className="btn" type="button" onClick={onManagePrograms} title="Add / edit programs">✎</button>
              </div>
            </Field>
          </div>
        </div>

        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px" }}>
            <Field label="Starting room" hint="Shown on the roster grid and prefilled when admitted." optional>
              <div className="row" style={{ gap: 6 }}>
                <select className="select" value={roomId} onChange={(e) => setRoomId(e.target.value)} style={{ flex: 1 }}>
                  <option value="">Unassigned</option>
                  {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}{r.capacity != null ? ` (cap ${r.capacity})` : ""}</option>)}
                </select>
                <button className="btn" type="button" onClick={onManageRooms} title="Add / edit rooms">✎</button>
              </div>
            </Field>
          </div>
          <div style={{ flex: "1 1 220px" }} />
        </div>

        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px" }}>
            <Field label="Customer preferred start" optional><input className="input" type="date" value={prefStart} onChange={(e) => setPrefStart(e.target.value)} /></Field>
          </div>
          <div style={{ flex: "1 1 220px" }}>
            <Field label="Planned start" optional><input className="input" type="date" value={plannedStart} onChange={(e) => setPlannedStart(e.target.value)} /></Field>
          </div>
        </div>

        <Field label="Sibling who is currently attending">
          <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div className="row" style={{ gap: 4, background: "#f3f4f6", padding: 3, borderRadius: 10 }}>
              <YesNoButton active={!siblingHas} onClick={() => setSiblingHas(false)}>No</YesNoButton>
              <YesNoButton active={siblingHas} onClick={() => setSiblingHas(true)}>Yes</YesNoButton>
            </div>
            {siblingHas && (
              <input
                className="input"
                autoFocus
                placeholder="Sibling's name (required)"
                value={sibling}
                onChange={(e) => setSibling(e.target.value)}
                style={{ flex: "1 1 220px" }}
              />
            )}
          </div>
        </Field>

        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px" }}>
            <Field label="Application received" hint="Leave empty until the application arrives." optional>
              <input className="input" type="date" value={appReceived} onChange={(e) => setAppReceived(e.target.value)} />
            </Field>
          </div>
          <div style={{ flex: "1 1 220px" }}>
            <Field label={`Application fee paid ($${APPLICATION_FEE})`} hint="Leave empty until paid." optional>
              <input className="input" type="date" value={feePaid} onChange={(e) => setFeePaid(e.target.value)} />
            </Field>
          </div>
        </div>

        <Field label="Notes" optional>
          <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ resize: "vertical", minHeight: 54, padding: "8px 12px" }} />
        </Field>

        <div className="hr" />
        <div className="stack" style={{ gap: 6 }}>
          <div className="row-between" style={{ alignItems: "center" }}>
            <div style={{ fontWeight: 800, fontSize: 13 }}>Offer log</div>
            <OfferCounters offers={offers} />
          </div>
          <div className="subtle" style={{ fontSize: 12 }}>
            Log an offer when you send it, then add another entry when it&apos;s accepted or denied.
          </div>
          <OfferLogEditor offers={offers} onAdd={addOffer} onDelete={deleteOffer} onEditNote={editOffer} busy={saving} />
        </div>
      </div>
    </Modal>
  );
}

// ─── Offer-log counters (table cell + editor summary) ─────────────────────────
function OfferCount({ glyph, color, count, title }: { glyph: string; color: string; count: number; title: string }) {
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 3, opacity: count === 0 ? 0.5 : 1 }}>
      <span style={{ color, fontWeight: 900, fontSize: 13 }}>{glyph}</span>
      <span style={{ fontWeight: 800, color: "#374151" }}>{count}</span>
    </span>
  );
}

export function OfferCounters({ offers }: { offers: { status: OfferStatus }[] }) {
  const c = offerCounts(offers);
  return (
    <span className="row" style={{ gap: 10, alignItems: "center" }}>
      <OfferCount glyph="✉" color="#6b7280" count={c.sent} title="Sent" />
      <OfferCount glyph="✓" color="#15803d" count={c.accepted} title="Accepted" />
      <OfferCount glyph="✕" color="#b91c1c" count={c.denied} title="Denied" />
    </span>
  );
}

// ─── Offer-log editor (multiple dated offers; each sent/accepted/denied + note) ─
// Presentational: onAdd/onDelete are supplied by the parent, which decides
// whether that's a live DB write (existing entry) or a local draft (new entry).
function OfferRow({ o, onDelete, onEditNote, busy }: {
  o: OfferDraft;
  onDelete: (o: OfferDraft) => void | Promise<void>;
  onEditNote: (o: OfferDraft, note: string) => void | Promise<void>;
  busy?: boolean;
}) {
  const [note, setNote] = useState(o.note ?? "");
  useEffect(() => { setNote(o.note ?? ""); }, [o.note]);
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "8px 12px" }}>
      <div className="row-between" style={{ alignItems: "center" }}>
        <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>{fmtDate(o.offer_date)}</span>
          <Pill label={OFFER_STATUS_LABEL[o.status]} {...OFFER_PILL[o.status]} />
        </div>
        <button className="btn" style={{ padding: "3px 9px", fontSize: 12, color: "#b91c1c" }} onClick={() => void onDelete(o)} disabled={busy}>Delete</button>
      </div>
      <input
        className="input"
        value={note}
        placeholder="Add a note…"
        disabled={busy}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => { if ((o.note ?? "") !== note) void onEditNote(o, note); }}
        style={{ marginTop: 8, fontSize: 13, padding: "6px 10px" }}
      />
    </div>
  );
}

function OfferLogEditor({
  offers, onAdd, onDelete, onEditNote, busy,
}: {
  offers: OfferDraft[];
  onAdd: (date: string, status: OfferStatus, note: string) => void | Promise<void>;
  onDelete: (o: OfferDraft) => void | Promise<void>;
  onEditNote: (o: OfferDraft, note: string) => void | Promise<void>;
  busy?: boolean;
}) {
  const [date, setDate] = useState(todayISO());
  const [status, setStatus] = useState<OfferStatus>("sent");
  const [note, setNote] = useState("");

  async function add() {
    if (!date) return;
    await onAdd(date, status, note);
    setDate(todayISO()); setStatus("sent"); setNote("");
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="stack" style={{ gap: 8 }}>
        {offers.length === 0 ? (
          <div className="subtle">No offers logged yet.</div>
        ) : (
          offers.map((o, i) => <OfferRow key={o.id ?? `draft-${i}`} o={o} onDelete={onDelete} onEditNote={onEditNote} busy={busy} />)
        )}
      </div>

      <div className="hr" />
      <div style={{ fontWeight: 800, fontSize: 13 }}>Log an offer</div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 170 }} />
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value as OfferStatus)}>
          <option value="sent">Sent</option>
          <option value="accepted">Accepted</option>
          <option value="denied">Denied</option>
        </select>
      </div>
      <input className="input" placeholder="Note for this offer (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div><button className="btn btn-primary" onClick={() => void add()} disabled={busy || !date}>Add to log</button></div>
    </div>
  );
}

function OffersModal({
  entry, myUserId, offers, onClose, onChanged,
}: {
  entry: WaitlistEntry;
  myUserId: string | null;
  offers: WaitlistOffer[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { confirm, modal: dialog } = useDialog();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function addOffer(date: string, status: OfferStatus, note: string) {
    setBusy(true); setErr("");
    const { error } = await supabase.from("hr_waitlist_offers").insert({
      waitlist_entry_id: entry.id, offer_date: date, status, note: note.trim() || null, created_by: myUserId,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await onChanged();
  }

  async function deleteOffer(o: OfferDraft) {
    if (!o.id) return;
    if (!(await confirm("Delete this offer from the log?", { title: "Delete offer", confirmLabel: "Delete", danger: true }))) return;
    setBusy(true);
    const { error } = await supabase.from("hr_waitlist_offers").delete().eq("id", o.id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await onChanged();
  }

  async function editOffer(o: OfferDraft, note: string) {
    if (!o.id) return;
    setBusy(true);
    const { error } = await supabase.from("hr_waitlist_offers").update({ note: note.trim() || null }).eq("id", o.id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await onChanged();
  }

  return (
    <Modal title="Offer Log" subtitle={fullName(entry)} onClose={onClose} width={480}>
      {dialog}
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 14, alignItems: "center" }}>
          <span className="subtle" style={{ fontSize: 12, fontWeight: 700 }}>Summary</span>
          <OfferCounters offers={offers} />
        </div>
        <OfferLogEditor offers={offers} onAdd={addOffer} onDelete={deleteOffer} onEditNote={editOffer} busy={busy} />
        {err ? <div style={{ color: "#b91c1c", fontSize: 12, fontWeight: 600 }}>{err}</div> : null}
      </div>
    </Modal>
  );
}

// ─── Admit modal ─────────────────────────────────────────────────────────────
// Pick the child's STARTING room (applied to the admit month only — later months
// are planned in the roster grid). Then create the roster entry.
export function AdmitModal({
  entry, rooms, programs, splitMonths, campusId, myUserId, onClose, onAdmitted,
}: {
  entry: WaitlistEntry;
  rooms: Room[];
  programs: Program[];
  splitMonths: { month: string; day: number }[];
  campusId: string;
  myUserId: string | null;
  onClose: () => void;
  onAdmitted: () => void;
}) {
  const [roomId, setRoomId] = useState<string>(entry.prospective_room_id ?? "");
  const [programId, setProgramId] = useState<string>(entry.program_id ?? "");
  const [tags, setTags] = useState<TagItem[]>([]);
  const [loadedTags, setLoadedTags] = useState<TagItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Preload the waitlist entry's existing planning tags (e.g. the auto Admit tag
  // from its planned start) so they show up — and carry over — when admitting.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("hr_admissions_month_notes")
        .select("id, month, kind, note_date").eq("waitlist_entry_id", entry.id).order("month");
      if (cancelled) return;
      const loaded: TagItem[] = (data ?? []).map((n: any) => ({ id: n.id, kind: n.kind, date: n.note_date ?? n.month, month: n.month }));
      setTags(loaded); setLoadedTags(loaded);
    })();
    return () => { cancelled = true; };
  }, [entry.id]);

  async function admit() {
    setBusy(true); setErr("");
    try {
      const rosterId = await admitWaitlistEntry(entry.id, roomId || null, programId || null);
      // The admit RPC migrates the waitlist entry's notes onto the roster row (same
      // ids), so reconcile against those to honor any tags the admin added/removed here.
      await saveMonthNoteTags(campusId, rosterId, tags, loadedTags, myUserId, { splitMonths, orderedRoomIds: rooms.map((r) => r.id) });
      onAdmitted();
    } catch (e: any) {
      setErr(e?.message ?? "Could not admit");
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Admit ${fullName(entry)}`}
      subtitle="Moves this child onto the roster and files the waitlist entry under “Admitted”."
      onClose={onClose}
      width={460}
      footer={
        <>
          {err ? <span style={{ color: "#b91c1c", fontSize: 13, fontWeight: 600 }}>{err}</span> : <span />}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void admit()} disabled={busy}>{busy ? "Admitting…" : "Confirm admit"}</button>
          </div>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <Field label="Starting room" hint="Just for the admit month — change rooms per-month later in the roster grid.">
          {rooms.length === 0 ? (
            <div className="subtle">No rooms yet. You can admit as <strong>Unassigned</strong> and place them later.</div>
          ) : (
            <select className="select" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">Unassigned</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}{r.capacity != null ? ` (cap ${r.capacity})` : ""}</option>)}
            </select>
          )}
        </Field>
        <Field label="Starting program" hint="Just for the admit month — change programs per-month later in the roster grid.">
          {programs.length === 0 ? (
            <div className="subtle">No programs yet. You can admit with <strong>no program</strong> and set it later.</div>
          ) : (
            <select className="select" value={programId} onChange={(e) => setProgramId(e.target.value)}>
              <option value="">— None —</option>
              {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </Field>
        <Field label="Planning tags" hint="Pick a date and the Admit / Promote / Withdraw tag auto-lands in that month's cell.">
          <TagListEditor tags={tags} onChange={setTags} />
        </Field>
        <div className="subtle" style={{ fontSize: 12 }}>
          Admitting stamps today ({fmtDate(todayISO())}) as the date admitted.
        </div>
      </div>
    </Modal>
  );
}
