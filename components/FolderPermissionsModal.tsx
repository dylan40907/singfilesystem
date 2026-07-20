"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile, fetchActiveTeachers } from "@/lib/teachers";
import { useEscapeKey } from "@/components/ui/useEscapeKey";

type UserFolderPermissionRow = {
  permission_id: string;
  folder_id: string;
  folder_name: string;
  access: "view" | "download" | "manage";
  inherit: boolean;
  created_at: string;
};

function labelForUser(u: { full_name?: string | null; username?: string | null; id: string }) {
  const name = (u.full_name ?? "").trim();
  const username = ((u as any).username ?? "").trim();
  if (name && username) return `${name} (${username})`;
  if (username) return username;
  if (name) return name;
  return u.id;
}

/**
 * Read-only-ish view of a teacher's folder shares, opened from the Files home.
 * Account management (reset password/phone, activate, delete) lives in HR →
 * Employees now; this modal is purely about folder access.
 */
export default function FolderPermissionsModal({ onClose }: { onClose: () => void }) {
  useEscapeKey(onClose);

  const [me, setMe] = useState<TeacherProfile | null>(null);
  const [teachers, setTeachers] = useState<TeacherProfile[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [perms, setPerms] = useState<UserFolderPermissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [permsLoading, setPermsLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");

  // Load profile + the teacher list this viewer is allowed to see.
  useEffect(() => {
    (async () => {
      try {
        const p = await fetchMyProfile();
        setMe(p);
        if (!p?.is_active) { setLoading(false); return; }

        if (p.role === "admin" || p.role === "campus_admin") {
          const { data, error } = await supabase.rpc("list_teachers");
          if (error) throw error;
          let list = ((data ?? []) as any[]).map((r) => ({
            id: r.id as string,
            email: (r.email ?? null) as string | null,
            username: (r.username ?? null) as string | null,
            full_name: (r.full_name ?? null) as string | null,
            role: "teacher",
            is_active: !!r.is_active,
            has_set_password: (r.has_set_password ?? true) as boolean,
            campus_id: (r.campus_id ?? null) as string | null,
          })) as TeacherProfile[];

          // Campus admins only see teachers at their own campus.
          if (p.role === "campus_admin" && p.campus_id) {
            const ids = list.map((t) => t.id);
            if (ids.length) {
              const { data: emps } = await supabase
                .from("hr_employees").select("profile_id")
                .eq("campus_id", p.campus_id).in("profile_id", ids);
              const inCampus = new Set(
                ((emps ?? []) as { profile_id: string | null }[]).map((e) => e.profile_id).filter((v): v is string => !!v)
              );
              list = list.filter((t) => inCampus.has(t.id));
            } else list = [];
          }

          list.sort((a, b) => {
            const aA = a.is_active ? 0 : 1, bA = b.is_active ? 0 : 1;
            if (aA !== bA) return aA - bA;
            return (a.full_name ?? a.username ?? "").toLowerCase().localeCompare((b.full_name ?? b.username ?? "").toLowerCase());
          });
          setTeachers(list);
        } else if (p.role === "supervisor") {
          // Supervisors only see the teachers assigned to them.
          const list = ((await fetchActiveTeachers()) ?? []).map((t) => ({ ...t, role: "teacher" })) as TeacherProfile[];
          list.sort((a, b) =>
            (a.full_name ?? a.username ?? "").toLowerCase().localeCompare((b.full_name ?? b.username ?? "").toLowerCase())
          );
          setTeachers(list);
        }
      } catch (e: any) {
        setStatus("Error: " + (e?.message ?? "unknown"));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const loadPerms = useCallback(async (userId: string) => {
    if (!userId) { setPerms([]); return; }
    setPermsLoading(true);
    try {
      const { data, error } = await supabase.rpc("list_user_folder_permissions", { target_user: userId });
      if (error) throw error;
      setPerms((data ?? []) as UserFolderPermissionRow[]);
    } catch (e: any) {
      setStatus("Error loading permissions: " + (e?.message ?? "unknown"));
      setPerms([]);
    } finally {
      setPermsLoading(false);
    }
  }, []);

  useEffect(() => { void loadPerms(selectedId); }, [selectedId, loadPerms]);

  async function revoke(permissionId: string) {
    setStatus("Revoking…");
    try {
      const { error } = await supabase.rpc("revoke_permission", { permission_uuid: permissionId });
      if (error) throw error;
      setStatus("✅ Permission revoked.");
      await loadPerms(selectedId);
    } catch (e: any) {
      setStatus("Revoke error: " + (e?.message ?? "unknown"));
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return teachers;
    return teachers.filter((t) => labelForUser(t).toLowerCase().includes(q));
  }, [teachers, search]);

  const canUse = !!me?.is_active && (me.role === "admin" || me.role === "campus_admin" || me.role === "supervisor");

  return (
    <div
      onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 300,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div className="card" style={{ width: "min(720px, 100%)", maxHeight: "86vh", display: "flex", flexDirection: "column", borderRadius: 14 }}>
        <div className="row-between" style={{ gap: 10 }}>
          <div>
            <div style={{ fontWeight: 950, fontSize: 16 }}>Teacher folder permissions</div>
            <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>See which folders a teacher has been shared on.</div>
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            {status ? <span className="badge badge-pink">{status}</span> : null}
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="hr" />

        {loading ? (
          <div className="subtle">Loading…</div>
        ) : !canUse ? (
          <div className="subtle">You don’t have access to view teacher permissions.</div>
        ) : (
          <div className="stack" style={{ gap: 12, minHeight: 0, flex: 1 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <input
                className="input"
                placeholder="Search teachers…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ flex: "1 1 200px" }}
              />
              <select
                className="select"
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                disabled={filtered.length === 0}
                style={{ flex: "1 1 240px" }}
              >
                <option value="">— Select a teacher —</option>
                {filtered.map((t) => (
                  <option key={t.id} value={t.id}>
                    {labelForUser(t)}{t.is_active ? "" : " (inactive)"}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ overflowY: "auto", minHeight: 0, flex: 1 }}>
              {!selectedId ? (
                <div className="subtle">(Select a teacher to see their folder shares)</div>
              ) : permsLoading ? (
                <div className="subtle">Loading…</div>
              ) : perms.length === 0 ? (
                <div className="subtle">(No direct folder shares)</div>
              ) : (
                <table className="table">
                  <thead>
                    <tr><th>Folder</th><th>Access</th><th>Inherit</th><th>Action</th></tr>
                  </thead>
                  <tbody>
                    {perms.map((p) => (
                      <tr key={p.permission_id}>
                        <td>{p.folder_name}</td>
                        <td><span className="badge badge-pink">{p.access}</span></td>
                        <td>{p.inherit ? "true" : "false"}</td>
                        <td><button className="btn" onClick={() => void revoke(p.permission_id)}>Revoke</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
