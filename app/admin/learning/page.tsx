"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { useDialog } from "@/components/ui/useDialog";

const PINK = "#e6178d";

type Category = { id: string; name: string; order_index: number };
type Lesson = {
  id: string;
  category_id: string | null;
  title: string;
  title_zh_traditional: string | null;
  title_zh_simplified: string | null;
  thumbnail_url: string | null;
  is_published: boolean;
  is_locked: boolean;
  order_index: number;
};

async function getAuthHeader() {
  const { data } = await supabase.auth.getSession();
  return `Bearer ${data.session?.access_token ?? ""}`;
}

async function deleteFromR2(objectKey: string) {
  const auth = await getAuthHeader();
  await fetch("/api/r2/learning-delete", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ objectKey }),
  });
}

export default function LearningAdminPage() {
  const { confirm, modal } = useDialog();
  const [categories, setCategories] = useState<Category[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [newCatName, setNewCatName] = useState("");
  const [addingCat, setAddingCat] = useState(false);
  const [error, setError] = useState("");

  // New lesson form state
  const [newLessonTitle, setNewLessonTitle] = useState("");
  const [newLessonCat, setNewLessonCat] = useState<string>("");
  const [addingLesson, setAddingLesson] = useState(false);
  const [addLevelOpen, setAddLevelOpen] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const [{ data: cats }, { data: lsns }] = await Promise.all([
      supabase.from("learning_categories").select("*").order("order_index"),
      supabase.from("learning_lessons").select("id, category_id, title, title_zh_traditional, title_zh_simplified, thumbnail_url, is_published, is_locked, order_index").order("order_index"),
    ]);
    setCategories(cats ?? []);
    setLessons(lsns ?? []);
    setLoading(false);
  }

  async function addCategory() {
    if (!newCatName.trim()) return;
    setAddingCat(true);
    setError("");
    const maxOrder = categories.reduce((m, c) => Math.max(m, c.order_index), -1);
    const { error: e } = await supabase
      .from("learning_categories")
      .insert({ name: newCatName.trim(), order_index: maxOrder + 1 });
    if (e) { setError(e.message); } else { setNewCatName(""); await load(); }
    setAddingCat(false);
  }

  async function deleteCategory(id: string) {
    const cat = categories.find(c => c.id === id);
    const lessonCount = lessons.filter(l => l.category_id === id).length;
    const ok = await confirm(
      `Song topics in this level will become unleveled${lessonCount > 0 ? ` (${lessonCount} affected)` : ""}. The song topics themselves will not be deleted.`,
      { title: `Delete level "${cat?.name ?? ""}"?`, confirmLabel: "Delete", danger: true },
    );
    if (!ok) return;
    await supabase.from("learning_categories").delete().eq("id", id);
    await load();
  }

  async function addLesson() {
    if (!newLessonTitle.trim()) return;
    setAddingLesson(true);
    setError("");
    const maxOrder = lessons.filter(l => l.category_id === (newLessonCat || null)).reduce((m, l) => Math.max(m, l.order_index), -1);
    const { error: e } = await supabase.from("learning_lessons").insert({
      title: newLessonTitle.trim(),
      category_id: newLessonCat || null,
      order_index: maxOrder + 1,
    });
    if (e) { setError(e.message); } else { setNewLessonTitle(""); await load(); }
    setAddingLesson(false);
  }

  async function togglePublished(lesson: Lesson) {
    await supabase.from("learning_lessons").update({ is_published: !lesson.is_published }).eq("id", lesson.id);
    setLessons(prev => prev.map(l => l.id === lesson.id ? { ...l, is_published: !l.is_published } : l));
  }

  async function deleteLesson(id: string) {
    const lesson = lessons.find(l => l.id === id);
    if (!lesson) return;

    // Gather all R2 keys for this lesson: lesson-level media + every slide's media
    const [{ data: fullLesson }, { data: lessonSlides }] = await Promise.all([
      supabase.from("learning_lessons")
        .select("thumbnail_key, video_key, karaoke_key, video_key_simplified, karaoke_key_simplified")
        .eq("id", id).single(),
      supabase.from("learning_slides")
        .select("image_key, audio_key, image_key_simplified, audio_key_simplified")
        .eq("lesson_id", id),
    ]);

    const lessonKeys = [
      fullLesson?.thumbnail_key,
      fullLesson?.video_key,
      fullLesson?.karaoke_key,
      fullLesson?.video_key_simplified,
      fullLesson?.karaoke_key_simplified,
    ].filter(Boolean) as string[];

    const slideKeys = (lessonSlides ?? []).flatMap((s: any) => [
      s.image_key, s.audio_key, s.image_key_simplified, s.audio_key_simplified,
    ]).filter(Boolean) as string[];

    const slideCount = lessonSlides?.length ?? 0;
    const totalFiles = lessonKeys.length + slideKeys.length;

    const ok = await confirm(
      `This will permanently delete:\n` +
      `• The song topic "${lesson.title}"\n` +
      `• All ${slideCount} flashcard${slideCount === 1 ? "" : "s"}\n` +
      `• All ${totalFiles} associated file${totalFiles === 1 ? "" : "s"} from R2 storage (thumbnail, videos, karaoke, flashcard images & audio — traditional and simplified)\n\n` +
      `This cannot be undone.`,
      { title: "Delete song topic?", confirmLabel: "Delete everything", danger: true },
    );
    if (!ok) return;

    // Delete DB rows first; slides cascade via FK (or we rely on the slides query result)
    await supabase.from("learning_lessons").delete().eq("id", id);

    // Best-effort R2 cleanup (don't block on failures)
    await Promise.all([...lessonKeys, ...slideKeys].map(k => deleteFromR2(k).catch(() => {})));

    setLessons(prev => prev.filter(l => l.id !== id));
  }

  const lessonsByCategory = (catId: string | null) =>
    lessons.filter(l => l.category_id === catId);

  // Reorders update local state immediately (no reload/scroll jump) and persist
  // by reassigning a clean 0..n sequence — robust even if order_index had ties.
  async function moveCategory(id: string, dir: -1 | 1) {
    const idx = categories.findIndex(c => c.id === id);
    if (idx === -1) return;
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= categories.length) return;
    const arr = [...categories];
    [arr[idx], arr[swapIdx]] = [arr[swapIdx], arr[idx]];
    const prev = categories;
    const reindexed = arr.map((c, i) => ({ ...c, order_index: i }));
    setCategories(reindexed);
    await Promise.all(
      reindexed
        .filter(c => prev.find(x => x.id === c.id)?.order_index !== c.order_index)
        .map(c => supabase.from("learning_categories").update({ order_index: c.order_index }).eq("id", c.id))
    );
  }

  async function moveLesson(lesson: Lesson, dir: -1 | 1) {
    const group = lessonsByCategory(lesson.category_id);
    const idx = group.findIndex(l => l.id === lesson.id);
    if (idx === -1) return;
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= group.length) return;
    const arr = [...group];
    [arr[idx], arr[swapIdx]] = [arr[swapIdx], arr[idx]];
    const reindexed = arr.map((l, i) => ({ ...l, order_index: i }));
    const prevGroup = group;
    // Place the reordered group back into the same slots of the full lessons array.
    setLessons(prevLessons => {
      const positions: number[] = [];
      prevLessons.forEach((l, i) => { if (l.category_id === lesson.category_id) positions.push(i); });
      const result = [...prevLessons];
      reindexed.forEach((l, k) => { result[positions[k]] = l; });
      return result;
    });
    await Promise.all(
      reindexed
        .filter(l => prevGroup.find(x => x.id === l.id)?.order_index !== l.order_index)
        .map(l => supabase.from("learning_lessons").update({ order_index: l.order_index }).eq("id", l.id))
    );
  }

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "32px 20px" }}>
      {modal}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 32 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>App Content</h1>
          <div className="subtle" style={{ marginTop: 4 }}>Manage levels, song topics, and flashcards</div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link href="/admin/learning/dictionary-categories" style={{ fontSize: 14, fontWeight: 600, color: PINK, textDecoration: "none", padding: "8px 16px", borderRadius: 10, border: `1.5px solid ${PINK}`, whiteSpace: "nowrap" }}>
            📚 Dictionary Categories
          </Link>
          <Link href="/admin/learning/users" style={{ fontSize: 14, fontWeight: 600, color: PINK, textDecoration: "none", padding: "8px 16px", borderRadius: 10, border: `1.5px solid ${PINK}`, whiteSpace: "nowrap" }}>
            👥 Users
          </Link>
          <Link href="/admin/learning/content" style={{ fontSize: 14, fontWeight: 600, color: "#6b7280", textDecoration: "none", padding: "8px 16px", borderRadius: 10, border: "1.5px solid #d1d5db", whiteSpace: "nowrap" }}>
            📄 Legal
          </Link>
        </div>
      </div>

      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", color: "#dc2626", marginBottom: 20, fontSize: 14 }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 24, alignItems: "start" }}>
        {/* ── LEFT: Levels sidebar ── */}
        <aside style={{ position: "sticky", top: 16, maxHeight: "calc(100vh - 32px)", overflowY: "auto", paddingRight: 4 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Levels</h2>
            <button
              onClick={() => setAddLevelOpen(o => !o)}
              style={{ fontSize: 13, fontWeight: 600, padding: "5px 12px", borderRadius: 8, border: `1.5px solid ${PINK}`, color: PINK, background: "#fff", cursor: "pointer" }}
            >
              {addLevelOpen ? "Cancel" : "+ Add Level"}
            </button>
          </div>

          {addLevelOpen && (
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              <input
                value={newCatName}
                onChange={e => setNewCatName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addCategory()}
                placeholder="New level name"
                autoFocus
                style={{ flex: 1, minWidth: 0, border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", fontSize: 14 }}
              />
              <button className="btn btn-primary" onClick={addCategory} disabled={addingCat || !newCatName.trim()} style={{ padding: "6px 12px", fontSize: 13 }}>
                {addingCat ? "…" : "Add"}
              </button>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {categories.map((cat, i) => (
              <div key={cat.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "#f9fafb", borderRadius: 10, padding: "8px 10px", border: "1px solid #e5e7eb" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  <button onClick={() => moveCategory(cat.id, -1)} disabled={i === 0} style={iconBtnStyle}>▲</button>
                  <button onClick={() => moveCategory(cat.id, 1)} disabled={i === categories.length - 1} style={iconBtnStyle}>▼</button>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{cat.name}</div>
                  <div className="subtle" style={{ fontSize: 12 }}>{lessonsByCategory(cat.id).length} song topic{lessonsByCategory(cat.id).length === 1 ? "" : "s"}</div>
                </div>
                <button
                  style={{ fontSize: 12, color: "#dc2626", background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}
                  onClick={() => deleteCategory(cat.id)}
                >
                  Delete
                </button>
              </div>
            ))}
            {categories.length === 0 && <div className="subtle" style={{ fontSize: 13 }}>No levels yet.</div>}
          </div>
        </aside>

        {/* ── RIGHT: Song topics ── */}
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 14 }}>Song Topics</h2>

          {/* Add song topic (kept at the top) */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 24, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <input
              value={newLessonTitle}
              onChange={e => setNewLessonTitle(e.target.value)}
              onKeyDown={e => e.key === "Enter" && newLessonTitle.trim() && addLesson()}
              placeholder="New song topic title"
              style={{ flex: 1, minWidth: 180, border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 12px", fontSize: 14 }}
            />
            <select
              value={newLessonCat}
              onChange={e => setNewLessonCat(e.target.value)}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 12px", fontSize: 14, background: "#fff" }}
            >
              <option value="">No level</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="btn btn-primary" onClick={addLesson} disabled={addingLesson || !newLessonTitle.trim()}>
              {addingLesson ? "Adding…" : "+ Add Song Topic"}
            </button>
          </div>

          {[...categories.map(c => ({ id: c.id, name: c.name })), { id: "__none__", name: "Unleveled" }].map(section => {
            const sectionLessons = lessonsByCategory(section.id === "__none__" ? null : section.id);
            if (section.id === "__none__" && sectionLessons.length === 0) return null;
            return (
              <section key={section.id} style={{ marginBottom: 26 }}>
                <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ background: PINK, color: "#fff", borderRadius: 20, padding: "3px 14px", fontSize: 13 }}>{section.name}</span>
                </h3>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {sectionLessons.map((lesson, li) => (
                    <div key={lesson.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "#fff", borderRadius: 10, padding: "10px 14px", border: "1px solid #e5e7eb", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
                      {/* Reorder within level */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                        <button onClick={() => moveLesson(lesson, -1)} disabled={li === 0} style={iconBtnStyle}>▲</button>
                        <button onClick={() => moveLesson(lesson, 1)} disabled={li === sectionLessons.length - 1} style={iconBtnStyle}>▼</button>
                      </div>

                      {/* Thumbnail */}
                      {lesson.thumbnail_url ? (
                        <img src={lesson.thumbnail_url} alt="" style={{ width: 48, height: 48, borderRadius: 6, objectFit: "cover", flexShrink: 0, border: "1px solid #e5e7eb" }} />
                      ) : (
                        <div style={{ width: 48, height: 48, borderRadius: 6, background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid #e5e7eb" }}>
                          <span style={{ fontSize: 20 }}>🖼</span>
                        </div>
                      )}

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{lesson.title}</div>
                        {(lesson.title_zh_traditional || lesson.title_zh_simplified) && (
                          <div className="subtle" style={{ fontSize: 12 }}>
                            {[lesson.title_zh_traditional, lesson.title_zh_simplified].filter(Boolean).join(" / ")}
                          </div>
                        )}
                      </div>

                      {/* Status pill (label only) */}
                      <span
                        style={{
                          fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 20,
                          background: lesson.is_published ? "#dcfce7" : "#f3f4f6",
                          color: lesson.is_published ? "#16a34a" : "#6b7280",
                        }}
                      >
                        {lesson.is_published ? "● Published" : "○ Draft"}
                      </span>

                      {/* Publish/unpublish action button (verb makes the action obvious) */}
                      <button
                        onClick={() => togglePublished(lesson)}
                        title={lesson.is_published ? "Hide from the app" : "Make visible in the app"}
                        style={{
                          fontSize: 12, fontWeight: 700, padding: "6px 12px", borderRadius: 8, cursor: "pointer", whiteSpace: "nowrap",
                          border: lesson.is_published ? "1.5px solid #d1d5db" : "none",
                          background: lesson.is_published ? "#fff" : "#16a34a",
                          color: lesson.is_published ? "#6b7280" : "#fff",
                        }}
                      >
                        {lesson.is_published ? "Unpublish" : "Publish"}
                      </button>

                      <Link
                        href={`/admin/learning/lesson/${lesson.id}`}
                        style={{ fontSize: 13, fontWeight: 600, color: PINK, textDecoration: "none", padding: "5px 12px", borderRadius: 8, border: `1px solid ${PINK}`, whiteSpace: "nowrap" }}
                      >
                        Edit
                      </Link>

                      <button
                        style={{ fontSize: 14, color: "#dc2626", background: "none", border: "none", cursor: "pointer", padding: "2px 6px" }}
                        onClick={() => deleteLesson(lesson.id)}
                        title="Delete song topic"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  {sectionLessons.length === 0 && <div className="subtle" style={{ fontSize: 14, padding: "4px 2px" }}>No song topics in this level.</div>}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  fontSize: 10,
  width: 22,
  height: 18,
  padding: 0,
  borderRadius: 4,
  border: "1px solid #e5e7eb",
  background: "#fff",
  color: "#6b7280",
  cursor: "pointer",
};
