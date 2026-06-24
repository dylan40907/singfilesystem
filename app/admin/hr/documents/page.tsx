"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import { applyCampusFilterToQuery, useCampusFilter } from "@/lib/CampusContext";

// ─── Types ───────────────────────────────────────────────────────────────────

type Employee = {
  id: string;
  legal_first_name: string;
  legal_last_name: string;
  nicknames: string[] | null;
  campus_id: string | null;
  is_active: boolean;
};

type Pack = { id: string; name: string; order_index: number };

type DocType = {
  id: string;
  pack_id: string | null;
  name: string;
  code: string | null;
  order_index: number;
  renewal_months: number | null;
  requires_approval: boolean;
  required_default: boolean;
  is_active: boolean;
};

type DocRecord = {
  id: string;
  employee_id: string;
  doc_type_id: string;
  required: boolean;
  object_key: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_at: string | null;
  approval_status: "pending" | "approved" | "rejected" | null;
  reviewed_at: string | null;
  review_note: string | null;
  expires_at: string | null;
};

type CellStatus = "not_required" | "missing" | "pending" | "approved" | "rejected" | "expired" | "expiring";

const EXPIRING_SOON_DAYS = 30;

function empName(e: Employee): string {
  const nick = Array.isArray(e.nicknames) && e.nicknames.length > 0 ? e.nicknames[0] : null;
  return `${nick ?? e.legal_first_name} ${e.legal_last_name}`.trim();
}

function cellKey(employeeId: string, docTypeId: string) {
  return `${employeeId}:${docTypeId}`;
}

function isRequired(rec: DocRecord | undefined, type: DocType): boolean {
  if (rec) return rec.required;
  return type.required_default;
}

function computeStatus(rec: DocRecord | undefined, type: DocType): CellStatus {
  if (!isRequired(rec, type)) return "not_required";
  if (!rec || !rec.object_key) return "missing";
  if (rec.approval_status === "rejected") return "rejected";
  if (rec.approval_status === "pending") return "pending";
  // approved
  if (rec.expires_at) {
    const exp = new Date(rec.expires_at).getTime();
    const now = Date.now();
    if (exp < now) return "expired";
    if (exp - now < EXPIRING_SOON_DAYS * 86400000) return "expiring";
  }
  return "approved";
}

const STATUS_STYLE: Record<CellStatus, { bg: string; border: string; color: string; label: string }> = {
  not_required: { bg: "#f9fafb", border: "#e5e7eb", color: "#9ca3af", label: "—" },
  missing: { bg: "#fff", border: "#d1d5db", color: "#9ca3af", label: "+" },
  pending: { bg: "#fffbeb", border: "#fcd34d", color: "#b45309", label: "Pending" },
  approved: { bg: "#ecfdf5", border: "#86efac", color: "#15803d", label: "✓" },
  rejected: { bg: "#fef2f2", border: "#fca5a5", color: "#b91c1c", label: "Rejected" },
  expired: { bg: "#fff7ed", border: "#fdba74", color: "#c2410c", label: "Expired" },
  expiring: { bg: "#fefce8", border: "#fde047", color: "#a16207", label: "Expiring" },
};

async function readJsonSafely(res: Response) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { __nonJson: true, text }; }
}

async function getToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("No session token");
  return t;
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function HrDocumentsPage() {
  const { filter } = useCampusFilter();
  const [me, setMe] = useState<TeacherProfile | null>(null);
  const isAdmin = !!me?.is_active && me.role === "admin";
  const canUse = !!me?.is_active && (me.role === "admin" || me.role === "campus_admin");

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [types, setTypes] = useState<DocType[]>([]);
  const [records, setRecords] = useState<Record<string, DocRecord>>({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  const [activePack, setActivePack] = useState<string>("all");
  const [search, setSearch] = useState("");

  // Cell action modal
  const [cell, setCell] = useState<{ emp: Employee; type: DocType } | null>(null);
  // Manage-columns modal
  const [manageOpen, setManageOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetRef = useRef<{ emp: Employee; type: DocType } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      let empQ = supabase
        .from("hr_employees")
        .select("id, legal_first_name, legal_last_name, nicknames, campus_id, is_active")
        .eq("is_active", true);
      empQ = applyCampusFilterToQuery(empQ, filter, "campus_id");
      const [{ data: emps }, { data: pk }, { data: tp }, { data: rec }] = await Promise.all([
        empQ,
        supabase.from("hr_document_packs").select("*").order("order_index"),
        supabase.from("hr_document_types").select("*").eq("is_active", true).order("order_index"),
        supabase.from("hr_document_records").select("*"),
      ]);

      const empList = ((emps ?? []) as Employee[]).sort((a, b) =>
        empName(a).toLowerCase().localeCompare(empName(b).toLowerCase())
      );
      setEmployees(empList);
      setPacks((pk ?? []) as Pack[]);
      setTypes((tp ?? []) as DocType[]);
      const map: Record<string, DocRecord> = {};
      for (const r of (rec ?? []) as DocRecord[]) map[cellKey(r.employee_id, r.doc_type_id)] = r;
      setRecords(map);
      setStatus("");
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    (async () => {
      const p = await fetchMyProfile();
      setMe(p);
    })();
  }, []);

  useEffect(() => {
    if (canUse) reload();
  }, [canUse, reload]);

  const visibleTypes = useMemo(() => {
    const t = activePack === "all" ? types : types.filter((x) => x.pack_id === activePack);
    return [...t].sort((a, b) => a.order_index - b.order_index);
  }, [types, activePack]);

  const visibleEmployees = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => empName(e).toLowerCase().includes(q));
  }, [employees, search]);

  const pendingCount = useMemo(
    () => Object.values(records).filter((r) => r.approval_status === "pending" && r.object_key).length,
    [records]
  );

  // Completion per type: approved / required across visible employees.
  const completion = useMemo(() => {
    const out: Record<string, { approved: number; required: number }> = {};
    for (const type of visibleTypes) {
      let approved = 0;
      let required = 0;
      for (const emp of visibleEmployees) {
        const rec = records[cellKey(emp.id, type.id)];
        if (!isRequired(rec, type)) continue;
        required++;
        if (computeStatus(rec, type) === "approved" || computeStatus(rec, type) === "expiring") approved++;
      }
      out[type.id] = { approved, required };
    }
    return out;
  }, [visibleTypes, visibleEmployees, records]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  async function upsertRecord(patch: Partial<DocRecord> & { employee_id: string; doc_type_id: string }) {
    const { data, error } = await supabase
      .from("hr_document_records")
      .upsert({ ...patch, updated_at: new Date().toISOString() }, { onConflict: "employee_id,doc_type_id" })
      .select("*")
      .single();
    if (error) throw error;
    setRecords((prev) => ({ ...prev, [cellKey(patch.employee_id, patch.doc_type_id)]: data as DocRecord }));
    return data as DocRecord;
  }

  function pickFileFor(emp: Employee, type: DocType) {
    uploadTargetRef.current = { emp, type };
    fileInputRef.current?.click();
  }

  async function onFilePicked(fileList: FileList | null) {
    const file = fileList?.[0];
    const target = uploadTargetRef.current;
    uploadTargetRef.current = null;
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file || !target) return;

    const { emp, type } = target;
    setStatus(`Uploading ${file.name}…`);
    try {
      const token = await getToken();
      const presignRes = await fetch("/api/r2/presign-employee-doc", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          employeeId: emp.id,
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        }),
      });
      const presign = await readJsonSafely(presignRes);
      if (!presignRes.ok || presign.__nonJson) throw new Error(presign?.error || "Presign failed");
      const { uploadUrl, objectKey } = presign as { uploadUrl: string; objectKey: string };

      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);

      const autoApprove = !type.requires_approval;
      const now = new Date();
      const expires =
        autoApprove && type.renewal_months
          ? new Date(now.getTime()).setMonth(now.getMonth() + type.renewal_months)
          : null;

      await upsertRecord({
        employee_id: emp.id,
        doc_type_id: type.id,
        required: true,
        object_key: objectKey,
        file_name: file.name,
        mime_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        uploaded_at: now.toISOString(),
        uploaded_by: me?.id ?? null,
        approval_status: autoApprove ? "approved" : "pending",
        reviewed_by: autoApprove ? me?.id ?? null : null,
        reviewed_at: autoApprove ? now.toISOString() : null,
        review_note: null,
        expires_at: expires ? new Date(expires).toISOString() : null,
      } as any);

      setStatus("✅ Uploaded.");
      setCell(null);
    } catch (e: any) {
      setStatus("Upload error: " + (e?.message ?? "unknown"));
    }
  }

  async function approve(emp: Employee, type: DocType, rec: DocRecord) {
    setStatus("Approving…");
    try {
      const now = new Date();
      const base = rec.uploaded_at ? new Date(rec.uploaded_at) : now;
      const expires = type.renewal_months
        ? new Date(new Date(base).setMonth(base.getMonth() + type.renewal_months)).toISOString()
        : null;
      await upsertRecord({
        employee_id: emp.id,
        doc_type_id: type.id,
        approval_status: "approved",
        reviewed_by: me?.id ?? null,
        reviewed_at: now.toISOString(),
        expires_at: expires,
      } as any);
      setStatus("✅ Approved.");
      setCell(null);
    } catch (e: any) {
      setStatus("Approve error: " + (e?.message ?? "unknown"));
    }
  }

  async function reject(emp: Employee, type: DocType) {
    setStatus("Rejecting…");
    try {
      await upsertRecord({
        employee_id: emp.id,
        doc_type_id: type.id,
        approval_status: "rejected",
        reviewed_by: me?.id ?? null,
        reviewed_at: new Date().toISOString(),
      } as any);
      setStatus("✅ Rejected.");
      setCell(null);
    } catch (e: any) {
      setStatus("Reject error: " + (e?.message ?? "unknown"));
    }
  }

  async function setRequired(emp: Employee, type: DocType, required: boolean) {
    setStatus("Saving…");
    try {
      await upsertRecord({ employee_id: emp.id, doc_type_id: type.id, required } as any);
      setStatus("");
      setCell(null);
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    }
  }

  async function clearFile(emp: Employee, type: DocType) {
    setStatus("Removing file…");
    try {
      // Clears the uploaded file (cell returns to "missing"); the row keeps its
      // required/not-required state. R2 object cleanup is handled later.
      await upsertRecord({
        employee_id: emp.id,
        doc_type_id: type.id,
        object_key: null,
        file_name: null,
        mime_type: null,
        size_bytes: null,
        uploaded_at: null,
        approval_status: null,
        reviewed_by: null,
        reviewed_at: null,
        expires_at: null,
      } as any);
      setStatus("✅ Removed.");
      setCell(null);
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    }
  }

  async function viewFile(rec: DocRecord) {
    try {
      const token = await getToken();
      const res = await fetch("/api/r2/hr-doc-download", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ recordId: rec.id, mode: "inline" }),
      });
      const body = await readJsonSafely(res);
      if (!res.ok || body.__nonJson || !body.url) throw new Error(body?.error || "Could not open file");
      window.open(body.url as string, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setStatus("Open error: " + (e?.message ?? "unknown"));
    }
  }

  if (me && !canUse) {
    return (
      <main className="stack">
        <h1 className="h1">Documents</h1>
        <div className="card"><div style={{ fontWeight: 800 }}>Not authorized</div></div>
      </main>
    );
  }

  const cellStyleBase: React.CSSProperties = {
    padding: "8px 10px",
    borderRight: "1px solid #e5e7eb",
    borderBottom: "1px solid #e5e7eb",
    fontSize: 13,
    whiteSpace: "nowrap",
    textAlign: "center",
  };

  return (
    <main className="stack">
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: "none" }}
        onChange={(e) => onFilePicked(e.target.files)}
      />

      <div className="row-between" style={{ flexWrap: "wrap", gap: 12 }}>
        <div className="stack" style={{ gap: 6 }}>
          <h1 className="h1">Documents</h1>
          <div className="subtle">Employee compliance documents. Sensitive files are stored encrypted and access is restricted.</div>
        </div>
        <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {pendingCount > 0 && <span className="badge badge-pink">{pendingCount} pending approval</span>}
          {status ? <span className="badge">{status}</span> : null}
          {isAdmin && <button className="btn btn-primary" onClick={() => setManageOpen(true)}>Manage columns</button>}
          <button className="btn" onClick={() => void reload()}>Refresh</button>
        </div>
      </div>

      {/* Pack tabs */}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className={`btn${activePack === "all" ? " btn-primary" : ""}`} onClick={() => setActivePack("all")}>All</button>
        {packs.map((p) => (
          <button key={p.id} className={`btn${activePack === p.id ? " btn-primary" : ""}`} onClick={() => setActivePack(p.id)}>
            {p.name}
          </button>
        ))}
      </div>

      <input
        className="input"
        placeholder="Search employees…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ maxWidth: 300 }}
      />

      {loading ? (
        <div className="subtle" style={{ padding: 20 }}>Loading…</div>
      ) : visibleTypes.length === 0 ? (
        <div className="card">
          <div style={{ fontWeight: 800 }}>No document columns yet</div>
          <div className="subtle" style={{ marginTop: 6 }}>
            {isAdmin ? 'Click "Manage columns" to add document types.' : "Ask an admin to add document types."}
          </div>
        </div>
      ) : (
        <div style={{ overflowX: "auto", border: "1.5px solid #e5e7eb", borderRadius: 12 }}>
          <table style={{ borderCollapse: "collapse", background: "white", minWidth: "max-content" }}>
            <thead>
              <tr>
                <th
                  style={{
                    ...cellStyleBase,
                    textAlign: "left",
                    background: "#f9fafb",
                    fontWeight: 800,
                    position: "sticky",
                    left: 0,
                    zIndex: 2,
                    minWidth: 200,
                    boxShadow: "2px 0 5px -2px rgba(0,0,0,0.12)",
                  }}
                >
                  Employee
                </th>
                {visibleTypes.map((t) => {
                  const c = completion[t.id] ?? { approved: 0, required: 0 };
                  const pct = c.required > 0 ? Math.round((c.approved / c.required) * 100) : 0;
                  return (
                    <th key={t.id} style={{ ...cellStyleBase, background: "#f9fafb", fontWeight: 700, minWidth: 120, verticalAlign: "top" }}>
                      <div style={{ fontSize: 12 }}>{t.name}</div>
                      {t.code ? <div className="subtle" style={{ fontSize: 10 }}>{t.code}</div> : null}
                      <div style={{ marginTop: 6, height: 5, borderRadius: 3, background: "#e5e7eb", overflow: "hidden" }}>
                        <div style={{ width: `${pct}%`, height: "100%", background: pct === 100 ? "#22c55e" : "#60a5fa" }} />
                      </div>
                      <div className="subtle" style={{ fontSize: 10, marginTop: 2 }}>{c.approved}/{c.required}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visibleEmployees.map((emp, i) => {
                const rowBg = i % 2 === 0 ? "white" : "#fafafa";
                return (
                  <tr key={emp.id} style={{ background: rowBg }}>
                    <td
                      style={{
                        ...cellStyleBase,
                        textAlign: "left",
                        fontWeight: 700,
                        position: "sticky",
                        left: 0,
                        zIndex: 1,
                        background: rowBg,
                        boxShadow: "2px 0 5px -2px rgba(0,0,0,0.12)",
                      }}
                    >
                      {empName(emp)}
                    </td>
                    {visibleTypes.map((t) => {
                      const rec = records[cellKey(emp.id, t.id)];
                      const st = computeStatus(rec, t);
                      const s = STATUS_STYLE[st];
                      return (
                        <td key={t.id} style={{ ...cellStyleBase, padding: 6 }}>
                          <button
                            onClick={() => setCell({ emp, type: t })}
                            title={st}
                            style={{
                              width: "100%",
                              minWidth: 92,
                              padding: "8px 6px",
                              borderRadius: 8,
                              border: `1.5px ${st === "missing" ? "dashed" : "solid"} ${s.border}`,
                              background: s.bg,
                              color: s.color,
                              fontWeight: 700,
                              fontSize: st === "approved" || st === "missing" ? 16 : 11,
                              cursor: "pointer",
                            }}
                          >
                            {s.label}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {cell && (
        <CellActionModal
          emp={cell.emp}
          type={cell.type}
          rec={records[cellKey(cell.emp.id, cell.type.id)]}
          onClose={() => setCell(null)}
          onUpload={() => pickFileFor(cell.emp, cell.type)}
          onView={(r) => viewFile(r)}
          onApprove={(r) => approve(cell.emp, cell.type, r)}
          onReject={() => reject(cell.emp, cell.type)}
          onClear={() => clearFile(cell.emp, cell.type)}
          onSetRequired={(req) => setRequired(cell.emp, cell.type, req)}
        />
      )}

      {manageOpen && isAdmin && (
        <ManageColumnsModal
          packs={packs}
          types={types}
          onClose={() => setManageOpen(false)}
          onChanged={() => void reload()}
        />
      )}
    </main>
  );
}

// ─── Cell action modal ────────────────────────────────────────────────────

function CellActionModal({
  emp, type, rec, onClose, onUpload, onView, onApprove, onReject, onClear, onSetRequired,
}: {
  emp: Employee;
  type: DocType;
  rec: DocRecord | undefined;
  onClose: () => void;
  onUpload: () => void;
  onView: (r: DocRecord) => void;
  onApprove: (r: DocRecord) => void;
  onReject: () => void;
  onClear: () => void;
  onSetRequired: (required: boolean) => void;
}) {
  const st = computeStatus(rec, type);
  const required = isRequired(rec, type);
  return (
    <div style={modalBackdrop} onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}>
      <div className="card" style={{ width: "min(460px, 96vw)", borderRadius: 16 }}>
        <div className="row-between">
          <div style={{ fontWeight: 900, fontSize: 16 }}>{type.name}</div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="subtle" style={{ marginTop: 4 }}>{empName(emp)}</div>
        <div className="hr" />

        <div className="subtle" style={{ marginBottom: 10 }}>
          Status: <strong style={{ color: STATUS_STYLE[st].color }}>{st.replace("_", " ")}</strong>
          {rec?.file_name ? <> · {rec.file_name}</> : null}
          {rec?.expires_at ? <> · expires {new Date(rec.expires_at).toLocaleDateString()}</> : null}
        </div>

        {!required ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className="subtle">This document is marked <strong>not required</strong> for this person.</div>
            <button className="btn" onClick={() => onSetRequired(true)}>Mark required</button>
          </div>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {rec?.object_key && (
              <button className="btn" onClick={() => onView(rec)}>View file</button>
            )}
            <button className="btn btn-primary" onClick={onUpload}>{rec?.object_key ? "Replace file" : "Upload file"}</button>
            {rec?.object_key && rec.approval_status === "pending" && (
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => onApprove(rec)}>Approve</button>
                <button className="btn" style={{ flex: 1 }} onClick={onReject}>Reject</button>
              </div>
            )}
            {rec?.object_key && rec.approval_status === "approved" && (
              <button className="btn" onClick={() => onApprove(rec)}>Re-approve / renew</button>
            )}
            {rec?.object_key && <button className="btn" onClick={onClear}>Remove file</button>}
            <button className="btn" onClick={() => onSetRequired(false)}>Mark not required for this person</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Manage columns modal ───────────────────────────────────────────────────

function ManageColumnsModal({
  packs, types, onClose, onChanged,
}: {
  packs: Pack[];
  types: DocType[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState("");
  const [newPack, setNewPack] = useState("");
  // new type form
  const [tName, setTName] = useState("");
  const [tCode, setTCode] = useState("");
  const [tPack, setTPack] = useState<string>("");
  const [tRenew, setTRenew] = useState<string>("");
  const [tApproval, setTApproval] = useState(true);
  const [tRequired, setTRequired] = useState(true);

  async function addPack() {
    if (!newPack.trim()) return;
    setStatus("Adding pack…");
    const { error } = await supabase.from("hr_document_packs").insert({ name: newPack.trim(), order_index: packs.length });
    setStatus(error ? "Error: " + error.message : "");
    if (!error) { setNewPack(""); onChanged(); }
  }

  async function addType() {
    if (!tName.trim()) { setStatus("Enter a name."); return; }
    setStatus("Adding column…");
    const { error } = await supabase.from("hr_document_types").insert({
      name: tName.trim(),
      code: tCode.trim() || null,
      pack_id: tPack || null,
      order_index: types.length,
      renewal_months: tRenew.trim() ? Number(tRenew) : null,
      requires_approval: tApproval,
      required_default: tRequired,
      is_active: true,
    });
    setStatus(error ? "Error: " + error.message : "");
    if (!error) { setTName(""); setTCode(""); setTRenew(""); onChanged(); }
  }

  async function deleteType(id: string) {
    if (!confirm("Delete this document column and all its records? This cannot be undone.")) return;
    setStatus("Deleting…");
    const { error } = await supabase.from("hr_document_types").delete().eq("id", id);
    setStatus(error ? "Error: " + error.message : "");
    if (!error) onChanged();
  }

  const packName = (id: string | null) => packs.find((p) => p.id === id)?.name ?? "—";

  return (
    <div style={modalBackdrop} onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}>
      <div className="card" style={{ width: "min(640px, 96vw)", borderRadius: 16, maxHeight: "90vh", overflowY: "auto" }}>
        <div className="row-between">
          <div style={{ fontWeight: 900, fontSize: 16 }}>Manage document columns</div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        {status ? <div className="subtle" style={{ marginTop: 6 }}>{status}</div> : null}
        <div className="hr" />

        {/* Packs */}
        <div style={{ fontWeight: 800, marginBottom: 8 }}>Packs (column groups)</div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          {packs.map((p) => <span key={p.id} className="badge">{p.name}</span>)}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input className="input" placeholder="New pack name" value={newPack} onChange={(e) => setNewPack(e.target.value)} />
          <button className="btn" onClick={() => void addPack()}>Add pack</button>
        </div>

        <div className="hr" />

        {/* New type */}
        <div style={{ fontWeight: 800, marginBottom: 8 }}>Add a document column</div>
        <div className="stack" style={{ gap: 8 }}>
          <input className="input" placeholder="Name (e.g. LIC 503 - Health Screening)" value={tName} onChange={(e) => setTName(e.target.value)} />
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="input" placeholder="Code (optional)" value={tCode} onChange={(e) => setTCode(e.target.value)} style={{ maxWidth: 160 }} />
            <select className="select" value={tPack} onChange={(e) => setTPack(e.target.value)}>
              <option value="">No pack</option>
              {packs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input className="input" placeholder="Renew (months)" value={tRenew} onChange={(e) => setTRenew(e.target.value)} style={{ maxWidth: 130 }} inputMode="numeric" />
          </div>
          <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            <label className="row" style={{ gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={tApproval} onChange={(e) => setTApproval(e.target.checked)} /> Requires approval
            </label>
            <label className="row" style={{ gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={tRequired} onChange={(e) => setTRequired(e.target.checked)} /> Required for everyone by default
            </label>
          </div>
          <button className="btn btn-primary" onClick={() => void addType()} style={{ alignSelf: "flex-start" }}>Add column</button>
        </div>

        <div className="hr" />

        {/* Existing types */}
        <div style={{ fontWeight: 800, marginBottom: 8 }}>Columns ({types.length})</div>
        <div className="stack" style={{ gap: 6 }}>
          {types.map((t) => (
            <div key={t.id} className="row-between" style={{ padding: "8px 4px", borderBottom: "1px solid #f3f4f6" }}>
              <div>
                <div style={{ fontWeight: 700 }}>{t.name}</div>
                <div className="subtle" style={{ fontSize: 12 }}>
                  {packName(t.pack_id)}
                  {t.renewal_months ? ` · renews every ${t.renewal_months}mo` : " · no expiry"}
                  {t.requires_approval ? " · approval" : " · auto-approve"}
                  {t.required_default ? " · required" : " · optional"}
                </div>
              </div>
              <button className="btn" onClick={() => void deleteType(t.id)}>Delete</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const modalBackdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  zIndex: 200,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
};
