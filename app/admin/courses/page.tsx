"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile } from "@/lib/teachers";
import { useDialog } from "@/components/ui/useDialog";
import {
  Course, CourseSegment, CourseStatus, CourseWithMeta,
  createCourse, createSegment, deleteCourse, fetchCourses, fetchSegments,
  setCourseStatus,
} from "@/lib/courses";

const SEGMENT_COLORS = ["#e6178d", "#7c3aed", "#2563eb", "#059669", "#d97706", "#dc2626", "#0891b2"];

function StatusBadge({ status }: { status: CourseStatus }) {
  const map: Record<CourseStatus, { bg: string; fg: string; label: string }> = {
    draft: { bg: "#f3f4f6", fg: "#6b7280", label: "Draft" },
    published: { bg: "#dcfce7", fg: "#166534", label: "Published" },
    archived: { bg: "#fee2e2", fg: "#991b1b", label: "Archived" },
  };
  const s = map[status];
  return (
    <span style={{ background: s.bg, color: s.fg, fontWeight: 700, fontSize: 12, padding: "3px 10px", borderRadius: 999 }}>
      {s.label}
    </span>
  );
}

export default function AdminCoursesPage() {
  const router = useRouter();
  const { confirm, modal: dialogModal } = useDialog();

  const [authzd, setAuthzd] = useState<boolean | null>(null);
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [courses, setCourses] = useState<CourseWithMeta[]>([]);
  const [segments, setSegments] = useState<CourseSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  // Create-course modal
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newSegmentId, setNewSegmentId] = useState<string>("");
  const [creating, setCreating] = useState(false);

  // Segment modal
  const [segOpen, setSegOpen] = useState(false);
  const [segName, setSegName] = useState("");
  const [segColor, setSegColor] = useState(SEGMENT_COLORS[0]);

  useEffect(() => {
    (async () => {
      const profile = await fetchMyProfile();
      setAuthzd(!!profile?.is_active && profile.role === "admin");
    })();
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [cs, segs] = await Promise.all([fetchCourses(), fetchSegments()]);
      setCourses(cs);
      setSegments(segs);
    } catch (e: any) {
      setStatus("Load error: " + (e?.message ?? "unknown"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authzd) reload();
  }, [authzd, reload]);

  const visible = useMemo(
    () => courses.filter((c) => (tab === "archived" ? c.status === "archived" : c.status !== "archived")),
    [courses, tab]
  );

  // Group active courses by segment (matches Connecteam's segmented layout)
  const grouped = useMemo(() => {
    const map = new Map<string, { segment: CourseSegment | null; items: CourseWithMeta[] }>();
    for (const c of visible) {
      const key = c.segment?.id ?? "__none__";
      if (!map.has(key)) map.set(key, { segment: c.segment, items: [] });
      map.get(key)!.items.push(c);
    }
    return Array.from(map.values());
  }, [visible]);

  async function handleCreate() {
    if (!newTitle.trim()) { setStatus("Enter a course name."); return; }
    setCreating(true);
    try {
      const course = await createCourse(newTitle.trim(), newSegmentId || null);
      setCreateOpen(false);
      setNewTitle("");
      setNewSegmentId("");
      router.push(`/admin/courses/${course.id}`);
    } catch (e: any) {
      setStatus("Create error: " + (e?.message ?? "unknown"));
    } finally {
      setCreating(false);
    }
  }

  async function handleAddSegment() {
    if (!segName.trim()) return;
    try {
      const seg = await createSegment(segName.trim(), segColor);
      setSegments((s) => [...s, seg]);
      setSegName("");
      setSegOpen(false);
    } catch (e: any) {
      setStatus("Segment error: " + (e?.message ?? "unknown"));
    }
  }

  async function changeStatus(c: Course, next: CourseStatus) {
    try {
      await setCourseStatus(c.id, next);
      await reload();
      setStatus(next === "published" ? "✅ Published." : next === "archived" ? "Archived." : "Moved to draft.");
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    }
  }

  async function handleDelete(c: Course) {
    const ok = await confirm(
      `Delete "${c.title}"?\n\nThis permanently removes the course, its content, and all assignment records.`,
      { title: "Delete course", confirmLabel: "Delete", danger: true }
    );
    if (!ok) return;
    try {
      await deleteCourse(c.id);
      await reload();
      setStatus("Deleted.");
    } catch (e: any) {
      setStatus("Delete error: " + (e?.message ?? "unknown"));
    }
  }

  if (authzd === null) return <main className="stack"><div className="subtle">Loading…</div></main>;
  if (!authzd) return <main className="stack"><h1 className="h1">Courses</h1><div className="card">Admin access required.</div></main>;

  return (
    <main className="stack">
      {dialogModal}
      <div className="row-between">
        <h1 className="h1">📘 Courses</h1>
        {status ? <span className="badge badge-pink">{status}</span> : null}
      </div>

      <div className="card">
        <div className="row-between" style={{ marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
          <div className="row" style={{ gap: 6 }}>
            <button className={`btn${tab === "active" ? " btn-primary" : ""}`} onClick={() => setTab("active")}>Active</button>
            <button className={`btn${tab === "archived" ? " btn-primary" : ""}`} onClick={() => setTab("archived")}>
              Archived ({courses.filter((c) => c.status === "archived").length})
            </button>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={() => setSegOpen(true)}>+ Add segment</button>
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>+ Add course</button>
          </div>
        </div>

        {loading ? (
          <div className="subtle">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="subtle" style={{ padding: 20, textAlign: "center" }}>
            {tab === "archived" ? "No archived courses." : "No courses yet. Click “Add course” to build one."}
          </div>
        ) : (
          grouped.map((g, i) => (
            <div key={g.segment?.id ?? i} style={{ marginBottom: 22 }}>
              <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                <span style={{ width: 12, height: 12, borderRadius: 999, background: g.segment?.color ?? "#9ca3af", display: "inline-block" }} />
                <span style={{ fontWeight: 800, color: g.segment?.color ?? "#6b7280" }}>{g.segment?.name ?? "Uncategorized"}</span>
              </div>
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr style={{ background: "#f9fafb", textAlign: "left", color: "#6b7280" }}>
                      <th style={th}>Name</th>
                      <th style={th}>Status</th>
                      <th style={th}>Assigned</th>
                      <th style={th}>Created</th>
                      <th style={{ ...th, textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((c) => (
                      <tr key={c.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                        <td style={td}>
                          <button onClick={() => router.push(`/admin/courses/${c.id}`)}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "#111827", fontWeight: 700, padding: 0, textAlign: "left" }}>
                            {c.title}
                          </button>
                        </td>
                        <td style={td}><StatusBadge status={c.status} /></td>
                        <td style={td}>{c.assignedCount}</td>
                        <td style={td}>{new Date(c.created_at).toLocaleDateString()}</td>
                        <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                          <button className="btn" onClick={() => router.push(`/admin/courses/${c.id}`)} style={miniBtn}>Edit</button>
                          {c.status !== "published" && c.status !== "archived" && (
                            <button className="btn" onClick={() => changeStatus(c, "published")} style={miniBtn}>Publish</button>
                          )}
                          {c.status === "published" && (
                            <button className="btn" onClick={() => changeStatus(c, "draft")} style={miniBtn}>Unpublish</button>
                          )}
                          {c.status !== "archived" ? (
                            <button className="btn" onClick={() => changeStatus(c, "archived")} style={miniBtn}>Archive</button>
                          ) : (
                            <button className="btn" onClick={() => changeStatus(c, "draft")} style={miniBtn}>Restore</button>
                          )}
                          <button className="btn" onClick={() => handleDelete(c)} style={{ ...miniBtn, color: "#991b1b" }}>🗑</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Create course modal */}
      {createOpen && (
        <Modal title="Create course" onClose={() => setCreateOpen(false)}>
          <label style={lbl}>Course name</label>
          <input className="input" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Enter course name" autoFocus />
          <label style={lbl}>Segment</label>
          <select className="select" value={newSegmentId} onChange={(e) => setNewSegmentId(e.target.value)}>
            <option value="">— None —</option>
            {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
            <button className="btn" onClick={() => setCreateOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>{creating ? "Creating…" : "Create"}</button>
          </div>
        </Modal>
      )}

      {/* Add segment modal */}
      {segOpen && (
        <Modal title="Add segment" onClose={() => setSegOpen(false)}>
          <label style={lbl}>Segment name</label>
          <input className="input" value={segName} onChange={(e) => setSegName(e.target.value)} placeholder="e.g. Human Resources" autoFocus />
          <label style={lbl}>Color</label>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {SEGMENT_COLORS.map((c) => (
              <button key={c} onClick={() => setSegColor(c)} aria-label={c}
                style={{ width: 28, height: 28, borderRadius: 999, background: c, border: segColor === c ? "3px solid #111827" : "2px solid #e5e7eb", cursor: "pointer" }} />
            ))}
          </div>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
            <button className="btn" onClick={() => setSegOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleAddSegment}>Add</button>
          </div>
        </Modal>
      )}
    </main>
  );
}

const th: React.CSSProperties = { padding: "10px 14px", fontWeight: 700, fontSize: 12 };
const td: React.CSSProperties = { padding: "10px 14px", color: "#374151" };
const miniBtn: React.CSSProperties = { padding: "4px 10px", fontSize: 12, marginLeft: 6 };
const lbl: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "#374151", margin: "12px 0 6px" };

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="card" style={{ width: "100%", maxWidth: 440 }}>
        <div style={{ fontWeight: 900, fontSize: 17, marginBottom: 4 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}
