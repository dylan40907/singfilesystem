"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type ReviewType = "monthly" | "annual";
type RoleKey = "admin" | "campus_admin" | "app_supervisor" | "supervisor" | "teacher";

const ROLES: { key: RoleKey; label: string }[] = [
  { key: "teacher", label: "Teacher (standard)" },
  { key: "supervisor", label: "Supervisor" },
  { key: "app_supervisor", label: "App Supervisor" },
  { key: "campus_admin", label: "Campus Admin" },
  { key: "admin", label: "Admin" },
];

/**
 * Editor for the optional per-role note that appears at the bottom of monthly
 * evaluations and annual reviews. A note is keyed by (review type, role); an
 * empty note means nothing is shown for that role. Admin/campus-admin only.
 */
export default function RoleNotesModal({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<ReviewType>("monthly");
  const [role, setRole] = useState<RoleKey>("teacher");
  // notes[`${type}:${role}`] = text
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("hr_review_role_notes").select("review_type, role_key, note");
      const map: Record<string, string> = {};
      for (const r of data ?? []) map[`${r.review_type}:${r.role_key}`] = r.note ?? "";
      setNotes(map);
      setLoading(false);
    })();
  }, []);

  const key = `${type}:${role}`;
  const value = notes[key] ?? "";

  async function save() {
    setSaving(true);
    setStatus("");
    const { error } = await supabase
      .from("hr_review_role_notes")
      .upsert({ review_type: type, role_key: role, note: value, updated_at: new Date().toISOString() }, { onConflict: "review_type,role_key" });
    setSaving(false);
    setStatus(error ? "Error: " + error.message : "✓ Saved");
    if (!error) setTimeout(() => setStatus(""), 2000);
  }

  const roleLabel = useMemo(() => ROLES.find((r) => r.key === role)?.label ?? role, [role]);

  return (
    <div onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="card" style={{ width: "100%", maxWidth: 620, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="row-between">
          <div style={{ fontWeight: 900, fontSize: 18 }}>📝 Role-specific review notes</div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="subtle" style={{ fontSize: 13 }}>
          Optional. A note appears at the bottom of that review type for employees whose role matches. Leave blank to show nothing.
        </div>

        {/* Monthly / Annual tab toggle */}
        <div className="row" style={{ gap: 6 }}>
          {(["monthly", "annual"] as ReviewType[]).map((t) => (
            <button key={t}
              className={type === t ? "btn btn-primary" : "btn"}
              style={{ flex: 1 }}
              onClick={() => setType(t)}>
              {t === "monthly" ? "Monthly evaluations" : "Annual reviews"}
            </button>
          ))}
        </div>

        <label style={{ fontWeight: 700, fontSize: 13 }}>
          Role
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as RoleKey)} style={{ display: "block", width: "100%", marginTop: 4 }}>
            {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </label>

        <label style={{ fontWeight: 700, fontSize: 13 }}>
          Note for {roleLabel} · {type === "monthly" ? "Monthly" : "Annual"}
          <textarea
            className="input"
            value={loading ? "" : value}
            disabled={loading}
            placeholder={loading ? "Loading…" : "e.g. Reminder about expectations for this role…"}
            onChange={(e) => setNotes((m) => ({ ...m, [key]: e.target.value }))}
            rows={6}
            style={{ display: "block", width: "100%", marginTop: 4, resize: "vertical" }}
          />
        </label>

        <div className="row-between">
          <span className="subtle" style={{ fontWeight: 800 }}>{status}</span>
          <button className="btn btn-primary" onClick={save} disabled={saving || loading}>{saving ? "Saving…" : "Save note"}</button>
        </div>
      </div>
    </div>
  );
}
