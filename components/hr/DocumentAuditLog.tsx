"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type AuditRow = {
  id: string;
  actor_user_id: string | null;
  action: string;
  record_id: string | null;
  employee_id: string | null;
  doc_type_id: string | null;
  file_name: string | null;
  detail: any;
  created_at: string;
};

const ACTION_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  download: { bg: "#dbeafe", fg: "#1e40af", label: "Download" },
  view: { bg: "#dbeafe", fg: "#1e40af", label: "View" },
  upload: { bg: "#dcfce7", fg: "#166534", label: "Upload" },
  replace: { bg: "#fef9c3", fg: "#854d0e", label: "Replace" },
  delete: { bg: "#fee2e2", fg: "#991b1b", label: "Delete" },
  approve: { bg: "#dcfce7", fg: "#166534", label: "Approve" },
  reject: { bg: "#fee2e2", fg: "#991b1b", label: "Reject" },
  status_change: { bg: "#f3f4f6", fg: "#374151", label: "Status change" },
  template_download: { bg: "#ede9fe", fg: "#5b21b6", label: "Template" },
};

export default function DocumentAuditLog({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [actorNames, setActorNames] = useState<Map<string, string>>(new Map());
  const [empNames, setEmpNames] = useState<Map<string, string>>(new Map());
  const [typeNames, setTypeNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("hr_document_audit")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1000);
      const list = (data ?? []) as AuditRow[];
      setRows(list);

      const actorIds = Array.from(new Set(list.map((r) => r.actor_user_id).filter(Boolean))) as string[];
      const empIds = Array.from(new Set(list.map((r) => r.employee_id).filter(Boolean))) as string[];
      const typeIds = Array.from(new Set(list.map((r) => r.doc_type_id).filter(Boolean))) as string[];

      const [{ data: actors }, { data: emps }, { data: types }] = await Promise.all([
        actorIds.length ? supabase.from("user_profiles").select("id, full_name, username, email").in("id", actorIds) : Promise.resolve({ data: [] as any }),
        empIds.length ? supabase.from("hr_employees").select("id, legal_first_name, legal_last_name").in("id", empIds) : Promise.resolve({ data: [] as any }),
        typeIds.length ? supabase.from("hr_document_types").select("id, name").in("id", typeIds) : Promise.resolve({ data: [] as any }),
      ]);
      setActorNames(new Map((actors ?? []).map((a: any) => [a.id, (a.full_name || a.username || a.email || "Unknown").trim()])));
      setEmpNames(new Map((emps ?? []).map((e: any) => [e.id, `${e.legal_first_name ?? ""} ${e.legal_last_name ?? ""}`.trim() || "Employee"])));
      setTypeNames(new Map((types ?? []).map((t: any) => [t.id, t.name])));
      setLoading(false);
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (actionFilter !== "all" && r.action !== actionFilter) return false;
      if (!q) return true;
      const hay = [
        actorNames.get(r.actor_user_id ?? "") ?? "",
        empNames.get(r.employee_id ?? "") ?? "",
        typeNames.get(r.doc_type_id ?? "") ?? "",
        r.file_name ?? "",
        r.detail?.ip ?? "",
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [rows, actionFilter, query, actorNames, empNames, typeNames]);

  return (
    <div onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="card" style={{ width: "100%", maxWidth: 960, maxHeight: "88vh", display: "flex", flexDirection: "column" }}>
        <div className="row-between" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 900, fontSize: 18 }}>🔎 Document audit log</div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <select className="select" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} style={{ width: 180 }}>
            <option value="all">All actions</option>
            {Object.keys(ACTION_STYLE).map((a) => <option key={a} value={a}>{ACTION_STYLE[a].label}</option>)}
          </select>
          <input className="input" placeholder="Search person, employee, file, IP…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
          <span className="subtle" style={{ fontSize: 13, alignSelf: "center" }}>{filtered.length} events</span>
        </div>

        <div style={{ overflow: "auto", flex: 1, border: "1px solid #e5e7eb", borderRadius: 12 }}>
          {loading ? (
            <div className="subtle" style={{ padding: 20 }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="subtle" style={{ padding: 20, textAlign: "center" }}>No document activity recorded.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f9fafb", textAlign: "left", color: "#6b7280", position: "sticky", top: 0 }}>
                  <th style={th}>When</th><th style={th}>Who</th><th style={th}>Action</th>
                  <th style={th}>Employee</th><th style={th}>Document</th><th style={th}>IP</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const s = ACTION_STYLE[r.action] ?? { bg: "#f3f4f6", fg: "#374151", label: r.action };
                  return (
                    <tr key={r.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                      <td style={td}>{new Date(r.created_at).toLocaleString()}</td>
                      <td style={td}>{r.actor_user_id ? (actorNames.get(r.actor_user_id) ?? "—") : "—"}</td>
                      <td style={td}><span style={{ background: s.bg, color: s.fg, fontWeight: 700, fontSize: 11, padding: "2px 8px", borderRadius: 999 }}>{s.label}</span></td>
                      <td style={td}>{r.employee_id ? (empNames.get(r.employee_id) ?? "—") : "—"}</td>
                      <td style={td}>{r.file_name || (r.doc_type_id ? typeNames.get(r.doc_type_id) : "") || "—"}{r.detail?.to ? <span className="subtle"> ({r.detail.from}→{r.detail.to})</span> : null}</td>
                      <td style={{ ...td, color: "#9ca3af", fontVariant: "tabular-nums" }}>{r.detail?.ip || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "8px 12px", fontWeight: 700, fontSize: 11, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "8px 12px", color: "#374151", whiteSpace: "nowrap" };
