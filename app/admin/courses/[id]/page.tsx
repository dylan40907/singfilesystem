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
  const [editor, setEditor] = useState<{ draft: ObjectDraft; sectionId: string; objectId?: string } | null>(null);
  // type picker popover (sectionId currently adding to)
  const [pickerSection, setPickerSection] = useState<string | null>(null);

  useEffect(() => { (async () => { const p = await fetchMyProfile(); setAuthzd(!!p?.is_active && p.role === "admin"); })(); }, []);

  const reload = useCallback(async () => {
    const f = await fetchCourseFull(courseId);
    setFull(f);
    if (f) setTitleDraft(f.course.title);
  }, [courseId]);

  useEffect(() => { if (authzd) reload(); }, [authzd, reload]);

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
    await reload();
  }

  async function addSection() {
    const pos = full?.sections.length ?? 0;
    await createSection(courseId, "New section", pos);
    await reload();
  }
  async function renameSectionPrompt(s: CourseSection) {
    const name = prompt("Section title", s.title);
    if (name == null) return;
    await updateSection(s.id, { title: name });
    await reload();
  }
  async function removeSection(s: CourseSection) {
    const ok = await confirm(`Delete section "${s.title}" and all its objects?`, { title: "Delete section", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    await deleteSection(s.id);
    await reload();
  }

  function openNewObject(sectionId: string, type: ObjectType) {
    setPickerSection(null);
    setEditor({ sectionId, draft: { type, title: "", content: {}, settings: {} } });
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
    await reload();
  }
  async function removeObject(o: CourseObject) {
    const ok = await confirm("Delete this object?", { title: "Delete", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    await deleteObject(o.id);
    await reload();
  }
  async function moveObject(o: CourseObject, dir: -1 | 1) {
    const list = objectsBySection.get(o.section_id) ?? [];
    const idx = list.findIndex((x) => x.id === o.id);
    const swap = list[idx + dir];
    if (!swap) return;
    await Promise.all([updateObject(o.id, { position: swap.position }), updateObject(swap.id, { position: o.position })]);
    await reload();
  }

  async function changeStatus(next: CourseStatus) {
    await setCourseStatus(courseId, next);
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
          {course.status !== "published" ? (
            <button className="btn btn-primary" onClick={() => changeStatus("published")}>Publish</button>
          ) : (
            <button className="btn" onClick={() => changeStatus("draft")}>Unpublish</button>
          )}
        </div>
      </div>

      <input
        className="input"
        value={titleDraft}
        onChange={(e) => setTitleDraft(e.target.value)}
        onBlur={saveTitle}
        style={{ fontSize: 22, fontWeight: 900, border: "none", padding: "6px 0", background: "transparent" }}
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
          {sections.length === 0 && <div className="subtle" style={{ padding: 12 }}>No sections yet. Add one to start building.</div>}

          {sections.sort((a, b) => a.position - b.position).map((s) => {
            const objs = objectsBySection.get(s.id) ?? [];
            return (
              <div key={s.id} style={{ marginBottom: 18, border: "1px solid #e5e7eb", borderRadius: 12, padding: 14 }}>
                <div className="row-between" style={{ marginBottom: 10 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span style={{ fontSize: 18 }}>📖</span>
                    <span style={{ fontWeight: 800, fontSize: 15 }}>{s.title || "Untitled section"}</span>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn" onClick={() => renameSectionPrompt(s)} style={mini}>Rename</button>
                    <button className="btn" onClick={() => removeSection(s)} style={{ ...mini, color: "#991b1b" }}>Delete</button>
                  </div>
                </div>

                {objs.map((o, i) => (
                  <div key={o.id} className="row-between" style={{ padding: "8px 10px", border: "1px solid #f1f5f9", borderRadius: 8, marginBottom: 6 }}>
                    <div className="row" style={{ gap: 10, minWidth: 0 }}>
                      <span style={{ color: "#6b7280", width: 18 }}>{i + 1}</span>
                      <span style={{ fontSize: 18 }}>{objIcon(o.type)}</span>
                      <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.title}</span>
                    </div>
                    <div className="row" style={{ gap: 4 }}>
                      <button className="btn" onClick={() => moveObject(o, -1)} disabled={i === 0} style={icoBtn}>↑</button>
                      <button className="btn" onClick={() => moveObject(o, 1)} disabled={i === objs.length - 1} style={icoBtn}>↓</button>
                      <button className="btn" onClick={() => openEditObject(o)} style={icoBtn}>✏️</button>
                      <button className="btn" onClick={() => removeObject(o)} style={icoBtn}>🗑</button>
                    </div>
                  </div>
                ))}

                <div style={{ position: "relative" }}>
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

          <button className="btn btn-primary" onClick={addSection}>+ Add section</button>
        </div>
      )}

      {editor && <ObjectEditorModal draft={editor.draft} onCancel={() => setEditor(null)} onSave={saveObject} />}
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
