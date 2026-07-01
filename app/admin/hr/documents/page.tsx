"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import { applyCampusFilterToQuery, useCampusFilter } from "@/lib/CampusContext";
import { useDialog } from "@/components/ui/useDialog";
import { previewModeForFile } from "@/lib/fileUtils";
import DocumentAuditLog from "@/components/hr/DocumentAuditLog";

// ─── Types ───────────────────────────────────────────────────────────────────

type Employee = {
  id: string;
  legal_first_name: string;
  legal_last_name: string;
  nicknames: string[] | null;
  campus_id: string | null;
  is_active: boolean;
};

type Pack = { id: string; name: string; order_index: number; assign_all: boolean; description: string | null };

type DocType = {
  id: string;
  pack_id: string | null;
  name: string;
  code: string | null;
  description: string | null;
  order_index: number;
  renewal_months: number | null;
  requires_approval: boolean;
  required_default: boolean;
  visible_in_app: boolean;
  allow_user_upload: boolean;
  expiration_enabled: boolean;
  expiration_date: string | null;
  template_object_key: string | null;
  template_file_name: string | null;
  template_mime_type: string | null;
  notify_settings: Record<string, any> | null;
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
  // Document create/edit modal: { mode, type? }
  const [docModal, setDocModal] = useState<{ mode: "create" | "edit"; type?: DocType } | null>(null);
  // Inline "add pack"
  const [addingPack, setAddingPack] = useState(false);
  const [newPackName, setNewPackName] = useState("");
  // Pending-approval review panel
  const [pendingOpen, setPendingOpen] = useState(false);
  // Options menu + pack-edit modal
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [packModal, setPackModal] = useState<Pack | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);

  async function notifyMissing() {
    setOptionsOpen(false);
    const ids = visibleTypes.map((t) => t.id);
    if (!ids.length) { setStatus("No documents in view."); return; }
    setStatus("Notifying…");
    const { data, error } = await supabase.rpc("notify_missing_docs", { p_doc_type_ids: ids });
    setStatus(error ? "Error: " + error.message : `✅ Sent ${data ?? 0} notification(s).`);
  }

  function exportCsv() {
    setOptionsOpen(false);
    const header = ["Employee", ...visibleTypes.map((t) => t.name)];
    const lines = visibleEmployees.map((emp) => [
      empName(emp),
      ...visibleTypes.map((t) => computeStatus(records[cellKey(emp.id, t.id)], t).replace("_", " ")),
    ]);
    const csv = [header, ...lines]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "documents-status.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function addPack() {
    const name = newPackName.trim();
    if (!name) return;
    setStatus("Adding pack…");
    const { error } = await supabase.from("hr_document_packs").insert({ name, order_index: packs.length });
    if (error) { setStatus("Error: " + error.message); return; }
    setNewPackName("");
    setAddingPack(false);
    setStatus("");
    await reload();
  }

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

      // An admin/campus-admin uploading on this page IS the authority, so the
      // document is auto-approved regardless of "require review" (which only
      // governs employee self-uploads). The DB trigger keeps employees pending.
      const now = new Date();
      const expires =
        type.expiration_enabled && type.expiration_date
          ? new Date(type.expiration_date).toISOString()
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
        submitted_by_employee: false,
        approval_status: "approved",
        reviewed_by: me?.id ?? null,
        reviewed_at: now.toISOString(),
        review_note: null,
        expires_at: expires,
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
      const expires =
        type.expiration_enabled && type.expiration_date
          ? new Date(type.expiration_date).toISOString()
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

  async function remind(emp: Employee, type: DocType) {
    setStatus("Sending reminder…");
    const { data, error } = await supabase.rpc("notify_employee_doc", { p_employee_id: emp.id, p_doc_type_id: type.id });
    setStatus(error ? "Error: " + error.message : data ? "✅ Reminder sent." : "Could not send reminder.");
    if (error || !data) throw new Error(error?.message ?? "Reminder failed");
  }

  // Remind an employee about EVERY required doc still missing/rejected, in one
  // consolidated notification. Returns the confirmation label for the button.
  async function remindEmployeeMissing(emp: Employee): Promise<string> {
    const { data, error } = await supabase.rpc("notify_employee_missing_docs", { p_employee_id: emp.id });
    if (error) { setStatus("Error: " + error.message); throw new Error(error.message); }
    const n = (data as number) ?? 0;
    if (n === 0) { setStatus(`✅ ${empName(emp)} has no missing documents.`); return "✓ Nothing missing"; }
    setStatus(`✅ Reminded ${empName(emp)} about ${n} document(s).`);
    return "✓ Reminder sent";
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

  // Short-lived signed URL for a record's file. mode "inline" → preview/iframe;
  // "attachment" → forces a download (Content-Disposition on the route).
  async function getSignedUrl(rec: DocRecord, mode: "inline" | "attachment"): Promise<string> {
    const token = await getToken();
    const res = await fetch("/api/r2/hr-doc-download", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ recordId: rec.id, mode }),
    });
    const body = await readJsonSafely(res);
    if (!res.ok || body.__nonJson || !body.url) throw new Error(body?.error || "Could not get file URL");
    return body.url as string;
  }

  // Used by the Pending panel (opens in a new tab).
  async function viewFile(rec: DocRecord) {
    try {
      window.open(await getSignedUrl(rec, "inline"), "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setStatus("Open error: " + (e?.message ?? "unknown"));
    }
  }

  async function downloadFile(rec: DocRecord) {
    try {
      const url = await getSignedUrl(rec, "attachment");
      const a = document.createElement("a");
      a.href = url;
      a.download = rec.file_name || "document";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e: any) {
      setStatus("Download error: " + (e?.message ?? "unknown"));
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
      {auditOpen && <DocumentAuditLog onClose={() => setAuditOpen(false)} />}
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
          {pendingCount > 0 && (
            <button className="btn badge-pink" style={{ fontWeight: 800 }} onClick={() => setPendingOpen(true)}>
              {pendingCount} Pending Approval
            </button>
          )}
          {status ? <span className="badge">{status}</span> : null}
          {isAdmin && (
            <button
              className="btn btn-primary"
              onClick={() => setDocModal({ mode: "create" })}
            >
              + Add document
            </button>
          )}
          {isAdmin && (
            <div style={{ position: "relative" }}>
              <button className="btn" onClick={() => setOptionsOpen((v) => !v)}>Options ▾</button>
              {optionsOpen && (
                <>
                  <div style={{ position: "fixed", inset: 0, zIndex: 90 }} onClick={() => setOptionsOpen(false)} />
                  <div
                    className="card"
                    style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 100, width: 280, padding: 6, borderRadius: 12 }}
                  >
                    <button className="btn" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => void notifyMissing()}>
                      🔔 Notify users with missing / rejected
                    </button>
                    <button className="btn" style={{ width: "100%", justifyContent: "flex-start", marginTop: 4 }} onClick={exportCsv}>
                      ⬇ Export status report (CSV)
                    </button>
                    <button className="btn" style={{ width: "100%", justifyContent: "flex-start", marginTop: 4 }} onClick={() => { setOptionsOpen(false); setAuditOpen(true); }}>
                      🔎 Document audit log
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <button className="btn" onClick={() => void reload()}>Refresh</button>
        </div>
      </div>

      {/* Pack tabs + inline add-pack */}
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="subtle" style={{ fontWeight: 800, fontSize: 13 }}>Packs</span>
        <button className={`btn${activePack === "all" ? " btn-primary" : ""}`} onClick={() => setActivePack("all")}>All</button>
        {packs.map((p) => (
          <button key={p.id} className={`btn${activePack === p.id ? " btn-primary" : ""}`} onClick={() => setActivePack(p.id)}>
            {p.name}
          </button>
        ))}
        {isAdmin && (
          addingPack ? (
            <span className="row" style={{ gap: 6 }}>
              <input
                className="input"
                autoFocus
                placeholder="New pack name"
                value={newPackName}
                onChange={(e) => setNewPackName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void addPack(); if (e.key === "Escape") { setAddingPack(false); setNewPackName(""); } }}
                style={{ maxWidth: 200 }}
              />
              <button className="btn btn-primary" onClick={() => void addPack()}>Add</button>
              <button className="btn" onClick={() => { setAddingPack(false); setNewPackName(""); }}>Cancel</button>
            </span>
          ) : (
            <button className="btn" onClick={() => setAddingPack(true)} title="Add a pack">+ Add pack</button>
          )
        )}
        {isAdmin && activePack !== "all" && (
          (() => {
            const p = packs.find((x) => x.id === activePack);
            return p ? <button className="btn" onClick={() => setPackModal(p)} title="Pack settings">⚙ Edit pack</button> : null;
          })()
        )}
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
            {isAdmin ? 'Click "+ Add document" to create your first document.' : "Ask an admin to add document types."}
          </div>
          {isAdmin && (
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => setDocModal({ mode: "create" })}>
              + Add document
            </button>
          )}
        </div>
      ) : (
        <div style={{ overflow: "auto", maxHeight: "75vh", border: "1.5px solid #e5e7eb", borderRadius: 12 }}>
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
                    top: 0,
                    zIndex: 3,
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
                    <th key={t.id} style={{ ...cellStyleBase, background: "#f9fafb", fontWeight: 700, minWidth: 120, verticalAlign: "top", position: "sticky", top: 0, zIndex: 1 }}>
                      <div
                        onClick={isAdmin ? () => setDocModal({ mode: "edit", type: t }) : undefined}
                        style={{ cursor: isAdmin ? "pointer" : "default" }}
                        title={isAdmin ? "Edit document settings" : undefined}
                      >
                        <div style={{ fontSize: 12 }}>
                          {t.name}
                          {isAdmin && <span className="subtle" style={{ fontWeight: 400 }}> ✎</span>}
                          {t.template_object_key ? <span title="Has a blank form"> 📎</span> : null}
                        </div>
                        {t.code ? <div className="subtle" style={{ fontSize: 10 }}>{t.code}</div> : null}
                        <div style={{ marginTop: 6, height: 5, borderRadius: 3, background: "#e5e7eb", overflow: "hidden" }}>
                          <div style={{ width: `${pct}%`, height: "100%", background: pct === 100 ? "#22c55e" : "#60a5fa" }} />
                        </div>
                        <div className="subtle" style={{ fontSize: 10, marginTop: 2 }}>{c.approved}/{c.required}</div>
                      </div>
                    </th>
                  );
                })}
                {isAdmin && (
                  <th style={{ ...cellStyleBase, background: "#f9fafb", minWidth: 110, verticalAlign: "middle", position: "sticky", top: 0, zIndex: 1 }}>
                    <button
                      className="btn btn-primary"
                      onClick={() => setDocModal({ mode: "create" })}
                      style={{ fontSize: 12, whiteSpace: "nowrap" }}
                    >
                      + Add document
                    </button>
                  </th>
                )}
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
                      <div className="row-between" style={{ gap: 8, alignItems: "center" }}>
                        <span>{empName(emp)}</span>
                        {isAdmin && (
                          <RemindButton
                            label="🔔"
                            title={`Remind ${empName(emp)} about all missing required documents`}
                            style={{ padding: "2px 8px", fontSize: 12, fontWeight: 700, flexShrink: 0 }}
                            onRemind={() => remindEmployeeMissing(emp)}
                          />
                        )}
                      </div>
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
                    {isAdmin && <td style={{ ...cellStyleBase, background: rowBg }} />}
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
          myUserId={me?.id ?? null}
          onClose={() => setCell(null)}
          onUpload={() => pickFileFor(cell.emp, cell.type)}
          onDownload={(r) => downloadFile(r)}
          getSignedUrl={getSignedUrl}
          onApprove={(r) => approve(cell.emp, cell.type, r)}
          onReject={() => reject(cell.emp, cell.type)}
          onClear={() => clearFile(cell.emp, cell.type)}
          onSetRequired={(req) => setRequired(cell.emp, cell.type, req)}
          onRemind={() => remind(cell.emp, cell.type)}
        />
      )}

      {pendingOpen && (
        <PendingPanel
          employees={employees}
          types={types}
          records={records}
          myUserId={me?.id ?? null}
          onClose={() => setPendingOpen(false)}
          onView={(r) => viewFile(r)}
          onApprove={(emp, type, rec) => approve(emp, type, rec)}
          onReject={(emp, type) => reject(emp, type)}
        />
      )}

      {docModal && isAdmin && (
        <DocumentModal
          mode={docModal.mode}
          type={docModal.type}
          packs={packs}
          typeCount={types.length}
          defaultPackId={activePack !== "all" ? activePack : ""}
          onClose={() => setDocModal(null)}
          onChanged={() => void reload()}
        />
      )}

      {packModal && isAdmin && (
        <PackModal
          pack={packModal}
          employees={employees}
          onClose={() => setPackModal(null)}
          onChanged={() => void reload()}
        />
      )}
    </main>
  );
}

// ─── Reminder button with inline "sent" confirmation ─────────────────────────
// Any reminder action: shows "Sending…" then briefly swaps the label to the
// confirmation returned by onRemind (default "✓ Reminder sent") before reverting.
function RemindButton({
  label, onRemind, className = "btn", style, title,
}: {
  label: React.ReactNode;
  onRemind: () => Promise<string | void>;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}) {
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [doneLabel, setDoneLabel] = useState("✓ Reminder sent");
  return (
    <button
      className={className}
      style={style}
      title={title}
      disabled={state !== "idle"}
      onClick={async (e) => {
        e.stopPropagation();
        setState("sending");
        try {
          const msg = await onRemind();
          setDoneLabel(msg || "✓ Reminder sent");
          setState("done");
          setTimeout(() => setState("idle"), 2200);
        } catch {
          setState("idle");
        }
      }}
    >
      {state === "sending" ? "Sending…" : state === "done" ? doneLabel : label}
    </button>
  );
}

// ─── Cell action modal ────────────────────────────────────────────────────

function CellActionModal({
  emp, type, rec, myUserId, onClose, onUpload, onDownload, getSignedUrl, onApprove, onReject, onClear, onSetRequired, onRemind,
}: {
  emp: Employee;
  type: DocType;
  rec: DocRecord | undefined;
  myUserId: string | null;
  onClose: () => void;
  onUpload: () => void;
  onDownload: (r: DocRecord) => void;
  getSignedUrl: (r: DocRecord, mode: "inline" | "attachment") => Promise<string>;
  onApprove: (r: DocRecord) => void;
  onReject: () => void;
  onClear: () => void;
  onSetRequired: (required: boolean) => void;
  onRemind: () => Promise<string | void>;
}) {
  const st = computeStatus(rec, type);
  const required = isRequired(rec, type);

  // Inline preview: PDFs render in an iframe (the browser PDF viewer gives page
  // navigation); images render directly. Other types fall back to download.
  const previewMode = rec?.file_name ? previewModeForFile(rec.file_name) : "unknown";
  const canPreview = !!rec?.object_key && (previewMode === "pdf" || previewMode === "image");
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreviewUrl("");
    if (rec?.object_key && canPreview) {
      setPreviewLoading(true);
      getSignedUrl(rec, "inline")
        .then((u) => { if (!cancelled) setPreviewUrl(u); })
        .catch(() => {})
        .finally(() => { if (!cancelled) setPreviewLoading(false); });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.id, rec?.object_key, previewMode]);

  return (
    <div style={modalBackdrop} onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}>
      <div className="card" style={{ width: "min(460px, 96vw)", borderRadius: 16, maxHeight: "92vh", overflowY: "auto" }}>
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

        {/* Inline preview */}
        {rec?.object_key && (
          <div style={{ marginBottom: 12 }}>
            {previewMode === "pdf" ? (
              previewLoading ? (
                <div style={previewBox}>Loading preview…</div>
              ) : previewUrl ? (
                <iframe
                  src={previewUrl}
                  title="Document preview"
                  style={{ width: "100%", height: 340, border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff" }}
                />
              ) : (
                <div style={previewBox}>Preview unavailable — use Download.</div>
              )
            ) : previewMode === "image" ? (
              previewLoading ? (
                <div style={previewBox}>Loading preview…</div>
              ) : previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt={rec.file_name ?? "Document"}
                  style={{ width: "100%", maxHeight: 340, objectFit: "contain", border: "1px solid #e5e7eb", borderRadius: 8, background: "#f9fafb" }}
                />
              ) : (
                <div style={previewBox}>Preview unavailable — use Download.</div>
              )
            ) : (
              <div style={previewBox}>No preview for this file type. Use Download to view it.</div>
            )}
          </div>
        )}

        {!required ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className="subtle">This document is marked <strong>not required</strong> for this person.</div>
            <button className="btn" onClick={() => onSetRequired(true)}>Mark required</button>
          </div>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {rec?.object_key && (
              <button className="btn" onClick={() => onDownload(rec)}>⬇ Download</button>
            )}
            <button className="btn btn-primary" onClick={onUpload}>{rec?.object_key ? "Replace file" : "Upload file"}</button>
            {(!rec?.object_key || rec.approval_status === "rejected") && (
              <RemindButton label="🔔 Remind to upload" onRemind={onRemind} />
            )}
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

        {rec && (
          <>
            <div className="hr" />
            <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>Comments</div>
            <DocComments recordId={rec.id} myUserId={myUserId} />
          </>
        )}
      </div>
    </div>
  );
}

// ─── Document create / edit modal (Connecteam-style "Request document upload") ──

function DocumentModal({
  mode, type, packs, typeCount, defaultPackId, onClose, onChanged,
}: {
  mode: "create" | "edit";
  type?: DocType;
  packs: Pack[];
  typeCount: number;
  defaultPackId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState(type?.name ?? "");
  const [code, setCode] = useState(type?.code ?? "");
  const [description, setDescription] = useState(type?.description ?? "");
  const [packId, setPackId] = useState<string>(type?.pack_id ?? defaultPackId ?? "");
  const [requiresApproval, setRequiresApproval] = useState(type?.requires_approval ?? true);
  const [requiredDefault, setRequiredDefault] = useState(type?.required_default ?? true);
  const [visibleInApp, setVisibleInApp] = useState(type?.visible_in_app ?? true);
  const [allowUserUpload, setAllowUserUpload] = useState(type?.allow_user_upload ?? true);
  const [expirationEnabled, setExpirationEnabled] = useState(type?.expiration_enabled ?? false);
  const [expiryDate, setExpiryDate] = useState<string>(type?.expiration_date ?? "");

  // Notification settings
  const ns = (type?.notify_settings ?? {}) as Record<string, any>;
  const [notifyUserStatus, setNotifyUserStatus] = useState<boolean>(ns.notify_user_status ?? true);
  const [notifyAdminAwaiting, setNotifyAdminAwaiting] = useState<boolean>(ns.notify_admin_awaiting ?? true);

  // blank / template form
  const [hasTemplate, setHasTemplate] = useState<boolean>(!!type?.template_object_key);
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [removeTemplate, setRemoveTemplate] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const { confirm, modal: dialog } = useDialog();

  async function uploadTemplate(docTypeId: string, file: File): Promise<string> {
    const token = await getToken();
    const presRes = await fetch("/api/r2/presign-doc-template", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ docTypeId, filename: file.name, contentType: file.type || "application/octet-stream", sizeBytes: file.size }),
    });
    const pres = await readJsonSafely(presRes);
    if (!presRes.ok || pres.__nonJson) throw new Error(pres?.error || "Template presign failed");
    const put = await fetch(pres.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
    if (!put.ok) throw new Error(`Template upload failed (${put.status})`);
    return pres.objectKey as string;
  }

  async function downloadTemplate() {
    if (!type?.id) return;
    try {
      const token = await getToken();
      const res = await fetch("/api/r2/hr-doc-template", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ docTypeId: type.id, mode: "attachment" }),
      });
      const body = await readJsonSafely(res);
      if (!res.ok || body.__nonJson || !body.url) throw new Error(body?.error || "Download failed");
      window.open(body.url as string, "_blank");
    } catch (e: any) { setStatus("Error: " + (e?.message ?? "unknown")); }
  }

  async function save() {
    if (!name.trim()) { setStatus("Enter a document name."); return; }
    setSaving(true);
    setStatus("Saving…");
    try {
      const baseFields = {
        name: name.trim(),
        code: code.trim() || null,
        description: description.trim() || null,
        pack_id: packId || null,
        renewal_months: null,
        expiration_date: expirationEnabled && expiryDate ? expiryDate : null,
        requires_approval: requiresApproval,
        required_default: requiredDefault,
        visible_in_app: visibleInApp,
        allow_user_upload: allowUserUpload,
        expiration_enabled: expirationEnabled && !!expiryDate,
        notify_settings: {
          ...(ns ?? {}),
          notify_user_status: notifyUserStatus,
          notify_admin_awaiting: notifyAdminAwaiting,
        },
      };

      let typeId = type?.id;
      if (mode === "create") {
        const { data, error } = await supabase
          .from("hr_document_types")
          .insert({ ...baseFields, order_index: typeCount, is_active: true })
          .select("id")
          .single();
        if (error) throw error;
        typeId = (data as { id: string }).id;
      } else {
        const { error } = await supabase.from("hr_document_types").update(baseFields).eq("id", typeId);
        if (error) throw error;
      }

      if (stagedFile && typeId) {
        const key = await uploadTemplate(typeId, stagedFile);
        const { error } = await supabase.from("hr_document_types").update({
          template_object_key: key,
          template_file_name: stagedFile.name,
          template_mime_type: stagedFile.type || "application/octet-stream",
          template_size_bytes: stagedFile.size,
        }).eq("id", typeId);
        if (error) throw error;
      } else if (removeTemplate && typeId) {
        const { error } = await supabase.from("hr_document_types").update({
          template_object_key: null, template_file_name: null, template_mime_type: null, template_size_bytes: null,
        }).eq("id", typeId);
        if (error) throw error;
      }

      onChanged();
      onClose();
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
      setSaving(false);
    }
  }

  async function deleteDoc() {
    if (!type?.id) return;
    if (!(await confirm("Delete this document and all its records? This cannot be undone.", { title: "Delete document", confirmLabel: "Delete", danger: true }))) return;
    setSaving(true);
    const { error } = await supabase.from("hr_document_types").delete().eq("id", type.id);
    if (error) { setStatus("Error: " + error.message); setSaving(false); return; }
    onChanged();
    onClose();
  }

  async function remindMissing(): Promise<string> {
    if (!type?.id) return "✓ Reminder sent";
    setStatus("Sending reminders…");
    const { data, error } = await supabase.rpc("notify_missing_docs", { p_doc_type_ids: [type.id] });
    if (error) { setStatus("Error: " + error.message); throw new Error(error.message); }
    const n = (data as number) ?? 0;
    setStatus(`✅ Reminded ${n} user(s) who haven't submitted.`);
    return `✓ Reminded ${n}`;
  }

  async function resetEntries() {
    if (!type?.id) return;
    if (!(await confirm("Clear ALL uploaded files and statuses for this document across every employee? The document itself stays; only the submissions are removed. This cannot be undone.", { title: "Reset entries", confirmLabel: "Reset", danger: true }))) return;
    setSaving(true);
    setStatus("Resetting…");
    const { error } = await supabase.from("hr_document_records").delete().eq("doc_type_id", type.id);
    if (error) { setStatus("Error: " + error.message); setSaving(false); return; }
    onChanged();
    onClose();
  }

  const showCurrentTemplate = hasTemplate && !removeTemplate && !stagedFile;

  return (
    <div style={modalBackdrop} onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}>
      <div className="card" style={{ width: "min(640px, 96vw)", borderRadius: 16, maxHeight: "92vh", overflowY: "auto" }}>
        <input
          ref={fileRef}
          type="file"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ""; if (f) { setStagedFile(f); setRemoveTemplate(false); } }}
        />
        {dialog}

        <div className="row-between">
          <div style={{ fontWeight: 900, fontSize: 16 }}>{mode === "create" ? "New document" : "Edit document"}</div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="subtle" style={{ marginTop: 4 }}>Create a document that users are required to upload.</div>
        <div className="hr" />

        <div className="stack" style={{ gap: 12 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>Document name</div>
            <input className="input" placeholder="e.g. LIC 503 - Health Screening" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div>
            <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>Description <span className="subtle" style={{ fontWeight: 400 }}>(optional)</span></div>
            <textarea
              className="input"
              placeholder="Instructions or notes for users…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              style={{ resize: "vertical", minHeight: 70, padding: "8px 12px" }}
            />
          </div>

          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="input" placeholder="Code (optional)" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 180 }} />
            <select className="select" value={packId} onChange={(e) => setPackId(e.target.value)}>
              <option value="">No pack</option>
              {packs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <div className="hr" />

          {/* Blank form */}
          <div>
            <div style={{ fontWeight: 800, fontSize: 13 }}>Blank document</div>
            <div className="subtle" style={{ fontSize: 12, marginBottom: 8 }}>Users can download this form to fill out and send back.</div>
            {showCurrentTemplate ? (
              <div className="row-between" style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "8px 12px" }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>📎 {type?.template_file_name ?? "Blank form"}</div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn" onClick={() => void downloadTemplate()}>Download</button>
                  <button className="btn" onClick={() => fileRef.current?.click()}>Replace</button>
                  <button className="btn" onClick={() => { setRemoveTemplate(true); setHasTemplate(false); }}>Remove</button>
                </div>
              </div>
            ) : stagedFile ? (
              <div className="row-between" style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "8px 12px" }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>📎 {stagedFile.name} <span className="subtle" style={{ fontWeight: 400 }}>(new)</span></div>
                <button className="btn" onClick={() => setStagedFile(null)}>Cancel</button>
              </div>
            ) : (
              <button className="btn" onClick={() => fileRef.current?.click()}>Add blank form</button>
            )}
          </div>

          <div className="hr" />

          {/* Settings */}
          <label className="row" style={{ gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={visibleInApp} onChange={(e) => setVisibleInApp(e.target.checked)} /> Visible to users in the mobile app
          </label>
          <label className="row" style={{ gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={allowUserUpload} onChange={(e) => setAllowUserUpload(e.target.checked)} /> Enable users to upload via the app &amp; their portal
          </label>
          <label className="row" style={{ gap: 8, alignItems: "center", marginLeft: 26 }}>
            <input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} /> Require review for user uploads
          </label>
          <label className="row" style={{ gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={requiredDefault} onChange={(e) => setRequiredDefault(e.target.checked)} /> Required for everyone by default
          </label>

          <div className="hr" />

          <label className="row" style={{ gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={expirationEnabled} onChange={(e) => setExpirationEnabled(e.target.checked)} /> Set document expiration
          </label>
          {expirationEnabled && (
            <div className="row" style={{ gap: 8, alignItems: "center", marginLeft: 26, flexWrap: "wrap" }}>
              <span className="subtle" style={{ fontSize: 13 }}>Expires on</span>
              <input
                className="input"
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                style={{ maxWidth: 180 }}
              />
              <span className="subtle" style={{ fontSize: 13 }}>· users reminded 30, 7, 1 days before</span>
            </div>
          )}

          <div className="hr" />

          {/* Notifications */}
          <div style={{ fontWeight: 800, fontSize: 13 }}>Notifications</div>
          <label className="row" style={{ gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={notifyUserStatus} onChange={(e) => setNotifyUserStatus(e.target.checked)} /> Notify the user when their document is approved or rejected
          </label>
          <label className="row" style={{ gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={notifyAdminAwaiting} onChange={(e) => setNotifyAdminAwaiting(e.target.checked)} /> Notify admins when a user submits this document
          </label>
          <div className="subtle" style={{ fontSize: 12 }}>
            “Action required” reminders are never automatic — send them with the Remind buttons.
          </div>

          {status ? <div className="subtle">{status}</div> : null}

          <div className="hr" />
          <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
            {mode === "edit" ? (
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <RemindButton label="🔔 Remind missing" className="btn btn-primary" onRemind={remindMissing} />
                <button className="btn" onClick={() => void resetEntries()} disabled={saving}>Reset entries</button>
                <button className="btn" onClick={() => void deleteDoc()} disabled={saving} style={{ color: "#b91c1c" }}>Delete</button>
              </div>
            ) : <span />}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : mode === "create" ? "Add document" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Comments thread (shared by the cell modal + the pending panel) ──────────

type DocComment = { id: string; author_id: string | null; body: string; created_at: string };

function DocComments({ recordId, myUserId }: { recordId: string; myUserId: string | null }) {
  const [comments, setComments] = useState<DocComment[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("hr_document_comments")
      .select("id, author_id, body, created_at")
      .eq("record_id", recordId)
      .order("created_at", { ascending: true });
    const list = (data ?? []) as DocComment[];
    setComments(list);
    const ids = Array.from(new Set(list.map((c) => c.author_id).filter(Boolean))) as string[];
    if (ids.length) {
      const { data: profs } = await supabase.from("user_profiles").select("id, full_name, username").in("id", ids);
      const next: Record<string, string> = {};
      for (const p of profs ?? []) next[(p as any).id] = ((p as any).full_name || (p as any).username || "Staff") as string;
      setNames(next);
    }
    setLoading(false);
  }, [recordId]);

  useEffect(() => { void load(); }, [load]);

  async function post() {
    const body = draft.trim();
    if (!body || !myUserId) return;
    const { data, error } = await supabase
      .from("hr_document_comments")
      .insert({ record_id: recordId, author_id: myUserId, body })
      .select("id, author_id, body, created_at")
      .single();
    if (!error && data) {
      setComments((c) => [...c, data as DocComment]);
      setDraft("");
    }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="stack" style={{ gap: 6, maxHeight: 200, overflowY: "auto" }}>
        {loading ? (
          <div className="subtle" style={{ fontSize: 13 }}>Loading…</div>
        ) : comments.length === 0 ? (
          <div className="subtle" style={{ fontSize: 13 }}>No comments yet.</div>
        ) : (
          comments.map((c) => (
            <div key={c.id} style={{ background: "#f9fafb", borderRadius: 10, padding: "8px 12px" }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#374151" }}>
                {c.author_id === myUserId ? "You" : names[c.author_id ?? ""] ?? "Staff"}
                <span className="subtle" style={{ fontWeight: 400, marginLeft: 8 }}>{new Date(c.created_at).toLocaleString()}</span>
              </div>
              <div style={{ fontSize: 14, marginTop: 2, whiteSpace: "pre-wrap" }}>{c.body}</div>
            </div>
          ))
        )}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input"
          placeholder="Write a comment…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void post(); }}
        />
        <button className="btn btn-primary" onClick={() => void post()}>Send</button>
      </div>
    </div>
  );
}

// ─── Pending Approval review panel ───────────────────────────────────────────

function PendingPanel({
  employees, types, records, myUserId, onClose, onView, onApprove, onReject,
}: {
  employees: Employee[];
  types: DocType[];
  records: Record<string, DocRecord>;
  myUserId: string | null;
  onClose: () => void;
  onView: (r: DocRecord) => void;
  onApprove: (emp: Employee, type: DocType, rec: DocRecord) => void;
  onReject: (emp: Employee, type: DocType) => void;
}) {
  const [openComments, setOpenComments] = useState<string | null>(null);
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);

  // Pending submissions grouped by document type.
  const groups = useMemo(() => {
    const pending = Object.values(records).filter((r) => r.approval_status === "pending" && r.object_key);
    const byType = new Map<string, DocRecord[]>();
    for (const r of pending) {
      const arr = byType.get(r.doc_type_id) ?? [];
      arr.push(r);
      byType.set(r.doc_type_id, arr);
    }
    return Array.from(byType.entries())
      .map(([typeId, recs]) => ({ type: typeById.get(typeId), recs }))
      .filter((g) => g.type)
      .sort((a, b) => (a.type!.name).localeCompare(b.type!.name));
  }, [records, typeById]);

  const total = useMemo(
    () => Object.values(records).filter((r) => r.approval_status === "pending" && r.object_key).length,
    [records]
  );

  return (
    <div style={modalBackdrop} onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}>
      <div className="card" style={{ width: "min(720px, 96vw)", borderRadius: 16, maxHeight: "92vh", overflowY: "auto" }}>
        <div className="row-between">
          <div style={{ fontWeight: 900, fontSize: 16 }}>{total} Document{total === 1 ? "" : "s"} Pending Approval</div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="hr" />

        {groups.length === 0 ? (
          <div className="subtle">Nothing waiting for approval. 🎉</div>
        ) : (
          <div className="stack" style={{ gap: 16 }}>
            {groups.map(({ type, recs }) => (
              <div key={type!.id}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>{type!.name} <span className="subtle" style={{ fontWeight: 400 }}>({recs.length})</span></div>
                <div className="stack" style={{ gap: 8 }}>
                  {recs.map((rec) => {
                    const emp = empById.get(rec.employee_id);
                    if (!emp) return null;
                    return (
                      <div key={rec.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px 12px" }}>
                        <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
                          <div>
                            <div style={{ fontWeight: 700 }}>{empName(emp)}</div>
                            {rec.file_name ? <div className="subtle" style={{ fontSize: 12 }}>{rec.file_name}</div> : null}
                          </div>
                          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                            <button className="btn" onClick={() => onView(rec)}>View</button>
                            <button className="btn" onClick={() => setOpenComments(openComments === rec.id ? null : rec.id)}>💬</button>
                            <button className="btn" onClick={() => onReject(emp, type!)}>Reject</button>
                            <button className="btn btn-primary" onClick={() => onApprove(emp, type!, rec)}>Approve</button>
                          </div>
                        </div>
                        {openComments === rec.id && (
                          <div style={{ marginTop: 10, borderTop: "1px dashed #e5e7eb", paddingTop: 10 }}>
                            <DocComments recordId={rec.id} myUserId={myUserId} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Pack settings modal (rename · assign to all/specific users · delete) ────

function PackModal({
  pack, employees, onClose, onChanged,
}: {
  pack: Pack;
  employees: Employee[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState(pack.name);
  const [assignAll, setAssignAll] = useState(pack.assign_all ?? true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const { confirm, modal: dialog } = useDialog();

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("hr_document_pack_assignments").select("employee_id").eq("pack_id", pack.id);
      setSelected(new Set((data ?? []).map((a: any) => a.employee_id)));
      setLoading(false);
    })();
  }, [pack.id]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => empName(e).toLowerCase().includes(q));
  }, [employees, search]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function save() {
    if (!name.trim()) { setStatus("Enter a pack name."); return; }
    setSaving(true);
    setStatus("Saving…");
    try {
      const { error: e1 } = await supabase.from("hr_document_packs").update({ name: name.trim(), assign_all: assignAll }).eq("id", pack.id);
      if (e1) throw e1;
      // Replace assignment rows (only meaningful when not assign-all).
      await supabase.from("hr_document_pack_assignments").delete().eq("pack_id", pack.id);
      if (!assignAll && selected.size) {
        const rows = [...selected].map((employee_id) => ({ pack_id: pack.id, employee_id }));
        const { error: e2 } = await supabase.from("hr_document_pack_assignments").insert(rows);
        if (e2) throw e2;
      }
      onChanged();
      onClose();
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
      setSaving(false);
    }
  }

  async function deletePack() {
    if (!(await confirm("Delete this pack? Its documents are kept (moved to no pack), not deleted.", { title: "Delete pack", confirmLabel: "Delete", danger: true }))) return;
    setSaving(true);
    try {
      // Detach documents so they survive, then remove the pack.
      await supabase.from("hr_document_types").update({ pack_id: null }).eq("pack_id", pack.id);
      const { error } = await supabase.from("hr_document_packs").delete().eq("id", pack.id);
      if (error) throw error;
      onChanged();
      onClose();
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
      setSaving(false);
    }
  }

  return (
    <div style={modalBackdrop} onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}>
      <div className="card" style={{ width: "min(560px, 96vw)", borderRadius: 16, maxHeight: "92vh", overflowY: "auto" }}>
        {dialog}
        <div className="row-between">
          <div style={{ fontWeight: 900, fontSize: 16 }}>Pack settings</div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="hr" />

        <div className="stack" style={{ gap: 12 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>Pack name</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div>
            <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>Assign this pack to</div>
            <label className="row" style={{ gap: 8, alignItems: "center" }}>
              <input type="radio" checked={assignAll} onChange={() => setAssignAll(true)} /> All users
            </label>
            <label className="row" style={{ gap: 8, alignItems: "center", marginTop: 4 }}>
              <input type="radio" checked={!assignAll} onChange={() => setAssignAll(false)} /> Specific users
            </label>
          </div>

          {!assignAll && (
            <div>
              <input className="input" placeholder="Search people…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: 8 }} />
              <div className="stack" style={{ gap: 2, maxHeight: 260, overflowY: "auto", border: "1px solid #e5e7eb", borderRadius: 10, padding: 6 }}>
                {loading ? (
                  <div className="subtle" style={{ fontSize: 13, padding: 8 }}>Loading…</div>
                ) : filtered.length === 0 ? (
                  <div className="subtle" style={{ fontSize: 13, padding: 8 }}>No people.</div>
                ) : (
                  filtered.map((e) => (
                    <label key={e.id} className="row" style={{ gap: 8, alignItems: "center", padding: "6px 8px", cursor: "pointer" }}>
                      <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                      {empName(e)}
                    </label>
                  ))
                )}
              </div>
              <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>{selected.size} selected</div>
            </div>
          )}

          {status ? <div className="subtle">{status}</div> : null}

          <div className="hr" />
          <div className="row-between">
            <button className="btn" onClick={() => void deletePack()} disabled={saving} style={{ color: "#b91c1c" }}>Delete pack</button>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const previewBox: React.CSSProperties = {
  height: 120,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px dashed #e5e7eb",
  borderRadius: 8,
  background: "#fafafa",
  color: "#6b7280",
  fontSize: 13,
  textAlign: "center",
  padding: 12,
};

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
