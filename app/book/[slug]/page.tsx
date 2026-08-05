"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

/**
 * Public tour booking page — the Calendly replacement.
 *
 * No auth and no Supabase client: everything goes through the `tours-public`
 * edge function, which runs with the service role and returns only free start
 * times. That keeps the tour tables closed to anonymous callers even though
 * this page is open to the world.
 *
 * Designed to work both standalone and inside a Squarespace iframe, so it posts
 * its height to the parent frame and keeps its own scrolling contained.
 */

const FN = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/tours-public`;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const PINK = "#e6178d";

type TourInfo = { name: string; description: string | null; location: string | null; duration_minutes: number; time_zone: string };

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

export default function BookTourPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug as string;

  const [tour, setTour] = useState<TourInfo | null>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [month, setMonth] = useState(() => new Date());
  const [picked, setPicked] = useState<string | null>(null);
  const [done, setDone] = useState<{ when: string } | null>(null);

  // The whole New Lead field set, so a tour request arrives as a complete lead
  // and nobody has to chase the family for basics afterwards.
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [timeZone, setTimeZone] = useState("Pacific (Los Angeles)");
  const [language, setLanguage] = useState("English");
  const [heard, setHeard] = useState("");
  const [heardDetail, setHeardDetail] = useState("");
  const [referredBy, setReferredBy] = useState("");
  const [childName, setChildName] = useState("");
  const [childDob, setChildDob] = useState("");
  const [program, setProgram] = useState("");
  const [schedule, setSchedule] = useState("");
  const [chineseLevel, setChineseLevel] = useState("");
  const [startDate, setStartDate] = useState("");
  const [startNote, setStartNote] = useState("");
  const [notes, setNotes] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [busy, setBusy] = useState(false);

  // Let a Squarespace embed size the iframe to the content.
  useEffect(() => {
    const post = () => window.parent?.postMessage(
      { type: "sing-book-height", height: document.body.scrollHeight }, "*"
    );
    post();
    const ro = new ResizeObserver(post);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, [tour, slots, picked, done]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const from = new Date(month.getFullYear(), month.getMonth(), 1);
      const to = new Date(month.getFullYear(), month.getMonth() + 1, 0);
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const data = await callFn({ mode: "slots", slug, from: iso(from), to: iso(to) });
      setTour(data.tour);
      setSlots(data.slots ?? []);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [slug, month]);

  useEffect(() => { void load(); }, [load]);

  const tz = tour?.time_zone ?? "America/Los_Angeles";

  /** Slots grouped by their day in the school's time zone. */
  const byDay = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of slots) {
      const key = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(s));
      m.set(key, [...(m.get(key) ?? []), s]);
    }
    return m;
  }, [slots, tz]);

  const timeLabel = (iso: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const dayLabel = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date(y, m - 1, d));
  };

  async function submit() {
    if (!picked) return;
    if (!name.trim() || !email.includes("@")) { setError("Please add your name and a valid email."); return; }
    setBusy(true);
    setError("");
    try {
      const data = await callFn({
        mode: "book", slug, start: picked, website,
        parent_name: name.trim(), parent_email: email.trim(), parent_phone: phone.trim(),
        city: city.trim(), time_zone: timeZone, preferred_language: language,
        source_other: [heard, heardDetail.trim()].filter(Boolean).join(" — ") || null,
        referred_by: referredBy.trim() || null,
        notes: notes.trim(),
        children: [{
          name: childName.trim(), dob: childDob || null, program: program || null,
          schedule: schedule.trim() || null, chinese_level: chineseLevel.trim() || null,
          desired_start_date: startDate || null, desired_start_note: startNote.trim() || null,
        }],
      });
      setDone({ when: data.when });
    } catch (e) {
      setError((e as Error).message);
      await load(); // the slot may have gone — refresh what's left
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Shell>
        <div style={{ textAlign: "center", padding: "28px 0" }}>
          <div style={{ fontSize: 40 }}>✓</div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: "10px 0 6px" }}>You&apos;re booked</h1>
          <p style={{ color: "#4b5563", margin: 0 }}>{done.when}</p>
          {tour?.location && <p style={{ color: "#6b7280", fontSize: 14 }}>{tour.location}</p>}
          <p style={{ color: "#6b7280", fontSize: 14, marginTop: 18 }}>
            A confirmation is on its way to {email}. It has a link if you need to change or cancel.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 style={{ fontSize: 21, fontWeight: 800, margin: "0 0 4px" }}>{tour?.name ?? "Book a tour"}</h1>
      <div style={{ color: "#6b7280", fontSize: 14, marginBottom: 4 }}>
        {tour ? `${tour.duration_minutes} min` : ""}{tour?.location ? ` · ${tour.location}` : ""}
      </div>
      {tour?.description && <p style={{ color: "#4b5563", fontSize: 14 }}>{tour.description}</p>}

      {error && (
        <div style={{ background: "#fef2f2", color: "#b91c1c", borderRadius: 10, padding: "10px 12px", fontSize: 14, margin: "12px 0" }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "18px 0 10px" }}>
        <button style={navBtn} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
        <strong>{new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(month)}</strong>
        <button style={navBtn} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
      </div>

      {loading ? (
        <p style={{ color: "#9ca3af" }}>Loading available times…</p>
      ) : byDay.size === 0 ? (
        <p style={{ color: "#6b7280" }}>
          No times available this month. Try the next month, or call us and we&apos;ll find a time.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {[...byDay.entries()].map(([day, times]) => (
            <div key={day}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>{dayLabel(day)}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {times.map((t) => (
                  <button
                    key={t}
                    onClick={() => setPicked(t)}
                    style={{
                      ...slotBtn,
                      borderColor: picked === t ? PINK : "#e5e7eb",
                      background: picked === t ? PINK : "#fff",
                      color: picked === t ? "#fff" : "#111827",
                    }}
                  >
                    {timeLabel(t)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {picked && (
        <div style={{ marginTop: 24, borderTop: "1px solid #eee", paddingTop: 18 }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>
            Your details — {new Intl.DateTimeFormat("en-US", {
              timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
            }).format(new Date(picked))}
          </div>

          <div style={{ fontWeight: 800, fontSize: 13, color: "#6b7280", margin: "6px 0 2px" }}>ABOUT YOU</div>
          <Field label="Your name *"><input style={input} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Email *"><input style={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Phone *"><input style={input} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="City"><input style={input} value={city} onChange={(e) => setCity(e.target.value)} /></Field>
          <Field label="Your time zone">
            <select style={input} value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
              {["Pacific (Los Angeles)", "Mountain (Denver)", "Central (Chicago)", "Eastern (New York)", "Other"]
                .map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </Field>
          <Field label="Preferred language">
            <select style={input} value={language} onChange={(e) => setLanguage(e.target.value)}>
              {["English", "Mandarin", "Cantonese", "Spanish", "Other"].map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </Field>
          <Field label="How did you hear about us?">
            <select style={input} value={heard} onChange={(e) => setHeard(e.target.value)}>
              <option value="">— Choose —</option>
              {["Google", "Instagram", "Facebook", "Yelp", "Drive by / Sign", "Sibling / Returning Family", "Friend or Family", "Other"]
                .map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </Field>
          {/* The follow-ups only appear when they're relevant, so the form
              stays as short as each parent's answers allow. */}
          {["Google", "Instagram", "Facebook", "Yelp", "Other"].includes(heard) && (
            <Field label="Where exactly?">
              <input style={input} value={heardDetail} onChange={(e) => setHeardDetail(e.target.value)} />
            </Field>
          )}
          {["Sibling / Returning Family", "Friend or Family"].includes(heard) && (
            <Field label="Who told you about us?">
              <input style={input} value={referredBy} onChange={(e) => setReferredBy(e.target.value)} />
            </Field>
          )}

          <div style={{ fontWeight: 800, fontSize: 13, color: "#6b7280", margin: "16px 0 2px" }}>ABOUT YOUR CHILD</div>
          <Field label="Child's full name *"><input style={input} value={childName} onChange={(e) => setChildName(e.target.value)} /></Field>
          <Field label="Child's date of birth"><input style={input} type="date" value={childDob} onChange={(e) => setChildDob(e.target.value)} /></Field>
          <Field label="Which program are you interested in?">
            <select style={input} value={program} onChange={(e) => setProgram(e.target.value)}>
              <option value="">— Choose —</option>
              {["Preschool", "HWC", "Language Classes", "Camps"].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Days / schedule / after care">
            <input style={input} value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="5 Days/Week (9am – 3pm)" />
          </Field>
          <Field label="Does your child have any current knowledge of Chinese?">
            <input style={input} value={chineseLevel} onChange={(e) => setChineseLevel(e.target.value)} />
          </Field>
          <Field label="Desired start date"><input style={input} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
          <Field label="…or in your own words">
            <input style={input} value={startNote} onChange={(e) => setStartNote(e.target.value)} placeholder="Sometime next fall" />
          </Field>
          <Field label="Anything that will help us prepare?">
            <textarea style={{ ...input, minHeight: 70 }} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>

          {/* Honeypot — hidden from people, tempting to bots. */}
          <input
            value={website} onChange={(e) => setWebsite(e.target.value)}
            tabIndex={-1} autoComplete="off" aria-hidden="true"
            style={{ position: "absolute", left: "-9999px", width: 1, height: 1 }}
          />

          <button onClick={() => void submit()} disabled={busy} style={{ ...cta, opacity: busy ? 0.6 : 1 }}>
            {busy ? "Booking…" : "Confirm booking"}
          </button>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", background: "#fff", minHeight: "100vh" }}>
      <div style={{ maxWidth: 620, margin: "0 auto", padding: "28px 20px 48px" }}>{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 5 }}>{label}</span>
      {children}
    </label>
  );
}

const input: React.CSSProperties = {
  width: "100%", padding: "10px 12px", fontSize: 15, borderRadius: 10,
  border: "1.5px solid #e5e7eb", background: "#fff", boxSizing: "border-box",
};
const slotBtn: React.CSSProperties = {
  padding: "9px 16px", borderRadius: 999, border: "1.5px solid #e5e7eb",
  fontSize: 14, fontWeight: 600, cursor: "pointer",
};
const navBtn: React.CSSProperties = {
  border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8,
  width: 34, height: 34, fontSize: 18, cursor: "pointer",
};
const cta: React.CSSProperties = {
  width: "100%", padding: "13px 16px", background: PINK, color: "#fff",
  border: "none", borderRadius: 12, fontSize: 16, fontWeight: 700, cursor: "pointer", marginTop: 6,
};
