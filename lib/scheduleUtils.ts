// Schedule utility functions

export type ScheduleStatus = "draft" | "published";

export interface Schedule {
  id: string;
  week_start: string; // YYYY-MM-DD (always a Monday)
  status: ScheduleStatus;
  created_at: string;
  updated_at: string;
}

export interface ScheduleRoom {
  id: string;
  schedule_id: string;
  name: string;
  columns: number;
  sort_order: number;
  created_at: string;
  required_teachers: number;
  single_teacher_periods: Array<{ start: string; end: string }>;
}

export type BlockType = "shift" | "lunch_break" | "break";

export interface ScheduleBlock {
  id: string;
  schedule_id: string;
  room_id: string;
  employee_id: string | null;
  day_of_week: number; // 1=Mon, 5=Fri
  start_time: string; // "HH:mm" or "HH:mm:ss"
  end_time: string;
  column_index: number;
  label: string | null;
  block_type: BlockType;
  created_at: string;
  updated_at: string;
}

export interface EmployeeLite {
  id: string;
  legal_first_name: string | null;
  legal_middle_name: string | null;
  legal_last_name: string | null;
  nicknames: string | string[] | null;
  is_active: boolean;
  profile_id: string | null;
}

// Time constants
export const START_HOUR = 7;
export const START_MINUTE = 0;
export const END_HOUR = 18;
export const END_MINUTE = 0;
export const SLOT_MINUTES = 5;
export const START_MINUTES = START_HOUR * 60 + START_MINUTE; // 440
export const END_MINUTES = END_HOUR * 60 + END_MINUTE; // 1080
export const TOTAL_SLOTS = (END_MINUTES - START_MINUTES) / SLOT_MINUTES; // 128
export const PX_PER_SLOT = 14; // pixels per 5-minute slot

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;
export const DAY_NUMBERS = [1, 2, 3, 4, 5] as const;

/** Get the Monday of the week containing the given date */
export function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Format a date as YYYY-MM-DD (no timezone shift) */
export function formatDateLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Parse a YYYY-MM-DD string into a local Date */
export function parseDateLocal(str: string): Date {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Get Friday from a Monday date */
export function getFriday(monday: Date): Date {
  const fri = new Date(monday);
  fri.setDate(fri.getDate() + 4);
  return fri;
}

/** Format a week range like "March 23 - March 27" */
export function formatWeekRange(mondayStr: string): string {
  const mon = parseDateLocal(mondayStr);
  const fri = getFriday(mon);
  const monMonth = mon.toLocaleString("en-US", { month: "long" });
  const friMonth = fri.toLocaleString("en-US", { month: "long" });
  if (monMonth === friMonth) {
    return `${monMonth} ${mon.getDate()} - ${fri.getDate()}`;
  }
  return `${monMonth} ${mon.getDate()} - ${friMonth} ${fri.getDate()}`;
}

/** Convert "HH:mm" or "HH:mm:ss" to total minutes from midnight */
export function timeToMinutes(time: string): number {
  const parts = time.split(":");
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

/** Convert total minutes from midnight to "HH:mm" */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Format a time string as "8:15 AM" */
export function formatTime(time: string): string {
  const mins = timeToMinutes(time);
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  return `${h12}:${String(m).padStart(2, "0")}`;
}

/** Format a time range like "8:15 AM - 8:40 AM" */
export function formatTimeRange(startTime: string, endTime: string): string {
  return `${formatTime(startTime)} - ${formatTime(endTime)}`;
}

/** Generate all 5-minute time slots from 7:20 AM to 6:00 PM */
export function generateTimeSlots(): string[] {
  const slots: string[] = [];
  for (let m = START_MINUTES; m < END_MINUTES; m += SLOT_MINUTES) {
    slots.push(minutesToTime(m));
  }
  return slots;
}

/** Convert a Y pixel offset in the grid to minutes from midnight */
export function yToMinutes(y: number): number {
  const slotIndex = Math.round(y / PX_PER_SLOT);
  const clamped = Math.max(0, Math.min(TOTAL_SLOTS - 1, slotIndex));
  return START_MINUTES + clamped * SLOT_MINUTES;
}

/** Convert minutes from midnight to Y pixel offset in the grid */
export function minutesToY(minutes: number): number {
  const slotIndex = (minutes - START_MINUTES) / SLOT_MINUTES;
  return slotIndex * PX_PER_SLOT;
}

/** Snap minutes to the nearest 5-minute increment within grid bounds */
export function snapMinutes(minutes: number): number {
  const snapped = Math.round(minutes / SLOT_MINUTES) * SLOT_MINUTES;
  return Math.max(START_MINUTES, Math.min(END_MINUTES, snapped));
}

/** Check if two time ranges overlap.
 *  Uses minute-based comparison to avoid "HH:mm" vs "HH:mm:ss" string issues. */
export function timeOverlaps(
  s1: string, e1: string,
  s2: string, e2: string
): boolean {
  return timeToMinutes(s1) < timeToMinutes(e2) && timeToMinutes(s2) < timeToMinutes(e1);
}

/** Calculate total paid minutes for an employee on a given day.
 *  Only 'shift' and 'break' count — 'lunch_break' is excluded. */
export function calculatePaidMinutes(
  blocks: ScheduleBlock[],
  employeeId: string,
  dayOfWeek: number,
  excludeBlockId?: string
): number {
  return blocks
    .filter(
      (b) =>
        b.employee_id === employeeId &&
        b.day_of_week === dayOfWeek &&
        b.block_type !== "lunch_break" &&
        (!excludeBlockId || b.id !== excludeBlockId)
    )
    .reduce(
      (sum, b) => sum + timeToMinutes(b.end_time) - timeToMinutes(b.start_time),
      0
    );
}

/** Find blocks that conflict with a candidate block (same employee, same day, overlapping times) */
export function detectConflicts(
  blocks: ScheduleBlock[],
  candidateBlock: {
    id?: string;
    employee_id: string | null;
    day_of_week: number;
    start_time: string;
    end_time: string;
  }
): ScheduleBlock[] {
  if (!candidateBlock.employee_id) return []; // labels never conflict
  return blocks.filter(
    (b) =>
      b.id !== candidateBlock.id &&
      b.employee_id === candidateBlock.employee_id &&
      b.day_of_week === candidateBlock.day_of_week &&
      timeOverlaps(b.start_time, b.end_time, candidateBlock.start_time, candidateBlock.end_time)
  );
}

/** Format employee name from parts */
export function formatEmployeeName(emp: EmployeeLite): string {
  return [emp.legal_first_name, emp.legal_middle_name, emp.legal_last_name]
    .filter(Boolean)
    .join(" ");
}

/** Get display name: nickname if available, else legal name */
export function getDisplayName(emp: EmployeeLite): string {
  // nicknames may be stored as an array or string in the DB
  const nick = Array.isArray(emp.nicknames)
    ? (emp.nicknames as string[]).join(", ")
    : emp.nicknames;
  if (nick && nick.trim()) return nick.trim();
  return formatEmployeeName(emp);
}

/** Get short first name for compact block display: first nickname word, or legal first name */
export function getFirstName(emp: EmployeeLite): string {
  const nick = Array.isArray(emp.nicknames)
    ? (emp.nicknames as string[])[0]
    : emp.nicknames;
  if (nick && nick.trim()) return nick.trim().split(" ")[0];
  return emp.legal_first_name?.trim() || formatEmployeeName(emp);
}

/** Generate week options starting from a given Monday, going forward N weeks */
export function generateWeekOptions(fromDate: Date, count: number): string[] {
  const monday = getMonday(fromDate);
  const weeks: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i * 7);
    weeks.push(formatDateLocal(d));
  }
  return weeks;
}
