"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useEscapeKey } from "@/components/ui/useEscapeKey";

type ReviewType = "monthly" | "annual";
type JobLevel = { id: string; name: string };

/**
 * Editor for the optional per-job-level note shown at the bottom of monthly
 * evaluations and annual reviews. A note is keyed by (review type, job level);
 * an empty note means nothing is shown for employees at that level. Employees
 * with no job level never see an extra note. Admin/campus-admin only.
 */
export default function RoleNotesModal({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<ReviewType>("monthly");
  const [levels, setLevels] = useState<JobLevel[]>([]);
  const [levelId, setLevelId] = useState<string>("");
  // notes[`${type}:${levelId}`] = text
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  useEscapeKey(onClose);

  useEffect(() => {
    (async () => {
      const [{ data: lvls }, { data: existing }] = await Promise.all([
        supabase.from("hr_job_levels").select("id, name").order("name", { ascending: true }),
        supabase.from("hr_review_role_notes").select("review_type, job_level_id, note"),
      ]);
      const list = (lvls ?? []) as JobLevel[];
      setLevels(list);
      if (list.length) setLevelId(list[0].id);
      const map: Record<string, string> = {};
      for (const r of existing ?? []) map[`${r.review_type}:${r.job_level_id}`] = r.note ?? "";
      setNotes(map);
      setLoading(false);
    })();
  }, []);

  const key = `${type}:${levelId}`;
  const value = notes[key] ?? "";

  async function save() {
    if (!levelId) return;
    setSaving(true);
    setStatus("");
    const { error } = await supabase
      .from("hr_review_role_notes")
      .upsert({ review_type: type, job_level_id: levelId, note: value, updated_at: new Date().toISOString() }, { onConflict: "review_type,job_level_id" });
    setSaving(false);
    setStatus(error ? "Error: " + error.message : "✓ Saved");
    if (!error) setTimeout(() => setStatus(""), 2000);
  }

  const levelName = useMemo(() => levels.find((l) => l.id === levelId)?.name ?? "", [levels, levelId]);

  return (
    <div onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="card" style={{ width: "100%", maxWidth: 620, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="row-between">
          <div style={{ fontWeight: 900, fontSize: 18 }}>📝 Job-level review notes</div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="subtle" style={{ fontSize: 13 }}>
          Optional. A note appears at the bottom of that review type for employees at the chosen job level. Leave blank to show nothing. Employees with no job level never see an extra note.
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
          Job level
          <select className="select" value={levelId} onChange={(e) => setLevelId(e.target.value)} disabled={loading || levels.length === 0} style={{ display: "block", width: "100%", marginTop: 4 }}>
            {levels.length === 0 ? <option value="">(no job levels defined)</option> : levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>

        <label style={{ fontWeight: 700, fontSize: 13 }}>
          Note for {levelName || "—"} · {type === "monthly" ? "Monthly" : "Annual"}
          <textarea
            className="input"
            value={loading ? "" : value}
            disabled={loading || !levelId}
            placeholder={loading ? "Loading…" : "e.g. Reminder about expectations for this level…"}
            onChange={(e) => setNotes((m) => ({ ...m, [key]: e.target.value }))}
            rows={6}
            style={{ display: "block", width: "100%", marginTop: 4, resize: "vertical" }}
          />
        </label>

        <div className="row-between">
          <span className="subtle" style={{ fontWeight: 800 }}>{status}</span>
          <button className="btn btn-primary" onClick={save} disabled={saving || loading || !levelId}>{saving ? "Saving…" : "Save note"}</button>
        </div>
      </div>
    </div>
  );
}
