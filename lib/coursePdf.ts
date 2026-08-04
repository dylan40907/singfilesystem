import { supabase } from "./supabaseClient";
import {
  Course, CourseObject, CourseSection, CourseSegment, ObjectType, QuizQuestion,
  ScriptKind, fetchCourseFull, fetchSegments,
} from "./courses";
import { emojiAlias, emojiPng, ensureCjkFont, segmentRich } from "./pdfGlyphs";

/**
 * Course → PDF, for printing a handbook.
 *
 * Every object type a course can hold is rendered as closely as a page allows:
 * text keeps its headings, lists, links and inline images; images and video
 * first-frames are embedded; and anything that only exists online (YouTube, a
 * downloadable file) becomes a labelled card carrying its address, so the
 * printed copy still tells you where to find it.
 */

export type PdfProgress = (message: string, done: number, total: number) => void;

// ── Page geometry (pt) ──────────────────────────────────────────────────────
const PAGE_W = 595.28; // A4 portrait
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

const INK = "#111827";
const MUTED = "#6b7280";
const PINK = "#e6178d";
const RULE = "#e5e7eb";

/** Just the jsPDF surface this module touches. */
type Doc = {
  addPage: () => void;
  addImage: (data: string, fmt: string, x: number, y: number, w: number, h: number, alias?: string, comp?: string) => void;
  addFileToVFS: (name: string, data: string) => void;
  addFont: (file: string, name: string, style: string) => void;
  setFont: (name: string, style: string) => void;
  setFontSize: (n: number) => void;
  setTextColor: (c: string) => void;
  setDrawColor: (c: string) => void;
  setFillColor: (c: string) => void;
  setLineWidth: (n: number) => void;
  getTextWidth: (s: string) => number;
  text: (s: string, x: number, y: number) => void;
  line: (x1: number, y1: number, x2: number, y2: number) => void;
  roundedRect: (x: number, y: number, w: number, h: number, rx: number, ry: number, style: string) => void;
  link: (x: number, y: number, w: number, h: number, opts: { url: string }) => void;
  save: (filename: string) => void;
};

type Run = { text: string; bold?: boolean; italic?: boolean; link?: string };

/** An image ready to place: data URL plus its natural pixel size. */
type Img = { dataUrl: string; w: number; h: number };

// ── Asset loading ───────────────────────────────────────────────────────────

const imgCache = new Map<string, Img | null>();

/** Course media is served same-origin, so fetching it never taints a canvas. */
async function loadImage(url: string): Promise<Img | null> {
  if (imgCache.has(url)) return imgCache.get(url)!;
  let out: Img | null = null;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const blob = await res.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      const size = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = reject;
        im.src = dataUrl;
      });
      if (size.w > 0 && size.h > 0) out = { dataUrl, ...size };
    }
  } catch { out = null; }
  imgCache.set(url, out);
  return out;
}

/**
 * Grab a still from a video so the page shows what it is rather than a grey
 * box. Seeks a little past zero — the very first frame is often black.
 */
async function videoPoster(url: string): Promise<Img | null> {
  const key = `poster:${url}`;
  if (imgCache.has(key)) return imgCache.get(key)!;
  let out: Img | null = null;
  try {
    out = await new Promise<Img | null>((resolve) => {
      const v = document.createElement("video");
      v.crossOrigin = "anonymous";
      v.muted = true;
      v.preload = "metadata";
      // A stuck or very slow video must not hold the whole export hostage.
      const bail = setTimeout(() => { cleanup(); resolve(null); }, 8000);
      function cleanup() { clearTimeout(bail); v.removeAttribute("src"); v.load(); }
      v.onloadeddata = () => { try { v.currentTime = Math.min(0.5, (v.duration || 1) / 10); } catch { cleanup(); resolve(null); } };
      v.onseeked = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx || !canvas.width) { cleanup(); resolve(null); return; }
          ctx.drawImage(v, 0, 0);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
          cleanup();
          resolve({ dataUrl, w: canvas.width, h: canvas.height });
        } catch { cleanup(); resolve(null); }
      };
      v.onerror = () => { cleanup(); resolve(null); };
      v.src = url;
    });
  } catch { out = null; }
  imgCache.set(key, out);
  return out;
}

function youtubeId(url: string): string | null {
  const m = /(?:youtu\.be\/|v=|embed\/|shorts\/)([A-Za-z0-9_-]{6,})/.exec(url ?? "");
  return m ? m[1] : null;
}

// ── HTML → runs ─────────────────────────────────────────────────────────────

type Block =
  | { kind: "para"; runs: Run[]; size: number; bold?: boolean; bullet?: string; indent?: number }
  | { kind: "image"; src: string };

/**
 * Flattens the editor's HTML into blocks the page renderer understands.
 * Deliberately small: the editor only produces headings, paragraphs, lists,
 * links, inline images and bold/italic/underline.
 */
function htmlToBlocks(html: string): Block[] {
  const out: Block[] = [];
  if (typeof DOMParser === "undefined") {
    if (html?.trim()) out.push({ kind: "para", runs: [{ text: stripTags(html) }], size: 10.5 });
    return out;
  }
  const doc = new DOMParser().parseFromString(`<div id="r">${html ?? ""}</div>`, "text/html");
  const root = doc.getElementById("r");
  if (!root) return out;

  let listIndex = 0;

  const walkInline = (node: Node, inherited: Run): Run[] => {
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? "";
      return text ? [{ ...inherited, text }] : [];
    }
    if (node.nodeType !== 1) return [];
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") return [{ ...inherited, text: "\n" }];
    if (tag === "img") return []; // handled as its own block
    const next: Run = {
      ...inherited,
      bold: inherited.bold || tag === "b" || tag === "strong",
      italic: inherited.italic || tag === "i" || tag === "em",
      link: tag === "a" ? el.getAttribute("href") ?? inherited.link : inherited.link,
    };
    const runs: Run[] = [];
    el.childNodes.forEach((c) => runs.push(...walkInline(c, next)));
    return runs;
  };

  const pushPara = (el: HTMLElement, size: number, bold: boolean, bullet?: string, indent = 0) => {
    const runs = walkInline(el, { text: "" }).filter((r) => r.text !== "");
    if (runs.some((r) => r.text.trim())) out.push({ kind: "para", runs, size, bold, bullet, indent });
    // Inline images inside the block become their own blocks, in order.
    el.querySelectorAll("img").forEach((im) => {
      const src = im.getAttribute("src");
      if (src) out.push({ kind: "image", src });
    });
  };

  const walkBlock = (el: HTMLElement) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "ul" || tag === "ol") {
      listIndex = 0;
      el.querySelectorAll(":scope > li").forEach((li) => {
        listIndex += 1;
        pushPara(li as HTMLElement, 10.5, false, tag === "ol" ? `${listIndex}.` : "•", 14);
      });
      return;
    }
    if (tag === "h1" || tag === "h2") return pushPara(el, 14, true);
    if (tag === "h3" || tag === "h4") return pushPara(el, 12, true);
    if (tag === "img") {
      const src = el.getAttribute("src");
      if (src) out.push({ kind: "image", src });
      return;
    }
    if (tag === "div" || tag === "p" || tag === "section") {
      // A wrapper that only contains other blocks shouldn't emit a paragraph.
      const hasBlockChild = Array.from(el.children).some((c) =>
        ["div", "p", "ul", "ol", "h1", "h2", "h3", "h4", "section"].includes(c.tagName.toLowerCase())
      );
      if (hasBlockChild) { Array.from(el.children).forEach((c) => walkBlock(c as HTMLElement)); return; }
      return pushPara(el, 10.5, false);
    }
    pushPara(el, 10.5, false);
  };

  Array.from(root.childNodes).forEach((n) => {
    if (n.nodeType === 3) {
      const t = (n.nodeValue ?? "").trim();
      if (t) out.push({ kind: "para", runs: [{ text: t }], size: 10.5 });
    } else if (n.nodeType === 1) {
      walkBlock(n as HTMLElement);
    }
  });
  return out;
}

function stripTags(html: string): string {
  return (html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// ── Page writer ─────────────────────────────────────────────────────────────

class Sheet {
  y = MARGIN;
  constructor(private doc: Doc, private font: string | null) {}

  private setFont(bold: boolean, italic = false) {
    if (this.font) this.doc.setFont(this.font, bold ? "bold" : "normal");
    else this.doc.setFont("helvetica", bold ? "bold" : italic ? "italic" : "normal");
  }

  space(h: number) {
    if (this.y + h > PAGE_H - MARGIN) this.newPage();
  }

  newPage() {
    this.doc.addPage();
    this.y = MARGIN;
  }

  gap(h: number) { this.y += h; }

  rule() {
    this.doc.setDrawColor(RULE);
    this.doc.setLineWidth(0.6);
    this.doc.line(MARGIN, this.y, PAGE_W - MARGIN, this.y);
    this.y += 10;
  }

  /**
   * Draws wrapped rich text. Emoji are placed as small images inline, because
   * no CJK font carries them and they'd otherwise vanish.
   */
  text(runs: Run[], opts: { size?: number; color?: string; bullet?: string; indent?: number; gapAfter?: number } = {}) {
    const size = opts.size ?? 10.5;
    const lineH = size * 1.45;
    const indent = opts.indent ?? 0;
    const left = MARGIN + indent;
    const maxW = CONTENT_W - indent;

    // Split runs into words while remembering their styling.
    type Piece = { run: Run; text: string; emoji: boolean };
    const pieces: Piece[] = [];
    for (const r of runs) {
      for (const part of r.text.split(/(\n)/)) {
        if (part === "\n") { pieces.push({ run: r, text: "\n", emoji: false }); continue; }
        for (const seg of segmentRich(part)) {
          if (seg.emoji) { pieces.push({ run: r, text: seg.text, emoji: true }); continue; }
          // Keep spaces attached so wrapping doesn't lose them.
          for (const w of seg.text.split(/(\s+)/)) if (w !== "") pieces.push({ run: r, text: w, emoji: false });
        }
      }
    }

    let line: Piece[] = [];
    let lineW = 0;
    let first = true;

    const widthOf = (p: Piece) => {
      if (p.emoji) return size * 1.05;
      this.setFont(!!p.run.bold, !!p.run.italic);
      this.doc.setFontSize(size);
      return this.doc.getTextWidth(p.text);
    };

    const flush = () => {
      this.space(lineH);
      let x = left + (first && opts.bullet ? 0 : 0);
      if (opts.bullet && first) {
        this.setFont(false);
        this.doc.setFontSize(size);
        this.doc.setTextColor(MUTED);
        this.doc.text(opts.bullet, MARGIN, this.y + size);
      }
      for (const p of line) {
        if (p.emoji) {
          const png = emojiPng(p.text);
          const w = size * 1.05;
          if (png) {
            try { this.doc.addImage(png, "PNG", x, this.y + size * 0.15, w * 0.9, w * 0.9, emojiAlias(p.text), "FAST"); }
            catch { /* a single glyph must never kill the export */ }
          }
          x += w;
          continue;
        }
        this.setFont(!!p.run.bold, !!p.run.italic);
        this.doc.setFontSize(size);
        this.doc.setTextColor(p.run.link ? "#1d4ed8" : (opts.color ?? INK));
        this.doc.text(p.text, x, this.y + size);
        const w = this.doc.getTextWidth(p.text);
        if (p.run.link) {
          this.doc.setDrawColor("#1d4ed8");
          this.doc.setLineWidth(0.4);
          this.doc.line(x, this.y + size + 1.5, x + w, this.y + size + 1.5);
          try { this.doc.link(x, this.y, w, size + 2, { url: p.run.link }); } catch { /* older jsPDF */ }
        }
        x += w;
      }
      this.y += lineH;
      line = [];
      lineW = 0;
      first = false;
    };

    for (const p of pieces) {
      if (p.text === "\n") { flush(); continue; }
      const w = widthOf(p);
      if (lineW + w > maxW && line.length > 0) flush();
      // Don't open a line with a space left over from wrapping.
      if (line.length === 0 && !p.emoji && !p.text.trim()) continue;
      line.push(p);
      lineW += w;
    }
    if (line.length) flush();
    this.y += opts.gapAfter ?? 4;
  }

  /** Places an image scaled to fit the column, never taller than most of a page. */
  image(img: Img, maxH = 300) {
    const scale = Math.min(CONTENT_W / img.w, maxH / img.h, 1);
    const w = img.w * scale;
    const h = img.h * scale;
    this.space(h + 8);
    try { this.doc.addImage(img.dataUrl, imgFormat(img.dataUrl), x0(w), this.y, w, h); }
    catch { /* one bad image must not sink the export */ }
    this.y += h + 8;
  }

  /** A labelled box for things a page can't show — files, links, media. */
  card(icon: string, title: string, subtitle: string | null, url: string | null) {
    const h = subtitle || url ? 46 : 32;
    this.space(h + 8);
    this.doc.setFillColor("#f9fafb");
    this.doc.setDrawColor(RULE);
    this.doc.roundedRect(MARGIN, this.y, CONTENT_W, h, 6, 6, "FD");
    const png = emojiPng(icon);
    if (png) { try { this.doc.addImage(png, "PNG", MARGIN + 10, this.y + 9, 14, 14, emojiAlias(icon), "FAST"); } catch { /* ignore */ } }
    this.setFont(true);
    this.doc.setFontSize(10.5);
    this.doc.setTextColor(INK);
    this.doc.text(title, MARGIN + 32, this.y + 19);
    if (subtitle) {
      this.setFont(false);
      this.doc.setFontSize(8.5);
      this.doc.setTextColor(MUTED);
      this.doc.text(subtitle, MARGIN + 32, this.y + 32);
    }
    if (url) {
      this.setFont(false);
      this.doc.setFontSize(8);
      this.doc.setTextColor("#1d4ed8");
      const short = url.length > 96 ? url.slice(0, 93) + "…" : url;
      this.doc.text(short, MARGIN + 32, this.y + (subtitle ? 41 : 30));
      try { this.doc.link(MARGIN + 32, this.y + (subtitle ? 34 : 23), CONTENT_W - 44, 10, { url }); } catch { /* ignore */ }
    }
    this.y += h + 10;
  }
}

/** Images are centred in the column. */
function x0(w: number) { return MARGIN + (CONTENT_W - w) / 2; }

/** jsPDF wants the format named explicitly; read it off the data URL. */
function imgFormat(dataUrl: string): string {
  const m = /^data:image\/([a-z0-9+]+)/i.exec(dataUrl);
  const kind = (m?.[1] ?? "png").toLowerCase();
  if (kind === "jpg" || kind === "jpeg") return "JPEG";
  if (kind === "webp") return "WEBP";
  return "PNG";
}

// ── Object rendering ────────────────────────────────────────────────────────

const TYPE_ICON: Record<ObjectType, string> = {
  text: "📝", image: "🖼", video: "🎬", pdf: "📕",
  youtube: "▶️", quiz: "✅", file: "📎", link: "🔗", audio: "🎵",
};

async function renderObject(sheet: Sheet, o: CourseObject) {
  const content = (o.content ?? {}) as Record<string, unknown>;
  const url = typeof content.url === "string" ? content.url : null;
  const name = typeof content.name === "string" ? content.name : null;
  const title = (o.title ?? "").trim();

  if (title) sheet.text([{ text: title, bold: true }], { size: 11.5, gapAfter: 3 });

  switch (o.type) {
    case "text": {
      const blocks = htmlToBlocks(typeof content.html === "string" ? content.html : "");
      for (const b of blocks) {
        if (b.kind === "image") {
          const img = await loadImage(b.src);
          if (img) sheet.image(img, 260);
          continue;
        }
        sheet.text(b.runs, { size: b.size, bullet: b.bullet, indent: b.indent, gapAfter: 3 });
      }
      const confirm = (o.settings as Record<string, unknown>)?.confirmLabel;
      if (typeof confirm === "string" && confirm.trim()) {
        sheet.text([{ text: `☐ ${confirm}`, bold: true }], { size: 10, color: MUTED });
      }
      break;
    }

    case "image": {
      if (url) {
        const img = await loadImage(url);
        if (img) sheet.image(img);
        else sheet.card(TYPE_ICON.image, name ?? "Image", "Could not be loaded", url);
      }
      const caption = typeof content.caption === "string" ? content.caption : "";
      if (caption.trim()) sheet.text([{ text: caption, italic: true }], { size: 9.5, color: MUTED });
      break;
    }

    case "video": {
      // A still frame tells the reader what the video is; the play badge and
      // the address tell them it's a video and where to watch it.
      const poster = url ? await videoPoster(url) : null;
      if (poster) sheet.image(poster, 260);
      sheet.card("🎬", name ?? "Video", poster ? "Video — play in the portal" : "Video", url);
      break;
    }

    case "youtube": {
      const id = url ? youtubeId(url) : null;
      const thumb = id ? await loadImage(`https://img.youtube.com/vi/${id}/hqdefault.jpg`) : null;
      if (thumb) sheet.image(thumb, 220);
      sheet.card("▶️", title || "YouTube video", "Watch online", url);
      break;
    }

    case "audio":
      sheet.card("🎵", name ?? "Audio", "Listen in the portal", url);
      break;

    case "pdf":
      sheet.card("📕", name ?? "PDF document", "Open in the portal", url);
      break;

    case "file":
      sheet.card("📎", name ?? "File", "Download from the portal", url);
      break;

    case "link":
      sheet.card("🔗", title || name || "Link", null, url);
      break;

    case "quiz": {
      const questions = (content.questions ?? []) as QuizQuestion[];
      questions.forEach((q, qi) => {
        sheet.text([{ text: `Q${qi + 1}. ${q.prompt}`, bold: true }], { size: 10.5, gapAfter: 2 });
        for (const a of q.answers ?? []) {
          sheet.text(
            [{ text: `${a.correct ? "☑" : "☐"}  ${a.text}` }],
            { size: 10, indent: 14, color: a.correct ? "#166534" : INK, gapAfter: 1 }
          );
        }
        sheet.gap(4);
      });
      break;
    }
  }
  sheet.gap(6);
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Everything textual in a course, used to build the font subset up front. */
function courseText(course: Course, sections: CourseSection[], objects: CourseObject[]): string {
  const parts = [course.title, ...sections.map((s) => s.title)];
  for (const o of objects) {
    parts.push(o.title);
    const c = (o.content ?? {}) as Record<string, unknown>;
    if (typeof c.html === "string") parts.push(stripTags(c.html));
    if (typeof c.caption === "string") parts.push(c.caption);
    if (typeof c.name === "string") parts.push(c.name);
    for (const q of (c.questions ?? []) as QuizQuestion[]) {
      parts.push(q.prompt);
      for (const a of q.answers ?? []) parts.push(a.text);
    }
    const s = (o.settings ?? {}) as Record<string, unknown>;
    if (typeof s.confirmLabel === "string") parts.push(s.confirmLabel);
  }
  return parts.join(" ");
}

async function newDoc(text: string, script: ScriptKind) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" }) as Doc;
  const font = await ensureCjkFont(doc, text, script === "simp" ? "sc" : "tc");
  return { doc, font };
}

/** Course title page / section heading blocks, shared by both exports. */
function courseHeading(sheet: Sheet, course: Course, segmentName: string | null) {
  if (segmentName) sheet.text([{ text: segmentName.toUpperCase() }], { size: 9, color: PINK, gapAfter: 2 });
  sheet.text([{ text: course.title, bold: true }], { size: 19, gapAfter: 6 });
  sheet.rule();
}

async function renderCourseInto(
  sheet: Sheet, courseId: string, segmentName: string | null, onProgress?: PdfProgress, step = { done: 0, total: 1 }
) {
  const full = await fetchCourseFull(courseId);
  if (!full) return;
  const { course, sections, objects } = full;
  courseHeading(sheet, course, segmentName);

  const ordered = [...sections].sort((a, b) => a.position - b.position);
  for (const s of ordered) {
    sheet.space(60);
    sheet.text([{ text: s.title || "Untitled section", bold: true }], { size: 13.5, color: PINK, gapAfter: 4 });
    const objs = objects.filter((o) => o.section_id === s.id).sort((a, b) => a.position - b.position);
    for (const o of objs) {
      onProgress?.(`${course.title} — ${o.title || o.type}`, step.done, step.total);
      await renderObject(sheet, o);
    }
    sheet.gap(6);
  }
}

function save(doc: Doc, filename: string) {
  doc.save(filename.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 120));
}

/** One course → one PDF. */
export async function exportCoursePdf(courseId: string, onProgress?: PdfProgress): Promise<void> {
  onProgress?.("Loading course…", 0, 1);
  const full = await fetchCourseFull(courseId);
  if (!full) throw new Error("Course not found.");
  const segments = await fetchSegments();
  const segName = full.course.segment_id
    ? segments.find((s) => s.id === full.course.segment_id)?.name ?? null
    : null;

  onProgress?.("Preparing fonts…", 0, 1);
  const text = courseText(full.course, full.sections, full.objects) + (segName ?? "");
  const { doc, font } = await newDoc(text, full.course.script);
  const sheet = new Sheet(doc, font);

  await renderCourseInto(sheet, courseId, segName, onProgress, { done: 0, total: 1 });
  onProgress?.("Saving…", 1, 1);
  save(doc, `${full.course.title}.pdf`);
}

/** Every course in one script, grouped under its segment — the handbook. */
export async function exportAllCoursesPdf(script: ScriptKind, onProgress?: PdfProgress): Promise<void> {
  onProgress?.("Loading courses…", 0, 1);
  const [{ data: rows }, segments] = await Promise.all([
    supabase.from("courses").select("*").eq("script", script).neq("status", "archived")
      .order("position", { ascending: true }).order("created_at", { ascending: true }),
    fetchSegments(script),
  ]);
  const courses = (rows ?? []) as Course[];
  if (courses.length === 0) throw new Error("No courses to export.");

  // Group by segment, preserving the order shown on screen.
  const bySegment = new Map<string, Course[]>();
  for (const c of courses) {
    const key = c.segment_id ?? "__none__";
    const arr = bySegment.get(key) ?? [];
    arr.push(c);
    bySegment.set(key, arr);
  }
  const segOrder = [...segments].sort((a, b) => a.position - b.position);
  const groups: { segment: CourseSegment | null; courses: Course[] }[] = [];
  for (const s of segOrder) if (bySegment.has(s.id)) groups.push({ segment: s, courses: bySegment.get(s.id)! });
  if (bySegment.has("__none__")) groups.push({ segment: null, courses: bySegment.get("__none__")! });

  // The font subset has to cover the whole book, so gather every course's text
  // before the first page is drawn.
  onProgress?.("Reading content…", 0, courses.length);
  const fulls = new Map<string, Awaited<ReturnType<typeof fetchCourseFull>>>();
  let read = 0;
  for (const c of courses) {
    fulls.set(c.id, await fetchCourseFull(c.id));
    read += 1;
    onProgress?.(`Reading ${c.title}`, read, courses.length);
  }
  const cover = script === "simp" ? "课程手册" : "課程手冊";
  const allText = [
    // The cover has to be in the subset too — a character that appears nowhere
    // in the courses (册 / 冊 does not) would otherwise have no glyph and drop
    // silently out of the title.
    cover,
    ...segOrder.map((s) => s.name),
    ...courses.map((c) => {
      const f = fulls.get(c.id);
      return f ? courseText(f.course, f.sections, f.objects) : c.title;
    }),
  ].join(" ");

  onProgress?.("Preparing fonts…", 0, courses.length);
  const { doc, font } = await newDoc(allText, script);
  const sheet = new Sheet(doc, font);

  // Cover
  sheet.gap(120);
  sheet.text([{ text: cover, bold: true }], { size: 30, gapAfter: 6 });
  sheet.text([{ text: script === "simp" ? "Course Handbook · Simplified" : "Course Handbook · Traditional" }],
    { size: 13, color: MUTED, gapAfter: 10 });
  sheet.text([{ text: new Date().toLocaleDateString() }], { size: 10, color: MUTED });

  let done = 0;
  for (const g of groups) {
    sheet.newPage();
    if (g.segment) {
      sheet.gap(40);
      sheet.text([{ text: g.segment.name, bold: true }], { size: 24, color: PINK, gapAfter: 8 });
      sheet.rule();
      sheet.gap(6);
    }
    for (const c of g.courses) {
      const f = fulls.get(c.id);
      if (!f) continue;
      sheet.space(140);
      courseHeading(sheet, f.course, g.segment?.name ?? null);
      const ordered = [...f.sections].sort((a, b) => a.position - b.position);
      for (const s of ordered) {
        sheet.space(60);
        sheet.text([{ text: s.title || "Untitled section", bold: true }], { size: 13.5, color: PINK, gapAfter: 4 });
        const objs = f.objects.filter((o) => o.section_id === s.id).sort((a, b) => a.position - b.position);
        for (const o of objs) await renderObject(sheet, o);
        sheet.gap(6);
      }
      done += 1;
      onProgress?.(`Rendering ${c.title}`, done, courses.length);
      sheet.newPage();
    }
  }

  onProgress?.("Saving…", courses.length, courses.length);
  save(doc, `Course Handbook - ${script === "simp" ? "Simplified" : "Traditional"}.pdf`);
}
