"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  AssignmentWithUser, assignUsers, fetchAssignments, sendReminder, unassignUser,
} from "@/lib/courses";

type PickUser = { id: string; full_name: string | null; username: string | null; email: string | null; role: string | null };

function nameOf(u: { full_name: string | null; username: string | null; email: string | null }) {
  return (u.full_name ?? "").trim() || (u.username ?? "").trim() || u.email || "Unknown";
}

export default function CoursePeoplePanel({ courseId }: { courseId: string }) {
  const [assignments, setAssignments] = useState<AssignmentWithUser[]>([]);
  const [allUsers, setAllUsers] = useState<PickUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [picker, setPicker] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [a, { data: users }] = await Promise.all([
        fetchAssignments(courseId),
        supabase.from("user_profiles").select("id, full_name, username, email, role").eq("is_active", true).order("full_name"),
      ]);
      setAssignments(a);
      setAllUsers((users ?? []) as PickUser[]);
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => { reload(); }, [reload]);

  const assignedIds = useMemo(() => new Set(assignments.map((a) => a.user_id)), [assignments]);
  const counts = useMemo(() => {
    let completed = 0, inProgress = 0, notStarted = 0;
    for (const a of assignments) {
      if (a.status === "completed") completed++;
      else if (a.status === "in_progress") inProgress++;
      else notStarted++;
    }
    return { completed, inProgress, notStarted, total: assignments.length };
  }, [assignments]);

  async function doAssign() {
    const ids = Array.from(picker).filter((id) => !assignedIds.has(id));
    if (ids.length === 0) { setPickerOpen(false); return; }
    setBusy(true);
    try {
      await assignUsers(courseId, ids);
      setPicker(new Set());
      setPickerOpen(false);
      setStatus(`✅ Assigned ${ids.length} ${ids.length === 1 ? "person" : "people"}.`);
      await reload();
    } catch (e: any) {
      setStatus("Assign error: " + (e?.message ?? "unknown"));
    } finally {
      setBusy(false);
    }
  }

  async function remind(userIds: string[]) {
    if (userIds.length === 0) return;
    setBusy(true);
    try {
      const n = await sendReminder(courseId, userIds);
      setStatus(`🔔 Reminder sent to ${n}.`);
    } catch (e: any) {
      setStatus("Reminder error: " + (e?.message ?? "unknown"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string) {
    setBusy(true);
    try {
      await unassignUser(courseId, userId);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const notCompletedIds = assignments.filter((a) => a.status !== "completed").map((a) => a.user_id);

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div className="row" style={{ gap: 10 }}>
          <StatCard color="#16a34a" n={counts.completed} label="Completed" />
          <StatCard color="#d97706" n={counts.inProgress} label="In progress" />
          <StatCard color="#dc2626" n={counts.notStarted} label="Not started" />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={() => remind(notCompletedIds)} disabled={busy || notCompletedIds.length === 0}>
            🔔 Remind not-completed
          </button>
          <button className="btn btn-primary" onClick={() => setPickerOpen(true)}>+ Assign people</button>
        </div>
      </div>

      {status && <div className="badge badge-pink" style={{ marginBottom: 10 }}>{status}</div>}

      {loading ? (
        <div className="subtle">Loading…</div>
      ) : assignments.length === 0 ? (
        <div className="subtle" style={{ padding: 16 }}>No one is assigned yet.</div>
      ) : (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ background: "#f9fafb", textAlign: "left", color: "#6b7280" }}>
                <th style={th}>Name</th><th style={th}>Status</th><th style={th}>Last viewed</th><th style={{ ...th, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={td}>{nameOf(a)}</td>
                  <td style={td}><StatusPill status={a.status} /></td>
                  <td style={td}>{a.last_viewed_at ? new Date(a.last_viewed_at).toLocaleString() : "—"}</td>
                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                    {a.status !== "completed" && (
                      <button className="btn" onClick={() => remind([a.user_id])} disabled={busy} style={mini}>Remind</button>
                    )}
                    <button className="btn" onClick={() => remove(a.user_id)} disabled={busy} style={{ ...mini, color: "#991b1b" }}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pickerOpen && (
        <div onMouseDown={(e) => { if (e.currentTarget === e.target) setPickerOpen(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div className="card" style={{ width: "100%", maxWidth: 460, maxHeight: "82vh", display: "flex", flexDirection: "column" }}>
            <div style={{ fontWeight: 900, fontSize: 17, marginBottom: 10 }}>Assign people</div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {allUsers.map((u) => {
                const already = assignedIds.has(u.id);
                const checked = picker.has(u.id) || already;
                return (
                  <label key={u.id} className="row" style={{ gap: 10, padding: "8px 4px", alignItems: "center", opacity: already ? 0.5 : 1, cursor: already ? "default" : "pointer" }}>
                    <input type="checkbox" disabled={already} checked={checked}
                      onChange={(e) => setPicker((s) => { const n = new Set(s); e.target.checked ? n.add(u.id) : n.delete(u.id); return n; })} />
                    <span style={{ flex: 1 }}>{nameOf(u)} {already && <span className="subtle" style={{ fontSize: 12 }}>(assigned)</span>}</span>
                    <span className="subtle" style={{ fontSize: 12 }}>{u.role}</span>
                  </label>
                );
              })}
            </div>
            <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button className="btn" onClick={() => setPickerOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={doAssign} disabled={busy}>Assign</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ color, n, label }: { color: string; n: number; label: string }) {
  return (
    <div style={{ border: `1px solid ${color}33`, background: `${color}11`, borderRadius: 12, padding: "10px 16px", minWidth: 110 }}>
      <div style={{ fontWeight: 900, fontSize: 22, color }}>{n}</div>
      <div style={{ fontSize: 12, color: "#6b7280", fontWeight: 700 }}>{label}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    completed: { bg: "#dcfce7", fg: "#166534", label: "Completed" },
    in_progress: { bg: "#fef9c3", fg: "#854d0e", label: "In progress" },
    not_started: { bg: "#fee2e2", fg: "#991b1b", label: "Not started" },
  };
  const s = map[status] ?? map.not_started;
  return <span style={{ background: s.bg, color: s.fg, fontWeight: 700, fontSize: 12, padding: "3px 10px", borderRadius: 999 }}>{s.label}</span>;
}

const th: React.CSSProperties = { padding: "10px 14px", fontWeight: 700, fontSize: 12 };
const td: React.CSSProperties = { padding: "10px 14px", color: "#374151" };
const mini: React.CSSProperties = { padding: "4px 10px", fontSize: 12, marginLeft: 6 };
