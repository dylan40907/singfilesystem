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

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
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

  // Admin-only: Add supervisor modal state
  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addName, setAddName] = useState("");
  const [addLoading, setAddLoading] = useState(false);

  // Admin-only: delete supervisor state
  const [deleteLoading, setDeleteLoading] = useState(false);

  async function refreshLists(preferSelectId?: string) {
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

    const exists = (id: string) => supRows.some((s) => s.id === id);

    if (preferSelectId && exists(preferSelectId)) {
      setSelectedSupervisorId(preferSelectId);
      return;
    }

    if (selectedSupervisorId && exists(selectedSupervisorId)) {
      // keep selection
      return;
    }

    if (supRows.length > 0) {
      setSelectedSupervisorId(supRows[0].id);
    } else {
      setSelectedSupervisorId("");
      setAssigned([]);
    }
  }

  async function bootstrap() {
    setStatus("Loading...");
    const profile = await fetchMyProfile();
    setMe(profile);

    if (!profile?.is_active || profile.role !== "admin") {
      setStatus("Not authorized.");
      return;
    }

    try {
      await refreshLists();
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

  // ADMIN: create supervisor via Edge Function
  async function createSupervisor() {
    const email = addEmail.trim();
    const name = addName.trim();

    if (!email || !isValidEmail(email)) {
      setStatus("Create supervisor error: Please enter a valid email.");
      return;
    }
    if (!name) {
      setStatus("Create supervisor error: Please enter a name.");
      return;
    }

    setAddLoading(true);
    setStatus("Creating supervisor...");
    try {
      // IMPORTANT: match Edge Function expected keys
      const { data, error } = await supabase.functions.invoke("admin-create-supervisor", {
        body: {
          supervisor_email: email,
          supervisor_full_name: name,
        },
      });

      if (error) {
        setStatus("Create supervisor error: " + (error.message ?? "unknown"));
        return;
      }

      setStatus("✅ Supervisor created.");
      setAddOpen(false);
      setAddEmail("");
      setAddName("");

      const createdId = (data as any)?.user_id ?? (data as any)?.supervisor_id ?? (data as any)?.id ?? null;

      await refreshLists(typeof createdId === "string" ? createdId : undefined);
    } catch (e: any) {
      setStatus("Create supervisor error: " + (e?.message ?? "unknown"));
    } finally {
      setAddLoading(false);
    }
  }

  // ADMIN: delete supervisor via Edge Function
  async function deleteSelectedSupervisor() {
    if (!selectedSupervisorId) return;
    if (!isAdmin) return;

    const selected = supervisors.find((s) => s.id === selectedSupervisorId) ?? null;

    const label = selected
      ? labelForUser({ id: selected.id, email: selected.email, full_name: selected.full_name })
      : selectedSupervisorId;

    const ok = window.confirm(`Delete this supervisor?\n\n${label}\n\nThis cannot be undone.`);
    if (!ok) return;

    setDeleteLoading(true);
    setStatus("Deleting supervisor...");
    try {
      const { data, error } = await supabase.functions.invoke("admin-delete-supervisor", {
        body: {
          supervisor_id: selectedSupervisorId,
        },
      });

      if (error) {
        setStatus("Delete supervisor error: " + (error.message ?? "unknown"));
        return;
      }

      void data;

      setStatus("✅ Supervisor deleted.");
      setSelectedSupervisorId("");
      setAssigned([]);
      await refreshLists();
    } catch (e: any) {
      setStatus("Delete supervisor error: " + (e?.message ?? "unknown"));
    } finally {
      setDeleteLoading(false);
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
        <div className="row-between" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ fontWeight: 900 }}>Select supervisor</div>

          <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
              Add supervisor
            </button>

            <button className="btn" onClick={() => refreshLists()}>
              Refresh
            </button>

            <button
              className="btn"
              title="Delete selected supervisor"
              onClick={() => void deleteSelectedSupervisor()}
              disabled={!selectedSupervisorId || deleteLoading}
              style={{ padding: "8px 10px" }}
            >
              🗑
            </button>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <select className="select" value={selectedSupervisorId} onChange={(e) => setSelectedSupervisorId(e.target.value)}>
            {supervisors.map((s) => (
              <option key={s.id} value={s.id}>
                {labelForUser(s)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Admin-only Add Supervisor Modal */}
      {addOpen ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            zIndex: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={() => {
            if (!addLoading) setAddOpen(false);
          }}
        >
          <div className="card" style={{ width: "min(520px, 100%)", borderRadius: 14 }} onClick={(e) => e.stopPropagation()}>
            <div className="row-between">
              <div style={{ fontWeight: 950, fontSize: 16 }}>Add supervisor</div>
              <button className="btn" onClick={() => !addLoading && setAddOpen(false)} disabled={addLoading}>
                Close
              </button>
            </div>

            <div className="hr" />

            <div className="stack" style={{ gap: 10 }}>
              <div className="subtle">Creates a supervisor account without a password (for now).</div>

              <input
                className="input"
                placeholder="Supervisor email"
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
                disabled={addLoading}
              />

              <input
                className="input"
                placeholder="Supervisor full name"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                disabled={addLoading}
              />

              <div className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
                <button className="btn" onClick={() => setAddOpen(false)} disabled={addLoading}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={() => void createSupervisor()} disabled={addLoading}>
                  {addLoading ? "Creating..." : "Create supervisor"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid-2">
        <div className="card">
          <div className="row-between">
            <div>
              <div style={{ fontWeight: 900 }}>Assigned teachers</div>
            </div>
            <button className="btn" onClick={() => selectedSupervisorId && loadAssignments(selectedSupervisorId)} disabled={!selectedSupervisorId}>
              Refresh
            </button>
          </div>

          <div className="hr" />

          {loading ? (
            <div className="subtle">Loading…</div>
          ) : !selectedSupervisorId ? (
            <div className="subtle">(Select a supervisor)</div>
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
                  <button className="btn" onClick={() => assignTeacher(t.id)} disabled={!selectedSupervisorId || already}>
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
