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

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 20px" }}>
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

      {/* Levels */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Levels</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
          {categories.map(cat => (
            <div key={cat.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "#f9fafb", borderRadius: 10, padding: "10px 14px", border: "1px solid #e5e7eb" }}>
              <span style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>{cat.name}</span>
              <span className="subtle" style={{ fontSize: 13 }}>{lessonsByCategory(cat.id).length} song topic{lessonsByCategory(cat.id).length === 1 ? "" : "s"}</span>
              <button
                style={{ fontSize: 12, color: "#dc2626", background: "none", border: "none", cursor: "pointer", padding: "2px 6px" }}
                onClick={() => deleteCategory(cat.id)}
              >
                Delete
              </button>
            </div>
          ))}
          {categories.length === 0 && <div className="subtle">No categories yet.</div>}
        </div>

        {/* Add level */}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={newCatName}
            onChange={e => setNewCatName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addCategory()}
            placeholder="New level name"
            style={{ flex: 1, border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 12px", fontSize: 14 }}
          />
          <button
            className="btn btn-primary"
            onClick={addCategory}
            disabled={addingCat || !newCatName.trim()}
          >
            {addingCat ? "Adding…" : "Add Level"}
          </button>
        </div>
      </section>

      {/* Song topics by level */}
      {[...categories.map(c => ({ id: c.id, name: c.name })), { id: "__none__", name: "Unleveled" }].map(section => {
        const sectionLessons = lessonsByCategory(section.id === "__none__" ? null : section.id);
        if (section.id === "__none__" && sectionLessons.length === 0) return null;
        return (
          <section key={section.id} style={{ marginBottom: 40 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ background: PINK, color: "#fff", borderRadius: 20, padding: "3px 14px", fontSize: 14 }}>{section.name}</span>
            </h2>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
              {sectionLessons.map(lesson => (
                <div key={lesson.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "#fff", borderRadius: 10, padding: "12px 14px", border: "1px solid #e5e7eb", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
                  {/* Thumbnail */}
                  {lesson.thumbnail_url ? (
                    <img src={lesson.thumbnail_url} alt="" style={{ width: 48, height: 48, borderRadius: 6, objectFit: "cover", flexShrink: 0 }} />
                  ) : (
                    <div style={{ width: 48, height: 48, borderRadius: 6, background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
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

                  {/* Published badge */}
                  <button
                    onClick={() => togglePublished(lesson)}
                    style={{
                      fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 20, border: "none", cursor: "pointer",
                      background: lesson.is_published ? "#dcfce7" : "#f3f4f6",
                      color: lesson.is_published ? "#16a34a" : "#6b7280",
                    }}
                  >
                    {lesson.is_published ? "Published" : "Draft"}
                  </button>

                  <Link
                    href={`/admin/learning/lesson/${lesson.id}`}
                    style={{ fontSize: 13, fontWeight: 600, color: PINK, textDecoration: "none", padding: "4px 10px", borderRadius: 8, border: `1px solid ${PINK}`, whiteSpace: "nowrap" }}
                  >
                    Edit
                  </Link>

                  <button
                    style={{ fontSize: 12, color: "#dc2626", background: "none", border: "none", cursor: "pointer", padding: "2px 6px" }}
                    onClick={() => deleteLesson(lesson.id)}
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

      {/* Add song topic */}
      <section>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Add Song Topic</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={newLessonTitle}
            onChange={e => setNewLessonTitle(e.target.value)}
            placeholder="Song topic title"
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
          <button
            className="btn btn-primary"
            onClick={addLesson}
            disabled={addingLesson || !newLessonTitle.trim()}
          >
            {addingLesson ? "Adding…" : "Add Song Topic"}
          </button>
        </div>
      </section>
    </div>
  );
}
