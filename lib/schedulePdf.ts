import {
  Schedule,
  ScheduleRoom,
  ScheduleBlock,
  EmployeeLite,
  DAY_LABELS,
  DAY_NUMBERS,
  timeToMinutes,
  formatTime,
  scheduleTitle,
  getFirstName,
} from "@/lib/scheduleUtils";

/**
 * Vector PDF export of a schedule — one landscape page per weekday, rooms across
 * the top and time down the side. Drawn programmatically (rather than screen-
 * shotting the DOM) so it stays crisp, paginates cleanly, and doesn't depend on
 * the grid's sticky/scroll layout.
 */

type Rgb = [number, number, number];

const BLOCK_FILL: Record<string, Rgb> = {
  shift: [224, 231, 255],      // indigo-100
  lunch_break: [255, 237, 213], // orange-100
  break: [220, 252, 231],       // green-100
};
const BLOCK_STROKE: Record<string, Rgb> = {
  shift: [99, 102, 241],
  lunch_break: [249, 115, 22],
  break: [34, 197, 94],
};
const PLAN_FILL: Rgb = [237, 233, 254];   // violet-100
const PLAN_STROKE: Rgb = [124, 58, 237];

export async function downloadSchedulePdf(opts: {
  schedule: Schedule;
  rooms: ScheduleRoom[];
  blocks: ScheduleBlock[];
  employees: EmployeeLite[];
  campusName?: string | null;
}) {
  const { schedule, rooms, blocks, employees, campusName } = opts;
  // Loaded on demand so jsPDF never lands in the initial page bundle.
  const { jsPDF } = await import("jspdf");

  const isPlan = schedule.kind === "plan";
  const empById = new Map(employees.map((e) => [e.id, e]));
  const title = scheduleTitle(schedule);

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const M = 32;                 // page margin
  const headerH = 54;           // title block
  const roomHeaderH = 22;       // room name row
  const timeColW = 52;          // left time gutter

  // Only render the time window that actually contains blocks, so the page
  // isn't mostly empty whitespace.
  const allMins = blocks.flatMap((b) => [timeToMinutes(b.start_time), timeToMinutes(b.end_time)]);
  const startMin = allMins.length ? Math.floor(Math.min(...allMins) / 60) * 60 : 8 * 60;
  const endMin = allMins.length ? Math.ceil(Math.max(...allMins) / 60) * 60 : 17 * 60;
  const span = Math.max(60, endMin - startMin);

  const gridTop = M + headerH + roomHeaderH;
  const gridH = pageH - gridTop - M;
  const gridLeft = M + timeColW;
  const gridW = pageW - gridLeft - M;

  const yFor = (mins: number) => gridTop + ((mins - startMin) / span) * gridH;

  // Each room occupies equal width; a room's internal columns split it further.
  const roomW = rooms.length ? gridW / rooms.length : gridW;

  const days = DAY_NUMBERS.filter((d) => blocks.some((b) => b.day_of_week === d));
  const pages = days.length ? days : [DAY_NUMBERS[0]];

  pages.forEach((day, pageIdx) => {
    if (pageIdx > 0) doc.addPage();

    // ── Header ──────────────────────────────────────────────────────────────
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(17, 24, 39);
    doc.text(title, M, M + 14);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(107, 114, 128);
    const dayLabel = DAY_LABELS[DAY_NUMBERS.indexOf(day)] ?? "";
    const bits = [
      isPlan ? "Plan" : "Weekly schedule",
      dayLabel,
      campusName || null,
      schedule.status === "published" ? "Published" : "Draft",
    ].filter(Boolean);
    doc.text(bits.join("  ·  "), M, M + 32);

    // ── Room headers ────────────────────────────────────────────────────────
    doc.setFontSize(9);
    rooms.forEach((room, i) => {
      const x = gridLeft + i * roomW;
      doc.setFillColor(249, 250, 251);
      doc.rect(x, gridTop - roomHeaderH, roomW, roomHeaderH, "F");
      doc.setDrawColor(229, 231, 235);
      doc.rect(x, gridTop - roomHeaderH, roomW, roomHeaderH, "S");
      doc.setFont("helvetica", "bold");
      doc.setTextColor(55, 65, 81);
      doc.text(fit(doc, room.name, roomW - 8), x + 4, gridTop - roomHeaderH + 14);
    });

    // ── Hour lines + time gutter ────────────────────────────────────────────
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    for (let m = startMin; m <= endMin; m += 60) {
      const y = yFor(m);
      doc.setDrawColor(235, 238, 242);
      doc.line(gridLeft, y, gridLeft + gridW, y);
      doc.setTextColor(156, 163, 175);
      doc.text(formatTime(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`), M, y + 3);
    }

    // Vertical room separators + outer border
    doc.setDrawColor(209, 213, 219);
    rooms.forEach((_, i) => {
      const x = gridLeft + i * roomW;
      doc.line(x, gridTop, x, gridTop + gridH);
    });
    doc.rect(gridLeft, gridTop, gridW, gridH, "S");

    // ── Blocks ──────────────────────────────────────────────────────────────
    const dayBlocks = blocks.filter((b) => b.day_of_week === day);
    for (const b of dayBlocks) {
      const roomIdx = rooms.findIndex((r) => r.id === b.room_id);
      if (roomIdx < 0) continue;
      const room = rooms[roomIdx];
      const cols = Math.max(1, room.columns ?? 1);
      const colIdx = Math.min(Math.max(0, b.column_index ?? 0), cols - 1);
      const colW = roomW / cols;

      const x = gridLeft + roomIdx * roomW + colIdx * colW;
      const y0 = yFor(timeToMinutes(b.start_time));
      const y1 = yFor(timeToMinutes(b.end_time));
      const h = Math.max(9, y1 - y0);

      const fill = isPlan ? PLAN_FILL : (BLOCK_FILL[b.block_type] ?? BLOCK_FILL.shift);
      const stroke = isPlan ? PLAN_STROKE : (BLOCK_STROKE[b.block_type] ?? BLOCK_STROKE.shift);

      doc.setFillColor(...fill);
      doc.setDrawColor(...stroke);
      doc.roundedRect(x + 1.5, y0 + 1, colW - 3, h - 2, 3, 3, "FD");

      // Label: the block text for plans, otherwise the person (or label).
      const emp = b.employee_id ? empById.get(b.employee_id) : null;
      const primary = isPlan
        ? (b.label ?? "")
        : emp
        ? getFirstName(emp)
        : (b.label ?? "Unassigned");

      doc.setTextColor(31, 41, 55);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      if (h >= 12) doc.text(fit(doc, primary, colW - 8), x + 4, y0 + 10);

      // Time range on taller blocks only, so short ones stay legible.
      if (h >= 24) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7);
        doc.setTextColor(107, 114, 128);
        doc.text(fit(doc, `${formatTime(b.start_time)}–${formatTime(b.end_time)}`, colW - 8), x + 4, y0 + 19);
      }
    }

    // Footer
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(156, 163, 175);
    doc.text(`Page ${pageIdx + 1} of ${pages.length}`, pageW - M, pageH - 12, { align: "right" });
  });

  const safe = title.replace(/[^\w\s-]+/g, "").trim().replace(/\s+/g, "-") || "schedule";
  doc.save(`${safe}.pdf`);
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
