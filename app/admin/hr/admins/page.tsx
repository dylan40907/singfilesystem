"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import { useDialog } from "@/components/ui/useDialog";
import { useCampusFilter } from "@/lib/CampusContext";

/**
 * Admin Management — true admins only.
 *
 * Lets true admins:
 *  - create campus admins (username + full_name + campus assignment)
 *  - change a campus admin's campus
 *  - reset password / activate / deactivate
 */

type CampusAdminRow = {
  id: string;
  email: string | null;
  username: string | null;
  full_name: string | null;
  is_active: boolean;
  campus_id: string | null;
};

function labelFor(u: { full_name: string | null; username: string | null; email: string | null; id: string }) {
  const name = (u.full_name ?? "").trim();
  const username = (u.username ?? "").trim();
  if (name && username) return `${name} (${username})`;
  if (name) return name;
  if (username) return username;
  return u.email ?? u.id;
}

function normalizeUsername(s: string) {
  return s.trim().toLowerCase();
}
function isValidUsername(username: string) {
  const u = normalizeUsername(username);
  return /^[a-z0-9._-]{3,32}$/.test(u);
}

export default function HrAdminsPage() {
  const { confirm, modal: dialogModal } = useDialog();
  const { campuses, refreshCampuses } = useCampusFilter();

  const [me, setMe] = useState<TeacherProfile | null>(null);
  const [status, setStatus] = useState("Loading...");
  const [admins, setAdmins] = useState<CampusAdminRow[]>([]);

  const [addOpen, setAddOpen] = useState(false);
  const [addUsername, setAddUsername] = useState("");
  const [addName, setAddName] = useState("");
  const [addCampusId, setAddCampusId] = useState("");
  const [addLoading, setAddLoading] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);

  const isTrueAdmin = !!me?.is_active && me.role === "admin";

  const reload = useCallback(async () => {
    const { data, error } = await supabase
      .from("user_profiles")
      .select("id, email, username, full_name, is_active, campus_id")
      .eq("role", "campus_admin")
      .order("full_name", { ascending: true });
    if (error) {
      setStatus("Error: " + error.message);
      return;
    }
    setAdmins(((data ?? []) as CampusAdminRow[]).sort((a, b) => {
      const aa = a.is_active ? 0 : 1;
      const bb = b.is_active ? 0 : 1;
      if (aa !== bb) return aa - bb;
      return labelFor(a).toLowerCase().localeCompare(labelFor(b).toLowerCase());
    }));
  }, []);

  useEffect(() => {
    (async () => {
      const p = await fetchMyProfile();
      setMe(p);
      if (!p?.is_active || p.role !== "admin") {
        setStatus("True admin access required.");
        return;
      }
      await reload();
      setStatus("");
    })();
  }, [reload]);

  async function createCampusAdmin() {
    const username = normalizeUsername(addUsername);
    const name = addName.trim();
    if (!username || !isValidUsername(username)) {
      setStatus("Invalid username (3–32 chars, letters/numbers/._-).");
      return;
    }
    if (!name) { setStatus("Full name required."); return; }
    if (!addCampusId) { setStatus("Select a campus."); return; }

    setAddLoading(true);
    setStatus("Creating campus admin...");
    try {
      const { error } = await supabase.functions.invoke("admin-create-campus-admin", {
        body: { admin_username: username, admin_full_name: name, campus_id: addCampusId },
      });
      if (error) { setStatus("Create error: " + error.message); return; }
      setStatus("✅ Campus admin created.");
      setAddOpen(false);
      setAddUsername("");
      setAddName("");
      setAddCampusId("");
      await reload();
    } catch (e: any) {
      setStatus("Create error: " + (e?.message ?? "unknown"));
    } finally {
      setAddLoading(false);
    }
  }

  async function changeCampus(adminId: string, newCampusId: string) {
    setBusyId(adminId);
    setStatus("Updating campus...");
    const { error } = await supabase
      .from("user_profiles")
      .update({ campus_id: newCampusId || null })
      .eq("id", adminId);
    setBusyId(null);
    if (error) { setStatus("Update error: " + error.message); return; }
    setStatus("✅ Campus updated.");
    await reload();
  }

  async function resetPassword(adminId: string, label: string) {
    const ok = await confirm(`Reset password for ${label}?\n\nThey'll need to use "Set up an account" again.`, {
      title: "Reset Password", confirmLabel: "Reset",
    });
    if (!ok) return;
    setBusyId(adminId);
    setStatus("Resetting password...");
    const { error } = await supabase.functions.invoke("admin-reset-user-password", {
      body: { target_user_id: adminId },
    });
    setBusyId(null);
    if (error) { setStatus("Reset error: " + error.message); return; }
    setStatus("✅ Password reset.");
  }

  async function deleteAdmin(adminId: string, label: string) {
    const ok = await confirm(
      `Delete ${label}?\n\nThis permanently removes the campus admin's account. This cannot be undone.`,
      { title: "Delete Campus Admin", confirmLabel: "Delete", danger: true }
    );
    if (!ok) return;
    setBusyId(adminId);
    setStatus("Deleting campus admin...");
    const { error } = await supabase.functions.invoke("admin-delete-campus-admin", {
      body: { campus_admin_id: adminId },
    });
    setBusyId(null);
    if (error) { setStatus("Delete error: " + error.message); return; }
    setStatus("✅ Campus admin deleted.");
    await reload();
  }

  async function setActive(adminId: string, label: string, nextActive: boolean) {
    const ok = await confirm(
      `${nextActive ? "Activate" : "Deactivate"} ${label}?\n\n${nextActive ? "They will be able to log in again." : "They will be signed out and unable to log in."}`,
      { title: nextActive ? "Activate" : "Deactivate", confirmLabel: nextActive ? "Activate" : "Deactivate", danger: !nextActive }
    );
    if (!ok) return;
    setBusyId(adminId);
    setStatus(nextActive ? "Activating..." : "Deactivating...");
    const { error } = await supabase.functions.invoke("admin-set-user-active", {
      body: { target_user_id: adminId, is_active: nextActive },
    });
    setBusyId(null);
    if (error) { setStatus((nextActive ? "Activate" : "Deactivate") + " error: " + error.message); return; }
    setStatus(nextActive ? "✅ Activated." : "✅ Deactivated.");
    await reload();
  }

  if (!isTrueAdmin) {
    return (
      <main className="stack">
        <div className="row-between">
          <h1 className="h1">Admin Management</h1>
          {status ? <span className="badge badge-pink">{status}</span> : null}
        </div>
        <div className="card">
          <div style={{ fontWeight: 800 }}>Not authorized</div>
          <div className="subtle" style={{ marginTop: 6 }}>True admins only — campus admins cannot manage other admins.</div>
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
            <h1 className="h1">Admin Management</h1>
            <div className="subtle">Manage campus admins. Each campus admin is locked to a single campus.</div>
          </div>
          {status ? <span className="badge badge-pink">{status}</span> : null}
        </div>

        <div className="card">
          <div className="row-between" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ fontWeight: 900 }}>Campus admins ({admins.length})</div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={() => { void refreshCampuses(); void reload(); }}>Refresh</button>
              <button className="btn btn-primary" onClick={() => setAddOpen(true)}>Add campus admin</button>
            </div>
          </div>

          <div className="hr" />

          {admins.length === 0 ? (
            <div className="subtle">No campus admins yet.</div>
          ) : (
            <div className="stack">
              {admins.map((a) => {
                const label = labelFor(a);
                const busy = busyId === a.id;
                return (
                  <div key={a.id} className="row-between" style={{ gap: 12, flexWrap: "wrap" }}>
                    <div style={{ minWidth: 220 }}>
                      <div style={{ fontWeight: 800 }}>{label}</div>
                      <div className="subtle">{a.is_active ? "active" : "inactive"}</div>
                    </div>
                    <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <label className="subtle" style={{ fontSize: 12, fontWeight: 700 }}>Campus</label>
                      <select
                        className="select"
                        value={a.campus_id ?? ""}
                        disabled={busy}
                        onChange={(e) => void changeCampus(a.id, e.target.value)}
                      >
                        <option value="">— None —</option>
                        {campuses.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                      <button className="btn" disabled={busy} onClick={() => void resetPassword(a.id, label)}>Reset password</button>
                      <button className="btn" disabled={busy} onClick={() => void setActive(a.id, label, !a.is_active)}>
                        {a.is_active ? "Deactivate" : "Activate"}
                      </button>
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => void deleteAdmin(a.id, label)}
                        title="Permanently delete this campus admin"
                        style={{ borderColor: "#fca5a5", color: "#991b1b", background: "#fee2e2", fontWeight: 700 }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {addOpen && (
          <div
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 200,
              display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
            }}
            onClick={() => { if (!addLoading) setAddOpen(false); }}
          >
            <div className="card" style={{ width: "min(520px, 100%)", borderRadius: 14 }} onClick={(e) => e.stopPropagation()}>
              <div className="row-between">
                <div style={{ fontWeight: 950, fontSize: 16 }}>Add campus admin</div>
                <button className="btn" onClick={() => !addLoading && setAddOpen(false)} disabled={addLoading}>Close</button>
              </div>
              <div className="hr" />
              <div className="stack" style={{ gap: 10 }}>
                <div className="subtle">Creates a campus admin account (no password yet — they set it on first login).</div>
                <input
                  className="input"
                  placeholder="Admin username"
                  value={addUsername}
                  onChange={(e) => setAddUsername(e.target.value)}
                  disabled={addLoading}
                />
                <input
                  className="input"
                  placeholder="Admin full name"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  disabled={addLoading}
                />
                <select
                  className="select"
                  value={addCampusId}
                  onChange={(e) => setAddCampusId(e.target.value)}
                  disabled={addLoading}
                >
                  <option value="">— Select campus —</option>
                  {campuses.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <div className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
                  <button className="btn" onClick={() => setAddOpen(false)} disabled={addLoading}>Cancel</button>
                  <button className="btn btn-primary" onClick={() => void createCampusAdmin()} disabled={addLoading}>
                    {addLoading ? "Creating..." : "Create"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
