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
}) {
  const { schedule, rooms, blocks, employees, campusName, cellColors = {} } = opts;
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
  ].join("");
  const cjk = await ensureCjkFont(doc, allText);
  const FONT = cjk ?? "helvetica";

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
    doc.text(title, M, M + 13);

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
    doc.text(bits.join("  ·  "), M, M + 30);

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
      doc.text(fit(doc, r.name, pos.w - 8), pos.x + pos.w / 2, gridTop - roomHeaderH + 13, { align: "center" });

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
      const innerW = subW - 11;
      const primary = isPlan
        ? (b.label ?? "").trim() || "Block"
        : emp
        ? preferFull(doc, getDisplayName(emp), getFirstName(emp), innerW)
        : (b.label ?? "Unassigned");

      doc.setTextColor(15, 23, 42);
      doc.setFont(FONT, "bold");
      let extraLines = 0;

      if (h >= 12) {
        doc.setFontSize(8.5);
        // Plan labels can carry typed newlines - render each on its own line,
        // as many as the block's height allows.
        const lines = primary.split(/\r?\n/).filter((l) => l.length > 0);
        const LINE_H = 9;
        const maxLines = Math.max(1, Math.floor((h - 10) / LINE_H));
        const shown = lines.slice(0, Math.max(1, Math.min(lines.length, maxLines)));
        shown.forEach((ln, li) => doc.text(fit(doc, ln, innerW), x + 7, y0 + 10 + li * LINE_H));
        extraLines = shown.length - 1;
      } else {
        // A 5–10 minute slot is only a few points tall, so the name can't fit
        // inside. Draw it anyway — smaller, vertically centred, and allowed to
        // spill past the card — rather than leaving an unreadable empty sliver.
        doc.setFontSize(6.8);
        const baseline = y0 + h / 2 + 2.3;
        const nameStr = fit(doc, primary, subW - 6);
        doc.text(nameStr, x + 6, baseline);

        // There's usually room to the right of a shrunken name for the times.
        const timeStr = `${formatTime(b.start_time)}–${formatTime(b.end_time)}`;
        const used = doc.getTextWidth(nameStr);
        doc.setFont(FONT, "normal");
        doc.setFontSize(6.2);
        if (doc.getTextWidth(timeStr) <= subW - 9 - used - 3) {
          doc.setTextColor(100, 116, 139);
          doc.text(timeStr, x + 6 + used + 3, baseline);
        }
      }

      const shift = extraLines * 9;
      if (h >= 22 + shift) {
        doc.setFont(FONT, "normal");
        doc.setFontSize(7.5);
        doc.setTextColor(100, 116, 139);
        doc.text(fit(doc, `${formatTime(b.start_time)}–${formatTime(b.end_time)}`, innerW), x + 7, y0 + 19 + shift);
      }
      // A non-plan block's own label, when there's room for a third line.
      if (!isPlan && emp && b.label && h >= 32 + shift) {
        doc.setTextColor(79, 70, 229);
        doc.setFont(FONT, "bold");
        doc.setFontSize(7);
        doc.text(fit(doc, b.label, innerW), x + 7, y0 + 28 + shift);
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

/** Use the full name when it fits, otherwise fall back to the short one. */
function preferFull(doc: any, full: string, short: string, maxW: number): string {
  return doc.getTextWidth(full) <= maxW ? full : short;
}

/** Truncate text with an ellipsis so it fits the given width. */
function fit(doc: any, text: string, maxW: number): string {
  const t = (text ?? "").toString();
  if (!t) return "";
  if (doc.getTextWidth(t) <= maxW) return t;
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.getTextWidth(t.slice(0, mid) + "…") <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? t.slice(0, lo) + "…" : "";
}
