"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { supabase } from "@/lib/supabaseClient";
import { formatEmployeeName, getDisplayName, timeToMinutes } from "@/lib/scheduleUtils";
import { useDialog } from "@/components/ui/useDialog";

// ─── Types ───────────────────────────────────────────────────────────────────

type BlockRow = {
  id: string;
  start_time: string;
  end_time: string;
  block_type: "shift" | "lunch_break" | "break";
  room_id: string;
  label: string | null;
};

type RoomRow = { id: string; name: string };

type Session = {
  start: string; // HH:MM:SS
  end: string;
  blocks: BlockRow[];
};

type EmployeeLite = {
  id: string;
  legal_first_name: string;
  legal_middle_name: string | null;
  legal_last_name: string;
  nicknames: string[] | null;
  hours_pin: string;
};

type ClockEntry = {
  id: string;
  session_start: string;
  session_end: string;
  clocked_in_at: string | null;
  clocked_out_at: string | null;
};

type Screen =
  | "pin"        // PIN pad
  | "clockin"    // ready to clock in
  | "clocking"   // currently clocked in (with timer)
  | "success";   // brief confirmation

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtTime(t: string) {
  const mins = timeToMinutes(t);
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  return `${h12}:${String(m).padStart(2, "0")}`;
}

/** Group blocks into sessions separated by lunch_break blocks */
function buildSessions(blocks: BlockRow[]): Session[] {
  const sorted = [...blocks].sort(
    (a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time)
  );
  const sessions: Session[] = [];
  let current: BlockRow[] = [];

  for (const b of sorted) {
    if (b.block_type === "lunch_break") {
      if (current.length > 0) {
        sessions.push({
          start: current[0].start_time,
          end: current[current.length - 1].end_time,
          blocks: current,
        });
        current = [];
      }
    } else {
      current.push(b);
    }
  }
  if (current.length > 0) {
    sessions.push({
      start: current[0].start_time,
      end: current[current.length - 1].end_time,
      blocks: current,
    });
  }
  return sessions;
}

/** Today's day-of-week as 1=Mon … 5=Fri */
function todayDow(): number {
  const d = new Date().getDay(); // 0=Sun
  return d === 0 ? 7 : d; // return 7 for Sunday (no schedule)
}

/** HH:MM:SS from Date */
function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function elapsed(sinceISO: string): string {
  const ms = Date.now() - new Date(sinceISO).getTime();
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ClockPage() {
  const router = useRouter();
  const { alert: dialogAlert, confirm: dialogConfirm, modal: dialogModal } = useDialog();

  // Auth guard
  const [authChecked, setAuthChecked] = useState(false);
  const [isHoursManager, setIsHoursManager] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { router.replace("/"); return; }
      const { data: prof } = await supabase
        .from("user_profiles")
        .select("role")
        .eq("id", session.user.id)
        .single();
      if (prof?.role !== "hours_manager") { router.replace("/"); return; }
      setIsHoursManager(true);
      setAuthChecked(true);
    })();
  }, [router]);

  // Proactively refresh the session every 45 minutes so kiosk devices don't expire mid-shift
  useEffect(() => {
    const id = setInterval(() => { supabase.auth.refreshSession(); }, 45 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // ── State ──
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [screen, setScreen] = useState<Screen>("pin");
  const [employee, setEmployee] = useState<EmployeeLite | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [clockEntry, setClockEntry] = useState<ClockEntry | null>(null);
  const [notes, setNotes] = useState("");
  const [clockError, setClockError] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [timerStr, setTimerStr] = useState("0:00");
  const [successMsg, setSuccessMsg] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoLogoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Rolling timer
  useEffect(() => {
    if (screen === "clocking" && clockEntry?.clocked_in_at) {
      timerRef.current = setInterval(() => {
        setTimerStr(elapsed(clockEntry.clocked_in_at!));
      }, 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [screen, clockEntry]);

  // Auto-logout after 30 seconds of inactivity on clockin/clocking screens
  useEffect(() => {
    if (screen !== "clockin" && screen !== "clocking") {
      if (autoLogoutRef.current) clearTimeout(autoLogoutRef.current);
      return;
    }
    if (autoLogoutRef.current) clearTimeout(autoLogoutRef.current);
    autoLogoutRef.current = setTimeout(() => resetToPin(), 30_000);
    return () => { if (autoLogoutRef.current) clearTimeout(autoLogoutRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  function resetAutoLogoutTimer() {
    if (screen !== "clockin" && screen !== "clocking") return;
    if (autoLogoutRef.current) clearTimeout(autoLogoutRef.current);
    autoLogoutRef.current = setTimeout(() => resetToPin(), 30_000);
  }

  // ── PIN input ──
  function pressDigit(d: string) {
    if (pin.length >= 4) return;
    const next = pin + d;
    setPin(next);
    setPinError("");
    if (next.length === 4) attemptPin(next);
  }

  function pressBackspace() {
    setPin((p) => p.slice(0, -1));
    setPinError("");
  }

  async function attemptPin(p: string) {
    // Ensure the session is still valid — JWT expires after 1h of inactivity
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      // Try to refresh; if that fails, kick back to login
      const { error: refreshErr } = await supabase.auth.refreshSession();
      if (refreshErr) { router.replace("/"); return; }
    }

    // Look up employee by PIN
    const { data: emp, error: empErr } = await supabase
      .from("hr_employees")
      .select("id, legal_first_name, legal_middle_name, legal_last_name, nicknames, hours_pin")
      .eq("hours_pin", p)
      .eq("is_active", true)
      .maybeSingle();

    if (empErr) {
      // Auth error — session expired and refresh failed; redirect to login
      if (empErr.code === "PGRST301" || empErr.message?.toLowerCase().includes("jwt")) {
        router.replace("/");
        return;
      }
      setPinError("Connection error. Please try again.");
      setPin("");
      return;
    }

    if (!emp) {
      setPinError("No employee found for that PIN. Try again.");
      setPin("");
      return;
    }

    setEmployee(emp as EmployeeLite);

    // Find today's published schedule
    const dow = todayDow();
    if (dow > 5) {
      setPinError("No schedule today (weekend).");
      setPin("");
      return;
    }

    // Get the most recent published schedule covering today (use LOCAL date, not UTC)
    const _now = new Date();
    const today = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, "0")}-${String(_now.getDate()).padStart(2, "0")}`;
    const { data: schedules } = await supabase
      .from("schedules")
      .select("id, week_start")
      .eq("status", "published")
      .lte("week_start", today)
      .order("week_start", { ascending: false })
      .limit(5);

    // Find the schedule whose week contains today
    let scheduleId: string | null = null;
    if (schedules) {
      for (const s of schedules) {
        const mon = new Date(s.week_start);
        const fri = new Date(mon);
        fri.setDate(mon.getDate() + 4);
        const todayDate = new Date(today);
        if (todayDate >= mon && todayDate <= fri) {
          scheduleId = s.id;
          break;
        }
      }
    }

    if (!scheduleId) {
      setPinError("No published schedule found for this week.");
      setPin("");
      return;
    }

    // Fetch blocks for this employee today
    const { data: blocks } = await supabase
      .from("schedule_blocks")
      .select("id, start_time, end_time, block_type, room_id, label")
      .eq("schedule_id", scheduleId)
      .eq("employee_id", emp.id)
      .eq("day_of_week", dow);

    // Fetch rooms for this schedule
    const { data: roomData } = await supabase
      .from("schedule_rooms")
      .select("id, name")
      .eq("schedule_id", scheduleId);

    setRooms((roomData as RoomRow[]) ?? []);

    const allSessions = buildSessions((blocks as BlockRow[]) ?? []);
    setSessions(allSessions);

    // Auto-clock-out any open entries from previous days
    const { data: openPrevEntries } = await supabase
      .from("clock_entries")
      .select("id, session_date")
      .eq("employee_id", emp.id)
      .is("clocked_out_at", null)
      .not("clocked_in_at", "is", null)
      .lt("session_date", today);

    for (const e of openPrevEntries ?? []) {
      // Auto clock-out at 11:59:59 PM on the session date (not at current login time)
      const [sy, sm, sd] = e.session_date.split("-").map(Number);
      const autoOut = new Date(sy, sm - 1, sd, 23, 59, 59);
      await supabase
        .from("clock_entries")
        .update({ clocked_out_at: autoOut.toISOString(), auto_clocked_out: true })
        .eq("id", e.id);
    }

    // Fetch ALL clock entries for this employee today to determine session state
    const { data: allEntries } = await supabase
      .from("clock_entries")
      .select("id, session_start, session_end, clocked_in_at, clocked_out_at")
      .eq("employee_id", emp.id)
      .eq("session_date", today);

    const entries = (allEntries ?? []) as ClockEntry[];

    // Priority 1: any session clocked in but not yet clocked out — must finish that first
    const incompleteEntry = entries.find((e) => e.clocked_in_at && !e.clocked_out_at);
    if (incompleteEntry) {
      const incompleteSession = allSessions.find(
        (s) => s.start === incompleteEntry.session_start
      ) ?? null;
      setCurrentSession(incompleteSession);
      setClockEntry(incompleteEntry);
      setTimerStr(elapsed(incompleteEntry.clocked_in_at!));
      setScreen("clocking");
      return;
    }

    // Priority 2: find the next session that hasn't been fully completed yet
    const nowMins = timeToMinutes(nowTime());
    const completedStarts = new Set(
      entries.filter((e) => e.clocked_in_at && e.clocked_out_at).map((e) => e.session_start)
    );

    // Among non-completed sessions: prefer one currently in-window, then next upcoming
    const activeSession =
      allSessions.find(
        (s) =>
          !completedStarts.has(s.start) &&
          timeToMinutes(s.start) <= nowMins &&
          nowMins < timeToMinutes(s.end)
      ) ??
      allSessions.find(
        (s) => !completedStarts.has(s.start) && timeToMinutes(s.start) > nowMins
      ) ??
      null;

    if (!activeSession) {
      setPinError("All sessions for today are complete.");
      setPin("");
      return;
    }

    setCurrentSession(activeSession);

    // Block clock-in if session hasn't started yet
    if (timeToMinutes(activeSession.start) > nowMins) {
      setPinError(
        `Next session starts at ${fmtTime(activeSession.start)} — please wait until then to clock in.`
      );
      setPin("");
      return;
    }

    setClockEntry(null);
    setScreen("clockin");
  }

  async function ensureSession(): Promise<boolean> {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) return true;
    const { error } = await supabase.auth.refreshSession();
    if (error) { router.replace("/"); return false; }
    return true;
  }

  async function handleClockIn() {
    if (!employee || !currentSession) return;
    setClockError("");
    if (!await ensureSession()) return;
    const _d = new Date();
    const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, "0")}-${String(_d.getDate()).padStart(2, "0")}`;
    const { data: { session: authSession } } = await supabase.auth.getSession();
    const { data, error } = await supabase
      .from("clock_entries")
      .insert({
        employee_id: employee.id,
        session_date: today,
        session_start: currentSession.start,
        session_end: currentSession.end,
        clocked_in_at: new Date().toISOString(),
        notes_in: notes.trim() || null,
        created_by: authSession?.user?.id ?? null,
      })
      .select()
      .single();

    if (error) { setClockError(error.message); return; }
    setClockEntry(data as ClockEntry);
    setSuccessMsg(`You're clocked in!`);
    setScreen("success");
    setTimeout(() => resetToPin(), 2500);
  }

  async function handleClockOut() {
    if (!clockEntry) return;
    setClockError("");
    if (!await ensureSession()) return;
    const { error } = await supabase
      .from("clock_entries")
      .update({
        clocked_out_at: new Date().toISOString(),
        notes_out: notes.trim() || null,
      })
      .eq("id", clockEntry.id);

    if (error) { setClockError(error.message); return; }
    setSuccessMsg(`You're clocked out!`);
    setScreen("success");
    setTimeout(() => resetToPin(), 2500);
  }

  function resetToPin() {
    setPin("");
    setPinError("");
    setClockError("");
    setEmployee(null);
    setSessions([]);
    setCurrentSession(null);
    setClockEntry(null);
    setNotes("");
    setDetailsOpen(false);
    setScreen("pin");
  }

  if (!authChecked || !isHoursManager) return null;

  // ── Render ──
  return (
    <>
    {dialogModal}
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #fdf2f8 0%, #eff6ff 100%)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      fontFamily: "system-ui, sans-serif",
      position: "relative",
    }}>
      {/* Sign out — discreet exit icon */}
      <button
        onClick={async () => {
          const ok = await dialogConfirm(
            "This will sign out the hours manager account and disable hour logging for employees. Are you sure?",
            { title: "Disable Hour Logging?", confirmLabel: "Sign Out", cancelLabel: "Cancel" }
          );
          if (!ok) return;
          await supabase.auth.signOut();
          router.replace("/");
        }}
        title="Sign out"
        style={{
          position: "absolute", top: 14, right: 14,
          background: "none", border: "none",
          padding: 6, borderRadius: 6,
          fontSize: 18, color: "#d1d5db",
          cursor: "pointer", lineHeight: 1,
          opacity: 0.5,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.5")}
      >
        ⏻
      </button>

      {/* ── SUCCESS SCREEN ── */}
      {screen === "success" && (
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 72, marginBottom: 16 }}>
            {successMsg.includes("in") ? "✅" : "👋"}
          </div>
          <div style={{ fontSize: 28, fontWeight: 900, color: "#111827", marginBottom: 8 }}>
            {successMsg}
          </div>
          <div style={{ fontSize: 15, color: "#6b7280" }}>Returning to PIN pad…</div>
        </div>
      )}

      {/* ── PIN PAD ── */}
      {screen === "pin" && (
        <div style={{ width: "100%", maxWidth: 360 }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
              <Image src="/logo.png" alt="Sing Portal" width={120} height={84} style={{ objectFit: "contain" }} priority />
            </div>
            <div style={{ fontSize: 15, color: "#6b7280" }}>Enter your 4-digit hours PIN</div>
          </div>

          {/* PIN dots */}
          <div style={{ display: "flex", justifyContent: "center", gap: 16, marginBottom: 32 }}>
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                style={{
                  width: 18, height: 18, borderRadius: "50%",
                  background: pin.length > i ? "#e6178d" : "#e5e7eb",
                  transition: "background 0.15s",
                }}
              />
            ))}
          </div>

          {/* Error */}
          {pinError && (
            <div style={{
              background: "#fef2f2", color: "#dc2626", padding: "10px 14px",
              borderRadius: 10, fontSize: 13, fontWeight: 600, marginBottom: 20, textAlign: "center",
            }}>
              {pinError}
            </div>
          )}

          {/* Number pad */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
            {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((k, idx) => (
              k === "" ? <div key={idx} /> :
              <button
                key={idx}
                onClick={() => k === "⌫" ? pressBackspace() : pressDigit(k)}
                style={{
                  height: 72, borderRadius: 16, border: "2px solid #e5e7eb",
                  background: "white", fontSize: k === "⌫" ? 22 : 26,
                  fontWeight: 700, color: k === "⌫" ? "#6b7280" : "#111827",
                  cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
                  transition: "all 0.1s",
                }}
                onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.94)")}
                onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
                onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
              >
                {k}
              </button>
            ))}
          </div>

          {/* Don't know your PIN */}
          <div style={{ textAlign: "center", marginTop: 28 }}>
            <button
              onClick={() => dialogAlert(
                "To find your PIN:\n\n1. Go to the Sing Portal website\n2. Log in with your personal account\n3. Click the HR tab in the navigation\n4. Your PIN is shown at the top of the page — click the eye icon to reveal it.",
                { title: "Finding Your PIN" }
              )}
              style={{
                background: "none", border: "none", color: "#6b7280",
                fontSize: 13, fontWeight: 600, cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              Don't know your PIN?
            </button>
          </div>
        </div>
      )}

      {/* ── CLOCK IN SCREEN ── */}
      {(screen === "clockin" || screen === "clocking") && employee && currentSession && (
        <div style={{ width: "100%", maxWidth: 420 }} onPointerDown={resetAutoLogoutTimer}>
          {/* Logo (small) */}
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
            <Image src="/logo.png" alt="Sing Portal" width={56} height={40} style={{ objectFit: "contain" }} />
          </div>
          {/* Employee name */}
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#111827" }}>
              {getDisplayName(employee as any)}
            </div>
            {screen === "clocking" && (
              <div style={{
                marginTop: 12, fontSize: 42, fontWeight: 900,
                color: "#e6178d", fontVariantNumeric: "tabular-nums",
              }}>
                {timerStr}
              </div>
            )}
            <div style={{ marginTop: 8, fontSize: 14, color: "#6b7280", fontWeight: 600 }}>
              Session: {fmtTime(currentSession.start)} – {fmtTime(currentSession.end)}
            </div>
          </div>

          {/* Notes */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 13, fontWeight: 700, color: "#374151", display: "block", marginBottom: 6 }}>
              Notes {screen === "clockin" ? "(optional — reason for late arrival, etc.)" : "(optional — overtime reason, etc.)"}
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add a note…"
              rows={2}
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 10,
                border: "1.5px solid #e5e7eb", fontSize: 16, resize: "vertical",
                boxSizing: "border-box", fontFamily: "inherit",
              }}
            />
          </div>

          {/* Shift details collapsible */}
          <div style={{ marginBottom: 20, borderRadius: 12, border: "1.5px solid #e5e7eb", overflow: "hidden" }}>
            <button
              onClick={() => setDetailsOpen((o) => !o)}
              style={{
                width: "100%", padding: "12px 16px", background: "#f9fafb",
                border: "none", cursor: "pointer", display: "flex",
                alignItems: "center", justifyContent: "space-between",
                fontWeight: 700, fontSize: 14, color: "#374151",
              }}
            >
              <span>Shift Details</span>
              <span style={{ fontSize: 12, transition: "transform 0.2s", display: "inline-block", transform: detailsOpen ? "rotate(180deg)" : "rotate(0deg)" }}>▼</span>
            </button>
            {detailsOpen && (
              <div style={{ padding: "12px 16px", background: "white" }}>
                {currentSession.blocks.map((b) => {
                  const room = rooms.find((r) => r.id === b.room_id);
                  const typeColor = b.block_type === "break" ? "#22c55e" : "#6366f1";
                  return (
                    <div
                      key={b.id}
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "8px 0", borderBottom: "1px solid #f3f4f6",
                      }}
                    >
                      <div style={{ width: 3, height: 32, borderRadius: 2, background: typeColor, flexShrink: 0 }} />
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14, color: "#111827" }}>
                          {fmtTime(b.start_time)} – {fmtTime(b.end_time)}
                        </div>
                        <div style={{ fontSize: 12, color: "#6b7280" }}>
                          {room?.name ?? "Room"}{b.label ? ` · ${b.label}` : ""}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Error on clocking screen */}
          {clockError && (
            <div style={{
              background: "#fef2f2", color: "#dc2626", padding: "10px 14px",
              borderRadius: 10, fontSize: 13, fontWeight: 600, marginBottom: 12, textAlign: "center",
            }}>
              {clockError}
            </div>
          )}

          {/* Action button */}
          {screen === "clockin" ? (
            <button
              type="button"
              onClick={handleClockIn}
              style={{
                width: "100%", padding: "18px 0", borderRadius: 16, border: "none",
                background: "linear-gradient(135deg, #e6178d, #c2185b)",
                color: "white", fontSize: 20, fontWeight: 900, cursor: "pointer",
                boxShadow: "0 4px 16px rgba(230,23,141,0.35)",
              }}
            >
              Clock In
            </button>
          ) : (
            <button
              type="button"
              onClick={handleClockOut}
              style={{
                width: "100%", padding: "18px 0", borderRadius: 16, border: "none",
                background: "linear-gradient(135deg, #6366f1, #4338ca)",
                color: "white", fontSize: 20, fontWeight: 900, cursor: "pointer",
                boxShadow: "0 4px 16px rgba(99,102,241,0.35)",
              }}
            >
              Clock Out
            </button>
          )}

          <button
            type="button"
            onClick={resetToPin}
            style={{
              display: "block", width: "100%", marginTop: 12, padding: "12px 0",
              background: "none", border: "1.5px solid #e5e7eb", borderRadius: 12,
              color: "#6b7280", fontSize: 15, fontWeight: 700, cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
    </>
  );
}
