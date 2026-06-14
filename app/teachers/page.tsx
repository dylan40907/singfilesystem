"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile, fetchActiveTeachers } from "@/lib/teachers";
import { useDialog } from "@/components/ui/useDialog";

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

function normalizeUsername(s: string) {
  return s.trim().toLowerCase();
}
function isValidUsername(username: string) {
  const u = normalizeUsername(username);
  return /^[a-z0-9._-]{3,32}$/.test(u);
}

export default function TeachersPage() {
  const { confirm, modal: dialogModal } = useDialog();

  const [status, setStatus] = useState("");
  const [me, setMe] = useState<TeacherProfile | null>(null);

  // Treat campus_admin as admin for in-page capabilities; list filtering by campus happens below.
  const isAdmin = !!me?.is_active && (me.role === "admin" || me.role === "campus_admin");
  const isAdminOrSupervisor =
    !!me?.is_active && (me.role === "admin" || me.role === "campus_admin" || me.role === "supervisor");

  // For supervisors: the only teacher IDs they may see. null => admin/no filter.
  const [allowedTeacherIds, setAllowedTeacherIds] = useState<string[] | null>(null);

  const [teachers, setTeachers] = useState<TeacherProfile[]>([]);
  const [selectedTeacherId, setSelectedTeacherId] = useState<string>("");

  // Admin-only: Add teacher modal state
  const [addOpen, setAddOpen] = useState(false);
  const [addUsername, setAddUsername] = useState("");
  const [addName, setAddName] = useState("");
  const [addLoading, setAddLoading] = useState(false);

  // Admin-only: delete + reset/deactivate state
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [adminActionLoading, setAdminActionLoading] = useState<{ reset: boolean; active: boolean }>({
    reset: false,
    active: false,
  });

  // Teacher folder permissions
  const [teacherPerms, setTeacherPerms] = useState<UserFolderPermissionRow[]>([]);
  const [teacherPermsLoading, setTeacherPermsLoading] = useState(false);

  const teacherById = useMemo(() => {
    const m = new Map<string, TeacherProfile>();
    for (const t of teachers) m.set(t.id, t);
    return m;
  }, [teachers]);

  const selectedTeacher = selectedTeacherId ? teacherById.get(selectedTeacherId) ?? null : null;

  function isTeacherAllowed(userId: string) {
    if (!userId) return false;
    if (me?.role === "admin") return true;
    if (me?.role === "campus_admin") return Array.isArray(allowedTeacherIds) && allowedTeacherIds.includes(userId);
    if (me?.role === "supervisor") return Array.isArray(allowedTeacherIds) && allowedTeacherIds.includes(userId);
    return false;
  }

  async function loadMe() {
    const profile = await fetchMyProfile();
    setMe(profile);
    return profile;
  }

  async function refreshTeacherList(preferSelectId?: string, profileArg?: TeacherProfile | null) {
    const p = profileArg ?? me;

    // ADMIN or CAMPUS_ADMIN => list_teachers RPC; campus_admin filtered to their campus.
    if (p?.role === "admin" || p?.role === "campus_admin") {
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

      if (p.role === "campus_admin" && p.campus_id) {
        const profileIds = list.map((t) => t.id);
        if (profileIds.length > 0) {
          const { data: emps } = await supabase
            .from("hr_employees")
            .select("profile_id")
            .eq("campus_id", p.campus_id)
            .in("profile_id", profileIds);
          const inCampus = new Set(
            ((emps ?? []) as { profile_id: string | null }[]).map((e) => e.profile_id).filter((v): v is string => !!v)
          );
          list = list.filter((t) => inCampus.has(t.id));
        } else {
          list = [];
        }
      }

      list.sort((a, b) => {
        const aActive = a.is_active ? 0 : 1;
        const bActive = b.is_active ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        const an = (a.full_name ?? a.username ?? "").toLowerCase();
        const bn = (b.full_name ?? b.username ?? "").toLowerCase();
        return an.localeCompare(bn);
      });

      setAllowedTeacherIds(p.role === "campus_admin" ? list.map((t) => t.id) : null);
      setTeachers(list);

      const exists = (id: string) => list.some((t) => t.id === id);
      const nextSelect =
        (preferSelectId && exists(preferSelectId) && preferSelectId) ||
        (selectedTeacherId && exists(selectedTeacherId) && selectedTeacherId) ||
        (list.length > 0 ? list[0].id : "");
      if (nextSelect !== selectedTeacherId) setSelectedTeacherId(nextSelect);
      return;
    }

    // SUPERVISOR => only assigned teachers
    if (p?.role === "supervisor") {
      const list = await fetchActiveTeachers();
      const safeList = (list ?? []).map((t) => ({ ...t, role: "teacher" })) as TeacherProfile[];
      safeList.sort((a, b) => {
        const an = (a.full_name ?? a.username ?? "").toLowerCase();
        const bn = (b.full_name ?? b.username ?? "").toLowerCase();
        return an.localeCompare(bn);
      });

      setAllowedTeacherIds(safeList.map((t) => t.id));
      setTeachers(safeList);

      const exists = (id: string) => safeList.some((t) => t.id === id);
      const nextSelect =
        (preferSelectId && exists(preferSelectId) && preferSelectId) ||
        (selectedTeacherId && exists(selectedTeacherId) && selectedTeacherId) ||
        (safeList.length > 0 ? safeList[0].id : "");
      if (nextSelect !== selectedTeacherId) setSelectedTeacherId(nextSelect);
      return;
    }

    setAllowedTeacherIds([]);
    setTeachers([]);
    setSelectedTeacherId("");
  }

  // ADMIN: reset password via Edge Function
  async function resetSelectedTeacherPassword() {
    if (!isAdmin || !selectedTeacherId) return;
    const label = selectedTeacher ? labelForUser(selectedTeacher) : selectedTeacherId;
    const ok = await confirm(`Reset password for this teacher?\n\n${label}\n\nThey will need to use "Set up an account" again.`);
    if (!ok) return;

    setAdminActionLoading((s) => ({ ...s, reset: true }));
    setStatus("Resetting password...");
    try {
      const { error } = await supabase.functions.invoke("admin-reset-user-password", {
        body: { target_user_id: selectedTeacherId },
      });
      if (error) {
        setStatus("Reset password error: " + (error.message ?? "unknown"));
        return;
      }
      setStatus("✅ Password reset.");
      await refreshTeacherList(selectedTeacherId, me);
    } catch (e: any) {
      setStatus("Reset password error: " + (e?.message ?? "unknown"));
    } finally {
      setAdminActionLoading((s) => ({ ...s, reset: false }));
    }
  }

  // ADMIN: deactivate/activate via Edge Function
  async function setSelectedTeacherActive(nextActive: boolean) {
    if (!isAdmin || !selectedTeacherId) return;
    const label = selectedTeacher ? labelForUser(selectedTeacher) : selectedTeacherId;
    const ok = await confirm(
      `${nextActive ? "Activate" : "Deactivate"} this teacher?\n\n${label}\n\n${
        nextActive ? "They will be able to log in again." : "They will be signed out and won't be able to log in."
      }`
    );
    if (!ok) return;

    setAdminActionLoading((s) => ({ ...s, active: true }));
    setStatus(nextActive ? "Activating..." : "Deactivating...");
    try {
      const { error } = await supabase.functions.invoke("admin-set-user-active", {
        body: { target_user_id: selectedTeacherId, is_active: nextActive },
      });
      if (error) {
        setStatus((nextActive ? "Activate" : "Deactivate") + " error: " + (error.message ?? "unknown"));
        return;
      }
      setStatus(nextActive ? "✅ Activated." : "✅ Deactivated.");
      await refreshTeacherList(selectedTeacherId, me);
    } catch (e: any) {
      setStatus((nextActive ? "Activate" : "Deactivate") + " error: " + (e?.message ?? "unknown"));
    } finally {
      setAdminActionLoading((s) => ({ ...s, active: false }));
    }
  }

  // ADMIN: create teacher via Edge Function
  async function createTeacher() {
    const username = normalizeUsername(addUsername.trim());
    const name = addName.trim();

    if (!username || !isValidUsername(username)) {
      setStatus("Create teacher error: Please enter a valid username (3–32 chars, letters/numbers/._-).");
      return;
    }
    if (username.includes("@")) {
      setStatus("Create teacher error: Username cannot contain '@'.");
      return;
    }
    if (!name) {
      setStatus("Create teacher error: Please enter a name.");
      return;
    }

    setAddLoading(true);
    setStatus("Creating teacher...");
    try {
      const { data, error } = await supabase.functions.invoke("admin-create-teacher", {
        body: { teacher_username: username, teacher_full_name: name },
      });
      if (error) {
        setStatus("Create teacher error: " + (error.message ?? "unknown"));
        return;
      }
      setStatus("✅ Teacher created.");
      setAddOpen(false);
      setAddUsername("");
      setAddName("");
      const createdId = (data as any)?.teacher_id ?? (data as any)?.id ?? null;
      await refreshTeacherList(typeof createdId === "string" ? createdId : undefined, me);
    } catch (e: any) {
      setStatus("Create teacher error: " + (e?.message ?? "unknown"));
    } finally {
      setAddLoading(false);
    }
  }

  // ADMIN: delete teacher via Edge Function
  async function deleteSelectedTeacher() {
    if (!isAdmin || !selectedTeacherId) return;
    const label = selectedTeacher ? labelForUser(selectedTeacher) : selectedTeacherId;
    const ok = await confirm(`Delete this teacher?\n\n${label}\n\nThis cannot be undone.`, { danger: true });
    if (!ok) return;

    setDeleteLoading(true);
    setStatus("Deleting teacher...");
    try {
      const { error } = await supabase.functions.invoke("admin-delete-teacher", {
        body: { teacher_id: selectedTeacherId },
      });
      if (error) {
        setStatus("Delete teacher error: " + (error.message ?? "unknown"));
        return;
      }
      setStatus("✅ Teacher deleted.");
      setSelectedTeacherId("");
      await refreshTeacherList(undefined, me);
    } catch (e: any) {
      setStatus("Delete teacher error: " + (e?.message ?? "unknown"));
    } finally {
      setDeleteLoading(false);
    }
  }

  async function refreshTeacherPerms(userId: string) {
    if (!isTeacherAllowed(userId)) {
      setStatus("Not authorized to view this teacher.");
      setTeacherPerms([]);
      return;
    }
    setTeacherPermsLoading(true);
    try {
      const { data, error } = await supabase.rpc("list_user_folder_permissions", { target_user: userId });
      if (error) throw error;
      setTeacherPerms((data ?? []) as UserFolderPermissionRow[]);
    } catch (e: any) {
      setStatus("Error loading permissions: " + (e?.message ?? "unknown"));
      setTeacherPerms([]);
    } finally {
      setTeacherPermsLoading(false);
    }
  }

  async function revokePermission(permissionId: string) {
    setStatus("Revoking permission...");
    try {
      const { error } = await supabase.rpc("revoke_permission", { permission_uuid: permissionId });
      if (error) throw error;
      setStatus("✅ Permission revoked.");
      if (selectedTeacherId) await refreshTeacherPerms(selectedTeacherId);
    } catch (e: any) {
      setStatus("Revoke error: " + (e?.message ?? "unknown"));
    }
  }

  async function bootstrap() {
    setStatus("Loading...");
    try {
      const profile = await loadMe();
      if (
        !profile?.is_active ||
        !(profile.role === "admin" || profile.role === "campus_admin" || profile.role === "supervisor")
      ) {
        setStatus("Not authorized.");
        return;
      }
      await refreshTeacherList(undefined, profile);
      setStatus("");
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    }
  }

  useEffect(() => {
    bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If a supervisor somehow has a selectedTeacherId that isn't allowed, clear it.
  useEffect(() => {
    if (!isAdminOrSupervisor || !selectedTeacherId) return;
    if (me?.role === "supervisor" && Array.isArray(allowedTeacherIds) && !allowedTeacherIds.includes(selectedTeacherId)) {
      setStatus("Not authorized to view that teacher.");
      setSelectedTeacherId("");
      setTeacherPerms([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeacherId, allowedTeacherIds, me?.role, isAdminOrSupervisor]);

  // Load folder permissions for the selected teacher.
  useEffect(() => {
    if (!isAdminOrSupervisor || !selectedTeacherId) return;
    if (!isTeacherAllowed(selectedTeacherId)) {
      setStatus("Not authorized to view this teacher.");
      setTeacherPerms([]);
      return;
    }
    refreshTeacherPerms(selectedTeacherId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeacherId, isAdminOrSupervisor]);

  if (!isAdminOrSupervisor) {
    return (
      <main className="stack">
        <div className="row-between">
          <div className="stack" style={{ gap: 6 }}>
            <h1 className="h1">Teachers</h1>
            <div className="subtle">Supervisor-only access.</div>
          </div>
          {status ? <span className="badge badge-pink">{status}</span> : null}
        </div>
        <div className="card">
          <div style={{ fontWeight: 800 }}>Not authorized</div>
          <div className="subtle" style={{ marginTop: 6 }}>
            You must be an active supervisor/admin to view this page.
          </div>
        </div>
      </main>
    );
  }

  const selectedTeacherIsActive = selectedTeacher ? !!selectedTeacher.is_active : true;
  const supervisorHasNoTeachers =
    me?.role === "supervisor" && Array.isArray(allowedTeacherIds) && allowedTeacherIds.length === 0;

  return (
    <>
      {dialogModal}
      <main className="stack">
        <div className="row-between">
          <div className="stack" style={{ gap: 6 }}>
            <h1 className="h1">Teachers</h1>
          </div>
          {status ? <span className="badge badge-pink">{status}</span> : null}
        </div>

        <div className="card">
          <div className="row-between">
            <div>
              <div style={{ fontWeight: 900 }}>Select teacher</div>
              {selectedTeacher ? (
                <div className="subtle" style={{ marginTop: 4 }}>
                  Status: <strong>{selectedTeacher.is_active ? "active" : "inactive"}</strong>
                </div>
              ) : supervisorHasNoTeachers ? (
                <div className="subtle" style={{ marginTop: 4 }}>
                  Status: <strong>no assigned teachers</strong>
                </div>
              ) : null}
            </div>

            <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              {isAdmin ? (
                <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
                  Add teacher
                </button>
              ) : null}

              <button className="btn" onClick={() => refreshTeacherList(undefined, me)}>
                Refresh teachers
              </button>

              {isAdmin ? (
                <>
                  <button
                    className="btn"
                    onClick={() => void resetSelectedTeacherPassword()}
                    disabled={!selectedTeacherId || adminActionLoading.reset}
                    title="Reset password for selected teacher"
                  >
                    {adminActionLoading.reset ? "Resetting..." : "Reset password"}
                  </button>

                  <button
                    className="btn"
                    onClick={() => void setSelectedTeacherActive(!selectedTeacherIsActive)}
                    disabled={!selectedTeacherId || adminActionLoading.active}
                    title={selectedTeacherIsActive ? "Deactivate selected teacher" : "Activate selected teacher"}
                  >
                    {adminActionLoading.active ? "Saving..." : selectedTeacherIsActive ? "Deactivate" : "Activate"}
                  </button>

                  <button
                    className="btn"
                    title="Delete selected teacher"
                    onClick={() => void deleteSelectedTeacher()}
                    disabled={!selectedTeacherId || deleteLoading}
                    style={{ padding: "8px 10px" }}
                  >
                    🗑
                  </button>
                </>
              ) : null}
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <select
              className="select"
              value={selectedTeacherId}
              onChange={(e) => setSelectedTeacherId(e.target.value)}
              disabled={teachers.length === 0}
            >
              {teachers.map((t) => (
                <option key={t.id} value={t.id}>
                  {labelForUser(t)}
                  {t.is_active ? "" : " (inactive)"}
                </option>
              ))}
            </select>

            {supervisorHasNoTeachers ? (
              <div className="subtle" style={{ marginTop: 10 }}>
                You don’t have any teachers assigned yet. Ask an admin to assign teachers to you in <strong>Supervisors</strong>.
              </div>
            ) : null}
          </div>
        </div>

        {/* Admin-only Add Teacher Modal */}
        {isAdmin && addOpen ? (
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
                <div style={{ fontWeight: 950, fontSize: 16 }}>Add teacher</div>
                <button className="btn" onClick={() => !addLoading && setAddOpen(false)} disabled={addLoading}>
                  Close
                </button>
              </div>

              <div className="hr" />

              <div className="stack" style={{ gap: 10 }}>
                <div className="subtle">Creates a teacher account without a password (for now).</div>

                <input
                  className="input"
                  placeholder="Teacher username"
                  value={addUsername}
                  onChange={(e) => setAddUsername(e.target.value)}
                  disabled={addLoading}
                />

                <input
                  className="input"
                  placeholder="Teacher full name"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  disabled={addLoading}
                />

                <div className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
                  <button className="btn" onClick={() => setAddOpen(false)} disabled={addLoading}>
                    Cancel
                  </button>
                  <button className="btn btn-primary" onClick={() => void createTeacher()} disabled={addLoading}>
                    {addLoading ? "Creating..." : "Create teacher"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="card">
          <div className="row-between">
            <div>
              <div style={{ fontWeight: 900 }}>Folder permissions</div>
            </div>
            <button
              className="btn"
              onClick={() => selectedTeacherId && refreshTeacherPerms(selectedTeacherId)}
              disabled={!selectedTeacherId || teacherPermsLoading || !isTeacherAllowed(selectedTeacherId)}
            >
              Refresh
            </button>
          </div>

          <div style={{ marginTop: 12 }}>
            {!selectedTeacherId ? (
              <div className="subtle">(Select a teacher)</div>
            ) : !isTeacherAllowed(selectedTeacherId) ? (
              <div className="subtle">(Not authorized)</div>
            ) : teacherPermsLoading ? (
              <div className="subtle">Loading…</div>
            ) : teacherPerms.length === 0 ? (
              <div className="subtle">(No direct folder shares)</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Folder</th>
                    <th>Access</th>
                    <th>Inherit</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {teacherPerms.map((p) => (
                    <tr key={p.permission_id}>
                      <td>{p.folder_name}</td>
                      <td>
                        <span className="badge badge-pink">{p.access}</span>
                      </td>
                      <td>{p.inherit ? "true" : "false"}</td>
                      <td>
                        <button className="btn" onClick={() => revokePermission(p.permission_id)} disabled={!isTeacherAllowed(selectedTeacherId)}>
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
