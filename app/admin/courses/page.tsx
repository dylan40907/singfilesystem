"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile } from "@/lib/teachers";
import { useDialog } from "@/components/ui/useDialog";
import {
  Course, CourseSegment, CourseStatus, CourseWithMeta,
  archiveCourses, assignToCourses, createCourse, createSegment, deleteCourse, deleteSegment,
  fetchCourses, fetchSegments, moveCourseToSegment, remindIncomplete, setCourseStatus,
  updateCourse, updateSegment,
} from "@/lib/courses";
import AssignPeopleModal from "@/components/courses/AssignPeopleModal";
import CourseGroupsPanel from "@/components/courses/CourseGroupsPanel";

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
  const [view, setView] = useState<"courses" | "groups">("courses");
  const [tab, setTab] = useState<"active" | "archived">("active");
  // multi-select + bulk
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
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
  // Edit-segment modal (name + color)
  const [segEdit, setSegEdit] = useState<{ id: string; name: string; color: string } | null>(null);
  // Move-course-to-segment modal
  const [moveCourse, setMoveCourse] = useState<{ course: Course; segmentId: string } | null>(null);

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

  // Group courses by segment. In the Active tab we seed ALL segments first so
  // empty ones still render (confirming they exist).
  const grouped = useMemo(() => {
    const map = new Map<string, { segment: CourseSegment | null; items: CourseWithMeta[] }>();
    if (tab === "active") {
      for (const s of segments) map.set(s.id, { segment: s, items: [] });
    }
    for (const c of visible) {
      const key = c.segment?.id ?? "__none__";
      if (!map.has(key)) map.set(key, { segment: c.segment ?? null, items: [] });
      map.get(key)!.items.push(c);
    }
    // Keep groups that have courses, plus (active tab) empty named segments.
    return Array.from(map.values()).filter((g) => g.items.length > 0 || (tab === "active" && !!g.segment));
  }, [visible, segments, tab]);

  const sortedSegments = useMemo(() => [...segments].sort((a, b) => a.position - b.position), [segments]);

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

  async function confirmSegEdit() {
    if (!segEdit || !segEdit.name.trim()) return;
    try {
      await updateSegment(segEdit.id, { name: segEdit.name.trim(), color: segEdit.color });
      setSegEdit(null);
      await reload();
    } catch (e: any) {
      setStatus("Edit error: " + (e?.message ?? "unknown"));
    }
  }

  // Reorder updates local state immediately (no reload) and persists a clean
  // 0..n sequence in the background — robust even when positions had ties (all 0).
  async function moveSegment(seg: CourseSegment, dir: -1 | 1) {
    const sorted = [...segments].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((s) => s.id === seg.id);
    const swapIdx = idx + dir;
    if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) return;
    [sorted[idx], sorted[swapIdx]] = [sorted[swapIdx], sorted[idx]];
    const reindexed = sorted.map((s, i) => ({ ...s, position: i }));
    const prev = segments;
    setSegments(reindexed);
    Promise.all(
      reindexed
        .filter((s) => prev.find((x) => x.id === s.id)?.position !== s.position)
        .map((s) => updateSegment(s.id, { position: s.position }))
    ).catch(() => setStatus("Reorder failed to save."));
  }

  async function handleDeleteSegment(seg: CourseSegment) {
    const ok = await confirm(
      `Delete segment "${seg.name}"?\n\nAny courses in it aren’t deleted — they just become uncategorized.`,
      { title: "Delete segment", confirmLabel: "Delete", danger: true }
    );
    if (!ok) return;
    try {
      await deleteSegment(seg.id);
      await reload();
      setStatus("Segment deleted.");
    } catch (e: any) {
      setStatus("Delete error: " + (e?.message ?? "unknown"));
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

  function toggleSelect(id: string, on: boolean) {
    setSelected((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });
  }
  function clearSelection() { setSelected(new Set()); }

  async function bulkAssign(userIds: string[]) {
    setBulkBusy(true);
    try {
      await assignToCourses(Array.from(selected), userIds);
      setBulkAssignOpen(false);
      clearSelection();
      setStatus(`✅ Assigned ${selected.size} course(s) to ${userIds.length} ${userIds.length === 1 ? "person" : "people"}.`);
      await reload();
    } catch (e: any) {
      setStatus("Assign error: " + (e?.message ?? "unknown"));
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkRemind() {
    setBulkBusy(true);
    try {
      let total = 0;
      for (const id of selected) total += await remindIncomplete(id);
      setStatus(`🔔 Reminded ${total} ${total === 1 ? "person" : "people"} across ${selected.size} course(s).`);
    } catch (e: any) {
      setStatus("Reminder error: " + (e?.message ?? "unknown"));
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkSetStatus(next: CourseStatus) {
    const ids = Array.from(selected);
    const ok = await confirm(
      `${next === "archived" ? "Archive" : "Restore"} ${ids.length} course(s)?`,
      { title: next === "archived" ? "Archive courses" : "Restore courses", confirmLabel: next === "archived" ? "Archive" : "Restore" }
    );
    if (!ok) return;
    setBulkBusy(true);
    try {
      if (next === "archived") await archiveCourses(ids);
      else for (const id of ids) await setCourseStatus(id, "draft");
      clearSelection();
      await reload();
      setStatus(next === "archived" ? "Archived." : "Restored to draft.");
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    } finally {
      setBulkBusy(false);
    }
  }

  async function confirmMoveCourse() {
    if (!moveCourse) return;
    try {
      await moveCourseToSegment(moveCourse.course.id, moveCourse.segmentId || null);
      setMoveCourse(null);
      await reload();
      setStatus("Moved.");
    } catch (e: any) {
      setStatus("Move error: " + (e?.message ?? "unknown"));
    }
  }

  function reorderCourse(items: CourseWithMeta[], idx: number, dir: -1 | 1) {
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= items.length) return;
    const arr = [...items];
    [arr[idx], arr[swapIdx]] = [arr[swapIdx], arr[idx]];
    const reindexed = arr.map((c, i) => ({ ...c, position: i }));
    const prevPos = new Map(items.map((c) => [c.id, c.position]));
    const itemIds = new Set(items.map((c) => c.id));
    // Place the reordered group back into the exact slots it occupied.
    setCourses((prev) => {
      const slots: number[] = [];
      prev.forEach((c, i) => { if (itemIds.has(c.id)) slots.push(i); });
      const result = [...prev];
      reindexed.forEach((c, k) => { if (slots[k] !== undefined) result[slots[k]] = c; });
      return result;
    });
    Promise.all(
      reindexed
        .filter((c) => prevPos.get(c.id) !== c.position)
        .map((c) => updateCourse(c.id, { position: c.position }))
    ).catch(() => setStatus("Reorder failed to save."));
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

      <div className="row" style={{ gap: 6 }}>
        <button className={`btn${view === "courses" ? " btn-primary" : ""}`} onClick={() => setView("courses")}>Courses</button>
        <button className={`btn${view === "groups" ? " btn-primary" : ""}`} onClick={() => setView("groups")}>Groups</button>
      </div>

      {view === "groups" ? (
        <div className="card"><CourseGroupsPanel /></div>
      ) : (
      <div className="card">
        <div className="row-between" style={{ marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
          <div className="row" style={{ gap: 6 }}>
            <button className={`btn${tab === "active" ? " btn-primary" : ""}`} onClick={() => { setTab("active"); clearSelection(); }}>Active</button>
            <button className={`btn${tab === "archived" ? " btn-primary" : ""}`} onClick={() => { setTab("archived"); clearSelection(); }}>
              Archived ({courses.filter((c) => c.status === "archived").length})
            </button>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={() => setSegOpen(true)}>+ Add segment</button>
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>+ Add course</button>
          </div>
        </div>

        {selected.size > 0 && (
          <div className="row-between" style={{ marginBottom: 14, padding: "10px 14px", background: "#fdf2f8", border: "1px solid #fbcfe8", borderRadius: 12, flexWrap: "wrap", gap: 10 }}>
            <span style={{ fontWeight: 800, color: "#9d174d" }}>{selected.size} selected</span>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="btn" disabled={bulkBusy} onClick={() => setBulkAssignOpen(true)}>Assign…</button>
              <button className="btn" disabled={bulkBusy} onClick={bulkRemind}>🔔 Remind not-completed</button>
              {tab === "archived"
                ? <button className="btn" disabled={bulkBusy} onClick={() => bulkSetStatus("draft")}>Restore</button>
                : <button className="btn" disabled={bulkBusy} onClick={() => bulkSetStatus("archived")}>Archive</button>}
              <button className="btn" disabled={bulkBusy} onClick={clearSelection}>Clear</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="subtle">Loading…</div>
        ) : grouped.length === 0 ? (
          <div className="subtle" style={{ padding: 20, textAlign: "center" }}>
            {tab === "archived" ? "No archived courses." : "No courses or segments yet. Add a segment or a course to start."}
          </div>
        ) : (
          grouped.map((g, i) => (
            <div key={g.segment?.id ?? i} style={{ marginBottom: 22 }}>
              <div className="row-between" style={{ marginBottom: 8 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span style={{ width: 12, height: 12, borderRadius: 999, background: g.segment?.color ?? "#9ca3af", display: "inline-block" }} />
                  <span style={{ fontWeight: 800, color: g.segment?.color ?? "#6b7280" }}>{g.segment?.name ?? "Uncategorized"}</span>
                </div>
                {g.segment && (() => {
                  const sIdx = sortedSegments.findIndex((s) => s.id === g.segment!.id);
                  return (
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn" style={{ ...miniBtn, color: "#e6178d", fontWeight: 800 }}
                        onClick={() => { setNewTitle(""); setNewSegmentId(g.segment!.id); setCreateOpen(true); }}>+ Course</button>
                      <button className="btn" style={miniBtn} onClick={() => moveSegment(g.segment!, -1)} disabled={sIdx === 0}>↑</button>
                      <button className="btn" style={miniBtn} onClick={() => moveSegment(g.segment!, 1)} disabled={sIdx === sortedSegments.length - 1}>↓</button>
                      <button className="btn" style={miniBtn} onClick={() => setSegEdit({ id: g.segment!.id, name: g.segment!.name, color: g.segment!.color })}>Edit</button>
                      <button className="btn" style={{ ...miniBtn, color: "#991b1b" }} onClick={() => handleDeleteSegment(g.segment!)}>Delete</button>
                    </div>
                  );
                })()}
              </div>
              {g.items.length === 0 ? (
                <div className="subtle" style={{ fontSize: 13, padding: "10px 14px", border: "1px dashed #e5e7eb", borderRadius: 12 }}>
                  No courses in this segment yet.
                </div>
              ) : (
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr style={{ background: "#f9fafb", textAlign: "left", color: "#6b7280" }}>
                      <th style={{ ...th, width: 36 }}>
                        <input type="checkbox"
                          checked={g.items.every((c) => selected.has(c.id))}
                          onChange={(e) => setSelected((s) => { const n = new Set(s); g.items.forEach((c) => (e.target.checked ? n.add(c.id) : n.delete(c.id))); return n; })} />
                      </th>
                      <th style={th}>Name</th>
                      <th style={th}>Status</th>
                      <th style={th}>Assigned</th>
                      <th style={th}>Created</th>
                      <th style={{ ...th, textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((c, ci) => (
                      <tr key={c.id} style={{ borderTop: "1px solid #f1f5f9", background: selected.has(c.id) ? "#fdf2f8" : undefined }}>
                        <td style={{ ...td, width: 36 }}>
                          <input type="checkbox" checked={selected.has(c.id)} onChange={(e) => toggleSelect(c.id, e.target.checked)} />
                        </td>
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
                          <button className="btn" onClick={() => reorderCourse(g.items, ci, -1)} disabled={ci === 0} style={miniBtn}>↑</button>
                          <button className="btn" onClick={() => reorderCourse(g.items, ci, 1)} disabled={ci === g.items.length - 1} style={miniBtn}>↓</button>
                          <button className="btn" onClick={() => router.push(`/admin/courses/${c.id}`)} style={miniBtn}>Edit</button>
                          <button className="btn" onClick={() => setMoveCourse({ course: c, segmentId: c.segment_id ?? "" })} style={miniBtn}>Move</button>
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
              )}
            </div>
          ))
        )}
      </div>
      )}

      {bulkAssignOpen && (
        <AssignPeopleModal
          title={`Assign ${selected.size} course(s)`}
          busy={bulkBusy}
          onClose={() => setBulkAssignOpen(false)}
          onAssign={bulkAssign}
        />
      )}

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

      {/* Move course to segment modal */}
      {moveCourse && (
        <Modal title={`Move "${moveCourse.course.title}"`} onClose={() => setMoveCourse(null)}>
          <label style={lbl}>Segment</label>
          <select className="select" value={moveCourse.segmentId}
            onChange={(e) => setMoveCourse((m) => (m ? { ...m, segmentId: e.target.value } : m))}>
            <option value="">— Uncategorized —</option>
            {sortedSegments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
            <button className="btn" onClick={() => setMoveCourse(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={confirmMoveCourse}>Move</button>
          </div>
        </Modal>
      )}

      {/* Edit segment modal (name + color) */}
      {segEdit && (
        <Modal title="Edit segment" onClose={() => setSegEdit(null)}>
          <label style={lbl}>Segment name</label>
          <input className="input" autoFocus value={segEdit.name}
            onChange={(e) => setSegEdit((s) => (s ? { ...s, name: e.target.value } : s))}
            onKeyDown={(e) => { if (e.key === "Enter") confirmSegEdit(); }} />
          <label style={lbl}>Color</label>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {SEGMENT_COLORS.map((c) => (
              <button key={c} onClick={() => setSegEdit((s) => (s ? { ...s, color: c } : s))} aria-label={c}
                style={{ width: 28, height: 28, borderRadius: 999, background: c, border: segEdit.color.toLowerCase() === c.toLowerCase() ? "3px solid #111827" : "2px solid #e5e7eb", cursor: "pointer" }} />
            ))}
            <label title="Custom color" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", marginLeft: 4 }}>
              <input type="color" value={segEdit.color} onChange={(e) => setSegEdit((s) => (s ? { ...s, color: e.target.value } : s))}
                style={{ width: 32, height: 32, padding: 0, border: "1px solid #e5e7eb", borderRadius: 8, background: "none", cursor: "pointer" }} />
              <span className="subtle" style={{ fontSize: 12 }}>Custom</span>
            </label>
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 12 }}>
            <span style={{ width: 12, height: 12, borderRadius: 999, background: segEdit.color, display: "inline-block" }} />
            <span style={{ fontWeight: 800, color: segEdit.color }}>{segEdit.name || "Preview"}</span>
          </div>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
            <button className="btn" onClick={() => setSegEdit(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={confirmSegEdit} disabled={!segEdit.name.trim()}>Save</button>
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
