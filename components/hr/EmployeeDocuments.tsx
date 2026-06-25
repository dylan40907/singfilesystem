"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

/**
 * EmployeeDocuments — self-service document checklist for the logged-in staff
 * member (rendered as the "Documents" tab in app/hr/page.tsx).
 *
 * Employees see the document types assigned to them (via pack assignment), can
 * download the blank/template form, upload their filled copy (which goes to
 * "pending approval"), view their uploaded file, and read/post comments.
 *
 * All admin-side approval happens on /admin/hr/documents. Uploads here are
 * always forced to pending review by a DB trigger (employees can't self-approve).
 */

type Pack = { id: string; name: string; order_index: number | null; assign_all: boolean };
type DocType = {
  id: string;
  pack_id: string | null;
  name: string;
  code: string | null;
  description: string | null;
  order_index: number | null;
  requires_approval: boolean;
  required_default: boolean;
  allow_user_upload: boolean;
  template_object_key: string | null;
  template_file_name: string | null;
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
  approval_status: "pending" | "approved" | "rejected" | null;
  review_note: string | null;
  expires_at: string | null;
  version: number;
};
type Comment = {
  id: string;
  record_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
};

type StatusKey = "missing" | "pending" | "approved" | "rejected" | "expired" | "not_required";

const STATUS: Record<StatusKey, { label: string; color: string; bg: string }> = {
  missing: { label: "Not uploaded", color: "#92400e", bg: "#fef3c7" },
  pending: { label: "Pending approval", color: "#92400e", bg: "#fef3c7" },
  approved: { label: "Approved", color: "#166534", bg: "#dcfce7" },
  rejected: { label: "Rejected", color: "#991b1b", bg: "#fee2e2" },
  expired: { label: "Expired", color: "#991b1b", bg: "#fee2e2" },
  not_required: { label: "Not required", color: "#6b7280", bg: "#f3f4f6" },
};

function computeStatus(type: DocType, rec: DocRecord | undefined): StatusKey {
  if (rec && rec.required === false) return "not_required";
  if (!rec || !rec.object_key) return "missing";
  if (rec.expires_at && new Date(rec.expires_at) < new Date()) return "expired";
  if (rec.approval_status === "approved") return "approved";
  if (rec.approval_status === "rejected") return "rejected";
  return "pending";
}

async function postJson(path: string, body: any) {
  const { data: s } = await supabase.auth.getSession();
  const token = s.session?.access_token;
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  return json;
}

export default function EmployeeDocuments({ employeeId }: { employeeId: string }) {
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [types, setTypes] = useState<DocType[]>([]);
  const [assignedPackIds, setAssignedPackIds] = useState<Set<string>>(new Set());
  const [records, setRecords] = useState<Record<string, DocRecord>>({}); // by doc_type_id
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyType, setBusyType] = useState<string | null>(null);

  // comments
  const [openComments, setOpenComments] = useState<string | null>(null); // record_id
  const [commentsByRecord, setCommentsByRecord] = useState<Record<string, Comment[]>>({});
  const [nameById, setNameById] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingTypeRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data: u } = await supabase.auth.getUser();
      setMyUserId(u.user?.id ?? null);

      const [packsRes, typesRes, assignRes, recsRes] = await Promise.all([
        supabase.from("hr_document_packs").select("id, name, order_index, assign_all").order("order_index", { ascending: true }),
        supabase.from("hr_document_types").select("id, pack_id, name, code, description, order_index, requires_approval, required_default, allow_user_upload, template_object_key, template_file_name, is_active").order("order_index", { ascending: true }),
        supabase.from("hr_document_pack_assignments").select("pack_id").eq("employee_id", employeeId),
        supabase.from("hr_document_records").select("id, employee_id, doc_type_id, required, object_key, file_name, mime_type, approval_status, review_note, expires_at, version").eq("employee_id", employeeId),
      ]);
      if (packsRes.error) throw packsRes.error;
      if (typesRes.error) throw typesRes.error;

      setPacks((packsRes.data ?? []) as Pack[]);
      setTypes(((typesRes.data ?? []) as DocType[]).filter((t) => t.is_active));
      setAssignedPackIds(new Set((assignRes.data ?? []).map((a: any) => a.pack_id)));
      const recMap: Record<string, DocRecord> = {};
      for (const r of (recsRes.data ?? []) as DocRecord[]) recMap[r.doc_type_id] = r;
      setRecords(recMap);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load documents.");
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Packs that apply to me: assign-all packs OR packs explicitly assigned to me.
  const applicablePacks = useMemo(
    () => packs.filter((p) => p.assign_all || assignedPackIds.has(p.id)),
    [packs, assignedPackIds]
  );
  const applicablePackIds = useMemo(() => new Set(applicablePacks.map((p) => p.id)), [applicablePacks]);
  const typesByPack = useMemo(() => {
    const m = new Map<string, DocType[]>();
    for (const t of types) {
      if (!t.pack_id || !applicablePackIds.has(t.pack_id)) continue;
      const arr = m.get(t.pack_id) ?? [];
      arr.push(t);
      m.set(t.pack_id, arr);
    }
    return m;
  }, [types, applicablePackIds]);

  async function downloadTemplate(type: DocType) {
    try {
      const { url } = await postJson("/api/r2/hr-doc-template", { docTypeId: type.id, mode: "attachment" });
      window.open(url, "_blank");
    } catch (e: any) {
      setError(e?.message ?? "Could not download the blank form.");
    }
  }

  async function viewFile(rec: DocRecord) {
    try {
      const { url } = await postJson("/api/r2/hr-doc-download", { recordId: rec.id, mode: "inline" });
      window.open(url, "_blank");
    } catch (e: any) {
      setError(e?.message ?? "Could not open the file.");
    }
  }

  function pickFile(typeId: string) {
    pendingTypeRef.current = typeId;
    fileInputRef.current?.click();
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    const typeId = pendingTypeRef.current;
    pendingTypeRef.current = null;
    if (!file || !typeId) return;

    setBusyType(typeId);
    setError(null);
    try {
      const pres = await postJson("/api/r2/presign-employee-doc", {
        employeeId,
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      });
      const put = await fetch(pres.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);

      const existing = records[typeId];
      const { error: upErr } = await supabase.from("hr_document_records").upsert(
        {
          employee_id: employeeId,
          doc_type_id: typeId,
          required: true,
          object_key: pres.objectKey,
          file_name: file.name,
          mime_type: file.type || "application/octet-stream",
          size_bytes: file.size,
          uploaded_by: myUserId,
          uploaded_at: new Date().toISOString(),
          version: (existing?.version ?? 0) + 1,
          // approval_status is forced to 'pending' by the DB trigger for employees
        },
        { onConflict: "employee_id,doc_type_id" }
      );
      if (upErr) throw upErr;
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Upload failed.");
    } finally {
      setBusyType(null);
    }
  }

  async function toggleComments(rec: DocRecord) {
    if (openComments === rec.id) {
      setOpenComments(null);
      return;
    }
    setOpenComments(rec.id);
    setDraft("");
    if (!commentsByRecord[rec.id]) {
      const { data } = await supabase
        .from("hr_document_comments")
        .select("id, record_id, author_id, body, created_at")
        .eq("record_id", rec.id)
        .order("created_at", { ascending: true });
      const list = (data ?? []) as Comment[];
      setCommentsByRecord((m) => ({ ...m, [rec.id]: list }));
      const authorIds = Array.from(new Set(list.map((c) => c.author_id).filter(Boolean))) as string[];
      const missing = authorIds.filter((id) => !nameById[id]);
      if (missing.length) {
        const { data: profs } = await supabase.from("user_profiles").select("id, full_name, username").in("id", missing);
        const next: Record<string, string> = {};
        for (const p of profs ?? []) next[(p as any).id] = ((p as any).full_name || (p as any).username || "Staff") as string;
        setNameById((m) => ({ ...m, ...next }));
      }
    }
  }

  async function postComment(rec: DocRecord) {
    const body = draft.trim();
    if (!body || !myUserId) return;
    const { data, error: cErr } = await supabase
      .from("hr_document_comments")
      .insert({ record_id: rec.id, author_id: myUserId, body })
      .select("id, record_id, author_id, body, created_at")
      .single();
    if (cErr) {
      setError(cErr.message);
      return;
    }
    setCommentsByRecord((m) => ({ ...m, [rec.id]: [...(m[rec.id] ?? []), data as Comment] }));
    setDraft("");
  }

  if (loading) return <div className="subtle">Loading documents…</div>;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={onFileChosen} />

      <div>
        <div style={{ fontWeight: 950, fontSize: 18 }}>My Documents</div>
        <div className="subtle" style={{ marginTop: 2 }}>
          Download the blank form, upload your completed copy, and track approval. Uploaded documents are reviewed by an admin.
        </div>
      </div>

      {error && (
        <div style={{ background: "#fee2e2", color: "#991b1b", padding: "10px 12px", borderRadius: 10, fontWeight: 700, fontSize: 13 }}>
          {error}
        </div>
      )}

      {applicablePacks.length === 0 && <div className="subtle">No documents are assigned to you.</div>}

      {applicablePacks.map((pack) => {
        const packTypes = typesByPack.get(pack.id) ?? [];
        if (packTypes.length === 0) return null;
        return (
          <div key={pack.id} style={{ border: "1px solid #e5e7eb", borderRadius: 16, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb", fontWeight: 900 }}>
              {pack.name}
            </div>
            <div>
              {packTypes.map((type) => {
                const rec = records[type.id];
                const st = computeStatus(type, rec);
                const badge = STATUS[st];
                const uploadable = type.allow_user_upload !== false && st !== "not_required";
                const commentCount = rec ? (commentsByRecord[rec.id]?.length ?? null) : null;
                return (
                  <div key={type.id} style={{ padding: "14px 16px", borderBottom: "1px solid #f3f4f6" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ flex: 1, minWidth: 220 }}>
                        <div style={{ fontWeight: 800 }}>{type.name}</div>
                        {type.description ? (
                          <div className="subtle" style={{ fontSize: 12, marginTop: 3, whiteSpace: "pre-wrap" }}>{type.description}</div>
                        ) : null}
                        {st === "rejected" && rec?.review_note ? (
                          <div style={{ fontSize: 12, marginTop: 6, color: "#991b1b" }}>
                            <b>Reason:</b> {rec.review_note}
                          </div>
                        ) : null}
                      </div>

                      <span style={{ alignSelf: "center", fontSize: 12, fontWeight: 800, color: badge.color, background: badge.bg, borderRadius: 999, padding: "4px 10px", whiteSpace: "nowrap" }}>
                        {badge.label}
                      </span>

                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignSelf: "center" }}>
                        {type.template_object_key && (
                          <button className="btn" type="button" onClick={() => downloadTemplate(type)} style={{ fontSize: 13 }}>
                            ⬇ Blank form
                          </button>
                        )}
                        {rec?.object_key && (
                          <button className="btn" type="button" onClick={() => viewFile(rec)} style={{ fontSize: 13 }}>
                            View
                          </button>
                        )}
                        {uploadable && (
                          <button
                            className="btn"
                            type="button"
                            onClick={() => pickFile(type.id)}
                            disabled={busyType === type.id}
                            style={{ fontSize: 13, background: "#e6178d", color: "white", border: "none", fontWeight: 800 }}
                          >
                            {busyType === type.id ? "Uploading…" : rec?.object_key ? "Replace" : "Upload"}
                          </button>
                        )}
                        {rec && (
                          <button className="btn" type="button" onClick={() => toggleComments(rec)} style={{ fontSize: 13 }}>
                            💬 {commentCount != null ? commentCount : "Comments"}
                          </button>
                        )}
                      </div>
                    </div>

                    {rec && openComments === rec.id && (
                      <div style={{ marginTop: 12, borderTop: "1px dashed #e5e7eb", paddingTop: 12 }}>
                        <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
                          {(commentsByRecord[rec.id] ?? []).length === 0 ? (
                            <div className="subtle" style={{ fontSize: 13 }}>No comments yet.</div>
                          ) : (
                            (commentsByRecord[rec.id] ?? []).map((c) => (
                              <div key={c.id} style={{ background: "#f9fafb", borderRadius: 10, padding: "8px 12px" }}>
                                <div style={{ fontSize: 12, fontWeight: 800, color: "#374151" }}>
                                  {c.author_id === myUserId ? "You" : nameById[c.author_id ?? ""] ?? "Staff"}
                                  <span className="subtle" style={{ fontWeight: 500, marginLeft: 8 }}>
                                    {new Date(c.created_at).toLocaleString()}
                                  </span>
                                </div>
                                <div style={{ fontSize: 14, marginTop: 2, whiteSpace: "pre-wrap" }}>{c.body}</div>
                              </div>
                            ))
                          )}
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <input
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") postComment(rec); }}
                            placeholder="Write a comment…"
                            style={{ flex: 1, height: 38, border: "1px solid #e5e7eb", borderRadius: 10, padding: "0 12px", outline: "none" }}
                          />
                          <button className="btn" type="button" onClick={() => postComment(rec)} style={{ background: "#e6178d", color: "white", border: "none", fontWeight: 800 }}>
                            Send
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
