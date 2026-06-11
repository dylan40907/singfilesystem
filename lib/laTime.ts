// All HR clock/timesheet time logic is anchored to America/Los_Angeles so that
// clock-in/out, auto clock-out, and timesheet display are identical no matter
// where the admin's browser — or the Vercel deploy — happens to run. NEVER use
// the runtime's local timezone (new Date().getHours(), getFullYear(), etc.) for
// these values: an admin pushing/working from another timezone would otherwise
// shift "midnight" and corrupt clock-out times.

export const LA_TZ = "America/Los_Angeles";

// Offset between a UTC instant and what the wall clock reads in LA at that
// instant, expressed as (LA-wall-clock-reinterpreted-as-UTC) − instant. This is
// negative (LA is behind UTC) and automatically reflects PST vs PDT.
function laOffsetMs(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TZ,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = Number(p.value);
  const hour = m.hour === 24 ? 0 : m.hour; // some engines emit "24" at midnight
  const asUTC = Date.UTC(m.year, m.month - 1, m.day, hour, m.minute, m.second);
  return asUTC - date.getTime();
}

/** Current date in LA as "YYYY-MM-DD". */
export function todayLA(): string {
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: LA_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** UTC ISO string for an LA wall-clock time (dateStr = "YYYY-MM-DD"). */
export function laWallTimeToISO(dateStr: string, h: number, min: number, s = 0): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const guessUTC = Date.UTC(y, mo - 1, d, h, min, s);
  // Offset evaluated near the target instant handles PST/PDT correctly.
  const offset = laOffsetMs(new Date(guessUTC));
  return new Date(guessUTC - offset).toISOString();
}

/** UTC ISO for 11:59:59 PM LA on dateStr — the canonical auto clock-out moment. */
export function laEndOfDayISO(dateStr: string): string {
  return laWallTimeToISO(dateStr, 23, 59, 59);
}

/** "HH:MM:SS" of an ISO instant rendered in LA (for <input type="time">). */
export function isoToLATimeInput(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LA_TZ, hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(iso));
  const m: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = p.value;
  const hh = m.hour === "24" ? "00" : m.hour;
  return `${hh}:${m.minute}:${m.second}`;
}

/** "h:mm:ss AM/PM" of an ISO instant rendered in LA. */
export function isoToLADisplayTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: LA_TZ, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
}

/** "YYYY-MM-DD" calendar date of an ISO instant in LA. */
export function isoToLADateStr(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: LA_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

/** Current LA wall-clock time as "HH:MM:SS". */
export function nowLATime(): string {
  return isoToLATimeInput(new Date().toISOString());
}

/** Current LA day-of-week as 1=Mon … 7=Sun. */
export function laDayOfWeek(): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: LA_TZ, weekday: "short" }).format(new Date());
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[wd] ?? 7;
}
