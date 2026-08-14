"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile } from "@/lib/teachers";
import { useDialog } from "@/components/ui/useDialog";
import {
  Course, CourseSegment, CourseStatus, CourseWithMeta, ScriptKind,
  archiveCourses, assignToCourses, createCourse, createSegment, deleteCourse, deleteSegment,
  fetchAssignedCounts, fetchCourses, fetchSegments, moveCourseToSegment, remindIncomplete, setCourseStatus,
  updateCourse, updateSegment,
} from "@/lib/courses";
import { ensureSegmentMirrors, mirrorInBackground, relockMirror, syncAllMirrors, unlockMirror } from "@/lib/courseMirror";
import { exportAllCoursesPdf, exportCoursePdf } from "@/lib/coursePdf";
import AssignPeopleModal from "@/components/courses/AssignPeopleModal";
import CourseGroupsPanel from "@/components/courses/CourseGroupsPanel";
import CourseProgressPanel from "@/components/courses/CourseProgressPanel";
import EmployeeCourses from "@/components/courses/EmployeeCourses";

const SEGMENT_COLORS = ["#e6178d", "#7c3aed", "#2563eb", "#059669", "#d97706", "#dc2626", "#0891b2"];

/**
 * The course list gets long, and "← Courses" is a forward navigation, which the
 * App Router always scrolls to the top — so opening a course and coming back
 * lost your place. We stash the position on the way in and restore it once the
 * rows have rendered. Session-scoped, and consumed on restore so it only ever
 * applies to the trip it was saved for.
 */
const SCROLL_KEY = "admin-courses:scrollY";
/** Which script tab you were on, so returning from a course lands you back. */
const SCRIPT_KEY = "admin-courses:script";

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
  const [view, setView] = useState<"courses" | "groups" | "progress" | "mine">("courses");
  // Admins can be assigned courses too — "My Courses" lets them take them here.
  const [takingMine, setTakingMine] = useState(false);
  const [tab, setTab] = useState<"active" | "archived">("active");
  /**
   * Traditional is where everything is authored. Simplified is a mirror of it,
   * so this toggle changes what you're looking at, never where you're working.
   * It exists on the Courses tab only — Groups and Progress deliberately show
   * both scripts side by side, since you assign and track them together.
   */
  const [script, setScript] = useState<ScriptKind>(() => {
    // Opening a course is a forward navigation, so coming back remounts this
    // page with fresh state — without this you'd always land on Traditional
    // even if you left from the Simplified tab.
    if (typeof window === "undefined") return "trad";
    try {
      return sessionStorage.getItem(SCRIPT_KEY) === "simp" ? "simp" : "trad";
    } catch {
      return "trad";
    }
  });

  /** One place to flip tabs, so the choice is always remembered. */
  function chooseScript(next: ScriptKind) {
    setScript(next);
    clearSelection();
    try { sessionStorage.setItem(SCRIPT_KEY, next); } catch { /* private mode */ }
  }
  const isSimp = script === "simp";
  const [resyncing, setResyncing] = useState(false);
  /** PDF export progress — a handbook takes a while, so it reports as it goes. */
  const [pdf, setPdf] = useState<{ label: string; done: number; total: number } | null>(null);

  async function runPdf(job: () => Promise<void>) {
    if (pdf) return; // one export at a time
    setPdf({ label: "Starting…", done: 0, total: 1 });
    try {
      await job();
      setStatus("✅ PDF downloaded.");
    } catch (e) {
      setStatus("PDF error: " + ((e as Error)?.message ?? "unknown"));
    } finally {
      setPdf(null);
    }
  }

  const onPdfProgress = (label: string, done: number, total: number) => setPdf({ label, done, total });
  // multi-select + bulk
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  /**
   * Who already has the selected courses. Loaded when the picker opens rather
   * than kept in sync — it only matters while the picker is on screen, and it
   * has to reflect the exact set of courses currently ticked.
   */
  const [assignedCount, setAssignedCount] = useState<Map<string, number>>(new Map());

  async function openBulkAssign() {
    setAssignedCount(new Map());
    setBulkAssignOpen(true);
    try {
      setAssignedCount(await fetchAssignedCounts(Array.from(selected)));
    } catch {
      // Non-fatal: the picker still works, it just can't grey anyone out.
    }
  }
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
      setAuthzd(!!profile?.is_active && (profile.role === "admin" || profile.role === "campus_admin"));
    })();
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [cs, segs] = await Promise.all([fetchCourses(undefined, script), fetchSegments(script)]);
      setCourses(cs);
      setSegments(segs);
    } catch (e: any) {
      setStatus("Load error: " + (e?.message ?? "unknown"));
    } finally {
      setLoading(false);
    }
  }, [script]);

  useEffect(() => {
    if (authzd) reload();
  }, [authzd, reload]);

  /**
   * After any Traditional edit, rebuild that course's Simplified copy. Runs in
   * the background so a slow conversion never holds up the admin's next click;
   * anything that goes wrong surfaces in the status badge.
   */
  const mirror = useCallback((sourceCourseId: string) => {
    if (isSimp) return; // editing an unlocked mirror — nothing downstream of it
    mirrorInBackground(sourceCourseId, setStatus);
  }, [isSimp]);

  /** Rebuild every mirror — the first pass, and the repair button afterwards. */
  async function resyncEverything() {
    setResyncing(true);
    setStatus("Rebuilding the Simplified copies…");
    try {
      const { synced, unlocked } = await syncAllMirrors();
      await reload();
      setStatus(
        `✅ ${synced} course(s) synced` +
        (unlocked ? ` · ${unlocked} left alone (unlocked)` : "")
      );
    } catch (e) {
      setStatus("Resync error: " + ((e as Error)?.message ?? "unknown"));
    } finally {
      setResyncing(false);
    }
  }

  async function toggleLock(c: CourseWithMeta) {
    try {
      if (c.synced) {
        await unlockMirror(c.id);
        await reload();
        setStatus(`🔓 "${c.title}" unlocked — it no longer follows the Traditional version.`);
        return;
      }
      const ok = await confirm(
        `Relock "${c.title}" and resync it with the Traditional version?\n\n` +
        `Every change made to this Simplified copy while it was unlocked will be lost. ` +
        `It will be rebuilt as a converted copy of the Traditional course as it stands right now.`,
        { title: "Relock & resync", confirmLabel: "Relock & resync", danger: true }
      );
      if (!ok) return;
      await relockMirror(c.id);
      await reload();
      setStatus(`🔒 "${c.title}" relocked and resynced.`);
    } catch (e) {
      setStatus("Lock error: " + ((e as Error)?.message ?? "unknown"));
    }
  }

  /** Remember where we were, then hand off to the course. */
  function openCourse(id: string) {
    try {
      sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
    } catch {
      /* private mode / storage disabled — just navigate */
    }
    router.push(`/admin/courses/${id}`);
  }

  // Restore only after `loading` clears: until the rows exist the page is short
  // and the browser would clamp the scroll back to the top.
  const scrollRestored = useRef(false);
  useEffect(() => {
    if (loading || scrollRestored.current) return;
    scrollRestored.current = true;

    let y = 0;
    try {
      y = Number(sessionStorage.getItem(SCROLL_KEY) ?? 0);
      sessionStorage.removeItem(SCROLL_KEY); // one-shot
    } catch {
      return;
    }
    // One frame after the commit, so the rows have actually laid out.
    if (y > 0) requestAnimationFrame(() => window.scrollTo({ top: y }));
  }, [loading]);

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
      mirror(course.id); // so it shows up in the Simplified view straight away
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
      await ensureSegmentMirrors().catch(() => {});
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
      // Segment headers have their own Simplified copies; a rename must carry.
      await ensureSegmentMirrors().catch(() => {});
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
      mirror(c.id);
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

  async function bulkPublish() {
    const ids = Array.from(selected);
    setBulkBusy(true);
    try {
      for (const id of ids) { await setCourseStatus(id, "published"); mirror(id); }
      clearSelection();
      await reload();
      setStatus(`✅ Published ${ids.length} course(s).`);
    } catch (e: any) {
      setStatus("Publish error: " + (e?.message ?? "unknown"));
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkUnpublish() {
    const ids = courses.filter((c) => selected.has(c.id) && c.status === "published").map((c) => c.id);
    if (ids.length === 0) return; // nothing published selected → no-op
    setBulkBusy(true);
    try {
      for (const id of ids) { await setCourseStatus(id, "draft"); mirror(id); }
      clearSelection();
      await reload();
      setStatus(`Unpublished ${ids.length} course(s).`);
    } catch (e: any) {
      setStatus("Unpublish error: " + (e?.message ?? "unknown"));
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
      ids.forEach(mirror);
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
      mirror(moveCourse.course.id);
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
        .map((c) => updateCourse(c.id, { position: c.position }).then(() => mirror(c.id)))
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

  // While taking one of your own assigned courses, hide the admin chrome so the
  // player is full-width (same behaviour as the HR page's Courses tab).
  const hideChrome = view === "mine" && takingMine;

  return (
    <main className="stack">
      {dialogModal}
      {!hideChrome && (
        <>
          <div className="row-between">
            <h1 className="h1">📘 Courses</h1>
            {status ? <span className="badge badge-pink">{status}</span> : null}
          </div>

          <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <button className={`btn${view === "courses" ? " btn-primary" : ""}`} onClick={() => setView("courses")}>Courses</button>
            <button className={`btn${view === "groups" ? " btn-primary" : ""}`} onClick={() => setView("groups")}>Groups</button>
            <button className={`btn${view === "progress" ? " btn-primary" : ""}`} onClick={() => setView("progress")}>Progress</button>
            <span style={{ width: 1, height: 22, background: "#e5e7eb", margin: "0 4px" }} />
            <button className={`btn${view === "mine" ? " btn-primary" : ""}`} onClick={() => setView("mine")}>⭐ My Courses</button>
          </div>
        </>
      )}

      {view === "mine" ? (
        <EmployeeCourses onTakingChange={setTakingMine} />
      ) : view === "groups" ? (
        <div className="card"><CourseGroupsPanel /></div>
      ) : view === "progress" ? (
        <div className="card"><CourseProgressPanel /></div>
      ) : (
      <div className="card">
        <div className="row-between" style={{ marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
          <div className="row" style={{ gap: 6 }}>
            <button className={`btn${tab === "active" ? " btn-primary" : ""}`} onClick={() => { setTab("active"); clearSelection(); }}>Active</button>
            <button className={`btn${tab === "archived" ? " btn-primary" : ""}`} onClick={() => { setTab("archived"); clearSelection(); }}>
              Archived ({courses.filter((c) => c.status === "archived").length})
            </button>
          </div>
          {/* Authoring lives in Traditional. In Simplified the only actions are
              resyncing and unlocking, so the create buttons aren't offered. */}
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn"
              disabled={!!pdf}
              title={`Every ${isSimp ? "Simplified" : "Traditional"} course in one PDF, grouped by segment`}
              onClick={() => void runPdf(() => exportAllCoursesPdf(script, onPdfProgress))}
            >
              📕 Export all {isSimp ? "Simplified" : "Traditional"} to PDF
            </button>
            {isSimp ? (
              <button className="btn" onClick={resyncEverything} disabled={resyncing}>
                {resyncing ? "Resyncing…" : "⟳ Resync all from Traditional"}
              </button>
            ) : (
              <>
                <button className="btn" onClick={() => setSegOpen(true)}>+ Add segment</button>
                <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>+ Add course</button>
              </>
            )}
          </div>
        </div>

        {/* Script switch — Courses tab only. */}
        <div className="row" style={{ gap: 6, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
          <button className={`btn${!isSimp ? " btn-primary" : ""}`} onClick={() => chooseScript("trad")}>
            繁 Traditional
          </button>
          <button className={`btn${isSimp ? " btn-primary" : ""}`} onClick={() => chooseScript("simp")}>
            简 Simplified
          </button>
          <span className="subtle" style={{ fontSize: 12, marginLeft: 6 }}>
            {isSimp
              ? "Copies of the Traditional courses. Locked ones update automatically when the Traditional version changes."
              : "The courses you author. Every change here updates its Simplified copy."}
          </span>
        </div>

        {selected.size > 0 && (
          <div className="row-between" style={{ marginBottom: 14, padding: "10px 14px", background: "#fdf2f8", border: "1px solid #fbcfe8", borderRadius: 12, flexWrap: "wrap", gap: 10 }}>
            <span style={{ fontWeight: 800, color: "#9d174d" }}>{selected.size} selected</span>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="btn" disabled={bulkBusy} onClick={() => void openBulkAssign()}>Assign…</button>
              <button className="btn" disabled={bulkBusy} onClick={bulkRemind}>🔔 Remind not-completed</button>
              {/* Assigning and reminding are per-course and belong to the mirror.
                  Publish state and archiving come from Traditional, so they're
                  offered there only. */}
              {!isSimp && tab !== "archived" && (
                <button className="btn" disabled={bulkBusy} onClick={bulkPublish}>Publish</button>
              )}
              {!isSimp && tab !== "archived" && (
                <button className="btn" disabled={bulkBusy} onClick={bulkUnpublish}>Unpublish</button>
              )}
              {!isSimp && (tab === "archived"
                ? <button className="btn" disabled={bulkBusy} onClick={() => bulkSetStatus("draft")}>Restore</button>
                : <button className="btn" disabled={bulkBusy} onClick={() => bulkSetStatus("archived")}>Archive</button>)}
              <button className="btn" disabled={bulkBusy} onClick={clearSelection}>Clear</button>
            </div>
          </div>
        )}

        {/* Only the very first load blanks the list. Every mutation re-runs
            reload(), and swapping the rows for a placeholder collapsed the page
            to nothing — the browser then clamped the scroll to 0, so adding or
            deleting anything threw you back to the top. Keeping the previous
            rows on screen while the refetch runs holds your place. */}
        {loading && courses.length === 0 ? (
          <div className="subtle">Loading…</div>
        ) : grouped.length === 0 ? (
          <div className="subtle" style={{ padding: 20, textAlign: "center" }}>
            {tab === "archived"
              ? "No archived courses."
              : isSimp
                ? "Nothing here yet. Simplified copies are created from the Traditional courses — press “Resync all from Traditional”."
                : "No courses or segments yet. Add a segment or a course to start."}
          </div>
        ) : (
          grouped.map((g, i) => (
            <div key={g.segment?.id ?? i} style={{ marginBottom: 22 }}>
              <div className="row-between" style={{ marginBottom: 8 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span style={{ width: 12, height: 12, borderRadius: 999, background: g.segment?.color ?? "#9ca3af", display: "inline-block" }} />
                  <span style={{ fontWeight: 800, color: g.segment?.color ?? "#6b7280" }}>{g.segment?.name ?? "Uncategorized"}</span>
                </div>
                {g.segment && !isSimp && (() => {
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
                          <button onClick={() => openCourse(c.id)}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "#111827", fontWeight: 700, padding: 0, textAlign: "left" }}>
                            {c.title}
                          </button>
                          {isSimp && !c.synced && (
                            <span
                              title="Edited by hand — it no longer follows the Traditional version"
                              style={{ marginLeft: 8, fontSize: 11, fontWeight: 800, color: "#9a3412", background: "#ffedd5", padding: "2px 8px", borderRadius: 999 }}
                            >
                              🔓 Unlocked
                            </span>
                          )}
                        </td>
                        <td style={td}><StatusBadge status={c.status} /></td>
                        <td style={td}>{c.assignedCount}</td>
                        <td style={td}>{new Date(c.created_at).toLocaleDateString()}</td>
                        <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                          {isSimp ? (
                            /* A mirror follows its source for everything structural.
                               Order, publish state, segment and existence all come
                               from Traditional — offering them here would let the
                               two drift and silently undo the order set over there.
                               Unlocking opens up content editing, and nothing else. */
                            <>
                              <button className="btn" style={miniBtn} disabled title="Set in the Traditional view">↑</button>
                              <button className="btn" style={miniBtn} disabled title="Set in the Traditional view">↓</button>
                              <button
                                className="btn"
                                style={miniBtn}
                                onClick={() => openCourse(c.id)}
                                disabled={c.synced}
                                title={c.synced ? "Locked to the Traditional version — unlock to edit" : "Edit this Simplified copy"}
                              >
                                Edit
                              </button>
                              <button className="btn" style={miniBtn} disabled title="Move it in the Traditional view">Move</button>
                              <button className="btn" style={miniBtn} disabled title="Publish it in the Traditional view">
                                {c.status === "published" ? "Unpublish" : "Publish"}
                              </button>
                              <button className="btn" style={miniBtn} disabled title="Archive it in the Traditional view">Archive</button>
                              <button
                                className="btn"
                                style={miniBtn}
                                disabled={!!pdf}
                                title="Download this course as a PDF"
                                onClick={() => void runPdf(() => exportCoursePdf(c.id, onPdfProgress))}
                              >
                                📕 PDF
                              </button>
                              <button
                                className="btn"
                                style={{ ...miniBtn, color: c.synced ? "#6b7280" : "#9d174d", fontWeight: 700 }}
                                onClick={() => toggleLock(c)}
                                title={c.synced ? "Stop following the Traditional version so this can be edited" : "Discard the edits and rebuild from Traditional"}
                              >
                                {c.synced ? "🔒 Unlock" : "🔓 Relock"}
                              </button>
                            </>
                          ) : (
                            <>
                              <button className="btn" onClick={() => reorderCourse(g.items, ci, -1)} disabled={ci === 0} style={miniBtn}>↑</button>
                              <button className="btn" onClick={() => reorderCourse(g.items, ci, 1)} disabled={ci === g.items.length - 1} style={miniBtn}>↓</button>
                              <button className="btn" onClick={() => openCourse(c.id)} style={miniBtn}>Edit</button>
                              <button className="btn" onClick={() => setMoveCourse({ course: c, segmentId: c.segment_id ?? "" })} style={miniBtn}>Move</button>
                              <button
                                className="btn"
                                style={miniBtn}
                                disabled={!!pdf}
                                title="Download this course as a PDF"
                                onClick={() => void runPdf(() => exportCoursePdf(c.id, onPdfProgress))}
                              >
                                📕 PDF
                              </button>
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
                            </>
                          )}
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

      {/* A handbook can run to hundreds of pages and fetch every image and
          video frame, so the export says what it's doing rather than looking
          frozen. Deliberately not dismissable — closing it wouldn't stop the
          work, and the file arrives on its own. */}
      {pdf && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 400,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
        }}>
          <div className="card" style={{ width: "min(440px, 96vw)" }}>
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 6 }}>Building PDF…</div>
            <div className="subtle" style={{ fontSize: 13, marginBottom: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {pdf.label}
            </div>
            <div style={{ height: 8, borderRadius: 999, background: "#f3f4f6", overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: `${Math.min(100, Math.round((pdf.done / Math.max(1, pdf.total)) * 100))}%`,
                background: "#e6178d",
                transition: "width 0.2s",
              }} />
            </div>
            <div className="subtle" style={{ fontSize: 12, marginTop: 8 }}>
              {pdf.total > 1 ? `${pdf.done} of ${pdf.total} course(s)` : "Working…"}
            </div>
          </div>
        </div>
      )}

      {bulkAssignOpen && (
        <AssignPeopleModal
          title={`Assign ${selected.size} course(s)`}
          // Spell out which script these are: a Traditional course and its
          // Simplified copy are separate courses with separate assignments, so
          // assigning one does not cover the other.
          subtitle={
            `${isSimp ? "简 Simplified" : "繁 Traditional"} — assigning these does not assign the ` +
            `${isSimp ? "Traditional" : "Simplified"} versions.`
          }
          alreadyAssigned={new Set(
            Array.from(assignedCount.entries())
              .filter(([, n]) => n >= selected.size)
              .map(([id]) => id)
          )}
          assignedCount={assignedCount}
          courseCount={selected.size}
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
