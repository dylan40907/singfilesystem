"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useEscapeKey } from "@/components/ui/useEscapeKey";
import {
  Access,
  BaseRole,
  PageDef,
  pagesByMode,
  resolveAccess,
} from "@/lib/pagePermissions";

export type RoleRow = {
  id: string;
  name: string;
  description: string | null;
  base_role: BaseRole;
  is_system: boolean;
};

const BASE_LABEL: Record<BaseRole, string> = {
  teacher: "Teacher",
  supervisor: "Supervisor",
  campus_admin: "Campus Admin",
};

const BASE_HINT: Record<BaseRole, string> = {
  teacher: "Own schedule, courses and files. No HR portal by default.",
  supervisor: "Oversees teachers at their campus; reads HR, edits meetings.",
  campus_admin: "Runs one campus — full HR for that campus.",
};

/**
 * Create or edit a role.
 *
 * A role is a base level plus overrides. Only pages that *differ* from the base
 * level's default are stored, so a role automatically follows any future change
 * to what its level gets by default — rather than freezing a copy of today's
 * answer and quietly drifting.
 */
export default function RoleEditor({
  role,
  onClose,
  onSaved,
}: {
  role: RoleRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !role;
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [base, setBase] = useState<BaseRole>(role?.base_role ?? "teacher");
  const [overrides, setOverrides] = useState<Record<string, Access>>({});
  const [loading, setLoading] = useState(!isNew);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEscapeKey(onClose, !busy);

  useEffect(() => {
    if (!role) return;
    (async () => {
      const { data } = await supabase
        .from("hr_role_permissions")
        .select("page_key, access")
        .eq("role_id", role.id);
      const next: Record<string, Access> = {};
      for (const p of (data ?? []) as { page_key: string; access: Access }[]) {
        next[p.page_key] = p.access;
      }
      setOverrides(next);
      setLoading(false);
    })();
  }, [role]);

  /** The level this page sits at right now, override or inherited. */
  function current(page: PageDef): Access {
    return resolveAccess(page.key, base, overrides);
  }

  function setAccess(page: PageDef, next: Access) {
    setOverrides((prev) => {
      const copy = { ...prev };
      // Back to the default → drop the override rather than storing a value
      // that happens to match today's default.
      if (next === page.defaults[base]) delete copy[page.key];
      else copy[page.key] = next;
      return copy;
    });
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) { setErr("Give the role a name."); return; }
    setBusy(true); setErr("");
    try {
      let roleId = role?.id;

      if (isNew) {
        const { data: me } = await supabase.auth.getUser();
        const { data, error } = await supabase
          .from("hr_roles")
          .insert({
            name: trimmed,
            description: description.trim() || null,
            base_role: base,
            created_by: me.user?.id ?? null,
          })
          .select("id")
          .single();
        if (error) throw new Error(error.message);
        roleId = data.id;
      } else {
        const { error } = await supabase
          .from("hr_roles")
          .update({
            name: trimmed,
            description: description.trim() || null,
            base_role: base,
          })
          .eq("id", role!.id);
        if (error) throw new Error(error.message);
      }

      // Replace the override set wholesale — simpler to reason about than
      // diffing, and these are a handful of rows.
      await supabase.from("hr_role_permissions").delete().eq("role_id", roleId!);
      const rows = Object.entries(overrides).map(([page_key, access]) => ({
        role_id: roleId!, page_key, access,
      }));
      if (rows.length) {
        const { error } = await supabase.from("hr_role_permissions").insert(rows);
        if (error) throw new Error(error.message);
      }

      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onMouseDown={(e) => { if (e.currentTarget === e.target && !busy) onClose(); }}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 300,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div className="card" style={{ width: "min(760px, 96vw)", maxHeight: "88vh", display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 18 }}>{isNew ? "New role" : `Edit ${role!.name}`}</div>
          <div className="subtle" style={{ fontSize: 13, marginTop: 3 }}>
            Start from one of the three levels, then change only what should differ.
          </div>
        </div>

        {err && (
          <div style={{ padding: "9px 13px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 13 }}>
            {err}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={lbl}>Role name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Teacher + Timesheets" />
          </div>
          <div>
            <label style={lbl}>Base level</label>
            <select className="select" value={base} onChange={(e) => setBase(e.target.value as BaseRole)}>
              {(["teacher", "supervisor", "campus_admin"] as BaseRole[]).map((b) => (
                <option key={b} value={b}>{BASE_LABEL[b]}</option>
              ))}
            </select>
            <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>{BASE_HINT[base]}</div>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={lbl}>Description</label>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this role is for" />
          </div>
        </div>

        <div style={{ overflowY: "auto", borderTop: "1px solid #e5e7eb", paddingTop: 12 }}>
          {loading ? (
            <div className="subtle">Loading…</div>
          ) : (
            pagesByMode().map((group) => (
              <div key={group.mode} style={{ marginBottom: 18 }}>
                <div style={{ fontWeight: 800, fontSize: 12, letterSpacing: 0.5, textTransform: "uppercase", color: "#6b7280", marginBottom: 8 }}>
                  {group.label}
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  {group.pages.map((page) => {
                    const value = current(page);
                    const isDefault = !overrides[page.key];
                    const locked = page.key === "hr.roles";
                    return (
                      <div
                        key={page.key}
                        className="row-between"
                        style={{
                          alignItems: "flex-start", gap: 12, padding: "9px 12px",
                          borderRadius: 10, border: "1px solid #f1f5f9",
                          background: isDefault ? "transparent" : "#fdf2f8",
                          opacity: locked ? 0.55 : 1,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>
                            {page.label}
                            {!isDefault && (
                              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 800, color: "#9d174d" }}>changed</span>
                            )}
                          </div>
                          {page.hint && (
                            <div className="subtle" style={{ fontSize: 11.5, marginTop: 2 }}>{page.hint}</div>
                          )}
                        </div>
                        <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                          {(page.editable ? (["none", "view", "edit"] as Access[]) : (["none", "view"] as Access[])).map((opt) => (
                            <button
                              key={opt}
                              disabled={locked}
                              onClick={() => setAccess(page, opt)}
                              style={{
                                padding: "5px 12px", borderRadius: 8, fontSize: 12, fontWeight: 800,
                                cursor: locked ? "not-allowed" : "pointer",
                                border: value === opt ? "1.5px solid #e6178d" : "1.5px solid #e5e7eb",
                                background: value === opt ? "#e6178d" : "white",
                                color: value === opt ? "white" : "#6b7280",
                              }}
                            >
                              {opt === "none" ? "No access" : opt === "view" ? "View" : "Edit"}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="row-between" style={{ borderTop: "1px solid #e5e7eb", paddingTop: 12 }}>
          <span className="subtle" style={{ fontSize: 12 }}>
            {Object.keys(overrides).length === 0
              ? `Identical to ${BASE_LABEL[base]}.`
              : `${Object.keys(overrides).length} page(s) differ from ${BASE_LABEL[base]}.`}
          </span>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
              {busy ? "Saving…" : isNew ? "Create role" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const lbl: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "#6b7280", margin: "0 0 6px" };
