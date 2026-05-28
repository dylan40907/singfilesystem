"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

const PINK = "#e6178d";
const TEAL = "#4ECEC8";

type Category = { id: string; name: string; order_index: number };

type Lesson = {
  id: string;
  category_id: string | null;
  title: string;
  title_zh: string | null;
  thumbnail_url: string | null;
  thumbnail_key: string | null;
  video_key: string | null;
  karaoke_key: string | null;
  video_key_simplified: string | null;
  karaoke_key_simplified: string | null;
  is_published: boolean;
  is_locked: boolean;
  order_index: number;
};

type Slide = {
  id: string;
  slide_number: number;
  image_url: string | null;
  image_key: string | null;
  audio_url: string | null;
  audio_key: string | null;
  term_chinese: string | null;
  term_english: string | null;
  pinyin: string | null;
  term_chinese_simplified: string | null;
  image_key_simplified: string | null;
  image_url_simplified: string | null;
  audio_key_simplified: string | null;
};

async function getAuthHeader() {
  const { data } = await supabase.auth.getSession();
  return `Bearer ${data.session?.access_token ?? ""}`;
}

async function uploadToR2(file: File, folder: string): Promise<{ objectKey: string }> {
  const auth = await getAuthHeader();
  const presignRes = await fetch("/api/r2/learning-presign", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ filename: file.name, contentType: file.type, folder }),
  });
  if (!presignRes.ok) throw new Error(await presignRes.text());
  const { uploadUrl, objectKey } = await presignRes.json();
  const putRes = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "content-type": file.type } });
  if (!putRes.ok) throw new Error("R2 upload failed");
  return { objectKey };
}

async function getPresignedUrl(objectKey: string, expiresIn = 3600): Promise<string> {
  const auth = await getAuthHeader();
  const res = await fetch("/api/r2/learning-url", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ objectKey, expiresIn }),
  });
  if (!res.ok) throw new Error(await res.text());
  const { url } = await res.json();
  return url;
}

async function deleteFromR2(objectKey: string) {
  const auth = await getAuthHeader();
  await fetch("/api/r2/learning-delete", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ objectKey }),
  });
}

function UploadButton({
  label,
  accept,
  uploading,
  onFile,
}: {
  label: string;
  accept: string;
  uploading: boolean;
  onFile: (file: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" accept={accept} style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
      <button
        onClick={() => ref.current?.click()}
        disabled={uploading}
        style={{ fontSize: 13, fontWeight: 600, padding: "6px 14px", borderRadius: 8, border: `1.5px solid ${PINK}`, color: PINK, background: "#fff", cursor: "pointer", opacity: uploading ? 0.6 : 1 }}
      >
        {uploading ? "Uploading…" : label}
      </button>
    </>
  );
}

type VideoType = "video" | "karaoke" | "video_simplified" | "karaoke_simplified";

export default function LessonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Lesson form
  const [title, setTitle] = useState("");
  const [titleZh, setTitleZh] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [isPublished, setIsPublished] = useState(false);
  const [isLocked, setIsLocked] = useState(false);

  // Upload states
  const [uploadingThumb, setUploadingThumb] = useState(false);
  const [uploadingVideo, setUploadingVideo] = useState<Record<VideoType, boolean>>({
    video: false, karaoke: false, video_simplified: false, karaoke_simplified: false,
  });

  // Slide editing
  const [addingSlide, setAddingSlide] = useState(false);
  const [slideUploads, setSlideUploads] = useState<Record<string, boolean>>({});

  useEffect(() => { load(); }, [id]);

  async function load() {
    setLoading(true);
    const [{ data: l }, { data: s }, { data: cats }] = await Promise.all([
      supabase.from("learning_lessons").select("*").eq("id", id).single(),
      supabase.from("learning_slides").select("*").eq("lesson_id", id).order("slide_number"),
      supabase.from("learning_categories").select("*").order("order_index"),
    ]);
    if (!l) { router.replace("/admin/learning"); return; }
    setLesson(l as Lesson);
    setTitle(l.title ?? "");
    setTitleZh(l.title_zh ?? "");
    setCategoryId(l.category_id ?? "");
    setIsPublished(l.is_published ?? false);
    setIsLocked(l.is_locked ?? false);
    setSlides((s ?? []) as Slide[]);
    setCategories((cats ?? []) as Category[]);
    setLoading(false);
  }

  async function saveLesson() {
    setSaving(true);
    setError("");
    const { error: e } = await supabase.from("learning_lessons").update({
      title: title.trim(),
      title_zh: titleZh.trim() || null,
      category_id: categoryId || null,
      is_published: isPublished,
      is_locked: isLocked,
    }).eq("id", id);
    if (e) setError(e.message);
    setSaving(false);
  }

  async function uploadThumbnail(file: File) {
    setUploadingThumb(true);
    setError("");
    try {
      const { objectKey } = await uploadToR2(file, "thumbnails");
      const url = await getPresignedUrl(objectKey, 604800);
      const { error: e } = await supabase.from("learning_lessons").update({
        thumbnail_key: objectKey,
        thumbnail_url: url,
      }).eq("id", id);
      if (e) throw new Error(e.message);
      if (lesson?.thumbnail_key && lesson.thumbnail_key !== objectKey) {
        await deleteFromR2(lesson.thumbnail_key).catch(() => {});
      }
      setLesson(prev => prev ? { ...prev, thumbnail_key: objectKey, thumbnail_url: url } : prev);
    } catch (e: any) {
      setError(e.message ?? "Upload failed");
    }
    setUploadingThumb(false);
  }

  const videoKeyMap: Record<VideoType, keyof Lesson> = {
    video: "video_key",
    karaoke: "karaoke_key",
    video_simplified: "video_key_simplified",
    karaoke_simplified: "karaoke_key_simplified",
  };

  async function uploadVideo(file: File, type: VideoType) {
    setUploadingVideo(p => ({ ...p, [type]: true }));
    setError("");
    try {
      const { objectKey } = await uploadToR2(file, "videos");
      const col = videoKeyMap[type];
      const { error: e } = await supabase.from("learning_lessons").update({ [col]: objectKey }).eq("id", id);
      if (e) throw new Error(e.message);
      const oldKey = lesson?.[col] as string | null;
      if (oldKey) await deleteFromR2(oldKey).catch(() => {});
      setLesson(prev => prev ? { ...prev, [col]: objectKey } : prev);
    } catch (e: any) {
      setError(e.message ?? "Upload failed");
    }
    setUploadingVideo(p => ({ ...p, [type]: false }));
  }

  async function addSlide() {
    setAddingSlide(true);
    const nextNum = slides.length > 0 ? Math.max(...slides.map(s => s.slide_number)) + 1 : 1;
    const { data, error: e } = await supabase.from("learning_slides").insert({
      lesson_id: id,
      slide_number: nextNum,
    }).select().single();
    if (!e && data) setSlides(prev => [...prev, data as Slide]);
    setAddingSlide(false);
  }

  async function updateSlideText(slideId: string, field: keyof Slide, value: string) {
    setSlides(prev => prev.map(s => s.id === slideId ? { ...s, [field]: value } : s));
    await supabase.from("learning_slides").update({ [field]: value || null }).eq("id", slideId);
  }

  async function uploadSlideImage(slideId: string, file: File, variant: "traditional" | "simplified") {
    const uploadKey = `${slideId}-image${variant === "simplified" ? "-simplified" : ""}`;
    setSlideUploads(p => ({ ...p, [uploadKey]: true }));
    try {
      const { objectKey } = await uploadToR2(file, "slides");
      const url = await getPresignedUrl(objectKey, 604800);
      const slide = slides.find(s => s.id === slideId);
      if (variant === "simplified") {
        await supabase.from("learning_slides").update({ image_key_simplified: objectKey, image_url_simplified: url }).eq("id", slideId);
        if (slide?.image_key_simplified) await deleteFromR2(slide.image_key_simplified).catch(() => {});
        setSlides(prev => prev.map(s => s.id === slideId ? { ...s, image_key_simplified: objectKey, image_url_simplified: url } : s));
      } else {
        await supabase.from("learning_slides").update({ image_key: objectKey, image_url: url }).eq("id", slideId);
        if (slide?.image_key) await deleteFromR2(slide.image_key).catch(() => {});
        setSlides(prev => prev.map(s => s.id === slideId ? { ...s, image_key: objectKey, image_url: url } : s));
      }
    } catch (e: any) {
      setError(e.message ?? "Upload failed");
    }
    setSlideUploads(p => ({ ...p, [uploadKey]: false }));
  }

  async function uploadSlideAudio(slideId: string, file: File, variant: "traditional" | "simplified") {
    const uploadKey = `${slideId}-audio${variant === "simplified" ? "-simplified" : ""}`;
    setSlideUploads(p => ({ ...p, [uploadKey]: true }));
    try {
      const { objectKey } = await uploadToR2(file, "audio");
      const slide = slides.find(s => s.id === slideId);
      if (variant === "simplified") {
        await supabase.from("learning_slides").update({ audio_key_simplified: objectKey }).eq("id", slideId);
        if (slide?.audio_key_simplified) await deleteFromR2(slide.audio_key_simplified).catch(() => {});
        setSlides(prev => prev.map(s => s.id === slideId ? { ...s, audio_key_simplified: objectKey } : s));
      } else {
        await supabase.from("learning_slides").update({ audio_key: objectKey }).eq("id", slideId);
        if (slide?.audio_key) await deleteFromR2(slide.audio_key).catch(() => {});
        setSlides(prev => prev.map(s => s.id === slideId ? { ...s, audio_key: objectKey } : s));
      }
    } catch (e: any) {
      setError(e.message ?? "Upload failed");
    }
    setSlideUploads(p => ({ ...p, [uploadKey]: false }));
  }

  async function deleteSlide(slideId: string) {
    if (!confirm("Delete this slide?")) return;
    const slide = slides.find(s => s.id === slideId);
    await supabase.from("learning_slides").delete().eq("id", slideId);
    const keysToDelete = [slide?.image_key, slide?.audio_key, slide?.image_key_simplified, slide?.audio_key_simplified].filter(Boolean) as string[];
    await Promise.all(keysToDelete.map(k => deleteFromR2(k).catch(() => {})));
    setSlides(prev => prev.filter(s => s.id !== slideId));
  }

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!lesson) return null;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 20px" }}>
      <div style={{ marginBottom: 24, fontSize: 14 }}>
        <Link href="/admin/learning" style={{ color: PINK, textDecoration: "none", fontWeight: 600 }}>← Learning</Link>
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 32px" }}>Edit Lesson</h1>

      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", color: "#dc2626", marginBottom: 20, fontSize: 14 }}>
          {error}
        </div>
      )}

      {/* ── Lesson details ── */}
      <section style={{ background: "#fff", borderRadius: 16, border: "1px solid #e5e7eb", padding: 24, marginBottom: 28, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 18 }}>Lesson Details</h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
            Title (English)
            <input value={title} onChange={e => setTitle(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
            Title (Chinese — optional)
            <input value={titleZh} onChange={e => setTitleZh(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
            Category
            <select
              value={categoryId}
              onChange={e => setCategoryId(e.target.value)}
              style={{ ...inputStyle, appearance: "auto" }}
            >
              <option value="">— No category —</option>
              {categories.map(cat => (
                <option key={cat.id} value={cat.id}>{cat.name}</option>
              ))}
            </select>
          </label>

          <div style={{ display: "flex", gap: 24 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "#374151", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={isPublished} onChange={e => setIsPublished(e.target.checked)} style={{ width: 16, height: 16 }} />
              Published
            </label>
            <label style={{ fontSize: 13, fontWeight: 600, color: "#374151", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={isLocked} onChange={e => setIsLocked(e.target.checked)} style={{ width: 16, height: 16 }} />
              Locked
            </label>
          </div>
        </div>

        <button className="btn btn-primary" onClick={saveLesson} disabled={saving} style={{ marginTop: 18 }}>
          {saving ? "Saving…" : "Save"}
        </button>
      </section>

      {/* ── Media uploads ── */}
      <section style={{ background: "#fff", borderRadius: 16, border: "1px solid #e5e7eb", padding: 24, marginBottom: 28, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 18 }}>Media</h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Thumbnail */}
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {lesson.thumbnail_url ? (
              <img src={lesson.thumbnail_url} alt="Thumbnail" style={{ width: 72, height: 72, borderRadius: 8, objectFit: "cover", border: "1px solid #e5e7eb" }} />
            ) : (
              <div style={{ width: 72, height: 72, borderRadius: 8, background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid #e5e7eb" }}>🖼</div>
            )}
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Thumbnail</div>
              <UploadButton label="Upload Image" accept="image/*" uploading={uploadingThumb} onFile={uploadThumbnail} />
              {lesson.thumbnail_key && <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>✓ {lesson.thumbnail_key.split("/").pop()}</div>}
            </div>
          </div>

          {/* Traditional / Simplified header row */}
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr", gap: 12, alignItems: "center" }}>
            <div />
            <div style={{ fontWeight: 700, fontSize: 13, color: "#374151", textAlign: "center" }}>Traditional (繁體)</div>
            <div style={{ fontWeight: 700, fontSize: 13, color: "#374151", textAlign: "center" }}>Simplified (简体)</div>
          </div>

          {/* Video row */}
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr", gap: 12, alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 22 }}>🎬</span>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Video</span>
            </div>
            <VideoUploadCell
              objectKey={lesson.video_key}
              uploading={uploadingVideo.video}
              onFile={f => uploadVideo(f, "video")}
            />
            <VideoUploadCell
              objectKey={lesson.video_key_simplified}
              uploading={uploadingVideo.video_simplified}
              onFile={f => uploadVideo(f, "video_simplified")}
            />
          </div>

          {/* Karaoke row */}
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr", gap: 12, alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 22 }}>🎤</span>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Karaoke</span>
            </div>
            <VideoUploadCell
              objectKey={lesson.karaoke_key}
              uploading={uploadingVideo.karaoke}
              onFile={f => uploadVideo(f, "karaoke")}
            />
            <VideoUploadCell
              objectKey={lesson.karaoke_key_simplified}
              uploading={uploadingVideo.karaoke_simplified}
              onFile={f => uploadVideo(f, "karaoke_simplified")}
            />
          </div>
        </div>
      </section>

      {/* ── Slides ── */}
      <section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Flashcard Slides ({slides.length})</h2>
          <button className="btn btn-primary" onClick={addSlide} disabled={addingSlide}>
            {addingSlide ? "Adding…" : "+ Add Slide"}
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {slides.map((slide) => (
            <div key={slide.id} style={{ background: "#fff", borderRadius: 16, border: `1.5px solid ${TEAL}`, padding: 20, boxShadow: "0 1px 4px rgba(78,206,200,0.1)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: TEAL }}>Slide {slide.slide_number}</span>
                <button onClick={() => deleteSlide(slide.id)} style={{ fontSize: 12, color: "#dc2626", background: "none", border: "none", cursor: "pointer" }}>Delete</button>
              </div>

              {/* Traditional / Simplified columns */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 14 }}>
                {/* Traditional */}
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: "#6b7280", marginBottom: 2 }}>Traditional (繁體)</div>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                      {slide.image_url ? (
                        <img src={slide.image_url} alt="" style={{ width: 80, height: 80, borderRadius: 8, objectFit: "cover", border: "1px solid #e5e7eb" }} />
                      ) : (
                        <div style={{ width: 80, height: 80, borderRadius: 8, background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid #e5e7eb", fontSize: 22 }}>🖼</div>
                      )}
                      <UploadButton label="Image" accept="image/*" uploading={!!slideUploads[`${slide.id}-image`]} onFile={f => uploadSlideImage(slide.id, f, "traditional")} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                      <div style={{ width: 80, height: 80, borderRadius: 8, background: "#fdf4ff", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", border: "1px solid #e9d5ff", gap: 2 }}>
                        <span style={{ fontSize: 22 }}>🔊</span>
                        {slide.audio_key && <span style={{ fontSize: 9, color: "#7c3aed", fontWeight: 600 }}>✓</span>}
                      </div>
                      <UploadButton label="Audio" accept="audio/*" uploading={!!slideUploads[`${slide.id}-audio`]} onFile={f => uploadSlideAudio(slide.id, f, "traditional")} />
                    </div>
                  </div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
                    Chinese (Traditional)
                    <input
                      value={slide.term_chinese ?? ""}
                      onChange={e => updateSlideText(slide.id, "term_chinese", e.target.value)}
                      style={{ ...inputStyle, fontSize: 18 }}
                      placeholder="例：你好"
                    />
                  </label>
                </div>

                {/* Simplified */}
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: "#6b7280", marginBottom: 2 }}>Simplified (简体)</div>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                      {slide.image_url_simplified ? (
                        <img src={slide.image_url_simplified} alt="" style={{ width: 80, height: 80, borderRadius: 8, objectFit: "cover", border: "1px solid #e5e7eb" }} />
                      ) : (
                        <div style={{ width: 80, height: 80, borderRadius: 8, background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid #e5e7eb", fontSize: 22 }}>🖼</div>
                      )}
                      <UploadButton label="Image" accept="image/*" uploading={!!slideUploads[`${slide.id}-image-simplified`]} onFile={f => uploadSlideImage(slide.id, f, "simplified")} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                      <div style={{ width: 80, height: 80, borderRadius: 8, background: "#fdf4ff", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", border: "1px solid #e9d5ff", gap: 2 }}>
                        <span style={{ fontSize: 22 }}>🔊</span>
                        {slide.audio_key_simplified && <span style={{ fontSize: 9, color: "#7c3aed", fontWeight: 600 }}>✓</span>}
                      </div>
                      <UploadButton label="Audio" accept="audio/*" uploading={!!slideUploads[`${slide.id}-audio-simplified`]} onFile={f => uploadSlideAudio(slide.id, f, "simplified")} />
                    </div>
                  </div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
                    Chinese (Simplified)
                    <input
                      value={slide.term_chinese_simplified ?? ""}
                      onChange={e => updateSlideText(slide.id, "term_chinese_simplified", e.target.value)}
                      style={{ ...inputStyle, fontSize: 18 }}
                      placeholder="例：你好"
                    />
                  </label>
                </div>
              </div>

              {/* Shared fields */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
                  Pinyin
                  <input
                    value={slide.pinyin ?? ""}
                    onChange={e => updateSlideText(slide.id, "pinyin", e.target.value)}
                    style={inputStyle}
                    placeholder="nǐ hǎo"
                  />
                </label>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
                  English
                  <input
                    value={slide.term_english ?? ""}
                    onChange={e => updateSlideText(slide.id, "term_english", e.target.value)}
                    style={inputStyle}
                    placeholder="Hello"
                  />
                </label>
              </div>
            </div>
          ))}

          {slides.length === 0 && (
            <div className="subtle" style={{ textAlign: "center", padding: 40, border: "2px dashed #e5e7eb", borderRadius: 16 }}>
              No slides yet. Click &ldquo;+ Add Slide&rdquo; to get started.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function VideoUploadCell({ objectKey, uploading, onFile }: { objectKey: string | null; uploading: boolean; onFile: (f: File) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, background: "#f9fafb", border: "1px solid #e5e7eb" }}>
      <UploadButton label="Upload Video" accept="video/*" uploading={uploading} onFile={onFile} />
      {objectKey && <span style={{ fontSize: 11, color: "#6b7280" }}>✓ {objectKey.split("/").pop()}</span>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  border: "1px solid #d1d5db",
  borderRadius: 8,
  padding: "8px 12px",
  fontSize: 14,
  boxSizing: "border-box",
};
