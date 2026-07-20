"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useEscapeKey } from "@/components/ui/useEscapeKey";

type CampusRow = { id: string; name: string };

type NewRole = "teacher" | "supervisor" | "app_supervisor" | "campus_admin";

const ROLE_OPTIONS: { value: NewRole; label: string; hint: string }[] = [
  { value: "teacher", label: "Teacher", hint: "Standard account." },
  { value: "supervisor", label: "Supervisor", hint: "Can be assigned teachers." },
  { value: "app_supervisor", label: "App Supervisor", hint: "Supervisor who can also manage the learning app." },
  { value: "campus_admin", label: "Campus Admin", hint: "Admin rights limited to one campus." },
];

function normalizeUsername(s: string) {
  return s.trim().toLowerCase();
}
function isValidUsername(u: string) {
  return /^[a-z0-9](?:[a-z0-9._-]{1,28}[a-z0-9])$/.test(normalizeUsername(u));
}

/** Unified "Add user" — creates the portal account (and, via trigger, the HR record). */
export default function AddUserModal({
  viewerRole,
  viewerCampusId,
  onClose,
  onCreated,
}: {
  viewerRole: string | null;
  viewerCampusId: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  useEscapeKey(onClose);

  const [role, setRole] = useState<NewRole>("teacher");
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [campusId, setCampusId] = useState("");
  const [campuses, setCampuses] = useState<CampusRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const isTrueAdmin = viewerRole === "admin";

  // Campus admins can't mint other campus admins.
  const options = useMemo(
    () => (isTrueAdmin ? ROLE_OPTIONS : ROLE_OPTIONS.filter((o) => o.value !== "campus_admin")),
    [isTrueAdmin]
  );

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("hr_campuses").select("id,name").order("name", { ascending: true });
      setCampuses((data ?? []) as CampusRow[]);
    })();
  }, []);

  const needsCampus = role === "campus_admin";

  async function create() {
    setErr("");
    const u = normalizeUsername(username);
    if (!isValidUsername(u)) { setErr("Enter a valid username (3–30 chars: letters, numbers, . _ -)."); return; }
    if (!fullName.trim()) { setErr("Enter a full name."); return; }
    if (needsCampus && !campusId) { setErr("Pick a campus for this campus admin."); return; }

    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-create-user", {
        body: {
          username: u,
          full_name: fullName.trim(),
          role,
          // Campus admins are pinned server-side to their own campus.
          campus_id: needsCampus ? campusId : (isTrueAdmin ? (campusId || null) : viewerCampusId),
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      onCreated();
    } catch (e: any) {
      setErr(e?.message ?? "Could not create user.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => { if (e.currentTarget === e.target && !busy) onClose(); }}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 300,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div className="card" style={{ width: "min(560px, 100%)", borderRadius: 16 }}>
        <div className="row-between">
          <div style={{ fontWeight: 950, fontSize: 17 }}>Add user</div>
          <button className="btn" onClick={onClose} disabled={busy}>Close</button>
        </div>

        <div className="hr" />

        <div className="stack" style={{ gap: 14 }}>
          <div className="subtle" style={{ fontSize: 13 }}>
            Creates the portal account and its HR employee record. The account starts with no
            password — they finish setup with “Set up an account”.
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <div style={{ fontWeight: 850, fontSize: 13 }}>Role</div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {options.map((o) => {
                const active = role === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setRole(o.value)}
                    disabled={busy}
                    title={o.hint}
                    style={{
                      padding: "7px 14px", borderRadius: 999, cursor: "pointer", fontWeight: 800, fontSize: 13,
                      border: `1.5px solid ${active ? "rgba(230,23,141,0.5)" : "#e5e7eb"}`,
                      background: active ? "rgba(230,23,141,0.08)" : "white",
                      color: active ? "#e6178d" : "#374151",
                    }}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            <div className="subtle" style={{ fontSize: 12 }}>
              {options.find((o) => o.value === role)?.hint}
            </div>
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <div style={{ fontWeight: 850, fontSize: 13 }}>Username</div>
            <input className="input" placeholder="e.g. jane.doe" value={username}
              onChange={(e) => setUsername(e.target.value)} disabled={busy} />
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <div style={{ fontWeight: 850, fontSize: 13 }}>Full name</div>
            <input className="input" placeholder="e.g. Jane Doe" value={fullName}
              onChange={(e) => setFullName(e.target.value)} disabled={busy} />
          </div>

          {isTrueAdmin ? (
            <div className="stack" style={{ gap: 6 }}>
              <div style={{ fontWeight: 850, fontSize: 13 }}>
                Campus {needsCampus ? "" : <span className="subtle" style={{ fontWeight: 500 }}>(optional)</span>}
              </div>
              <select className="select" value={campusId} onChange={(e) => setCampusId(e.target.value)} disabled={busy}>
                <option value="">{needsCampus ? "— Select a campus —" : "— None —"}</option>
                {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {needsCampus ? (
                <div className="subtle" style={{ fontSize: 12 }}>Campus admins are locked to this campus.</div>
              ) : null}
            </div>
          ) : (
            <div className="subtle" style={{ fontSize: 12 }}>
              New users are added to your campus.
            </div>
          )}

          {err ? <div style={{ color: "#b91c1c", fontWeight: 700, fontSize: 13 }}>{err}</div> : null}

          <div className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void create()} disabled={busy}>
              {busy ? "Creating…" : "Create user"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
