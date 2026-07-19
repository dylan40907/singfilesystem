"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import { useCampusFilter } from "@/lib/CampusContext";
import WaitlistView from "@/components/hr/admissions/WaitlistView";
import RosterView from "@/components/hr/admissions/RosterView";

type Tab = "waitlist" | "roster";

export default function AdmissionsPage() {
  // We read the campus *list* and role info from context, but Admissions keeps
  // its OWN campus selection — it deliberately does not touch the global top-bar
  // picker (which drives the other HR tabs).
  const { loading, campuses, isCampusAdmin, isTrueAdmin, lockedCampusId } = useCampusFilter();

  const [me, setMe] = useState<TeacherProfile | null>(null);
  const isSupervisor = me?.role === "supervisor";
  const canUse = !!me?.is_active && (me.role === "admin" || me.role === "campus_admin" || me.role === "supervisor");

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

  // Supervisors: resolve their campus from HR (via a security-definer RPC, so it
  // works regardless of hr_employees row-level access).
  useEffect(() => {
    if (me?.role !== "supervisor") return;
    (async () => {
      const { data } = await supabase.rpc("current_supervisor_campus");
      setSupCampusId((data as string | null) ?? null);
      setSupLoaded(true);
    })();
  }, [me?.role]);

  const activeCampusId = isCampusAdmin ? lockedCampusId : isSupervisor ? supCampusId : selectedCampusId;
  const activeCampus = campuses.find((c) => c.id === activeCampusId) ?? null;
  // Admins with more than one campus get an in-tab "Change campus" control.
  const canSwitch = isTrueAdmin && campuses.length > 1;
  // Wait for the supervisor's campus lookup before deciding what to show.
  const stillLoading = loading || (isSupervisor && !supLoaded);

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

            <div className="row" style={{ gap: 4, background: "#f3f4f6", padding: 4, borderRadius: 12 }}>
              <TabButton active={tab === "roster"} onClick={() => setTab("roster")}>Roster</TabButton>
              <TabButton active={tab === "waitlist"} onClick={() => setTab("waitlist")}>Waitlist</TabButton>
            </div>
          </div>

          {tab === "waitlist" ? (
            <WaitlistView campusId={activeCampusId} myUserId={me?.id ?? null} />
          ) : (
            <RosterView campusId={activeCampusId} myUserId={me?.id ?? null} />
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
