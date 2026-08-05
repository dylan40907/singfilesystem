"use client";

import { useState } from "react";

/**
 * Bookable hours and closed dates for one bookable thing — a preschool tour or
 * an online consultation. Shared by Sales → Tours and Sales → Meetings, which
 * need identical controls over different tour types; keeping one copy means a
 * fix to either tab lands in both.
 */

export type AvailabilityRow = {
  id: string; tour_type_id: string; day_of_week: number; start_time: string; end_time: string;
};
/** A closed date — holidays, a week away. Beats deleting and re-adding hours. */
export type BlackoutRow = { id: string; tour_type_id: string; day: string; reason: string | null };

export type BookableType = {
  id: string; slug: string; name: string;
  duration_minutes: number; min_notice_hours: number; max_days_ahead: number;
};

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Bookable hours for one campus, shown as the whole week so a day with nothing
 * on it is visibly empty rather than just absent from a list. Each card keeps
 * its own draft — they used to share one, so picking a day for Torrance moved
 * North Torrance's picker too.
 */
export default function TypeAvailability({
  type, rows, closed, campusName, onAddWindow, onRemoveWindow, onAddBlackout, onRemoveBlackout,
}: {
  type: BookableType;
  rows: AvailabilityRow[];
  closed: BlackoutRow[];
  campusName: string;
  onAddWindow: (typeId: string, day: number, start: string, end: string) => void;
  onRemoveWindow: (id: string) => void;
  onAddBlackout: (typeId: string, from: string, to: string, reason: string) => void;
  onRemoveBlackout: (id: string) => void;
}) {
  const [day, setDay] = useState(1);
  const [from, setFrom] = useState("09:30");
  const [to, setTo] = useState("12:00");
  const [err, setErr] = useState("");
  const [boFrom, setBoFrom] = useState("");
  const [boTo, setBoTo] = useState("");
  const [boReason, setBoReason] = useState("");

  const byDay = (d: number) =>
    rows.filter((a) => a.day_of_week === d)
      .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));

  // Past closures are history — only what's still ahead is worth showing.
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const upcomingClosed = closed.filter((b) => b.day >= todayKey).sort((a, b) => a.day.localeCompare(b.day));

  function add() {
    setErr("");
    if (to <= from) { setErr("The end time has to be after the start time."); return; }
    // Overlapping windows would offer the same slot twice on the booking page.
    const clash = byDay(day).some((a) => from < String(a.end_time).slice(0, 5) && to > String(a.start_time).slice(0, 5));
    if (clash) { setErr(`That overlaps hours already set for ${DAYS[day]}.`); return; }
    onAddWindow(type.id, day, from, to);
  }

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 14 }}>
      <div className="row-between" style={{ flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
        <div style={{ fontWeight: 800 }}>{type.name}</div>
        <code style={{ fontSize: 12, color: "#6b7280" }}>/book/{type.slug}</code>
      </div>
      <div className="subtle" style={{ fontSize: 12, marginBottom: 12 }}>
        {campusName} · {type.duration_minutes} min · {type.min_notice_hours}h notice · up to {type.max_days_ahead} days ahead
      </div>

      {rows.length === 0 && (
        <div style={{
          fontSize: 13, marginBottom: 10, padding: "8px 12px", borderRadius: 8,
          background: "#fff7ed", border: "1px solid #fed7aa", color: "#9a3412", fontWeight: 600,
        }}>
          No hours set — the booking page shows no times at all for this campus until you add some.
        </div>
      )}

      <div className="stack" style={{ gap: 4, marginBottom: 12 }}>
        {DAYS.map((label, d) => {
          const windows = byDay(d);
          return (
            <div key={label} className="row" style={{ gap: 10, alignItems: "flex-start", padding: "5px 0", borderTop: d ? "1px solid #f1f5f9" : undefined }}>
              <div style={{ width: 92, fontWeight: 700, fontSize: 13, color: windows.length ? "#111827" : "#9ca3af" }}>{label}</div>
              {windows.length === 0 ? (
                <span className="subtle" style={{ fontSize: 13 }}>Closed</span>
              ) : (
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {windows.map((a) => (
                    <span key={a.id} style={{
                      display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600,
                      background: "#fdf2f8", border: "1px solid #fbcfe8", color: "#9d174d",
                      borderRadius: 999, padding: "2px 4px 2px 10px",
                    }}>
                      {String(a.start_time).slice(0, 5)}–{String(a.end_time).slice(0, 5)}
                      <button
                        className="btn"
                        title="Remove these hours"
                        onClick={() => onRemoveWindow(a.id)}
                        style={{ padding: "0 6px", fontSize: 12, lineHeight: 1.6, color: "#991b1b", background: "transparent", border: "none" }}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {err && <div style={{ color: "#b91c1c", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>{err}</div>}

      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select className="select" style={{ maxWidth: 150 }} value={day} onChange={(e) => setDay(Number(e.target.value))}>
          {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select>
        <input className="input" style={{ maxWidth: 120 }} type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="subtle">to</span>
        <input className="input" style={{ maxWidth: 120 }} type="time" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn" onClick={add}>+ Add hours</button>
      </div>

      {/* ── Closed dates ────────────────────────────────────────────────────
          Separate from the weekly hours on purpose: a holiday or a week away
          shouldn't mean deleting your Monday hours and remembering to put them
          back. These simply override the pattern above. */}
      <div style={{ borderTop: "1px solid #f1f5f9", marginTop: 16, paddingTop: 14 }}>
        <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 2 }}>Closed dates</div>
        <div className="subtle" style={{ fontSize: 12, marginBottom: 10 }}>
          Holidays or time away. No tours can be booked on these days, whatever the hours above say.
        </div>

        {upcomingClosed.length === 0 ? (
          <div className="subtle" style={{ fontSize: 13, marginBottom: 10 }}>Nothing closed coming up.</div>
        ) : (
          <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {upcomingClosed.map((b) => (
              <span key={b.id} style={{
                display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600,
                background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b",
                borderRadius: 999, padding: "2px 4px 2px 10px",
              }}>
                {niceDay(b.day)}{b.reason ? ` · ${b.reason}` : ""}
                <button
                  className="btn"
                  title="Reopen this day"
                  onClick={() => onRemoveBlackout(b.id)}
                  style={{ padding: "0 6px", fontSize: 12, lineHeight: 1.6, color: "#991b1b", background: "transparent", border: "none" }}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input className="input" style={{ maxWidth: 160 }} type="date" value={boFrom} onChange={(e) => setBoFrom(e.target.value)} />
          <span className="subtle">to</span>
          <input className="input" style={{ maxWidth: 160 }} type="date" value={boTo} onChange={(e) => setBoTo(e.target.value)} />
          <input
            className="input" style={{ maxWidth: 190 }} placeholder="Reason (optional)"
            value={boReason} onChange={(e) => setBoReason(e.target.value)}
          />
          <button
            className="btn"
            disabled={!boFrom}
            title={boFrom ? "Close these dates" : "Pick a start date first"}
            onClick={() => {
              onAddBlackout(type.id, boFrom, boTo || boFrom, boReason);
              setBoFrom(""); setBoTo(""); setBoReason("");
            }}
          >
            🚫 Close dates
          </button>
          <span className="subtle" style={{ fontSize: 12 }}>
            Leave the second date empty to close a single day.
          </span>
        </div>
      </div>
    </div>
  );
}


/** "Mon 10 Aug 2026" — closed dates are scanned, not read. */
function niceDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })
    .format(new Date(y, m - 1, d));
}

