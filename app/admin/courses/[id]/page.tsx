"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { fetchMyProfile } from "@/lib/teachers";
import { useDialog } from "@/components/ui/useDialog";
import {
  CourseObject, CourseSection, CourseStatus, FullCourse, ObjectType,
  createObject, createSection, deleteObject, deleteSection, fetchCourseFull,
  setCourseStatus, updateCourse, updateObject, updateSection,
} from "@/lib/courses";
import ObjectEditorModal, { ObjectDraft } from "@/components/courses/ObjectEditorModal";
import CoursePeoplePanel from "@/components/courses/CoursePeoplePanel";
import { mirrorInBackground, relockMirror, unlockMirror } from "@/lib/courseMirror";

const OBJECT_TYPES: { type: ObjectType; label: string; icon: string }[] = [
  { type: "text", label: "Text", icon: "📝" },
  { type: "image", label: "Image", icon: "🖼" },
  { type: "video", label: "Video", icon: "🎬" },
  { type: "pdf", label: "PDF", icon: "📕" },
  { type: "youtube", label: "YouTube", icon: "▶️" },
  { type: "quiz", label: "Quiz", icon: "✅" },
  { type: "file", label: "File", icon: "📎" },
  { type: "link", label: "Link", icon: "🔗" },
  { type: "audio", label: "Audio", icon: "🎵" },
];

const objIcon = (t: ObjectType) => OBJECT_TYPES.find((o) => o.type === t)?.icon ?? "•";
const objTypeLabel = (t: ObjectType) => OBJECT_TYPES.find((o) => o.type === t)?.label ?? "object";

export default function CourseBuilderPage() {
  const params = useParams();
  const courseId = String(params.id);
  const router = useRouter();
  const { confirm, modal: dialogModal } = useDialog();

  const [authzd, setAuthzd] = useState<boolean | null>(null);
  const [full, setFull] = useState<FullCourse | null>(null);
  const [tab, setTab] = useState<"content" | "people">("content");
  const [status, setStatus] = useState("");
  const [titleDraft, setTitleDraft] = useState("");

  // object editor state
  const [editor, setEditor] = useState<{ draft: ObjectDraft; sectionId: string; objectId?: string; isNew?: boolean } | null>(null);
  // type picker popover (sectionId currently adding to)
  const [pickerSection, setPickerSection] = useState<string | null>(null);
  // section create/rename modal (no browser prompts)
  const [sectionModal, setSectionModal] = useState<{ mode: "create" | "rename"; id?: string; value: string } | null>(null);

  useEffect(() => { (async () => { const p = await fetchMyProfile(); setAuthzd(!!p?.is_active && (p.role === "admin" || p.role === "campus_admin")); })(); }, []);

  const reload = useCallback(async () => {
    const f = await fetchCourseFull(courseId);
    setFull(f);
    if (f) setTitleDraft(f.course.title);
  }, [courseId]);

  useEffect(() => { if (authzd) reload(); }, [authzd, reload]);

  // A Simplified mirror is read-only while it's locked to its Traditional
  // source — otherwise an edit here would be silently overwritten by the next
  // change made over there.
  const isMirror = full?.course.script === "simp";
  const readOnly = !!isMirror && !!full?.course.synced;

  /** Push this course's edits into its Simplified copy. No-op on a mirror. */
  const mirror = useCallback(() => {
    if (isMirror) return;
    mirrorInBackground(courseId, setStatus);
  }, [courseId, isMirror]);

  async function unlockThis() {
    try {
      await unlockMirror(courseId);
      await reload();
      setStatus("🔓 Unlocked — this copy no longer follows the Traditional version.");
    } catch (e) { setStatus("Could not unlock: " + ((e as Error)?.message ?? "unknown")); }
  }

  async function relockThis() {
    const ok = await confirm(
      "Relock this course and resync it with the Traditional version?\n\n" +
      "Every change made to this Simplified copy while it was unlocked will be lost. " +
      "It will be rebuilt as a converted copy of the Traditional course as it stands right now.",
      { title: "Relock & resync", confirmLabel: "Relock & resync", danger: true }
    );
    if (!ok) return;
    try {
      await relockMirror(courseId);
      await reload();
      setStatus("🔒 Relocked and resynced with the Traditional version.");
    } catch (e) { setStatus("Could not relock: " + ((e as Error)?.message ?? "unknown")); }
  }

  const objectsBySection = useMemo(() => {
    const map = new Map<string, CourseObject[]>();
    (full?.objects ?? []).forEach((o) => {
      const arr = map.get(o.section_id) ?? [];
      arr.push(o);
      map.set(o.section_id, arr);
    });
    for (const arr of map.values()) arr.sort((a, b) => a.position - b.position);
    return map;
  }, [full]);

  async function saveTitle() {
    if (!full || titleDraft.trim() === full.course.title) return;
    await updateCourse(courseId, { title: titleDraft.trim() || "Untitled course" });
    mirror();
    await reload();
  }

  function addSection() { setSectionModal({ mode: "create", value: "" }); }
  function renameSection(s: CourseSection) { setSectionModal({ mode: "rename", id: s.id, value: s.title }); }
  async function confirmSection() {
    if (!sectionModal) return;
    const name = sectionModal.value.trim();
    if (!name) return;
    if (sectionModal.mode === "create") {
      await createSection(courseId, name, full?.sections.length ?? 0);
    } else if (sectionModal.id) {
      await updateSection(sectionModal.id, { title: name });
    }
    setSectionModal(null);
    mirror();
    await reload();
  }
  // Reorders update local state immediately (no reload) and persist a clean
  // 0..n sequence in the background. The render sorts by position, so updating
  // the position fields is enough to reflect the new order instantly.
  function moveSection(s: CourseSection, dir: -1 | 1) {
    const sorted = [...(full?.sections ?? [])].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((x) => x.id === s.id);
    const swapIdx = idx + dir;
    if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) return;
    [sorted[idx], sorted[swapIdx]] = [sorted[swapIdx], sorted[idx]];
    const posById = new Map(sorted.map((x, i) => [x.id, i]));
    setFull((f) => (f ? { ...f, sections: f.sections.map((x) => ({ ...x, position: posById.get(x.id) ?? x.position })) } : f));
    Promise.all(
      (full?.sections ?? [])
        .filter((x) => posById.get(x.id) !== x.position)
        .map((x) => updateSection(x.id, { position: posById.get(x.id)! }))
    ).then(mirror).catch(() => setStatus("Reorder failed to save."));
  }
  async function removeSection(s: CourseSection) {
    const ok = await confirm(`Delete section "${s.title}" and all its objects?`, { title: "Delete section", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    await deleteSection(s.id);
    mirror();
    await reload();
  }

  // Picking a type creates the (empty) object immediately, so the editor is
  // always editing something real. That gives autosaved work a durable home:
  // dismiss the modal by accident and the placeholder is still in the list —
  // hit ✏️ to pick the draft back up.
  async function openNewObject(sectionId: string, type: ObjectType) {
    setPickerSection(null);
    const pos = objectsBySection.get(sectionId)?.length ?? 0;
    let created: CourseObject;
    try {
      created = await createObject({ courseId, sectionId, type, title: "", content: {}, settings: {}, position: pos });
    } catch (e: any) {
      setStatus("Could not add object: " + (e?.message ?? "unknown"));
      return;
    }
    mirror();
    await reload();
    setEditor({
      sectionId,
      objectId: created.id,
      isNew: true,
      draft: { type: created.type, title: created.title, content: created.content, settings: created.settings },
    });
  }

  /** Cancel on a just-created object removes the placeholder it left behind. */
  async function discardEditor() {
    const e = editor;
    setEditor(null);
    if (e?.isNew && e.objectId) {
      await deleteObject(e.objectId);
      mirror();
      await reload();
    }
  }
  function openEditObject(o: CourseObject) {
    setEditor({ sectionId: o.section_id, objectId: o.id, draft: { type: o.type, title: o.title, content: o.content, settings: o.settings } });
  }
  async function saveObject(d: ObjectDraft) {
    if (!editor) return;
    if (editor.objectId) {
      await updateObject(editor.objectId, { title: d.title, content: d.content, settings: d.settings });
    } else {
      const pos = objectsBySection.get(editor.sectionId)?.length ?? 0;
      await createObject({ courseId, sectionId: editor.sectionId, type: d.type, title: d.title, content: d.content, settings: d.settings, position: pos });
    }
    setEditor(null);
    mirror();
    await reload();
  }
  async function removeObject(o: CourseObject) {
    const ok = await confirm("Delete this object?", { title: "Delete", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    await deleteObject(o.id);
    mirror();
    await reload();
  }
  function moveObject(o: CourseObject, dir: -1 | 1) {
    const list = objectsBySection.get(o.section_id) ?? [];
    const idx = list.findIndex((x) => x.id === o.id);
    const swapIdx = idx + dir;
    if (idx === -1 || swapIdx < 0 || swapIdx >= list.length) return;
    const arr = [...list];
    [arr[idx], arr[swapIdx]] = [arr[swapIdx], arr[idx]];
    const posById = new Map(arr.map((x, i) => [x.id, i]));
    setFull((f) => (f ? { ...f, objects: f.objects.map((x) => (posById.has(x.id) ? { ...x, position: posById.get(x.id)! } : x)) } : f));
    Promise.all(
      list
        .filter((x) => posById.get(x.id) !== x.position)
        .map((x) => updateObject(x.id, { position: posById.get(x.id)! }))
    ).then(mirror).catch(() => setStatus("Reorder failed to save."));
  }

  async function changeStatus(next: CourseStatus) {
    await setCourseStatus(courseId, next);
    mirror();
    await reload();
    setStatus(next === "published" ? "✅ Published — assignees can now take it." : "Moved to draft.");
  }

  if (authzd === null) return <main className="stack"><div className="subtle">Loading…</div></main>;
  if (!authzd) return <main className="stack"><div className="card">Admin access required.</div></main>;
  if (!full) return <main className="stack"><div className="subtle">Loading course…</div></main>;

  const { course, sections } = full;

  return (
    <main className="stack">
      {dialogModal}
      <div className="row-between" style={{ flexWrap: "wrap", gap: 10 }}>
        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          <Link href="/admin/courses" className="btn" style={{ padding: "4px 10px" }}>← Courses</Link>
          <StatusBadge status={course.status} />
        </div>
        <div className="row" style={{ gap: 8 }}>
          {isMirror ? (
            /* Publish state belongs to the Traditional course — this copy
               follows it, so offering it here would let the two disagree. */
            course.synced
              ? <button className="btn" onClick={unlockThis}>🔒 Unlock to edit</button>
              : <button className="btn" onClick={relockThis} style={{ color: "#9d174d", fontWeight: 800 }}>🔓 Relock &amp; resync</button>
          ) : course.status !== "published" ? (
            <button className="btn btn-primary" onClick={() => changeStatus("published")}>Publish</button>
          ) : (
            <button className="btn" onClick={() => changeStatus("draft")}>Unpublish</button>
          )}
        </div>
      </div>

      {isMirror && (
        <div
          style={{
            padding: "10px 14px", borderRadius: 12, fontSize: 13, fontWeight: 600,
            background: readOnly ? "#eff6ff" : "#fff7ed",
            border: `1px solid ${readOnly ? "#bfdbfe" : "#fed7aa"}`,
            color: readOnly ? "#1e40af" : "#9a3412",
          }}
        >
          {readOnly
            ? "简 Simplified copy — locked to the Traditional version. It updates automatically whenever the Traditional course changes. Unlock it to edit by hand."
            : "简 Simplified copy — unlocked. Your edits stay, and this course no longer follows the Traditional version. Relocking rebuilds it and discards them."}
        </div>
      )}

      <input
        className="input"
        value={titleDraft}
        onChange={(e) => setTitleDraft(e.target.value)}
        onBlur={saveTitle}
        readOnly={readOnly}
        style={{ fontSize: 22, fontWeight: 900, border: "none", padding: "6px 0", background: "transparent", color: readOnly ? "#4b5563" : undefined }}
        placeholder="Course title"
      />

      <div className="row" style={{ gap: 6 }}>
        <button className={`btn${tab === "content" ? " btn-primary" : ""}`} onClick={() => setTab("content")}>Content</button>
        <button className={`btn${tab === "people" ? " btn-primary" : ""}`} onClick={() => setTab("people")}>People &amp; completion</button>
        {status && <span className="badge badge-pink" style={{ marginLeft: 8 }}>{status}</span>}
      </div>

      {tab === "people" ? (
        <div className="card"><CoursePeoplePanel courseId={courseId} /></div>
      ) : (
        <div className="card">
          {sections.length === 0 && (
            <div className="subtle" style={{ padding: 12 }}>
              {readOnly
                ? "Nothing here yet — this copy fills in as soon as the Traditional course has content."
                : "No sections yet. Add one to start building."}
            </div>
          )}

          {sections.sort((a, b) => a.position - b.position).map((s, si, arr) => {
            const objs = objectsBySection.get(s.id) ?? [];
            return (
              <div key={s.id} style={{ marginBottom: 18, border: "1px solid #e5e7eb", borderRadius: 12, padding: 14 }}>
                <div className="row-between" style={{ marginBottom: 10, gap: 8, alignItems: "flex-start" }}>
                  <div className="row" style={{ gap: 8, minWidth: 0, flex: 1, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 18, flexShrink: 0 }}>📖</span>
                    <span style={{ fontWeight: 800, fontSize: 15, overflowWrap: "anywhere", wordBreak: "break-word" }}>{s.title || "Untitled section"}</span>
                  </div>
                  {!readOnly && (
                    <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                      <button className="btn" onClick={() => moveSection(s, -1)} disabled={si === 0} style={icoBtn}>↑</button>
                      <button className="btn" onClick={() => moveSection(s, 1)} disabled={si === arr.length - 1} style={icoBtn}>↓</button>
                      <button className="btn" onClick={() => renameSection(s)} style={mini}>Rename</button>
                      <button className="btn" onClick={() => removeSection(s)} style={{ ...mini, color: "#991b1b" }}>Delete</button>
                    </div>
                  )}
                </div>

                {objs.map((o, i) => (
                  <div key={o.id} className="row-between" style={{ padding: "8px 10px", border: "1px solid #f1f5f9", borderRadius: 8, marginBottom: 6, gap: 8, alignItems: "flex-start" }}>
                    <div className="row" style={{ gap: 10, minWidth: 0, flex: 1, alignItems: "flex-start" }}>
                      <span style={{ color: "#6b7280", width: 18, flexShrink: 0 }}>{i + 1}</span>
                      <span style={{ fontSize: 18, flexShrink: 0 }}>{objIcon(o.type)}</span>
                      <span style={{ fontWeight: 600, overflowWrap: "anywhere", wordBreak: "break-word", color: o.title?.trim() ? undefined : "#9ca3af", fontStyle: o.title?.trim() ? undefined : "italic" }}>
                        {o.title?.trim() || `Untitled ${objTypeLabel(o.type).toLowerCase()}`}
                      </span>
                    </div>
                    {!readOnly && (
                      <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                        <button className="btn" onClick={() => moveObject(o, -1)} disabled={i === 0} style={icoBtn}>↑</button>
                        <button className="btn" onClick={() => moveObject(o, 1)} disabled={i === objs.length - 1} style={icoBtn}>↓</button>
                        <button className="btn" onClick={() => openEditObject(o)} style={icoBtn}>✏️</button>
                        <button className="btn" onClick={() => removeObject(o)} style={icoBtn}>🗑</button>
                      </div>
                    )}
                  </div>
                ))}

                <div style={{ position: "relative", display: readOnly ? "none" : undefined }}>
                  <button className="btn" style={{ width: "100%", marginTop: 6, color: "#2563eb", fontWeight: 700 }} onClick={() => setPickerSection(pickerSection === s.id ? null : s.id)}>
                    + Add object
                  </button>
                  {pickerSection === s.id && (
                    <>
                      <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setPickerSection(null)} />
                      <div className="card" style={{ position: "absolute", left: 0, right: 0, top: "calc(100% + 6px)", zIndex: 50, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                        {OBJECT_TYPES.map((t) => (
                          <button key={t.type} className="btn" onClick={() => openNewObject(s.id, t.type)} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "12px 4px" }}>
                            <span style={{ fontSize: 22 }}>{t.icon}</span>
                            <span style={{ fontSize: 12 }}>{t.label}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}

          {!readOnly && <button className="btn btn-primary" onClick={addSection}>+ Add section</button>}
        </div>
      )}

      {editor && (
        <ObjectEditorModal
          draft={editor.draft}
          // Keyed to the real row, so autosaved work is reachable again via
          // the object's edit button.
          draftKey={editor.objectId ? `course-object:${editor.objectId}` : undefined}
          onCancel={() => setEditor(null)}
          onDiscard={discardEditor}
          onSave={saveObject}
        />
      )}

      {sectionModal && (
        <div onMouseDown={(e) => { if (e.currentTarget === e.target) setSectionModal(null); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div className="card" style={{ width: "100%", maxWidth: 420 }}>
            <div style={{ fontWeight: 900, fontSize: 17, marginBottom: 10 }}>{sectionModal.mode === "create" ? "New section" : "Rename section"}</div>
            <input className="input" autoFocus value={sectionModal.value}
              onChange={(e) => setSectionModal((m) => (m ? { ...m, value: e.target.value } : m))}
              onKeyDown={(e) => { if (e.key === "Enter") confirmSection(); }}
              placeholder="Section title" />
            <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button className="btn" onClick={() => setSectionModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmSection} disabled={!sectionModal.value.trim()}>
                {sectionModal.mode === "create" ? "Create" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: CourseStatus }) {
  const map: Record<CourseStatus, { bg: string; fg: string; label: string }> = {
    draft: { bg: "#f3f4f6", fg: "#6b7280", label: "Draft" },
    published: { bg: "#dcfce7", fg: "#166534", label: "Published" },
    archived: { bg: "#fee2e2", fg: "#991b1b", label: "Archived" },
  };
  const s = map[status];
  return <span style={{ background: s.bg, color: s.fg, fontWeight: 700, fontSize: 12, padding: "3px 10px", borderRadius: 999 }}>{s.label}</span>;
}

const mini: React.CSSProperties = { padding: "4px 10px", fontSize: 12 };
const icoBtn: React.CSSProperties = { padding: "2px 8px", fontSize: 13 };
