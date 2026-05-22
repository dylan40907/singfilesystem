"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { Campus, useCampusFilter } from "@/lib/CampusContext";

/**
 * Campus selector button + dropdown for the HR navbar.
 *
 * - True admins: dropdown shows "All campuses", every campus, "Unassigned", and an "Edit campuses" action.
 * - Campus admins: button is non-interactive and shows their locked campus name.
 * - Hidden for any other role.
 */
export default function CampusSelector() {
  const {
    loading, campuses, filter, setFilter, isTrueAdmin, isCampusAdmin, lockedCampusId, refreshCampuses,
  } = useCampusFilter();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (loading) return null;
  if (!isTrueAdmin && !isCampusAdmin) return null;

  const currentLabel = (() => {
    if (isCampusAdmin) {
      const c = campuses.find((x) => x.id === lockedCampusId);
      return c?.name ?? "Campus";
    }
    if (filter === "all") return "All campuses";
    if (filter === "unassigned") return "Unassigned";
    const c = campuses.find((x) => x.id === filter);
    return c?.name ?? "All campuses";
  })();

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        onClick={() => { if (isTrueAdmin) setOpen((v) => !v); }}
        style={{
          padding: "10px 12px", borderRadius: 12,
          border: "1px solid rgba(230,23,141,0.35)",
          background: open ? "rgba(230,23,141,0.10)" : "rgba(230,23,141,0.06)",
          color: "#e6178d", fontWeight: 700, fontSize: 14,
          cursor: isTrueAdmin ? "pointer" : "default",
          display: "inline-flex", alignItems: "center", gap: 6,
        }}
        title={isCampusAdmin ? "You're locked to this campus" : "Switch campus"}
      >
        {currentLabel}
        {isTrueAdmin && <span style={{ fontSize: 11, opacity: 0.7 }}>▾</span>}
      </button>

      {open && isTrueAdmin && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 220,
            background: "white", border: "1px solid #e5e7eb", borderRadius: 12,
            boxShadow: "0 8px 24px rgba(0,0,0,0.10)", padding: 6, zIndex: 100,
          }}
        >
          <DropdownItem
            label="All campuses"
            active={filter === "all"}
            onClick={() => { setFilter("all"); setOpen(false); }}
          />
          {campuses.map((c) => (
            <DropdownItem
              key={c.id}
              label={c.name}
              active={filter === c.id}
              onClick={() => { setFilter(c.id); setOpen(false); }}
            />
          ))}
          <DropdownItem
            label="Unassigned"
            active={filter === "unassigned"}
            onClick={() => { setFilter("unassigned"); setOpen(false); }}
          />
          <div style={{ borderTop: "1px solid #f3f4f6", margin: "6px 0" }} />
          <DropdownItem
            label="Edit campuses…"
            active={false}
            onClick={() => { setEditing(true); setOpen(false); }}
          />
        </div>
      )}

      {editing && (
        <EditCampusesModal
          campuses={campuses}
          onClose={() => setEditing(false)}
          onChanged={refreshCampuses}
        />
      )}
    </div>
  );
}

function DropdownItem({
  label, active, onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block", width: "100%", textAlign: "left",
        padding: "8px 12px", borderRadius: 8,
        background: active ? "rgba(230,23,141,0.08)" : "transparent",
        color: active ? "#e6178d" : "#111827",
        border: "none", cursor: "pointer",
        fontWeight: active ? 800 : 600, fontSize: 13,
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "#f9fafb"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
    >
      {label}
    </button>
  );
}

// ─── Edit Campuses Modal ───────────────────────────────────────────────────────

function EditCampusesModal({
  campuses,
  onClose,
  onChanged,
}: {
  campuses: Campus[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [list, setList] = useState<Campus[]>(campuses);
  const [adding, setAdding] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setList(campuses); }, [campuses]);

  async function addCampus() {
    const name = adding.trim();
    if (!name) return;
    setSaving(true); setError(null);
    const { error: err } = await supabase.from("hr_campuses").insert({ name });
    setSaving(false);
    if (err) { setError(err.message); return; }
    setAdding("");
    await onChanged();
  }

  async function renameCampus(id: string, name: string) {
    setSaving(true); setError(null);
    const { error: err } = await supabase.from("hr_campuses").update({ name }).eq("id", id);
    setSaving(false);
    if (err) { setError(err.message); return; }
    await onChanged();
  }

  async function deleteCampus(id: string) {
    if (!confirm("Delete this campus? Employees assigned to it will become unassigned.")) return;
    setSaving(true); setError(null);
    const { error: err } = await supabase.from("hr_campuses").delete().eq("id", id);
    setSaving(false);
    if (err) { setError(err.message); return; }
    await onChanged();
  }

  const usedNames = useMemo(() => new Set(list.map((c) => c.name.toLowerCase())), [list]);

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 300 }}
        onClick={onClose}
      />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
          zIndex: 301, background: "white", borderRadius: 16, width: "min(480px, 95vw)",
          boxShadow: "0 8px 40px rgba(0,0,0,0.2)", padding: 0,
        }}
      >
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Edit campuses</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#9ca3af" }}>✕</button>
        </div>

        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          {list.length === 0 && <div style={{ color: "#6b7280", fontSize: 13 }}>No campuses yet — add one below.</div>}
          {list.map((c) => (
            <CampusRow key={c.id} campus={c} disabled={saving} onRename={(name) => renameCampus(c.id, name)} onDelete={() => deleteCampus(c.id)} />
          ))}

          <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 12, display: "flex", gap: 8 }}>
            <input
              type="text"
              placeholder="New campus name"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              disabled={saving}
              style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1.5px solid #e5e7eb", fontSize: 13 }}
            />
            <button
              onClick={addCampus}
              disabled={saving || !adding.trim() || usedNames.has(adding.trim().toLowerCase())}
              style={{ padding: "8px 16px", borderRadius: 8, border: "1.5px solid #e6178d", background: "#e6178d", color: "white", fontWeight: 700, fontSize: 13, cursor: "pointer" }}
            >
              Add
            </button>
          </div>

          {error && <div style={{ color: "#991b1b", fontSize: 12, fontWeight: 600 }}>{error}</div>}
        </div>
      </div>
    </>
  );
}

function CampusRow({
  campus, disabled, onRename, onDelete,
}: {
  campus: Campus;
  disabled: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  // Local edit state — parent re-mounts via key={campus.id} when the row swaps, so this stays in sync.
  const [name, setName] = useState(campus.name);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => { if (name.trim() && name !== campus.name) onRename(name.trim()); }}
        disabled={disabled}
        style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1.5px solid #e5e7eb", fontSize: 13 }}
      />
      <button
        onClick={onDelete}
        disabled={disabled}
        title="Delete campus"
        style={{ padding: "6px 10px", borderRadius: 8, border: "1.5px solid #fca5a5", background: "#fee2e2", color: "#991b1b", fontWeight: 700, fontSize: 12, cursor: "pointer" }}
      >
        Delete
      </button>
    </div>
  );
}
