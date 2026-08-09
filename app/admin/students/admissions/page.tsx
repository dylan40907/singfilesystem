"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import { canEditStudents } from "@/lib/hrAccess";
import { useCampusFilter, PROGRAM_LABEL, PROGRAM_ORDER } from "@/lib/CampusContext";
import { useEscapeKey } from "@/components/ui/useEscapeKey";
import WaitlistView from "@/components/hr/admissions/WaitlistView";
import RosterView from "@/components/hr/admissions/RosterView";

type Tab = "waitlist" | "roster";

export default function AdmissionsPage() {
  // We read the campus *list* and role info from context, but Admissions keeps
  // its OWN campus selection — it deliberately does not touch the global top-bar
  // picker (which drives the other HR tabs).
  // Admissions is the one place that also lists Homework Club and Language
  // School — they have their own roster and waitlist but aren't real sites.
  const { loading, allCampuses: campuses, isCampusAdmin, lockedCampusId } = useCampusFilter();

  const [me, setMe] = useState<TeacherProfile | null>(null);
  const isSupervisor = me?.role === "supervisor";
  /**
   * Teachers get the roster for their own campus and nothing else: no waitlist
   * (those children aren't theirs yet) and a short forward window, since a
   * teacher planning their class doesn't need next year's projections.
   */
  const isTeacherView = !!me && !isSupervisor && !isCampusAdmin && me.role !== "admin";
  // Every active account may read the roster; only admins, campus admins and
  // supervisors may change it. The database enforces the same split, so the
  // read-only mode below is convenience rather than the actual gate.
  const canUse = !!me?.is_active;
  const readOnly = !canEditStudents(me);

  const [tab, setTab] = useState<Tab>("roster");
  // Two-step roster picker: campus, then programme. A popup rather than a page
  // of its own — switching roster shouldn't feel like leaving Admissions.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerParent, setPickerParent] = useState<string | null>(null);

  // Local, tab-scoped campus selection (independent of the top-bar picker).
  const [selectedCampusId, setSelectedCampusId] = useState<string | null>(null);
  // Supervisors are locked to the campus on their HR record.
  const [supCampusId, setSupCampusId] = useState<string | null>(null);
  const [supLoaded, setSupLoaded] = useState(false);

  useEffect(() => {
    (async () => setMe(await fetchMyProfile()))();
  }, []);

  useEscapeKey(() => setPickerOpen(false), pickerOpen);

  // Campus admins are always locked to their own campus — auto-select it.
  useEffect(() => {
    if (isCampusAdmin && lockedCampusId) setSelectedCampusId(lockedCampusId);
  }, [isCampusAdmin, lockedCampusId]);

  // Supervisors and teachers: resolve their campus from HR (via a
  // security-definer RPC, so it works regardless of hr_employees row access).
  const needsCampusLookup = !!me && (me.role === "supervisor" || isTeacherView);
  useEffect(() => {
    if (!needsCampusLookup || !me) return;
    (async () => {
      const rpc = me.role === "supervisor" ? "current_supervisor_campus" : "current_employee_campus";
      const { data } = await supabase.rpc(rpc);
      setSupCampusId((data as string | null) ?? null);
      setSupLoaded(true);
    })();
  }, [needsCampusLookup, me]);

  // ── Campus → programme ────────────────────────────────────────────────────
  // Rosters hang off a programme, not a campus: Torrance PV · Preschool and
  // Torrance PV · Homework Club are separate lists. `homeCampusId` is the real
  // campus someone belongs to; `activeCampusId` is the roster they're viewing.
  const parents = useMemo(() => campuses.filter((c) => !c.parent_campus_id), [campuses]);
  const programsOf = useCallback(
    (parentId: string | null) =>
      campuses
        .filter((c) => c.parent_campus_id === parentId)
        .sort((a, b) => PROGRAM_ORDER.indexOf(a.program ?? "") - PROGRAM_ORDER.indexOf(b.program ?? "")),
    [campuses]
  );

  // Campus admins, supervisors and teachers are pinned to one site but may look
  // at any of its programmes.
  const homeCampusId = isCampusAdmin ? lockedCampusId : (isSupervisor || isTeacherView) ? supCampusId : null;
  const activeCampusId = selectedCampusId;
  const activeCampus = campuses.find((c) => c.id === activeCampusId) ?? null;
  const activeParent = campuses.find((c) => c.id === activeCampus?.parent_campus_id) ?? null;

  // Everyone can change *programme*; only unpinned staff can change campus.
  const canSwitch = !homeCampusId || programsOf(homeCampusId).length > 1;
  const stillLoading = loading || !me || (needsCampusLookup && !supLoaded);

  // Land on the first programme of your own campus rather than an empty page.
  useEffect(() => {
    if (selectedCampusId || !homeCampusId) return;
    const first = programsOf(homeCampusId)[0];
    if (first) setSelectedCampusId(first.id);
  }, [selectedCampusId, homeCampusId, programsOf]);

  if (me && !canUse) {
    return (
      <main className="stack">
        <h1 className="h1">Admissions</h1>
        <div className="card"><div style={{ fontWeight: 800 }}>Not authorized</div>
          <div className="subtle" style={{ marginTop: 6 }}>Only admins, campus admins and supervisors can view the waitlist and roster.</div>
        </div>
      </main>
    );
  }

  return (
    <main className="stack">
      <div className="stack" style={{ gap: 6 }}>
        <h1 className="h1">Admissions</h1>
        <div className="subtle">
          Campus waitlist &amp; roster. Each campus is kept completely separate.
        </div>
        {readOnly && (
          <div
            style={{
              padding: "8px 14px", borderRadius: 12, fontSize: 13, fontWeight: 700,
              background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e40af",
              alignSelf: "flex-start",
            }}
          >
            👁 View only — you can browse the roster and waitlist but not change them.
          </div>
        )}
      </div>

      {stillLoading ? (
        <div className="subtle" style={{ padding: 20 }}>Loading…</div>
      ) : needsCampusLookup && !supCampusId ? (
        // Supervisors and teachers are scoped by the campus on their HR record.
        // Without one there's nothing they're allowed to see — and we must not
        // fall through to the picker, which would offer every campus.
        <div className="card">
          <div style={{ fontWeight: 800 }}>No campus assigned</div>
          <div className="subtle" style={{ marginTop: 6 }}>
            You&apos;re not assigned to a campus yet, so there&apos;s no waitlist or roster to show. Ask an admin to set your campus on your HR record.
          </div>
        </div>
      ) : !activeCampusId ? (
        <div className="card">
          <div style={{ fontWeight: 800 }}>Choose a roster</div>
          <div className="subtle" style={{ marginTop: 6, marginBottom: 14 }}>
            Pick a campus, then a programme.
          </div>
          <button className="btn btn-primary" onClick={() => setPickerOpen(true)}>Choose</button>
        </div>
      ) : (
        <>
          {/* Campus banner + in-tab switch + Waitlist/Roster toggle */}
          <div className="row-between" style={{ flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span
                style={{
                  display: "inline-flex", alignItems: "center", gap: 8,
                  padding: "8px 14px", borderRadius: 999,
                  background: "rgba(230,23,141,0.08)", border: "1.5px solid rgba(230,23,141,0.35)",
                  color: "#e6178d", fontWeight: 800, fontSize: 14,
                }}
              >
                🏫 {activeParent?.name ?? activeCampus?.name ?? "Campus"}
                {activeCampus?.program ? ` · ${PROGRAM_LABEL[activeCampus.program]}` : ""}
              </span>
              {canSwitch && (
                <button
                  className="btn"
                  onClick={() => { setPickerOpen(true); setPickerParent(activeParent?.id ?? null); }}
                  title="Choose a different roster"
                  style={{ fontSize: 13 }}
                >
                  ⇆ Change
                </button>
              )}
            </div>

            {/* Teachers get the roster only — waitlisted children aren't in
                anyone's class yet, so that list isn't theirs to see. */}
            {!isTeacherView && (
              <div className="row" style={{ gap: 4, background: "#f3f4f6", padding: 4, borderRadius: 12 }}>
                <TabButton active={tab === "roster"} onClick={() => setTab("roster")}>Roster</TabButton>
                <TabButton active={tab === "waitlist"} onClick={() => setTab("waitlist")}>Waitlist</TabButton>
              </div>
            )}
          </div>

          {tab === "waitlist" && !isTeacherView ? (
            <WaitlistView campusId={activeCampusId} myUserId={me?.id ?? null} readOnly={readOnly} />
          ) : (
            <RosterView
              campusId={activeCampusId}
              myUserId={me?.id ?? null}
              readOnly={readOnly}
              // Current month plus the next three — far enough to plan a class,
              // not far enough to be a projection of the whole school year.
              maxMonthsAhead={isTeacherView ? 3 : undefined}
              hideProspective={isTeacherView}
            />
          )}
        </>
      )}

      {pickerOpen && (
        <div
          onMouseDown={(e) => { if (e.currentTarget === e.target) setPickerOpen(false); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 300,
            display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
          }}
        >
          <div className="card" style={{ width: "min(420px, 96vw)" }}>
            <div className="row-between" style={{ marginBottom: 10, alignItems: "center" }}>
              <div style={{ fontWeight: 900, fontSize: 16 }}>
                {pickerParent ? campuses.find((c) => c.id === pickerParent)?.name : "Choose a campus"}
              </div>
              <button className="btn" onClick={() => setPickerOpen(false)}>Close</button>
            </div>

            {!pickerParent ? (
              <div className="stack" style={{ gap: 8 }}>
                {parents
                  // Someone pinned to a campus only ever sees that one.
                  .filter((p) => !homeCampusId || p.id === homeCampusId)
                  .map((p) => (
                    <button key={p.id} className="btn" style={{ justifyContent: "flex-start" }}
                      onClick={() => setPickerParent(p.id)}>
                      🏫 {p.name}
                    </button>
                  ))}
              </div>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {programsOf(pickerParent).map((c) => (
                  <button
                    key={c.id}
                    className={`btn${c.id === activeCampusId ? " btn-primary" : ""}`}
                    style={{ justifyContent: "flex-start" }}
                    onClick={() => {
                      setSelectedCampusId(c.id);
                      setPickerOpen(false);
                      setPickerParent(null);
                    }}
                  >
                    {PROGRAM_LABEL[c.program ?? ""] || c.name}
                  </button>
                ))}
                {programsOf(pickerParent).length === 0 && (
                  <div className="subtle" style={{ fontSize: 13 }}>No programmes set up for this campus.</div>
                )}
                {!homeCampusId && (
                  <button className="btn" style={{ marginTop: 4 }} onClick={() => setPickerParent(null)}>
                    ← All campuses
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 20px", borderRadius: 9, border: "none", cursor: "pointer",
        fontWeight: 800, fontSize: 14,
        background: active ? "white" : "transparent",
        color: active ? "#e6178d" : "#6b7280",
        boxShadow: active ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
      }}
    >
      {children}
    </button>
  );
}
