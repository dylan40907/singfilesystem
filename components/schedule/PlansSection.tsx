"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { Schedule, scheduleTitle } from "@/lib/scheduleUtils";
import { applyCampusFilterToQuery, CampusFilter, Campus } from "@/lib/CampusContext";

/**
 * "Plans" — freeform, hand-named schedules used as general room/day plans.
 * They aren't tied to a week and carry no employees, so they never touch
 * timesheets or leave. Listed above the weekly schedules for quick access.
 */
export default function PlansSection({
  onSelectSchedule,
  campuses,
  campusFilter,
  defaultCampusId,
  isCampusAdmin,
}: {
  onSelectSchedule: (id: string) => void;
  campuses: Campus[];
  campusFilter: CampusFilter;
  defaultCampusId: string;
  isCampusAdmin: boolean;
}) {
  const [plans, setPlans] = useState<(Schedule & { campus_id?: string | null })[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCampusId, setNewCampusId] = useState(defaultCampusId);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setNewCampusId(defaultCampusId); }, [defaultCampusId]);

  const fetchPlans = useCallback(async () => {
    setLoading(true);
    let q = supabase.from("schedules").select("*").eq("kind", "plan");
    q = applyCampusFilterToQuery(q, campusFilter);
    const { data, error: err } = await q.order("created_at", { ascending: false });
    if (err) setError(err.message);
    else setPlans((data as (Schedule & { campus_id?: string | null })[]) ?? []);
    setLoading(false);
  }, [campusFilter]);

  useEffect(() => { void fetchPlans(); }, [fetchPlans]);

  async function handleCreate() {
    setError(null);
    const name = newName.trim();
    if (!name) { setError("Give the plan a name."); return; }
    if (!newCampusId) { setError("Pick a campus for this plan."); return; }

    setCreating(true);
    const { data, error: err } = await supabase
      .from("schedules")
      .insert({ kind: "plan", name, week_start: null, status: "draft", campus_id: newCampusId })
      .select()
      .single();

    if (err) { setError(err.message); setCreating(false); return; }

    // Seed rooms from the most recent plan at this campus so you're not starting
    // from an empty grid every time.
    if (data) {
      const { data: prev } = await supabase
        .from("schedules")
        .select("id")
        .eq("kind", "plan")
        .eq("campus_id", newCampusId)
        .neq("id", data.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (prev) {
        const { data: prevRooms } = await supabase
          .from("schedule_rooms")
          .select("name, columns, sort_order, required_teachers")
          .eq("schedule_id", prev.id)
          .order("sort_order");
        if (prevRooms?.length) {
          await supabase.from("schedule_rooms").insert(
            prevRooms.map((r) => ({
              schedule_id: data.id,
              name: r.name,
              columns: r.columns,
              sort_order: r.sort_order,
              required_teachers: r.required_teachers,
            }))
          );
        }
      }

      setCreating(false);
      setShowForm(false);
      setNewName("");
      onSelectSchedule(data.id);
    }
  }

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Plans</h2>
          <div className="subtle" style={{ fontSize: 13, marginTop: 2 }}>
            General room plans — not tied to a week, and never counted toward hours.
          </div>
        </div>
        <button className="btn btn-pink" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ New Plan"}
        </button>
      </div>

      {showForm && (
        <div style={{ padding: 16, background: "#f5f3ff", borderRadius: 12, marginBottom: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, flex: "1 1 260px" }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Name:</span>
            <input
              className="input"
              placeholder="e.g. Standard Day Plan"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleCreate(); }}
              disabled={creating}
              autoFocus
              style={{ flex: 1, minWidth: 180 }}
            />
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
              {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <button className="btn btn-pink" onClick={() => void handleCreate()} disabled={creating}>
            {creating ? "Creating…" : "Create Plan"}
          </button>
        </div>
      )}

      {error && (
        <div style={{ padding: "10px 16px", background: "#fef2f2", color: "#dc2626", borderRadius: 10, marginBottom: 12, fontSize: 14, fontWeight: 600 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="subtle" style={{ padding: 12 }}>Loading plans…</div>
      ) : plans.length === 0 ? (
        <div className="subtle" style={{ padding: 12 }}>No plans yet.</div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {plans.map((p) => {
            const campus = campuses.find((c) => c.id === p.campus_id);
            return (
              <button
                key={p.id}
                onClick={() => onSelectSchedule(p.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "12px 16px", background: "white",
                  border: "1.5px solid #e5e7eb", borderRadius: 12,
                  cursor: "pointer", textAlign: "left",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#7c3aed")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#e5e7eb")}
              >
                <span style={{ fontSize: 16 }}>📋</span>
                <span>
                  <span style={{ display: "block", fontWeight: 800, fontSize: 14 }}>{scheduleTitle(p)}</span>
                  <span className="subtle" style={{ fontSize: 12 }}>{campus?.name ?? "(no campus)"}</span>
                </span>
                <span
                  style={{
                    padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700,
                    background: p.status === "published" ? "#dcfce7" : "#fef3c7",
                    color: p.status === "published" ? "#16a34a" : "#d97706",
                  }}
                >
                  {p.status === "published" ? "Published" : "Draft"}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
