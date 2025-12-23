"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";

type PersonRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  is_active: boolean;
};

function labelForUser(u: { id: string; email?: string | null; full_name?: string | null }) {
  const name = (u.full_name ?? "").trim();
  const email = (u.email ?? "").trim();
  if (name && email) return `${name} (${email})`;
  if (name) return name;
  if (email) return email;
  return u.id;
}

export default function AdminSupervisorsPage() {
  const [status, setStatus] = useState("");
  const [me, setMe] = useState<TeacherProfile | null>(null);

  const [supervisors, setSupervisors] = useState<PersonRow[]>([]);
  const [teachers, setTeachers] = useState<PersonRow[]>([]);
  const [selectedSupervisorId, setSelectedSupervisorId] = useState<string>("");

  const [assigned, setAssigned] = useState<PersonRow[]>([]);
  const [loading, setLoading] = useState(false);

  const isAdmin = !!me?.is_active && me.role === "admin";

  async function bootstrap() {
    setStatus("Loading...");
    const profile = await fetchMyProfile();
    setMe(profile);

    if (!profile?.is_active || profile.role !== "admin") {
      setStatus("Not authorized.");
      return;
    }

    try {
      const [{ data: sData, error: sErr }, { data: tData, error: tErr }] = await Promise.all([
        supabase.rpc("list_supervisors"),
        supabase.rpc("list_teachers"),
      ]);

      if (sErr) throw sErr;
      if (tErr) throw tErr;

      const supRows = (sData ?? []) as PersonRow[];
      const teacherRows = (tData ?? []) as PersonRow[];

      setSupervisors(supRows);
      setTeachers(teacherRows);

      if (!selectedSupervisorId && supRows.length > 0) setSelectedSupervisorId(supRows[0].id);

      setStatus("");
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    }
  }

  async function loadAssignments(supervisorId: string) {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc("list_supervisor_assignments", {
        supervisor_uuid: supervisorId,
      });
      if (error) throw error;

      // RPC returns: teacher_id, email, full_name, is_active
      const rows = (data ?? []).map((r: any) => ({
        id: r.teacher_id as string,
        email: r.email as string | null,
        full_name: r.full_name as string | null,
        is_active: r.is_active as boolean,
      })) as PersonRow[];

      setAssigned(rows);
    } catch (e: any) {
      setStatus("Error loading assignments: " + (e?.message ?? "unknown"));
      setAssigned([]);
    } finally {
      setLoading(false);
    }
  }

  async function assignTeacher(teacherId: string) {
    if (!selectedSupervisorId) return;
    setStatus("Assigning...");
    try {
      const { error } = await supabase.rpc("assign_teacher_to_supervisor", {
        supervisor_uuid: selectedSupervisorId,
        teacher_uuid: teacherId,
      });
      if (error) throw error;

      setStatus("✅ Assigned.");
      await loadAssignments(selectedSupervisorId);
    } catch (e: any) {
      setStatus("Assign error: " + (e?.message ?? "unknown"));
    }
  }

  async function unassignTeacher(teacherId: string) {
    if (!selectedSupervisorId) return;
    setStatus("Unassigning...");
    try {
      const { error } = await supabase.rpc("unassign_teacher_from_supervisor", {
        supervisor_uuid: selectedSupervisorId,
        teacher_uuid: teacherId,
      });
      if (error) throw error;

      setStatus("✅ Unassigned.");
      await loadAssignments(selectedSupervisorId);
    } catch (e: any) {
      setStatus("Unassign error: " + (e?.message ?? "unknown"));
    }
  }

  const assignedIds = useMemo(() => new Set(assigned.map((a) => a.id)), [assigned]);

  useEffect(() => {
    bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    if (!selectedSupervisorId) return;
    loadAssignments(selectedSupervisorId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSupervisorId, isAdmin]);

  if (!isAdmin) {
    return (
      <main className="stack">
        <div className="row-between">
          <h1 className="h1">Supervisor Management</h1>
          {status ? <span className="badge badge-pink">{status}</span> : null}
        </div>
        <div className="card">
          <div style={{ fontWeight: 800 }}>Not authorized</div>
          <div className="subtle" style={{ marginTop: 6 }}>
            Admin-only access.
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="stack">
      <div className="row-between">
        <div className="stack" style={{ gap: 6 }}>
          <h1 className="h1">Supervisor Management</h1>
        </div>
        {status ? <span className="badge badge-pink">{status}</span> : null}
      </div>

      <div className="card">
        <div style={{ fontWeight: 900 }}>Select supervisor</div>

        <div style={{ marginTop: 12 }}>
          <select
            className="select"
            value={selectedSupervisorId}
            onChange={(e) => setSelectedSupervisorId(e.target.value)}
          >
            {supervisors.map((s) => (
              <option key={s.id} value={s.id}>
                {labelForUser(s)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="row-between">
            <div>
              <div style={{ fontWeight: 900 }}>Assigned teachers</div>
            </div>
            <button className="btn" onClick={() => selectedSupervisorId && loadAssignments(selectedSupervisorId)}>
              Refresh
            </button>
          </div>

          <div className="hr" />

          {loading ? (
            <div className="subtle">Loading…</div>
          ) : assigned.length === 0 ? (
            <div className="subtle">(None assigned)</div>
          ) : (
            <div className="stack">
              {assigned.map((t) => (
                <div key={t.id} className="row-between" style={{ gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 800 }}>{labelForUser(t)}</div>
                    <div className="subtle">{t.is_active ? "active" : "inactive"}</div>
                  </div>
                  <button className="btn" onClick={() => unassignTeacher(t.id)}>
                    Unassign
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div style={{ fontWeight: 900 }}>All teachers</div>

          <div className="hr" />

          <div className="stack">
            {teachers.map((t) => {
              const already = assignedIds.has(t.id);
              return (
                <div key={t.id} className="row-between" style={{ gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 800 }}>{labelForUser(t)}</div>
                    <div className="subtle">{t.is_active ? "active" : "inactive"}</div>
                  </div>
                  <button className="btn" onClick={() => assignTeacher(t.id)} disabled={already}>
                    {already ? "Assigned" : "Assign"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </main>
  );
}
