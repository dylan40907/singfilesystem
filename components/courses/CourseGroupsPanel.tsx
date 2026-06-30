"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useDialog } from "@/components/ui/useDialog";
import {
  CourseGroup, createGroup, deleteGroup, fetchGroupMembers, fetchGroups, renameGroup, setGroupMembers,
} from "@/lib/courses";

type PickUser = { id: string; full_name: string | null; username: string | null; email: string | null; role: string | null };
const nameOf = (u: { full_name: string | null; username: string | null; email: string | null }) =>
  (u.full_name ?? "").trim() || (u.username ?? "").trim() || u.email || "Unknown";

export default function CourseGroupsPanel() {
  const { confirm, modal: dialogModal } = useDialog();
  const [groups, setGroups] = useState<CourseGroup[]>([]);
  const [users, setUsers] = useState<PickUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  // create / rename modal
  const [editModal, setEditModal] = useState<{ mode: "create" | "rename"; id?: string; value: string } | null>(null);
  // members modal
  const [membersModal, setMembersModal] = useState<{ group: CourseGroup; sel: Set<string> } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const [gs, { data: us }] = await Promise.all([
      fetchGroups(),
      supabase.from("user_profiles").select("id, full_name, username, email, role").eq("is_active", true).order("full_name"),
    ]);
    setGroups(gs);
    setUsers((us ?? []) as PickUser[]);
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function confirmEdit() {
    if (!editModal || !editModal.value.trim()) return;
    try {
      if (editModal.mode === "create") await createGroup(editModal.value.trim());
      else if (editModal.id) await renameGroup(editModal.id, editModal.value.trim());
      setEditModal(null);
      await reload();
    } catch (e: any) { setStatus("Error: " + (e?.message ?? "unknown")); }
  }

  async function handleDelete(g: CourseGroup) {
    const ok = await confirm(`Delete group "${g.name}"?\n\nThis only removes the group — assigned courses stay assigned.`, { title: "Delete group", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    await deleteGroup(g.id);
    await reload();
  }

  async function openMembers(g: CourseGroup) {
    const members = await fetchGroupMembers(g.id);
    setMembersModal({ group: g, sel: new Set(members) });
  }
  async function saveMembers() {
    if (!membersModal) return;
    await setGroupMembers(membersModal.group.id, Array.from(membersModal.sel));
    setMembersModal(null);
    setStatus("✅ Members updated.");
    await reload();
  }

  return (
    <div>
      {dialogModal}
      <div className="row-between" style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>People groups</div>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          {status && <span className="badge badge-pink">{status}</span>}
          <button className="btn btn-primary" onClick={() => setEditModal({ mode: "create", value: "" })}>+ New group</button>
        </div>
      </div>

      {loading ? <div className="subtle">Loading…</div> : groups.length === 0 ? (
        <div className="subtle" style={{ padding: 16 }}>No groups yet. Create one to assign courses to many people at once.</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {groups.map((g) => (
            <div key={g.id} className="row-between" style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 14px" }}>
              <div>
                <div style={{ fontWeight: 700 }}>👥 {g.name}</div>
                <div className="subtle" style={{ fontSize: 12 }}>{g.memberCount} {g.memberCount === 1 ? "person" : "people"}</div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn" style={mini} onClick={() => openMembers(g)}>Members</button>
                <button className="btn" style={mini} onClick={() => setEditModal({ mode: "rename", id: g.id, value: g.name })}>Rename</button>
                <button className="btn" style={{ ...mini, color: "#991b1b" }} onClick={() => handleDelete(g)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editModal && (
        <ModalShell title={editModal.mode === "create" ? "New group" : "Rename group"} onClose={() => setEditModal(null)}>
          <input className="input" autoFocus value={editModal.value} placeholder="Group name"
            onChange={(e) => setEditModal((m) => (m ? { ...m, value: e.target.value } : m))}
            onKeyDown={(e) => { if (e.key === "Enter") confirmEdit(); }} />
          <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button className="btn" onClick={() => setEditModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={confirmEdit} disabled={!editModal.value.trim()}>{editModal.mode === "create" ? "Create" : "Save"}</button>
          </div>
        </ModalShell>
      )}

      {membersModal && (
        <ModalShell title={`Members · ${membersModal.group.name}`} onClose={() => setMembersModal(null)} tall>
          <div style={{ overflowY: "auto", flex: 1, marginTop: 4 }}>
            {users.map((u) => (
              <label key={u.id} className="row" style={{ gap: 10, padding: "8px 4px", alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={membersModal.sel.has(u.id)}
                  onChange={(e) => setMembersModal((m) => {
                    if (!m) return m;
                    const n = new Set(m.sel); e.target.checked ? n.add(u.id) : n.delete(u.id);
                    return { ...m, sel: n };
                  })} />
                <span style={{ flex: 1 }}>{nameOf(u)}</span>
                <span className="subtle" style={{ fontSize: 12 }}>{u.role}</span>
              </label>
            ))}
          </div>
          <div className="row-between" style={{ marginTop: 12, alignItems: "center" }}>
            <span className="subtle" style={{ fontSize: 13 }}>{membersModal.sel.size} selected</span>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={() => setMembersModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveMembers}>Save</button>
            </div>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

function ModalShell({ title, onClose, tall, children }: { title: string; onClose: () => void; tall?: boolean; children: React.ReactNode }) {
  return (
    <div onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 250, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="card" style={{ width: "100%", maxWidth: 460, maxHeight: tall ? "84vh" : undefined, display: "flex", flexDirection: "column" }}>
        <div style={{ fontWeight: 900, fontSize: 17, marginBottom: 8 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

const mini: React.CSSProperties = { padding: "4px 10px", fontSize: 12 };
