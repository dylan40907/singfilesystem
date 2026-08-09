"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * What a parent lands on from the "change or cancel" link in their confirmation
 * email. The token in the URL is the only credential — same approach Calendly
 * uses for invitees, who have no account with us.
 */

const FN = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/tours-public`;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const PINK = "#e6178d";

async function callFn(body: Record<string, unknown>) {
  const res = await fetch(FN, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${ANON}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Something went wrong (${res.status}).`);
  return data;
}

type Booking = {
  status: string; starts_at: string; when: string; parent_name: string;
  tour: { name: string; location: string | null; time_zone: string; slug: string };
};

/** Statuses a parent can still act on — must match the server's allow-list. */
const ACTIVE = new Set(["requested", "scheduled", "confirmed"]);

const STATUS_TITLE: Record<string, string> = {
  cancelled: "This booking has been cancelled",
  reschedule_requested: "We asked you to pick a new time",
  completed: "Thank you for visiting",
  no_show: "This booking has passed",
};

function ManageInner() {
  const token = useSearchParams().get("t") ?? "";
  const [booking, setBooking] = useState<Booking | null>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    if (!token) { setError("This link is missing its booking reference."); return; }
    try {
      setBooking(await callFn({ mode: "lookup", token }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const tz = booking?.tour.time_zone ?? "America/Los_Angeles";

  async function openReschedule() {
    if (!booking) return;
    setBusy(true);
    try {
      const today = new Date();
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const to = new Date(today); to.setDate(to.getDate() + 45);
      const data = await callFn({ mode: "slots", slug: booking.tour.slug, from: iso(today), to: iso(to) });
      setSlots(data.slots ?? []);
      setPicking(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const byDay = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of slots) {
      const k = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(s));
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return m;
  }, [slots, tz]);

  if (error) return <Shell><p style={{ color: "#b91c1c" }}>{error}</p></Shell>;
  if (!booking) return <Shell><p style={{ color: "#9ca3af" }}>Loading your booking…</p></Shell>;

  if (msg) return <Shell><h1 style={h1}>Done</h1><p style={{ color: "#4b5563" }}>{msg}</p></Shell>;

  // The same three statuses the server treats as live. It used to check only
  // for "scheduled", which nothing has been created with since bookings became
  // request-then-confirm — so every parent saw a dead end instead of a
  // Cancel button.
  if (!ACTIVE.has(booking.status)) {
    return (
      <Shell>
        <h1 style={h1}>{STATUS_TITLE[booking.status] ?? `This booking is ${booking.status}`}</h1>
        <p style={{ color: "#4b5563" }}>
          Nothing more to do here. You&apos;re very welcome to book again:{" "}
          <a href={`/book/${booking.tour.slug}`} style={{ color: PINK }}>pick a new time</a>.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 style={h1}>Your booking</h1>
      <p style={{ color: "#4b5563", margin: "0 0 4px" }}>{booking.tour.name}</p>
      <p style={{ fontWeight: 700, fontSize: 17, margin: "0 0 4px" }}>{booking.when}</p>
      {booking.tour.location && <p style={{ color: "#6b7280", fontSize: 14 }}>{booking.tour.location}</p>}
      {booking.status === "requested" && (
        <p style={{ color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "8px 12px", fontSize: 14, marginTop: 12 }}>
          We&apos;re holding this time for you while we confirm it. You can still change or cancel it.
        </p>
      )}

      {confirming ? (
        <div style={{ marginTop: 22 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Cancel this booking?</div>
          <p style={{ color: "#6b7280", fontSize: 14, margin: "0 0 12px" }}>
            The time goes back into our calendar straight away. You can book again whenever suits you.
          </p>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Anything you'd like us to know? (optional)"
            style={{
              width: "100%", padding: "11px 14px", fontSize: 15, borderRadius: 12,
              border: "1.5px solid #e5e7eb", outline: "none", boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
            <button
              style={{ ...cta, background: "#b91c1c" }}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await callFn({ mode: "cancel", token, reason: reason.trim() || undefined });
                  setMsg("Your booking has been cancelled. We've emailed you to confirm.");
                } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
              }}
            >
              {busy ? "Cancelling…" : "Yes, cancel it"}
            </button>
            <button
              style={{ ...cta, background: "#fff", color: "#374151", border: "1.5px solid #e5e7eb" }}
              disabled={busy}
              onClick={() => { setConfirming(false); setReason(""); }}
            >
              Keep my booking
            </button>
          </div>
        </div>
      ) : !picking ? (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
          <button style={cta} disabled={busy} onClick={() => void openReschedule()}>Pick a different time</button>
          <button
            style={{ ...cta, background: "#fff", color: "#b91c1c", border: "1.5px solid #fecaca" }}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Cancel my booking
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 22 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Choose a new time</div>
          {byDay.size === 0 ? (
            <p style={{ color: "#6b7280" }}>No other times are free right now — please call us.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {[...byDay.entries()].map(([day, times]) => {
                const [y, m, d] = day.split("-").map(Number);
                return (
                  <div key={day}>
                    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>
                      {new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date(y, m - 1, d))}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {times.map((t) => (
                        <button
                          key={t}
                          disabled={busy}
                          style={slotBtn}
                          onClick={async () => {
                            setBusy(true);
                            try {
                              const r = await callFn({ mode: "reschedule", token, start: t });
                              setMsg(`Your booking has moved to ${r.when}. We've emailed you the details.`);
                            } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
                          }}
                        >
                          {new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(t))}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <button style={{ ...cta, background: "#fff", color: "#374151", border: "1.5px solid #e5e7eb", marginTop: 16 }}
            onClick={() => setPicking(false)}>
            Keep my current time
          </button>
        </div>
      )}
    </Shell>
  );
}

export default function ManageBookingPage() {
  return (
    <Suspense fallback={<Shell><p style={{ color: "#9ca3af" }}>Loading…</p></Shell>}>
      <ManageInner />
    </Suspense>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", background: "#fff", minHeight: "100vh" }}>
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "40px 20px" }}>{children}</div>
    </div>
  );
}

const h1: React.CSSProperties = { fontSize: 21, fontWeight: 800, margin: "0 0 10px" };
const cta: React.CSSProperties = {
  padding: "12px 18px", background: PINK, color: "#fff", border: "none",
  borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: "pointer",
};
const slotBtn: React.CSSProperties = {
  padding: "9px 16px", borderRadius: 999, border: "1.5px solid #e5e7eb",
  background: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer",
};
