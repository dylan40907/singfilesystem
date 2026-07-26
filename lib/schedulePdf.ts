import type { jsPDF } from "jspdf";
import {
  Schedule,
  ScheduleRoom,
  ScheduleBlock,
  EmployeeLite,
  DAY_LABELS,
  DAY_NUMBERS,
  SLOT_MINUTES,
  timeToMinutes,
  minutesToTime,
  formatTime,
  scheduleTitle,
  getDisplayName,
  getFirstName,
} from "@/lib/scheduleUtils";

/**
 * Vector PDF export of a schedule.
 *
 * Layout rules, in priority order:
 *  1. Columns must be readable — we never squeeze every room onto one page.
 *     Rooms are paginated so each sub-column gets at least MIN_SUB_W points.
 *  2. Rooms with nothing on them that day are dropped entirely.
 *  3. All of a day's rooms are emitted before moving to the next day.
 *
 * Drawn programmatically rather than screenshotting the DOM, so it stays crisp
 * and doesn't depend on the grid's sticky/scroll layout.
 */

type Rgb = [number, number, number];

/** Per-day painted cell backgrounds: day -> "roomId:colIdx:HH:MM" -> hex. */
export type CellColorsByDay = Record<number, Record<string, string>>;

const ACCENT: Record<string, Rgb> = {
  shift: [99, 102, 241],
  lunch_break: [249, 115, 22],
  break: [34, 197, 94],
};
const PLAN_ACCENT: Rgb = [124, 58, 237];

/** Minimum width for a single sub-column before we spill onto a new page. */
const MIN_SUB_W = 74;

const CJK_RE = /[㐀-鿿豈-﫿　-〿＀-￯]/;

/**
 * jsPDF's built-in fonts are WinAnsi-only, so Chinese renders as mojibake.
 * When a schedule contains CJK we fetch a subsetted Noto Sans SC (only the
 * glyphs this document actually uses, ~20-40 KB) and embed that instead.
 * Returns the font name to use, or null to stay on Helvetica.
 */
async function ensureCjkFont(doc: any, text: string): Promise<string | null> {
  if (!CJK_RE.test(text)) return null;
  try {
    const res = await fetch("/api/schedule-font", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    const { regular, bold } = (await res.json()) as { regular: string; bold: string };
    doc.addFileToVFS("NotoCJK-Regular.ttf", regular);
    doc.addFont("NotoCJK-Regular.ttf", "NotoCJK", "normal");
    doc.addFileToVFS("NotoCJK-Bold.ttf", bold);
    doc.addFont("NotoCJK-Bold.ttf", "NotoCJK", "bold");
    return "NotoCJK";
  } catch {
    return null; // fall back rather than failing the whole export
  }
}

/**
 * Emoji.
 *
 * jsPDF can only embed TrueType outlines, so colour emoji can never come from a
 * font — they used to be stripped, which turned an emoji-only label into the
 * literal word "Block". Instead we rasterise each emoji through a canvas using
 * the platform's own emoji font (Segoe UI Emoji / Apple Color Emoji), giving the
 * same glyphs the on-screen grid shows, and place them inline as images.
 *
 * Text therefore has to be measured and drawn in runs — see measureRich/drawRich
 * below. Every helper that positions text goes through those, never doc.text /
 * doc.getTextWidth directly, or emoji-bearing strings would be mis-measured.
 */
const EMOJI_CHAR_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE00}-\u{FE0F}\u{20E3}]/u;
const EMOJI_STRIP_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE00}-\u{FE0F}\u{20E3}\u{200D}]/gu;

/** Emoji contribute nothing to the CJK subset — they're drawn as images. */
function stripEmoji(t: string): string {
  return (t ?? "").replace(EMOJI_STRIP_RE, "");
}

type RichSeg = { emoji: boolean; text: string };

let segmenter: Intl.Segmenter | undefined | null = null;
function graphemeSegmenter(): Intl.Segmenter | undefined {
  if (segmenter === null) {
    try {
      segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : undefined;
    } catch {
      segmenter = undefined;
    }
  }
  return segmenter ?? undefined;
}

/**
 * Split into grapheme clusters so ZWJ sequences (👨‍👩‍👧), skin-tone modifiers and
 * flags stay whole — splitting them would render as separate broken glyphs.
 */
function toClusters(text: string): string[] {
  const seg = graphemeSegmenter();
  if (seg) return Array.from(seg.segment(text), (s) => s.segment);

  // Fallback for engines without Intl.Segmenter: glue joiners/modifiers on.
  const out: string[] = [];
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    let c = chars[i];
    while (i + 1 < chars.length && /[‍️⃣\u{1F3FB}-\u{1F3FF}]/u.test(chars[i + 1])) {
      c += chars[++i];
      // A ZWJ always binds the following glyph into the same cluster.
      if (chars[i] === "‍" && i + 1 < chars.length) c += chars[++i];
    }
    out.push(c);
  }
  return out;
}

/**
 * Emoji clusters stay separate (one image each); plain text runs coalesce.
 * Memoised — the font-size search in fitNameLines re-measures the same strings
 * several times per block, and segmenting is the expensive part.
 */
const segmentCache = new Map<string, RichSeg[]>();

function segmentRich(text: string): RichSeg[] {
  const key = text ?? "";
  const hit = segmentCache.get(key);
  if (hit) return hit;

  const out: RichSeg[] = [];
  for (const c of toClusters(key)) {
    const emoji = EMOJI_CHAR_RE.test(c);
    const last = out[out.length - 1];
    if (!emoji && last && !last.emoji) last.text += c;
    else out.push({ emoji, text: c });
  }
  segmentCache.set(key, out);
  return out;
}

/** cluster -> PNG data URL (or null when it can't be rendered). */
const emojiPngCache = new Map<string, string | null>();

function emojiPng(cluster: string): string | null {
  if (emojiPngCache.has(cluster)) return emojiPngCache.get(cluster)!;

  let url: string | null = null;
  try {
    if (typeof document !== "undefined") {
      // Rasterise well above the on-page size so the PDF stays crisp when zoomed.
      const S = 128;
      const canvas = document.createElement("canvas");
      canvas.width = S;
      canvas.height = S;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.font = `${Math.round(S * 0.78)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif`;
        ctx.fillText(cluster, S / 2, S * 0.82);

        // If nothing was painted there's no emoji font here — treat it as
        // unrenderable so it takes no width, instead of leaving a blank gap.
        const { data } = ctx.getImageData(0, 0, S, S);
        let painted = false;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] !== 0) { painted = true; break; }
        }
        if (painted) url = canvas.toDataURL("image/png");
      }
    }
  } catch {
    url = null; // never let a single glyph kill the export
  }

  emojiPngCache.set(cluster, url);
  return url;
}

/** Stable ASCII key for a cluster, e.g. "emoji-1f469-200d-1f373". */
function emojiAlias(cluster: string): string {
  return "emoji-" + Array.from(cluster).map((c) => c.codePointAt(0)!.toString(16)).join("-");
}

/** Advance width for one emoji at the given font size. */
function emojiWidth(cluster: string, fontSize: number): number {
  return emojiPng(cluster) ? fontSize * 1.1 : 0;
}

/** doc.getTextWidth, but emoji-aware. Uses the doc's current font size. */
function measureRich(doc: jsPDF, text: string): number {
  const fs = doc.getFontSize();
  let w = 0;
  for (const s of segmentRich(text)) {
    w += s.emoji ? emojiWidth(s.text, fs) : doc.getTextWidth(s.text);
  }
  return w;
}

/** doc.text, but emoji are drawn as inline images. */
function drawRich(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  opts?: { align?: "left" | "center" | "right" }
) {
  const segs = segmentRich(text);
  if (!segs.length) return;

  const fs = doc.getFontSize();
  const align = opts?.align ?? "left";
  let cx = x;
  if (align !== "left") {
    const total = measureRich(doc, text);
    cx = align === "center" ? x - total / 2 : x - total;
  }

  for (const s of segs) {
    if (!s.emoji) {
      doc.text(s.text, cx, y);
      cx += doc.getTextWidth(s.text);
      continue;
    }
    const png = emojiPng(s.text);
    if (!png) continue; // unrenderable: contributes no width either
    const adv = fs * 1.1;
    const size = fs;
    try {
      // Sit the glyph on the text baseline. The alias dedupes repeats so the
      // same emoji is only embedded once no matter how often it appears — keep
      // it plain ASCII rather than the raw cluster, since it becomes a PDF key.
      doc.addImage(png, "PNG", cx + (adv - size) / 2, y - size * 0.82, size, size, emojiAlias(s.text), "FAST");
    } catch {
      /* skip this glyph rather than fail the export */
    }
    cx += adv;
  }
}

function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec((hex ?? "").trim());
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

export async function downloadSchedulePdf(opts: {
  schedule: Schedule;
  rooms: ScheduleRoom[];
  blocks: ScheduleBlock[];
  employees: EmployeeLite[];
  campusName?: string | null;
  cellColors?: CellColorsByDay;
  /** Surfaced when the export degrades (e.g. the CJK font couldn't load). */
  onWarn?: (message: string) => void;
}) {
  const { schedule, rooms, blocks, employees, campusName, cellColors = {}, onWarn } = opts;
  const { jsPDF } = await import("jspdf");

  const isPlan = schedule.kind === "plan";
  const empById = new Map(employees.map((e) => [e.id, e]));
  const title = scheduleTitle(schedule);

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const M = 30;
  const headerH = 50;
  const roomHeaderH = 20;
  const timeColW = 46;

  // One shared time axis for the whole document so pages stay comparable.
  const allMins = blocks.flatMap((b) => [timeToMinutes(b.start_time), timeToMinutes(b.end_time)]);
  const startMin = allMins.length ? Math.floor(Math.min(...allMins) / 60) * 60 : 8 * 60;
  const endMin = allMins.length ? Math.ceil(Math.max(...allMins) / 60) * 60 : 17 * 60;
  const span = Math.max(60, endMin - startMin);

  const gridTop = M + headerH + roomHeaderH;
  const gridH = pageH - gridTop - M;
  const gridLeft = M + timeColW;
  const gridW = pageW - gridLeft - M;
  const yFor = (mins: number) => gridTop + ((mins - startMin) / span) * gridH;

  const subCount = (r: ScheduleRoom) => Math.max(1, r.columns ?? 1);

  // ── Build the page list: for each day, only the rooms in use, chunked so
  //    every sub-column clears MIN_SUB_W. ────────────────────────────────────
  type Page = { day: number; rooms: ScheduleRoom[]; part: number; parts: number };
  const pages: Page[] = [];

  for (const day of DAY_NUMBERS) {
    const dayBlocks = blocks.filter((b) => b.day_of_week === day);
    const dayColors = cellColors[day] ?? {};
    const paintedRoomIds = new Set(Object.keys(dayColors).map((k) => k.split(":")[0]));

    // Drop rooms with neither blocks nor paint on this day.
    const used = rooms.filter(
      (r) => dayBlocks.some((b) => b.room_id === r.id) || paintedRoomIds.has(r.id)
    );
    if (used.length === 0) continue;

    const chunks: ScheduleRoom[][] = [];
    let cur: ScheduleRoom[] = [];
    let curSubs = 0;
    for (const r of used) {
      const subs = subCount(r);
      if (cur.length > 0 && (curSubs + subs) * MIN_SUB_W > gridW) {
        chunks.push(cur);
        cur = [];
        curSubs = 0;
      }
      cur.push(r);
      curSubs += subs;
    }
    if (cur.length) chunks.push(cur);

    chunks.forEach((chunkRooms, i) =>
      pages.push({ day, rooms: chunkRooms, part: i + 1, parts: chunks.length })
    );
  }

  if (pages.length === 0) pages.push({ day: DAY_NUMBERS[0], rooms: [], part: 1, parts: 1 });

  // Everything we're going to draw — used to subset the CJK font.
  const allText = [
    title,
    campusName ?? "",
    ...rooms.map((r) => r.name),
    ...employees.map((e) => `${getDisplayName(e)}${getFirstName(e)}`),
    ...blocks.map((b) => b.label ?? ""),
    "0123456789:–.,·  ",
    ...DAY_LABELS,
    "Weekly schedulePlanPublishedDraftRoomsofPage",
  ]
    .map(stripEmoji) // emoji are drawn as images, not glyphs from this font
    .join("");
  const cjk = await ensureCjkFont(doc, allText);
  const FONT = cjk ?? "helvetica";
  // Don't silently emit mojibake — say so if the CJK font didn't load.
  if (!cjk && CJK_RE.test(allText)) {
    onWarn?.("Chinese characters may not render — the PDF font could not be loaded.");
  }

  pages.forEach((page, pageIdx) => {
    if (pageIdx > 0) doc.addPage();

    const { day, rooms: pageRooms } = page;
    const dayBlocks = blocks.filter((b) => b.day_of_week === day);
    const dayColors = cellColors[day] ?? {};

    // Uniform sub-column width across the page.
    const totalSubs = pageRooms.reduce((n, r) => n + subCount(r), 0) || 1;
    const subW = gridW / totalSubs;

    // Room x-offsets
    const roomX = new Map<string, { x: number; w: number; subs: number }>();
    let cursor = gridLeft;
    for (const r of pageRooms) {
      const subs = subCount(r);
      const w = subs * subW;
      roomX.set(r.id, { x: cursor, w, subs });
      cursor += w;
    }

    // ── Header ──────────────────────────────────────────────────────────────
    doc.setFont(FONT, "bold");
    doc.setFontSize(15);
    doc.setTextColor(17, 24, 39);
    drawRich(doc, title, M, M + 13);

    doc.setFont(FONT, "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(107, 114, 128);
    const dayLabel = DAY_LABELS[day - 1] ?? "";
    const bits = [
      isPlan ? "Plan" : "Weekly schedule",
      dayLabel,
      campusName || null,
      schedule.status === "published" ? "Published" : "Draft",
      page.parts > 1 ? `Rooms ${page.part} of ${page.parts}` : null,
    ].filter(Boolean);
    drawRich(doc, bits.join("  ·  "), M, M + 30);

    // ── Painted cell backgrounds (merged into runs to avoid hairlines) ──────
    // key = roomId:colIdx:HH:MM
    const runs = new Map<string, { color: string; slots: number[] }>();
    for (const [key, color] of Object.entries(dayColors)) {
      // key is roomId:colIdx:HH:MM — pop from the right so the UUID stays intact.
      const parts = key.split(":");
      if (parts.length < 4) continue;
      const mm = parts.pop()!;
      const hh = parts.pop()!;
      const colIdx = parts.pop()!;
      const roomId = parts.join(":");
      if (!roomX.has(roomId)) continue;
      const mins = timeToMinutes(`${hh}:${mm}`);
      const groupKey = `${roomId}|${colIdx}|${color}`;
      const g = runs.get(groupKey) ?? { color, slots: [] };
      g.slots.push(mins);
      runs.set(groupKey, g);
    }

    for (const [groupKey, { color, slots }] of runs) {
      const [roomId, colIdxStr] = groupKey.split("|");
      const pos = roomX.get(roomId);
      if (!pos) continue;
      const rgb = hexToRgb(color);
      if (!rgb) continue;
      const colIdx = Math.min(Math.max(0, Number(colIdxStr) || 0), pos.subs - 1);
      const x = pos.x + colIdx * subW;

      slots.sort((a, b) => a - b);
      let runStart = slots[0];
      let prev = slots[0];
      const flush = (from: number, toExclusive: number) => {
        const y0 = yFor(from);
        const y1 = yFor(toExclusive);
        doc.setFillColor(rgb[0], rgb[1], rgb[2]);
        doc.rect(x, y0, subW, Math.max(0.6, y1 - y0), "F");
      };
      for (let i = 1; i < slots.length; i++) {
        if (slots[i] !== prev + SLOT_MINUTES) {
          flush(runStart, prev + SLOT_MINUTES);
          runStart = slots[i];
        }
        prev = slots[i];
      }
      flush(runStart, prev + SLOT_MINUTES);
    }

    // ── Hour lines + time gutter ────────────────────────────────────────────
    doc.setFontSize(8);
    doc.setFont(FONT, "normal");
    for (let m = startMin; m <= endMin; m += 60) {
      const y = yFor(m);
      doc.setDrawColor(226, 232, 240);
      doc.setLineWidth(0.5);
      doc.line(gridLeft, y, gridLeft + gridW, y);
      doc.setTextColor(148, 163, 184);
      doc.text(formatTime(minutesToTime(m)), gridLeft - 6, y + 3, { align: "right" });
    }

    // ── Room headers + separators ───────────────────────────────────────────
    doc.setFontSize(9);
    for (const r of pageRooms) {
      const pos = roomX.get(r.id)!;
      doc.setFillColor(249, 250, 251);
      doc.rect(pos.x, gridTop - roomHeaderH, pos.w, roomHeaderH, "F");
      doc.setDrawColor(203, 213, 225);
      doc.setLineWidth(0.6);
      doc.rect(pos.x, gridTop - roomHeaderH, pos.w, roomHeaderH, "S");
      doc.setFont(FONT, "bold");
      doc.setTextColor(51, 65, 85);
      drawRich(doc, fit(doc, r.name, pos.w - 8), pos.x + pos.w / 2, gridTop - roomHeaderH + 13, { align: "center" });

      // Faint sub-column dividers inside the room
      doc.setDrawColor(241, 245, 249);
      for (let c = 1; c < pos.subs; c++) {
        const x = pos.x + c * subW;
        doc.line(x, gridTop, x, gridTop + gridH);
      }
      // Room divider
      doc.setDrawColor(203, 213, 225);
      doc.line(pos.x, gridTop, pos.x, gridTop + gridH);
    }
    doc.setDrawColor(203, 213, 225);
    doc.rect(gridLeft, gridTop, gridW, gridH, "S");

    // ── Blocks ──────────────────────────────────────────────────────────────
    // Geometry first, so we can draw every card before any label. Two passes
    // keep short blocks' overflowing text on top of their neighbours' boxes.
    const laidOut = dayBlocks.flatMap((b) => {
      const pos = roomX.get(b.room_id);
      if (!pos) return [];
      const colIdx = Math.min(Math.max(0, b.column_index ?? 0), pos.subs - 1);
      const x = pos.x + colIdx * subW;
      const y0 = yFor(timeToMinutes(b.start_time));
      const y1 = yFor(timeToMinutes(b.end_time));
      return [{ b, x, y0, h: Math.max(3, y1 - y0) }];
    });

    // Pass 1 — cards. The body is a translucent white so the painted cell
    // colour behind it still reads through, matching the on-screen grid.
    const GState = (doc as any).GState;
    for (const { b, x, y0, h } of laidOut) {
      const accent = isPlan ? PLAN_ACCENT : (ACCENT[b.block_type] ?? ACCENT.shift);
      const bh = Math.max(1.4, h - 1);

      doc.setGState(new GState({ opacity: 0.62 }));
      doc.setFillColor(255, 255, 255);
      doc.roundedRect(x + 1.5, y0 + 0.5, subW - 3, bh, 2.5, 2.5, "F");

      // Border + accent stay fully opaque so edges remain crisp.
      doc.setGState(new GState({ opacity: 1 }));
      doc.setDrawColor(203, 213, 225);
      doc.setLineWidth(0.6);
      doc.roundedRect(x + 1.5, y0 + 0.5, subW - 3, bh, 2.5, 2.5, "S");
      doc.setFillColor(accent[0], accent[1], accent[2]);
      doc.rect(x + 1.5, y0 + 0.5, 2.6, bh, "F");
    }

    // Pass 2 — labels.
    for (const { b, x, y0, h } of laidOut) {
      const emp = b.employee_id ? empById.get(b.employee_id) : null;
      const innerX = x + 7;
      const innerW = subW - 11;
      const primary =
        (isPlan
          ? (b.label ?? "").trim() || "Block"
          : emp
          ? preferFull(doc, getDisplayName(emp), getFirstName(emp), innerW)
          : (b.label ?? "Unassigned")
        ).trim() || (isPlan ? "Block" : "—");
      const timeStr = `${formatTime(b.start_time)}–${formatTime(b.end_time)}`;
      const secondary = !isPlan && emp && b.label ? b.label.trim() || null : null;

      // EVERY block shows both its name and its time. We reserve the time's
      // space first, then fit the name into what's left — shrinking the font,
      // and only clipping as a last resort — so the time is never dropped.
      if (h >= 20) {
        // Stacked: name line(s) on top, time (and optional note) beneath.
        const secondaryH = secondary ? 8 : 0;
        const availNameH = Math.max(9, h - 6 - 9 /* time line */ - secondaryH);
        const { font, lineH, lines: nameLines } = fitNameLines(doc, primary, innerW, availNameH);

        doc.setFont(FONT, "bold");
        doc.setFontSize(font);
        doc.setTextColor(15, 23, 42);
        nameLines.forEach((ln, li) => drawRich(doc, ln, innerX, y0 + font + 1 + li * lineH));

        const timeY = y0 + font + 1 + nameLines.length * lineH + 1;
        doc.setFont(FONT, "normal");
        doc.setFontSize(6.8);
        doc.setTextColor(100, 116, 139);
        doc.text(fit(doc, timeStr, innerW), innerX, timeY);

        if (secondary) {
          doc.setFont(FONT, "bold");
          doc.setFontSize(6.6);
          doc.setTextColor(79, 70, 229);
          drawRich(doc, fit(doc, secondary, innerW), innerX, timeY + 8);
        }
      } else {
        // Inline: too short to stack — the name and its time share one baseline,
        // with the time sitting directly to the RIGHT of the name (not far-right
        // aligned). The name shrinks to leave room for the time beside it.
        const baseline = y0 + h / 2 + 2.3;
        const gap = 3;

        // Reserve the time's width first so the name can't crowd it out.
        const timeFs = 6.2;
        doc.setFont(FONT, "normal");
        doc.setFontSize(timeFs);
        const timeW = doc.getTextWidth(timeStr);

        const nameMaxW = Math.max(6, subW - 8 - gap - timeW);
        doc.setFont(FONT, "bold");
        let nameFs = 6.9;
        doc.setFontSize(nameFs);
        while (nameFs > 4.8 && measureRich(doc, primary) > nameMaxW) { nameFs -= 0.3; doc.setFontSize(nameFs); }
        doc.setTextColor(15, 23, 42);
        const nameDrawn = fit(doc, primary, nameMaxW);
        drawRich(doc, nameDrawn, innerX, baseline);
        const nameW = measureRich(doc, nameDrawn);

        doc.setFont(FONT, "normal");
        doc.setFontSize(timeFs);
        doc.setTextColor(100, 116, 139);
        doc.text(timeStr, innerX + nameW + gap, baseline);
      }
    }

    // Footer
    doc.setFont(FONT, "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.text(`Page ${pageIdx + 1} of ${pages.length}`, pageW - M, pageH - 12, { align: "right" });
  });

  const safe = title.replace(/[^\w\s-]+/g, "").trim().replace(/\s+/g, "-") || "schedule";
  doc.save(`${safe}.pdf`);
}

/**
 * Fit (wrapping) text into width `W` and height `availH`. Tries decreasing font
 * sizes and accepts the first where every wrapped line fits the width AND the
 * line count fits the height — so the name shrinks rather than losing its time.
 * Only when even the minimum size won't fit does it clip the last line.
 */
function fitNameLines(
  doc: any,
  text: string,
  W: number,
  availH: number
): { font: number; lineH: number; lines: string[] } {
  for (let f = 8.5; f >= 6; f -= 0.5) {
    doc.setFontSize(f);
    const lineH = f * 1.06;
    const maxLines = Math.max(1, Math.floor(availH / lineH));
    const lines = wrapRich(doc, text, W);
    if (lines.length <= maxLines && lines.every((l) => measureRich(doc, l) <= W)) {
      return { font: f, lineH, lines };
    }
  }

  // Minimum size — clip to fit both width and height.
  const f = 6;
  doc.setFontSize(f);
  const lineH = f * 1.06;
  const maxLines = Math.max(1, Math.floor(availH / lineH));
  const all = wrapRich(doc, text, W);
  const shown = all.slice(0, maxLines).map((l) => fit(doc, l, W));
  if (all.length > shown.length && shown.length) {
    shown[shown.length - 1] = fit(doc, (all[shown.length - 1] ?? "") + "…", W);
  }
  return { font: f, lineH, lines: shown.length ? shown : [fit(doc, text, W)] };
}

/**
 * Word-wrap to width `W`. Replaces doc.splitTextToSize, which measures with
 * getTextWidth and so would treat emoji as zero-width.
 */
function wrapRich(doc: jsPDF, text: string, W: number): string[] {
  const wrapped: string[] = [];

  for (const para of (text ?? "").split(/\r?\n/)) {
    if (!para.trim()) continue;
    let cur = "";
    for (const token of para.split(/(\s+)/)) {
      if (!token) continue;
      const next = cur + token;
      if (cur && measureRich(doc, next.trim()) > W) {
        wrapped.push(cur.trim());
        cur = token.trim() ? token : "";
      } else {
        cur = next;
      }
    }
    if (cur.trim()) wrapped.push(cur.trim());
  }

  // A single unbroken token (or one very wide emoji run) can still overflow.
  const out: string[] = [];
  for (const line of wrapped) {
    if (measureRich(doc, line) <= W) {
      out.push(line);
      continue;
    }
    let buf = "";
    for (const c of toClusters(line)) {
      if (buf && measureRich(doc, buf + c) > W) {
        out.push(buf);
        buf = c;
      } else {
        buf += c;
      }
    }
    if (buf) out.push(buf);
  }
  return out;
}

/** Use the full name when it fits, otherwise fall back to the short one. */
function preferFull(doc: any, full: string, short: string, maxW: number): string {
  return measureRich(doc, full) <= maxW ? full : short;
}

/** Truncate text with an ellipsis so it fits the given width. */
function fit(doc: any, text: string, maxW: number): string {
  const t = (text ?? "").toString();
  if (!t) return "";
  if (measureRich(doc, t) <= maxW) return t;
  // Cut on grapheme clusters so a multi-codepoint emoji is never split apart.
  const clusters = toClusters(t);
  let lo = 0;
  let hi = clusters.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureRich(doc, clusters.slice(0, mid).join("") + "…") <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? clusters.slice(0, lo).join("") + "…" : "";
}
