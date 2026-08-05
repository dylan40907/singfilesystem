"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import { canEditStudents } from "@/lib/hrAccess";
import { useCampusFilter } from "@/lib/CampusContext";
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

  // Local, tab-scoped campus selection (independent of the top-bar picker).
  const [selectedCampusId, setSelectedCampusId] = useState<string | null>(null);
  // Supervisors are locked to the campus on their HR record.
  const [supCampusId, setSupCampusId] = useState<string | null>(null);
  const [supLoaded, setSupLoaded] = useState(false);

  useEffect(() => {
    (async () => setMe(await fetchMyProfile()))();
  }, []);

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

  const activeCampusId = isCampusAdmin
    ? lockedCampusId
    // A teacher with a campus on their record goes straight there; one without
    // falls through to the picker rather than seeing an empty page.
    : isSupervisor || isTeacherView
      ? supCampusId ?? selectedCampusId
      : selectedCampusId;
  const activeCampus = campuses.find((c) => c.id === activeCampusId) ?? null;
  // Admins with more than one campus get an in-tab "Change campus" control.
  // Campus admins and supervisors are pinned to their own site; everyone else
  // who gets as far as the picker may move between campuses.
  // A teacher pinned to their own campus can't wander to the other one.
  const canSwitch = !isCampusAdmin && !isSupervisor && !(isTeacherView && supCampusId) && campuses.length > 1;
  // Wait for the campus lookup before deciding what to show.
  const stillLoading = loading || !me || (needsCampusLookup && !supLoaded);

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
      ) : isSupervisor && !activeCampusId ? (
        // Supervisor without a campus on their HR record can't view anything yet.
        <div className="card">
          <div style={{ fontWeight: 800 }}>No campus assigned</div>
          <div className="subtle" style={{ marginTop: 6 }}>
            You&apos;re not assigned to a campus yet, so there&apos;s no waitlist or roster to show. Ask an admin to set your campus on your HR record.
          </div>
        </div>
      ) : !activeCampusId ? (
        // Admin hasn't picked a campus yet (campus admins / supervisors never reach this).
        <div className="card">
          <div style={{ fontWeight: 800 }}>Choose a campus</div>
          <div className="subtle" style={{ marginTop: 6, marginBottom: 14 }}>
            Waitlists and rosters are per-campus. Pick the campus you want to work in.
          </div>
          {campuses.length === 0 ? (
            <div className="subtle">No campuses yet. Add one from the campus selector in the top bar.</div>
          ) : (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {campuses.map((c) => (
                <button key={c.id} className="btn" onClick={() => setSelectedCampusId(c.id)}>{c.name}</button>
              ))}
            </div>
          )}
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
                🏫 {activeCampus?.name ?? "Campus"}
              </span>
              {canSwitch && (
                <button
                  className="btn"
                  onClick={() => setSelectedCampusId(null)}
                  title="Choose a different campus"
                  style={{ fontSize: 13 }}
                >
                  ⇆ Change campus
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
