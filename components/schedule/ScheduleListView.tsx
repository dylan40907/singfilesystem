"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  Schedule,
  scheduleTitle,
  formatWeekRange,
  getMonday,
  formatDateLocal,
} from "@/lib/scheduleUtils";
import PlansSection from "./PlansSection";
import WeekPicker from "./WeekPicker";
import TeacherScheduleView from "./TeacherScheduleView";
import { useCampusFilter, applyCampusFilterToQuery } from "@/lib/CampusContext";

interface ScheduleListViewProps {
  onSelectSchedule: (id: string) => void;
}

type ScheduleWithCampus = Schedule & { campus_id?: string | null };

export default function ScheduleListView({ onSelectSchedule }: ScheduleListViewProps) {
  const { filter: campusFilter, campuses, isCampusAdmin, lockedCampusId } = useCampusFilter();

  const [schedules, setSchedules] = useState<ScheduleWithCampus[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newWeekStart, setNewWeekStart] = useState(() =>
    formatDateLocal(getMonday(new Date()))
  );
  const [newCampusId, setNewCampusId] = useState<string>("");
  const [showNewForm, setShowNewForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default the create-form campus to: locked campus (campus_admin) → navbar selection
  // (if it's a real campus) → first "Torrance" campus → first campus.
  const defaultCreateCampusId = useMemo(() => {
    if (isCampusAdmin && lockedCampusId) return lockedCampusId;
    if (campusFilter !== "all" && campusFilter !== "unassigned") return campusFilter;
    const torrance = campuses.find((c) => /torrance/i.test(c.name));
    return torrance?.id ?? campuses[0]?.id ?? "";
  }, [campusFilter, campuses, isCampusAdmin, lockedCampusId]);

  // Keep newCampusId in sync with the default unless the user has already changed it
  useEffect(() => {
    setNewCampusId(defaultCreateCampusId);
  }, [defaultCreateCampusId]);

  // My Schedule modal
  const [myScheduleOpen, setMyScheduleOpen] = useState(false);
  const [myEmployeeId, setMyEmployeeId] = useState<string | null | false>(null); // false = not found
  const [myPin, setMyPin] = useState<string | null>(null);
  const [pinRevealed, setPinRevealed] = useState(false);
  const [empLoading, setEmpLoading] = useState(false);

  async function fetchSchedules() {
    setLoading(true);
    // Plans are listed separately (PlansSection) — this list is weekly only.
    let q = supabase.from("schedules").select("*").eq("kind", "week");
    q = applyCampusFilterToQuery(q, campusFilter);
    const { data, error: err } = await q.order("week_start", { ascending: false });
    if (err) {
      setError(err.message);
    } else {
      setSchedules((data as ScheduleWithCampus[]) ?? []);
    }
    setLoading(false);
  }

  useEffect(() => {
    fetchSchedules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campusFilter]);

  async function openMySchedule() {
    setMyScheduleOpen(true);
    if (myEmployeeId !== null) return; // already fetched (string or false)

    setEmpLoading(true);
    const { data: session } = await supabase.auth.getSession();
    const userId = session.session?.user?.id;
    if (!userId) { setMyEmployeeId(false); setEmpLoading(false); return; }

    const { data: emp } = await supabase
      .from("hr_employees")
      .select("id, hours_pin")
      .eq("profile_id", userId)
      .single();

    if (emp) {
      setMyEmployeeId(emp.id);
      setMyPin(emp.hours_pin ?? null);
    } else {
      setMyEmployeeId(false);
    }
    setEmpLoading(false);
  }

  async function handleCreate() {
    setError(null);
    if (!newCampusId) {
      setError("Pick a campus for this schedule.");
      return;
    }
    // Check if schedule already exists for this week+campus combination
    const existing = schedules.find((s) => s.week_start === newWeekStart && s.campus_id === newCampusId);
    if (existing) {
      setError("A schedule already exists for this week + campus.");
      return;
    }

    setCreating(true);
    const { data, error: err } = await supabase
      .from("schedules")
      .insert({ week_start: newWeekStart, status: "draft", campus_id: newCampusId })
      .select()
      .single();

    if (err) {
      setError(err.message);
      setCreating(false);
      return;
    }

    // Auto-fill rooms from most recent previous schedule for the SAME campus
    if (data) {
      const { data: prevSchedule } = await supabase
        .from("schedules")
        .select("id")
        .lt("week_start", newWeekStart)
        .eq("campus_id", newCampusId)
        .order("week_start", { ascending: false })
        .limit(1)
        .single();

      if (prevSchedule) {
        const { data: prevRooms } = await supabase
          .from("schedule_rooms")
          .select("name, capacity, sort_order")
          .eq("schedule_id", prevSchedule.id)
          .order("sort_order");

        if (prevRooms && prevRooms.length > 0) {
          await supabase.from("schedule_rooms").insert(
            prevRooms.map((r) => ({
              schedule_id: data.id,
              name: r.name,
              capacity: r.capacity,
              sort_order: r.sort_order,
            }))
          );
        }
      }

      setCreating(false);
      setShowNewForm(false);
      onSelectSchedule(data.id);
    }
  }

  return (
    <div style={{ padding: "24px 0" }}>
      {/* Plans sit above the weekly list — they're general, always-relevant
          references rather than one-week-at-a-time staffing. */}
      <PlansSection
        onSelectSchedule={onSelectSchedule}
        campuses={campuses}
        campusFilter={campusFilter}
        defaultCampusId={defaultCreateCampusId}
        isCampusAdmin={isCampusAdmin}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Weekly Schedules</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={openMySchedule}>
            My Schedule
          </button>
          <button
            className="btn btn-pink"
            onClick={() => setShowNewForm(!showNewForm)}
          >
            {showNewForm ? "Cancel" : "+ New Schedule"}
          </button>
        </div>
      </div>

      {showNewForm && (
        <div
          style={{
            padding: 16,
            background: "#fdf2f8",
            borderRadius: 12,
            marginBottom: 20,
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Week:</span>
            <WeekPicker value={newWeekStart} onChange={setNewWeekStart} weeksBack={4} weeksForward={16} />
          </div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Campus:</span>
            <select
              className="select"
              value={newCampusId}
              onChange={(e) => setNewCampusId(e.target.value)}
              disabled={creating || isCampusAdmin}
              style={{ width: "auto", minWidth: 180 }}
            >
              <option value="">— Select campus —</option>
              {campuses.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <button
            className="btn btn-pink"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? "Creating…" : "Create Draft"}
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "10px 16px",
            background: "#fef2f2",
            color: "#dc2626",
            borderRadius: 10,
            marginBottom: 16,
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="subtle" style={{ padding: 20 }}>
          Loading schedules…
        </div>
      ) : schedules.length === 0 ? (
        <div className="subtle" style={{ padding: 20 }}>
          No schedules yet. Create one to get started.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {schedules.map((s) => (
            <button
              key={s.id}
              onClick={() => onSelectSchedule(s.id)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "14px 18px",
                background: "white",
                border: "1.5px solid #e5e7eb",
                borderRadius: 12,
                cursor: "pointer",
                textAlign: "left",
                transition: "border-color 0.15s",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.borderColor = "#e6178d")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.borderColor = "#e5e7eb")
              }
            >
              <div>
                <div style={{ fontWeight: 800, fontSize: 15 }}>
                  {scheduleTitle(s)}
                </div>
                <div className="subtle" style={{ fontSize: 13, marginTop: 2 }}>
                  {s.week_start}
                  {(() => {
                    const c = campuses.find((x) => x.id === s.campus_id);
                    if (c) return ` · ${c.name}`;
                    return s.campus_id ? "" : " · (no campus)";
                  })()}
                </div>
              </div>
              <span
                style={{
                  padding: "4px 12px",
                  borderRadius: 20,
                  fontSize: 12,
                  fontWeight: 700,
                  background:
                    s.status === "published" ? "#dcfce7" : "#fef3c7",
                  color:
                    s.status === "published" ? "#16a34a" : "#d97706",
                }}
              >
                {s.status === "published" ? "Published" : "Draft"}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* My Schedule modal */}
      {myScheduleOpen && (
        <>
          <div
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 200 }}
            onClick={() => setMyScheduleOpen(false)}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 201,
              background: "white",
              borderRadius: 16,
              boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
              width: "min(640px, 95vw)",
              maxHeight: "85vh",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #e5e7eb", flexShrink: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>My Schedule</div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {myPin && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 12px", background: "#f9fafb", borderRadius: 10, border: "1.5px solid #e5e7eb" }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#6b7280" }}>Hours PIN:</span>
                    <span style={{ fontWeight: 900, fontSize: 16, letterSpacing: 4, fontVariantNumeric: "tabular-nums", color: "#111827" }}>
                      {pinRevealed ? myPin : "••••"}
                    </span>
                    <button
                      onClick={() => setPinRevealed((v) => !v)}
                      style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 2 }}
                      title={pinRevealed ? "Hide PIN" : "Reveal PIN"}
                    >
                      {pinRevealed ? "🙈" : "👁️"}
                    </button>
                  </div>
                )}
                <button
                  onClick={() => setMyScheduleOpen(false)}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#9ca3af", lineHeight: 1, padding: 4 }}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Modal body */}
            <div style={{ padding: "20px", overflowY: "auto", flex: 1 }}>
              {empLoading ? (
                <div style={{ color: "#6b7280", fontSize: 14 }}>Loading…</div>
              ) : myEmployeeId === false ? (
                <div style={{ color: "#6b7280", fontSize: 14 }}>
                  No employee record found for your account. Ask an admin to link your profile to an employee record.
                </div>
              ) : myEmployeeId ? (
                <TeacherScheduleView employeeId={myEmployeeId} />
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
