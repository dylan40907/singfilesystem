"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile, UserRole } from "@/lib/teachers";
import { useDialog } from "@/components/ui/useDialog";
import { useCampusFilter } from "@/lib/CampusContext";

/**
 * Roles — true admins only. Lets a true admin change any non-admin user's role
 * between teacher / supervisor / campus_admin (and assign campus for campus_admin).
 *
 * Other admin users (campus admins) cannot access this page.
 */

type UserRow = {
  id: string;
  email: string | null;
  username: string | null;
  full_name: string | null;
  is_active: boolean;
  role: Exclude<UserRole, "admin" | "employee" | "hours_manager">;
  campus_id: string | null;
  can_manage_learning: boolean;
};

type EligibleRole = "teacher" | "supervisor" | "campus_admin";
// A supervisor with the learning flag is selected/shown as "App Supervisor".
type EligibleSelection = "teacher" | "supervisor" | "app_supervisor" | "campus_admin";

const SELECTION_LABEL: Record<EligibleSelection, string> = {
  teacher: "Teacher",
  supervisor: "Supervisor",
  app_supervisor: "App Supervisor",
  campus_admin: "Campus Admin",
};

// What the dropdown reflects for an already-saved user.
function currentSelection(u: UserRow): EligibleSelection {
  return u.role === "supervisor" && u.can_manage_learning ? "app_supervisor" : u.role;
}

function labelFor(u: UserRow): string {
  const name = (u.full_name ?? "").trim();
  const username = (u.username ?? "").trim();
  if (name && username) return `${name} (${username})`;
  if (name) return name;
  if (username) return username;
  return u.email ?? u.id;
}

export default function HrRolesPage() {
  const { confirm, modal: dialogModal } = useDialog();
  const { campuses, refreshCampuses } = useCampusFilter();

  const [me, setMe] = useState<TeacherProfile | null>(null);
  const [status, setStatus] = useState("Loading...");
  const [users, setUsers] = useState<UserRow[]>([]);

  // Per-row staged change: pending role + campus selection (before user clicks Save).
  const [staged, setStaged] = useState<Record<string, { role: EligibleSelection; campusId: string }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const isTrueAdmin = !!me?.is_active && me.role === "admin";

  const reload = useCallback(async () => {
    const { data, error } = await supabase
      .from("user_profiles")
      .select("id, email, username, full_name, is_active, role, campus_id, can_manage_learning")
      .in("role", ["teacher", "supervisor", "campus_admin"])
      .order("role", { ascending: true })
      .order("full_name", { ascending: true });
    if (error) {
      setStatus("Error: " + error.message);
      return;
    }
    // Drop any nameless rows (defensive — e.g. stray accounts with no identity).
    const rows = ((data ?? []) as UserRow[]).filter(
      (r) => (r.full_name ?? "").trim() || (r.username ?? "").trim() || (r.email ?? "").trim()
    );
    // Sort: active first, then by role, then name
    rows.sort((a, b) => {
      const aa = a.is_active ? 0 : 1;
      const bb = b.is_active ? 0 : 1;
      if (aa !== bb) return aa - bb;
      if (a.role !== b.role) return a.role.localeCompare(b.role);
      return labelFor(a).toLowerCase().localeCompare(labelFor(b).toLowerCase());
    });
    setUsers(rows);
  }, []);

  useEffect(() => {
    (async () => {
      const p = await fetchMyProfile();
      setMe(p);
      if (!p?.is_active || p.role !== "admin") {
        setStatus("True admin access required.");
        return;
      }
      await Promise.all([refreshCampuses(), reload()]);
      setStatus("");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  function getStagedFor(u: UserRow): { role: EligibleSelection; campusId: string } {
    return staged[u.id] ?? { role: currentSelection(u), campusId: u.campus_id ?? "" };
  }

  function setStagedFor(u: UserRow, next: { role: EligibleSelection; campusId: string }) {
    setStaged((prev) => ({ ...prev, [u.id]: next }));
  }

  function resetStagedFor(u: UserRow) {
    setStaged((prev) => {
      const copy = { ...prev };
      delete copy[u.id];
      return copy;
    });
  }

  function isDirty(u: UserRow): boolean {
    const s = staged[u.id];
    if (!s) return false;
    if (s.role !== currentSelection(u)) return true;
    if (s.role === "campus_admin" && s.campusId !== (u.campus_id ?? "")) return true;
    return false;
  }

  async function saveRow(u: UserRow) {
    const s = getStagedFor(u);
    // "App Supervisor" is stored as a supervisor + the can_manage_learning flag.
    const newRole: EligibleRole = s.role === "app_supervisor" ? "supervisor" : s.role;
    const grantLearning = s.role === "app_supervisor";

    if (newRole === "campus_admin" && !s.campusId) {
      setStatus("Pick a campus for the campus admin.");
      return;
    }

    // Warn only when actually LEAVING supervisor (App Supervisor stays supervisor).
    if (u.role === "supervisor" && newRole !== "supervisor") {
      const { count } = await supabase
        .from("supervisor_teacher_assignments")
        .select("*", { count: "exact", head: true })
        .eq("supervisor_user_id", u.id);
      const n = count ?? 0;
      if (n > 0) {
        const ok = await confirm(
          `${labelFor(u)} is currently supervising ${n} teacher${n === 1 ? "" : "s"}.\n\nChanging their role to ${SELECTION_LABEL[s.role]} will remove all of those teacher assignments. Continue?`,
          { title: "Supervisor has assignments", danger: true, confirmLabel: "Change role and unassign" }
        );
        if (!ok) return;
      }
    } else {
      const ok = await confirm(
        `Change ${labelFor(u)} from ${SELECTION_LABEL[currentSelection(u)]} to ${SELECTION_LABEL[s.role]}?`,
        { title: "Change role", confirmLabel: "Change" }
      );
      if (!ok) return;
    }

    setBusyId(u.id);
    setStatus("Updating role...");
    const body: Record<string, unknown> = {
      target_user_id: u.id,
      new_role: newRole,
      can_manage_learning: grantLearning,
    };
    if (newRole === "campus_admin") body.campus_id = s.campusId;

    const { error } = await supabase.functions.invoke("admin-change-user-role", { body });
    setBusyId(null);

    if (error) { setStatus("Update error: " + error.message); return; }
    setStatus(`✅ ${labelFor(u)} is now ${SELECTION_LABEL[s.role]}.`);
    resetStagedFor(u);
    await reload();
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => labelFor(u).toLowerCase().includes(q));
  }, [users, search]);

  if (!isTrueAdmin) {
    return (
      <main className="stack">
        <div className="row-between">
          <h1 className="h1">Roles</h1>
          {status ? <span className="badge badge-pink">{status}</span> : null}
        </div>
        <div className="card">
          <div style={{ fontWeight: 800 }}>Not authorized</div>
          <div className="subtle" style={{ marginTop: 6 }}>
            True admins only — campus admins cannot manage roles.
          </div>
        </div>
      </main>
    );
  }

  return (
    <>
      {dialogModal}
      <main className="stack">
        <div className="row-between">
          <div className="stack" style={{ gap: 6 }}>
            <h1 className="h1">Roles</h1>
            <div className="subtle">Change any user&apos;s role to Teacher, Supervisor, App Supervisor, or Campus Admin. &ldquo;App Supervisor&rdquo; is a Supervisor who can also manage the App (learning) page. True admins are not shown.</div>
          </div>
          {status ? <span className="badge badge-pink">{status}</span> : null}
        </div>

        <div className="card">
          <div className="row-between" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ fontWeight: 900 }}>Users ({filtered.length})</div>
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <input
                className="input"
                placeholder="Search name or username…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ width: 240 }}
              />
              <button className="btn" onClick={() => void reload()}>Refresh</button>
            </div>
          </div>

          <div className="hr" />

          {filtered.length === 0 ? (
            <div className="subtle">No users found.</div>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {filtered.map((u) => {
                const s = getStagedFor(u);
                const dirty = isDirty(u);
                const busy = busyId === u.id;
                const currentCampusName = (() => {
                  const c = campuses.find((x) => x.id === u.campus_id);
                  return c?.name ?? null;
                })();

                return (
                  <div
                    key={u.id}
                    className="row-between"
                    style={{
                      gap: 12,
                      flexWrap: "wrap",
                      padding: "10px 4px",
                      borderBottom: "1px solid #f3f4f6",
                    }}
                  >
                    <div style={{ minWidth: 220 }}>
                      <div style={{ fontWeight: 800 }}>{labelFor(u)}</div>
                      <div className="subtle" style={{ fontSize: 12 }}>
                        Current: {SELECTION_LABEL[currentSelection(u)]}
                        {u.role === "campus_admin" && currentCampusName ? ` · ${currentCampusName}` : ""}
                        {!u.is_active ? " · inactive" : ""}
                      </div>
                    </div>
                    <div
                      className="row"
                      style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}
                    >
                      <label className="subtle" style={{ fontSize: 12, fontWeight: 700 }}>
                        Change to
                      </label>
                      <select
                        className="select"
                        value={s.role}
                        disabled={busy}
                        onChange={(e) =>
                          setStagedFor(u, { role: e.target.value as EligibleSelection, campusId: s.campusId })
                        }
                      >
                        <option value="teacher">Teacher</option>
                        <option value="supervisor">Supervisor</option>
                        <option value="app_supervisor">App Supervisor</option>
                        <option value="campus_admin">Campus Admin</option>
                      </select>
                      {s.role === "campus_admin" && (
                        <select
                          className="select"
                          value={s.campusId}
                          disabled={busy}
                          onChange={(e) => setStagedFor(u, { role: s.role, campusId: e.target.value })}
                        >
                          <option value="">— Select campus —</option>
                          {campuses.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      )}
                      <button
                        className="btn btn-primary"
                        disabled={!dirty || busy}
                        onClick={() => void saveRow(u)}
                      >
                        {busy ? "Saving..." : "Save"}
                      </button>
                      {dirty && (
                        <button className="btn" disabled={busy} onClick={() => resetStagedFor(u)}>
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
