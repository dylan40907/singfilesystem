"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type PersonRow = {
  id: string;
  email: string | null;
  username: string | null;
  full_name: string | null;
  is_active: boolean;
};

function labelForUser(u: { full_name: string | null; username: string | null; id: string }) {
  const name = (u.full_name ?? "").trim();
  const username = (u.username ?? "").trim();
  if (name && username) return `${name} (${username})`;
  return username || name || u.id;
}

/**
 * Teachers assigned to a supervisor. Replaces the old /admin/supervisors page —
 * redesigned so the "add" list is a compact search box + results instead of a
 * huge always-open roster you had to scroll past.
 */
export default function SupervisorAssignees({ supervisorProfileId }: { supervisorProfileId: string }) {
  const [assigned, setAssigned] = useState<PersonRow[]>([]);
  const [allTeachers, setAllTeachers] = useState<PersonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");

  const loadAssigned = useCallback(async () => {
    const { data, error } = await supabase.rpc("list_supervisor_assignments", { supervisor_uuid: supervisorProfileId });
    if (error) throw error;
    setAssigned(
      ((data ?? []) as any[]).map((r) => ({
        id: r.teacher_id as string,
        email: (r.email ?? null) as string | null,
        username: (r.username ?? null) as string | null,
        full_name: (r.full_name ?? null) as string | null,
        is_active: !!r.is_active,
      }))
    );
  }, [supervisorProfileId]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [{ data: teachers, error: tErr }] = await Promise.all([
          supabase.rpc("list_teachers"),
          loadAssigned(),
        ]);
        if (tErr) throw tErr;
        setAllTeachers(
          ((teachers ?? []) as any[]).map((r) => ({
            id: r.id as string,
            email: (r.email ?? null) as string | null,
            username: (r.username ?? null) as string | null,
            full_name: (r.full_name ?? null) as string | null,
            is_active: !!r.is_active,
          }))
        );
      } catch (e: any) {
        setStatus("Error: " + (e?.message ?? "unknown"));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadAssigned]);

  const assignedIds = useMemo(() => new Set(assigned.map((a) => a.id)), [assigned]);

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    const pool = allTeachers.filter((t) => !assignedIds.has(t.id));
    if (!q) return pool.slice(0, 8); // keep the list short until they search
    return pool.filter((t) => labelForUser(t).toLowerCase().includes(q)).slice(0, 20);
  }, [allTeachers, assignedIds, search]);

  async function assign(teacherId: string) {
    setBusyId(teacherId); setStatus("");
    try {
      const { error } = await supabase.rpc("assign_teacher_to_supervisor", {
        supervisor_uuid: supervisorProfileId, teacher_uuid: teacherId,
      });
      if (error) throw error;
      await loadAssigned();
    } catch (e: any) {
      setStatus("Assign error: " + (e?.message ?? "unknown"));
    } finally { setBusyId(null); }
  }

  async function unassign(teacherId: string) {
    setBusyId(teacherId); setStatus("");
    try {
      const { error } = await supabase.rpc("unassign_teacher_from_supervisor", {
        supervisor_uuid: supervisorProfileId, teacher_uuid: teacherId,
      });
      if (error) throw error;
      await loadAssigned();
    } catch (e: any) {
      setStatus("Unassign error: " + (e?.message ?? "unknown"));
    } finally { setBusyId(null); }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row-between" style={{ gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Assigned teachers</div>
          <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>
            Teachers this supervisor can see in Teachers, Schedules and folder shares.
          </div>
        </div>
        {status ? <span className="badge badge-pink">{status}</span> : null}
      </div>

      {loading ? (
        <div className="subtle">Loading…</div>
      ) : (
        <>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "10px 12px", borderBottom: "1px solid #f3f4f6", fontWeight: 800, fontSize: 13 }}>
              Assigned · {assigned.length}
            </div>
            {assigned.length === 0 ? (
              <div className="subtle" style={{ padding: 14 }}>No teachers assigned yet.</div>
            ) : (
              assigned.map((t) => (
                <div key={t.id} className="row-between" style={{ padding: "9px 12px", borderTop: "1px solid #f8fafc", gap: 10 }}>
                  <span style={{ fontWeight: 600 }}>
                    {labelForUser(t)}{t.is_active ? "" : <span className="subtle" style={{ fontSize: 12 }}> (inactive)</span>}
                  </span>
                  <button className="btn" style={{ padding: "3px 10px", fontSize: 12, color: "#b91c1c" }}
                    disabled={busyId === t.id} onClick={() => void unassign(t.id)}>
                    {busyId === t.id ? "…" : "Remove"}
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="stack" style={{ gap: 8 }}>
            <div style={{ fontWeight: 800, fontSize: 13 }}>Add a teacher</div>
            <input
              className="input"
              placeholder="Search teachers…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {candidates.length === 0 ? (
              <div className="subtle" style={{ fontSize: 13 }}>
                {search.trim() ? "No matching teachers." : "Everyone is already assigned."}
              </div>
            ) : (
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
                {candidates.map((t) => (
                  <div key={t.id} className="row-between" style={{ padding: "9px 12px", borderTop: "1px solid #f8fafc", gap: 10 }}>
                    <span>
                      {labelForUser(t)}{t.is_active ? "" : <span className="subtle" style={{ fontSize: 12 }}> (inactive)</span>}
                    </span>
                    <button className="btn btn-primary" style={{ padding: "3px 12px", fontSize: 12 }}
                      disabled={busyId === t.id} onClick={() => void assign(t.id)}>
                      {busyId === t.id ? "…" : "Assign"}
                    </button>
                  </div>
                ))}
                {!search.trim() && allTeachers.filter((t) => !assignedIds.has(t.id)).length > candidates.length ? (
                  <div className="subtle" style={{ padding: "8px 12px", fontSize: 12, borderTop: "1px solid #f8fafc" }}>
                    Showing {candidates.length} — search to narrow down.
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
