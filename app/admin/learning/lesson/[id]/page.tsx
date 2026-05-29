"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Converter } from "opencc-js";
import { pinyin as getPinyin } from "pinyin-pro";
import { supabase } from "@/lib/supabaseClient";
import { useDialog } from "@/components/ui/useDialog";

const PINK = "#e6178d";
const TEAL = "#4ECEC8";

type ZhLink = "trad_leads" | "simp_leads" | "unlinked";

let tradToSimp: ((t: string) => string) | null = null;
let simpToTrad: ((t: string) => string) | null = null;
try {
  tradToSimp = Converter({ from: "tw", to: "cn" });
  simpToTrad = Converter({ from: "cn", to: "tw" });
} catch {}

type Category = { id: string; name: string; order_index: number };

type Lesson = {
  id: string;
  category_id: string | null;
  title: string;
  title_zh_traditional: string | null;
  title_zh_simplified: string | null;
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

// A flashcard is "complete" only when every field below is filled. Any missing
// field flags the card with a red hue so admins notice it needs attention.
function missingSlideFields(s: Slide): string[] {
  const missing: string[] = [];
  if (!s.term_chinese) missing.push("Chinese (Traditional)");
  if (!s.term_chinese_simplified) missing.push("Chinese (Simplified)");
  if (!s.pinyin) missing.push("Pinyin");
  if (!s.term_english) missing.push("English");
  if (!s.image_key) missing.push("Traditional image");
  if (!s.image_key_simplified) missing.push("Simplified image");
  if (!s.audio_key) missing.push("Traditional audio");
  if (!s.audio_key_simplified) missing.push("Simplified audio");
  return missing;
}

type DictCategory = {
  id: string;
  name: string;
  name_zh_traditional: string | null;
  name_zh_simplified: string | null;
  pinyin: string | null;
  order_index: number;
};

type DictItem = { id: string; category_id: string; slide_id: string; order_index: number };

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
  label, accept, uploading, onFile,
}: {
  label: string; accept: string; uploading: boolean; onFile: (file: File) => void;
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
  const { confirm, modal } = useDialog();

  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [dictCategories, setDictCategories] = useState<DictCategory[]>([]);
  const [dictItems, setDictItems] = useState<DictItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [title, setTitle] = useState("");
  const [titleZhTraditional, setTitleZhTraditional] = useState("");
  const [titleZhSimplified, setTitleZhSimplified] = useState("");
  const [zhTitleLink, setZhTitleLink] = useState<ZhLink>("trad_leads");
  const [categoryId, setCategoryId] = useState<string>("");
  const [isPublished, setIsPublished] = useState(false);
  const [isLocked, setIsLocked] = useState(false);

  const [uploadingThumb, setUploadingThumb] = useState(false);
  const [uploadingVideo, setUploadingVideo] = useState<Record<VideoType, boolean>>({
    video: false, karaoke: false, video_simplified: false, karaoke_simplified: false,
  });

  const [addingSlide, setAddingSlide] = useState(false);
  const [slideUploads, setSlideUploads] = useState<Record<string, boolean>>({});
  const [slideLinks, setSlideLinks] = useState<Record<string, ZhLink>>({});

  useEffect(() => { load(); }, [id]);

  async function load() {
    setLoading(true);
    const [{ data: l }, { data: s }, { data: cats }, { data: dictCats }] = await Promise.all([
      supabase.from("learning_lessons").select("*").eq("id", id).single(),
      supabase.from("learning_slides").select("*").eq("lesson_id", id).order("slide_number"),
      supabase.from("learning_categories").select("*").order("order_index"),
      supabase.from("learning_dictionary_categories").select("*").order("order_index"),
    ]);
    if (!l) { router.replace("/admin/learning"); return; }
    setLesson(l as Lesson);
    setTitle(l.title ?? "");
    setTitleZhTraditional(l.title_zh_traditional ?? "");
    setTitleZhSimplified(l.title_zh_simplified ?? "");
    const hasTrad = !!l.title_zh_traditional;
    const hasSimp = !!l.title_zh_simplified;
    setZhTitleLink(hasTrad && hasSimp ? "unlinked" : hasSimp ? "simp_leads" : "trad_leads");
    setCategoryId(l.category_id ?? "");
    setIsPublished(l.is_published ?? false);
    setIsLocked(l.is_locked ?? false);
    const slideList = (s ?? []) as Slide[];
    setSlides(slideList);
    setCategories((cats ?? []) as Category[]);
    setDictCategories((dictCats ?? []) as DictCategory[]);

    // Dictionary-category memberships for this lesson's flashcards.
    const slideIds = slideList.map(sl => sl.id);
    if (slideIds.length > 0) {
      const { data: dItems } = await supabase
        .from("learning_dictionary_category_items")
        .select("*")
        .in("slide_id", slideIds);
      setDictItems((dItems ?? []) as DictItem[]);
    } else {
      setDictItems([]);
    }
    const initialLinks: Record<string, ZhLink> = {};
    slideList.forEach(slide => {
      const ht = !!slide.term_chinese;
      const hs = !!slide.term_chinese_simplified;
      initialLinks[slide.id] = ht && hs ? "unlinked" : hs ? "simp_leads" : "trad_leads";
    });
    setSlideLinks(initialLinks);
    setLoading(false);
  }

  async function saveLesson() {
    setSaving(true);
    setError("");
    const { error: e } = await supabase.from("learning_lessons").update({
      title: title.trim(),
      title_zh_traditional: titleZhTraditional.trim() || null,
      title_zh_simplified: titleZhSimplified.trim() || null,
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
      const { error: e } = await supabase.from("learning_lessons").update({ thumbnail_key: objectKey, thumbnail_url: url }).eq("id", id);
      if (e) throw new Error(e.message);
      if (lesson?.thumbnail_key && lesson.thumbnail_key !== objectKey) await deleteFromR2(lesson.thumbnail_key).catch(() => {});
      setLesson(prev => prev ? { ...prev, thumbnail_key: objectKey, thumbnail_url: url } : prev);
    } catch (e: any) { setError(e.message ?? "Upload failed"); }
    setUploadingThumb(false);
  }

  const videoKeyMap: Record<VideoType, keyof Lesson> = {
    video: "video_key", karaoke: "karaoke_key",
    video_simplified: "video_key_simplified", karaoke_simplified: "karaoke_key_simplified",
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
    } catch (e: any) { setError(e.message ?? "Upload failed"); }
    setUploadingVideo(p => ({ ...p, [type]: false }));
  }

  async function addSlide() {
    setAddingSlide(true);
    const nextNum = slides.length > 0 ? Math.max(...slides.map(s => s.slide_number)) + 1 : 1;
    const { data, error: e } = await supabase.from("learning_slides").insert({ lesson_id: id, slide_number: nextNum }).select().single();
    if (!e && data) {
      setSlides(prev => [...prev, data as Slide]);
      setSlideLinks(prev => ({ ...prev, [(data as Slide).id]: "trad_leads" }));
    }
    setAddingSlide(false);
  }

  // ── Dictionary category assignment (per flashcard) ──
  async function addSlideToCategory(slideId: string, categoryId: string) {
    if (dictItems.some(i => i.slide_id === slideId && i.category_id === categoryId)) return;
    setError("");
    // Append to the end of the category's slideshow order.
    const { data: maxRow } = await supabase
      .from("learning_dictionary_category_items")
      .select("order_index")
      .eq("category_id", categoryId)
      .order("order_index", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextOrder = ((maxRow?.order_index as number | undefined) ?? -1) + 1;
    const { data, error: e } = await supabase
      .from("learning_dictionary_category_items")
      .insert({ category_id: categoryId, slide_id: slideId, order_index: nextOrder })
      .select()
      .single();
    if (e) { setError(e.message); return; }
    setDictItems(prev => [...prev, data as DictItem]);
  }

  async function removeSlideFromCategory(itemId: string) {
    setError("");
    const { error: e } = await supabase.from("learning_dictionary_category_items").delete().eq("id", itemId);
    if (e) { setError(e.message); return; }
    setDictItems(prev => prev.filter(i => i.id !== itemId));
  }

  async function createDictCategory(fields: {
    name: string; pinyin: string; zhTrad: string; zhSimp: string;
  }): Promise<string | null> {
    setError("");
    const maxOrder = dictCategories.reduce((m, c) => Math.max(m, c.order_index), -1);
    const { data, error: e } = await supabase
      .from("learning_dictionary_categories")
      .insert({
        name: fields.name.trim(),
        name_zh_traditional: fields.zhTrad.trim() || null,
        name_zh_simplified: fields.zhSimp.trim() || null,
        pinyin: fields.pinyin.trim() || null,
        order_index: maxOrder + 1,
      })
      .select()
      .single();
    if (e) { setError(e.message); return null; }
    setDictCategories(prev => [...prev, data as DictCategory]);
    return (data as DictCategory).id;
  }

  function handleTitleTradChange(value: string) {
    if (zhTitleLink === "simp_leads") {
      setZhTitleLink("unlinked");
      setTitleZhTraditional(value);
    } else if (zhTitleLink === "trad_leads") {
      setTitleZhTraditional(value);
      if (tradToSimp) setTitleZhSimplified(tradToSimp(value));
    } else {
      setTitleZhTraditional(value);
    }
  }

  function handleTitleSimpChange(value: string) {
    if (zhTitleLink === "trad_leads") {
      setZhTitleLink("unlinked");
      setTitleZhSimplified(value);
    } else if (zhTitleLink === "simp_leads") {
      setTitleZhSimplified(value);
      if (simpToTrad) setTitleZhTraditional(simpToTrad(value));
    } else {
      setTitleZhSimplified(value);
    }
  }

  async function handleSlideTradChange(slideId: string, value: string) {
    const link = slideLinks[slideId] ?? "trad_leads";
    if (link === "simp_leads") {
      setSlideLinks(p => ({ ...p, [slideId]: "unlinked" }));
      setSlides(prev => prev.map(s => s.id === slideId ? { ...s, term_chinese: value } : s));
      await supabase.from("learning_slides").update({ term_chinese: value || null }).eq("id", slideId);
    } else if (link === "trad_leads") {
      const simp = tradToSimp ? tradToSimp(value) : null;
      const py = value ? getPinyin(value, { toneType: "symbol" }) : "";
      setSlides(prev => prev.map(s => s.id === slideId ? {
        ...s, term_chinese: value,
        ...(simp !== null ? { term_chinese_simplified: simp } : {}),
        pinyin: py,
      } : s));
      await supabase.from("learning_slides").update({
        term_chinese: value || null,
        ...(simp !== null ? { term_chinese_simplified: simp || null } : {}),
        pinyin: py || null,
      }).eq("id", slideId);
    } else {
      setSlides(prev => prev.map(s => s.id === slideId ? { ...s, term_chinese: value } : s));
      await supabase.from("learning_slides").update({ term_chinese: value || null }).eq("id", slideId);
    }
  }

  async function handleSlideSimpChange(slideId: string, value: string) {
    const link = slideLinks[slideId] ?? "trad_leads";
    if (link === "trad_leads") {
      setSlideLinks(p => ({ ...p, [slideId]: "unlinked" }));
      setSlides(prev => prev.map(s => s.id === slideId ? { ...s, term_chinese_simplified: value } : s));
      await supabase.from("learning_slides").update({ term_chinese_simplified: value || null }).eq("id", slideId);
    } else if (link === "simp_leads") {
      const trad = simpToTrad ? simpToTrad(value) : null;
      const py = value ? getPinyin(value, { toneType: "symbol" }) : "";
      setSlides(prev => prev.map(s => s.id === slideId ? {
        ...s, term_chinese_simplified: value,
        ...(trad !== null ? { term_chinese: trad } : {}),
        pinyin: py,
      } : s));
      await supabase.from("learning_slides").update({
        term_chinese_simplified: value || null,
        ...(trad !== null ? { term_chinese: trad || null } : {}),
        pinyin: py || null,
      }).eq("id", slideId);
    } else {
      setSlides(prev => prev.map(s => s.id === slideId ? { ...s, term_chinese_simplified: value } : s));
      await supabase.from("learning_slides").update({ term_chinese_simplified: value || null }).eq("id", slideId);
    }
  }

  async function updateSlideText(slideId: string, field: "pinyin" | "term_english", value: string) {
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
    } catch (e: any) { setError(e.message ?? "Upload failed"); }
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
    } catch (e: any) { setError(e.message ?? "Upload failed"); }
    setSlideUploads(p => ({ ...p, [uploadKey]: false }));
  }

  async function deleteSlide(slideId: string) {
    const slide = slides.find(s => s.id === slideId);
    const fileCount = [slide?.image_key, slide?.audio_key, slide?.image_key_simplified, slide?.audio_key_simplified].filter(Boolean).length;
    const ok = await confirm(
      `This will permanently delete Flashcard ${slide?.slide_number ?? ""}${fileCount > 0 ? ` and its ${fileCount} associated file${fileCount === 1 ? "" : "s"} from storage` : ""}.\n\nThis cannot be undone.`,
      { title: "Delete flashcard?", confirmLabel: "Delete", danger: true },
    );
    if (!ok) return;
    await supabase.from("learning_slides").delete().eq("id", slideId);
    // Remove any dictionary-category memberships for this flashcard.
    await supabase.from("learning_dictionary_category_items").delete().eq("slide_id", slideId);
    const keysToDelete = [slide?.image_key, slide?.audio_key, slide?.image_key_simplified, slide?.audio_key_simplified].filter(Boolean) as string[];
    await Promise.all(keysToDelete.map(k => deleteFromR2(k).catch(() => {})));
    setSlides(prev => prev.filter(s => s.id !== slideId));
    setDictItems(prev => prev.filter(i => i.slide_id !== slideId));
  }

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!lesson) return null;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 20px" }}>
      {modal}
      <div style={{ marginBottom: 24, fontSize: 14 }}>
        <Link href="/admin/learning" style={{ color: PINK, textDecoration: "none", fontWeight: 600 }}>← App Content</Link>
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 32px" }}>Edit Song Topic</h1>

      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", color: "#dc2626", marginBottom: 20, fontSize: 14 }}>
          {error}
        </div>
      )}

      {/* ── Lesson details ── */}
      <section style={{ background: "#fff", borderRadius: 16, border: "1px solid #e5e7eb", padding: 24, marginBottom: 28, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 18 }}>Song Topic Details</h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
            Title (English)
            <input value={title} onChange={e => setTitle(e.target.value)} style={inputStyle} />
          </label>

          <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
            Title (Traditional Chinese)
            <input value={titleZhTraditional} onChange={e => handleTitleTradChange(e.target.value)} style={inputStyle} placeholder="例：你好" />
          </label>

          <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
            Title (Simplified Chinese)
            <input value={titleZhSimplified} onChange={e => handleTitleSimpChange(e.target.value)} style={inputStyle} placeholder="例：你好" />
          </label>

          <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
            Level
            <select value={categoryId} onChange={e => setCategoryId(e.target.value)} style={{ ...inputStyle, appearance: "auto" }}>
              <option value="">— No level —</option>
              {categories.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
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

          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr", gap: 12, alignItems: "center" }}>
            <div />
            <div style={{ fontWeight: 700, fontSize: 13, color: "#374151", textAlign: "center" }}>Traditional (繁體)</div>
            <div style={{ fontWeight: 700, fontSize: 13, color: "#374151", textAlign: "center" }}>Simplified (简体)</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr", gap: 12, alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 22 }}>🎬</span>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Video</span>
            </div>
            <VideoUploadCell objectKey={lesson.video_key} uploading={uploadingVideo.video} onFile={f => uploadVideo(f, "video")} />
            <VideoUploadCell objectKey={lesson.video_key_simplified} uploading={uploadingVideo.video_simplified} onFile={f => uploadVideo(f, "video_simplified")} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr", gap: 12, alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 22 }}>🎤</span>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Karaoke</span>
            </div>
            <VideoUploadCell objectKey={lesson.karaoke_key} uploading={uploadingVideo.karaoke} onFile={f => uploadVideo(f, "karaoke")} />
            <VideoUploadCell objectKey={lesson.karaoke_key_simplified} uploading={uploadingVideo.karaoke_simplified} onFile={f => uploadVideo(f, "karaoke_simplified")} />
          </div>
        </div>
      </section>

      {/* ── Slides ── */}
      <section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Flashcards ({slides.length})</h2>
          <button className="btn btn-primary" onClick={addSlide} disabled={addingSlide}>
            {addingSlide ? "Adding…" : "+ Add Flashcard"}
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {slides.map((slide) => {
            const missing = missingSlideFields(slide);
            const incomplete = missing.length > 0;
            return (
              <div
                key={slide.id}
                style={{
                  background: incomplete ? "#fef2f2" : "#fff",
                  borderRadius: 16,
                  border: `1.5px solid ${incomplete ? "#f87171" : TEAL}`,
                  padding: 20,
                  boxShadow: incomplete ? "0 1px 6px rgba(248,113,113,0.18)" : "0 1px 4px rgba(78,206,200,0.1)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: incomplete ? "#dc2626" : TEAL }}>Flashcard {slide.slide_number}</span>
                    {incomplete && (
                      <span
                        title={`Missing: ${missing.join(", ")}`}
                        style={{ fontSize: 11, fontWeight: 700, background: "#fee2e2", color: "#dc2626", borderRadius: 20, padding: "2px 10px" }}
                      >
                        ⚠ Incomplete · missing {missing.length} field{missing.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  <button onClick={() => deleteSlide(slide.id)} style={{ fontSize: 12, color: "#dc2626", background: "none", border: "none", cursor: "pointer" }}>Delete</button>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 14 }}>
                  {/* Traditional */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ fontWeight: 700, fontSize: 12, color: "#6b7280", marginBottom: 2 }}>
                      Traditional (繁體)
                    </div>
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
                        onChange={e => handleSlideTradChange(slide.id, e.target.value)}
                        style={{ ...inputStyle, fontSize: 18 }}
                        placeholder="例：你好"
                      />
                    </label>
                  </div>

                  {/* Simplified */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ fontWeight: 700, fontSize: 12, color: "#6b7280", marginBottom: 2 }}>
                      Simplified (简体)
                    </div>
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
                        onChange={e => handleSlideSimpChange(slide.id, e.target.value)}
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

                {/* Dictionary category assignment */}
                <SlideCategoryAssigner
                  categories={dictCategories}
                  assignedItems={dictItems.filter(i => i.slide_id === slide.id)}
                  onAdd={(categoryId) => addSlideToCategory(slide.id, categoryId)}
                  onRemove={removeSlideFromCategory}
                  onCreateCategory={createDictCategory}
                />
              </div>
            );
          })}

          {slides.length === 0 && (
            <div className="subtle" style={{ textAlign: "center", padding: 40, border: "2px dashed #e5e7eb", borderRadius: 16 }}>
              No flashcards yet. Click &ldquo;+ Add Flashcard&rdquo; to get started.
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

// Per-flashcard control for assigning the slide to dictionary categories, with
// an inline "new category" form so admins can categorize while building cards.
function SlideCategoryAssigner({
  categories, assignedItems, onAdd, onRemove, onCreateCategory,
}: {
  categories: DictCategory[];
  assignedItems: DictItem[];
  onAdd: (categoryId: string) => Promise<void>;
  onRemove: (itemId: string) => Promise<void>;
  onCreateCategory: (fields: { name: string; pinyin: string; zhTrad: string; zhSimp: string }) => Promise<string | null>;
}) {
  const [creating, setCreating] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [pinyin, setPinyin] = useState("");
  const [zhTrad, setZhTrad] = useState("");
  const [zhSimp, setZhSimp] = useState("");
  const [zhLink, setZhLink] = useState<ZhLink>("trad_leads");
  const [pinyinManual, setPinyinManual] = useState(false);

  const assignedCatIds = new Set(assignedItems.map(i => i.category_id));
  const available = categories.filter(c => !assignedCatIds.has(c.id));

  function resetForm() {
    setName(""); setPinyin(""); setZhTrad(""); setZhSimp("");
    setZhLink("trad_leads"); setPinyinManual(false); setFormOpen(false);
  }

  function handleTradChange(v: string) {
    if (zhLink === "simp_leads") { setZhLink("unlinked"); setZhTrad(v); }
    else if (zhLink === "trad_leads") {
      setZhTrad(v);
      if (tradToSimp) setZhSimp(tradToSimp(v));
      if (!pinyinManual) setPinyin(v ? getPinyin(v, { toneType: "symbol" }) : "");
    } else setZhTrad(v);
  }
  function handleSimpChange(v: string) {
    if (zhLink === "trad_leads") { setZhLink("unlinked"); setZhSimp(v); }
    else if (zhLink === "simp_leads") {
      setZhSimp(v);
      if (simpToTrad) setZhTrad(simpToTrad(v));
      if (!pinyinManual) setPinyin(v ? getPinyin(v, { toneType: "symbol" }) : "");
    } else setZhSimp(v);
  }

  async function handleCreate() {
    if (!name.trim() || creating) return;
    setCreating(true);
    const id = await onCreateCategory({ name, pinyin, zhTrad, zhSimp });
    if (id) { await onAdd(id); resetForm(); }
    setCreating(false);
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px dashed #e5e7eb" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 8 }}>Dictionary Categories</div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {/* Assigned category chips */}
        {assignedItems.map(item => {
          const cat = categories.find(c => c.id === item.category_id);
          return (
            <span key={item.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, background: "#fdf2f8", color: PINK, border: `1px solid ${PINK}`, borderRadius: 20, padding: "3px 6px 3px 12px" }}>
              {cat?.name ?? "Unknown category"}
              <button
                onClick={() => onRemove(item.id)}
                title="Remove from category"
                style={{ background: "none", border: "none", color: PINK, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 2px" }}
              >
                ×
              </button>
            </span>
          );
        })}
        {assignedItems.length === 0 && (
          <span className="subtle" style={{ fontSize: 12 }}>Not in any category yet.</span>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        {/* Add to existing category */}
        <select
          value=""
          onChange={e => { if (e.target.value) onAdd(e.target.value); }}
          disabled={available.length === 0}
          style={{ fontSize: 13, padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: available.length ? "#374151" : "#9ca3af", maxWidth: 240 }}
        >
          <option value="">{available.length ? "Add to category…" : "All categories added"}</option>
          {available.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <button
          onClick={() => setFormOpen(o => !o)}
          style={{ fontSize: 13, fontWeight: 600, padding: "6px 12px", borderRadius: 8, border: `1.5px solid ${PINK}`, color: PINK, background: "#fff", cursor: "pointer" }}
        >
          {formOpen ? "Cancel" : "+ New Category"}
        </button>
      </div>

      {/* Inline new-category form */}
      {formOpen && (
        <div style={{ marginTop: 12, background: "#fafafa", borderRadius: 10, padding: 14, border: "1px solid #e5e7eb" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
              Name (English)
              <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} placeholder="e.g. Pets" />
            </label>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
              Pinyin
              <input value={pinyin} onChange={e => { setPinyinManual(true); setPinyin(e.target.value); }} style={inputStyle} placeholder="chǒng wù" />
            </label>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
              Name (Traditional Chinese)
              <input value={zhTrad} onChange={e => handleTradChange(e.target.value)} style={inputStyle} placeholder="例：寵物" />
            </label>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
              Name (Simplified Chinese)
              <input value={zhSimp} onChange={e => handleSimpChange(e.target.value)} style={inputStyle} placeholder="例：宠物" />
            </label>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button className="btn btn-primary" onClick={handleCreate} disabled={creating || !name.trim()}>
              {creating ? "Creating…" : "Create & Add"}
            </button>
            <button onClick={resetForm} style={{ fontSize: 13, fontWeight: 600, padding: "8px 16px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </div>
      )}
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
