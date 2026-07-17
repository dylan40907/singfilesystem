"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { CourseGroup, fetchGroups, fetchGroupMembersMap } from "@/lib/courses";
import { useEscapeKey } from "@/components/ui/useEscapeKey";

type PickUser = { id: string; full_name: string | null; username: string | null; email: string | null; role: string | null };

function nameOf(u: { full_name: string | null; username: string | null; email: string | null }) {
  return (u.full_name ?? "").trim() || (u.username ?? "").trim() || u.email || "Unknown";
}

/** Select people directly and/or via groups; returns the resolved set of user ids. */
export default function AssignPeopleModal({
  title = "Assign people",
  alreadyAssigned,
  busy,
  onClose,
  onAssign,
}: {
  title?: string;
  alreadyAssigned?: Set<string>;
  busy?: boolean;
  onClose: () => void;
  onAssign: (userIds: string[]) => void;
}) {
  const [users, setUsers] = useState<PickUser[]>([]);
  const [groups, setGroups] = useState<CourseGroup[]>([]);
  const [membersByGroup, setMembersByGroup] = useState<Map<string, string[]>>(new Map());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  useEscapeKey(onClose, !busy);

  useEffect(() => {
    (async () => {
      const [{ data: us }, gs] = await Promise.all([
        supabase.from("user_profiles").select("id, full_name, username, email, role").eq("is_active", true).order("full_name"),
        fetchGroups(),
      ]);
      setUsers((us ?? []) as PickUser[]);
      setGroups(gs);
      setMembersByGroup(await fetchGroupMembersMap(gs.map((g) => g.id)));
      setLoading(false);
    })();
  }, []);

  function toggleUser(id: string, on: boolean) {
    setSel((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });
  }
  function toggleGroup(g: CourseGroup, on: boolean) {
    const members = membersByGroup.get(g.id) ?? [];
    setSel((s) => {
      const n = new Set(s);
      members.forEach((m) => (on ? n.add(m) : (alreadyAssigned?.has(m) ? null : n.delete(m))));
      return n;
    });
  }
  const groupChecked = (g: CourseGroup) => {
    const members = membersByGroup.get(g.id) ?? [];
    return members.length > 0 && members.every((m) => sel.has(m) || alreadyAssigned?.has(m));
  };

  const selectedCount = useMemo(() => Array.from(sel).filter((id) => !alreadyAssigned?.has(id)).length, [sel, alreadyAssigned]);

  return (
    <div onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 250, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="card" style={{ width: "100%", maxWidth: 480, maxHeight: "84vh", display: "flex", flexDirection: "column" }}>
        <div style={{ fontWeight: 900, fontSize: 17, marginBottom: 10 }}>{title}</div>

        {loading ? <div className="subtle">Loading…</div> : (
          <div style={{ overflowY: "auto", flex: 1 }}>
            {groups.length > 0 && (
              <>
                <div style={{ fontWeight: 800, fontSize: 12, color: "#6b7280", margin: "4px 0 6px" }}>GROUPS</div>
                {groups.map((g) => (
                  <label key={g.id} className="row" style={{ gap: 10, padding: "8px 4px", alignItems: "center", cursor: g.memberCount ? "pointer" : "default", opacity: g.memberCount ? 1 : 0.5 }}>
                    <input type="checkbox" disabled={!g.memberCount} checked={groupChecked(g)} onChange={(e) => toggleGroup(g, e.target.checked)} />
                    <span style={{ flex: 1, fontWeight: 600 }}>👥 {g.name}</span>
                    <span className="subtle" style={{ fontSize: 12 }}>{g.memberCount} {g.memberCount === 1 ? "person" : "people"}</span>
                  </label>
                ))}
                <div style={{ fontWeight: 800, fontSize: 12, color: "#6b7280", margin: "12px 0 6px" }}>INDIVIDUALS</div>
              </>
            )}
            {users.map((u) => {
              const already = alreadyAssigned?.has(u.id);
              return (
                <label key={u.id} className="row" style={{ gap: 10, padding: "8px 4px", alignItems: "center", opacity: already ? 0.5 : 1, cursor: already ? "default" : "pointer" }}>
                  <input type="checkbox" disabled={already} checked={sel.has(u.id) || !!already} onChange={(e) => toggleUser(u.id, e.target.checked)} />
                  <span style={{ flex: 1 }}>{nameOf(u)} {already && <span className="subtle" style={{ fontSize: 12 }}>(assigned)</span>}</span>
                  <span className="subtle" style={{ fontSize: 12 }}>{u.role}</span>
                </label>
              );
            })}
          </div>
        )}

        <div className="row-between" style={{ marginTop: 12, alignItems: "center" }}>
          <span className="subtle" style={{ fontSize: 13 }}>{selectedCount} selected</span>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || selectedCount === 0}
              onClick={() => onAssign(Array.from(sel).filter((id) => !alreadyAssigned?.has(id)))}>
              {busy ? "Assigning…" : "Assign"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
