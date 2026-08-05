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
 * Laid out as two panels like the booking tools parents already know: what the
 * visit is on the left, and one job at a time on the right — pick a day, pick a
 * time, then fill in details. Choosing a time *replaces* the calendar rather
 * than revealing a form below it, so nobody has to scroll to find what's next.
 */

const FN = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/tours-public`;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const PINK = "#e6178d";
const INK = "#111827";
const MUTED = "#6b7280";
const LINE = "#e5e7eb";

type TourInfo = {
  name: string; description: string | null; location: string | null;
  duration_minutes: number; time_zone: string;
  /** Preschool tours and HWC consultations ask different questions. */
  kind?: "preschool_tour" | "hwc_consult";
};

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

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function BookTourPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug as string;

  const [tour, setTour] = useState<TourInfo | null>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [month, setMonth] = useState(() => new Date());
  const [day, setDay] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [step, setStep] = useState<"pick" | "details">("pick");
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
  const [referredBy, setReferredBy] = useState("");
  const [childName, setChildName] = useState("");
  const [childDob, setChildDob] = useState("");
  const [schedule, setSchedule] = useState("");
  const [chineseLevel, setChineseLevel] = useState("");
  const [startDate, setStartDate] = useState("");
  const [startNote, setStartNote] = useState("");
  const [notes, setNotes] = useState("");
  // Consultation-only questions.
  const [goals, setGoals] = useState("");
  const [whichProgram, setWhichProgram] = useState("");
  const [takingLessons, setTakingLessons] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [busy, setBusy] = useState(false);

  // Let a Squarespace embed size the iframe to the content.
  useEffect(() => {
    const post = () => window.parent?.postMessage(
      { type: "sing-book-height", height: document.body.scrollHeight }, "*"
    );
    post();
    const t = setTimeout(post, 250);
    return () => clearTimeout(t);
  }, [tour, slots, picked, done, step]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Pull a wide window so paging months doesn't refetch constantly, and so
      // the calendar can grey out days that simply have nothing free.
      const from = new Date(month.getFullYear(), month.getMonth(), 1);
      const to = new Date(month.getFullYear(), month.getMonth() + 2, 0);
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
      const key = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
        .format(new Date(s));
      m.set(key, [...(m.get(key) ?? []), s]);
    }
    return m;
  }, [slots, tz]);

  const timeLabel = (i: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(i));
  const longDay = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date(y, m - 1, d));
  };
  const whenLabel = (i: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
    }).format(new Date(i));

  /** Leading blanks + every date in the shown month. */
  const grid = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const cells: (Date | null)[] = Array.from({ length: first.getDay() }, () => null);
    for (let d = 1; d <= days; d++) cells.push(new Date(month.getFullYear(), month.getMonth(), d));
    return cells;
  }, [month]);

  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(month);
  const times = day ? byDay.get(day) ?? [] : [];
  /** Only a personal referral has someone to name. */
  const needsReferrer = ["Sibling / Returning Family", "Friend or Family"].includes(heard);
  /** Chinese Classes + Homework Club consultations ask a different set. */
  const isConsult = tour?.kind === "hwc_consult";

  function chooseDay(key: string) {
    setDay(key);
    setPicked(null);
  }

  async function submit() {
    if (!picked) return;

    // Everything is required. Naming the first gap beats a generic "check the
    // form" — the parent shouldn't have to hunt for what's missing.
    const missing =
      !name.trim() ? "your first and last name"
      : !email.includes("@") ? "a valid email address"
      : !phone.trim() ? "your phone number"
      : !city.trim() ? "your city"
      : !timeZone ? "your time zone"
      : !language ? "your preferred language"
      : !heard ? "how you heard about us"
      : needsReferrer && !referredBy.trim() ? "who told you about us"
      : !childName.trim() ? "your child's full name"
      : !childDob ? "your child's date of birth"
      : !chineseLevel.trim() ? "whether your child knows any Chinese"
      // The two forms diverge from here.
      : isConsult
        ? (!goals.trim() ? "your learning goals for your child"
          : !whichProgram ? "which program you're interested in"
          : !takingLessons.trim() ? "whether your child is taking Chinese lessons"
          : !notes.trim() ? "anything that will help prepare for our meeting"
          : null)
        : (!schedule ? "the days / schedule / after care you're after"
          // These two are alternatives by design ("…or in your own words"), so
          // either one on its own is enough.
          : !startDate && !startNote.trim() ? "a desired start date, or a note about when"
          : !notes.trim() ? "anything that will help us prepare"
          : null);
    if (missing) { setError(`Please add ${missing}.`); return; }

    setBusy(true);
    setError("");
    try {
      const data = await callFn({
        mode: "book", slug, start: picked, website,
        parent_name: name.trim(), parent_email: email.trim(), parent_phone: phone.trim(),
        city: city.trim(), time_zone: timeZone, preferred_language: language,
        source_other: heard || null,
        referred_by: referredBy.trim() || null,
        notes: notes.trim(),
        // A consultation records its own answers and creates no lead, so the
        // child block is only meaningful for a preschool tour.
        child_name: childName.trim(),
        child_dob: childDob || null,
        answers: isConsult ? {
          chinese_knowledge: chineseLevel.trim(),
          learning_goals: goals.trim(),
          program_interest: whichProgram,
          currently_taking_lessons: takingLessons.trim(),
          how_heard: heard,
        } : {},
        children: isConsult ? [] : [{
          // These links are preschool tours, so the programme is a given —
          // no point asking, and the lead should still record it.
          name: childName.trim(), dob: childDob || null, program: "Preschool",
          schedule: schedule.trim() || null, chinese_level: chineseLevel.trim() || null,
          desired_start_date: startDate || null, desired_start_note: startNote.trim() || null,
        }],
      });
      setDone({ when: data.when });
    } catch (e) {
      setError((e as Error).message);
      setStep("pick");
      await load(); // the slot may have gone — refresh what's left
    } finally {
      setBusy(false);
    }
  }

  // ── Confirmation ──────────────────────────────────────────────────────────
  if (done) {
    return (
      <Shell>
        <div style={{ padding: "56px 32px", textAlign: "center" }}>
          <div style={{ fontSize: 46, lineHeight: 1 }}>🎉</div>
          <h1 style={{ fontSize: 25, fontWeight: 800, margin: "16px 0 8px", color: INK }}>
            {isConsult ? "You’re booked" : "Request received"}
          </h1>
          <div style={{ fontSize: 17, fontWeight: 700, color: INK }}>{done.when}</div>
          {tour?.location && <div style={{ color: MUTED, marginTop: 4 }}>{tour.location}</div>}
          <p style={{ color: MUTED, maxWidth: 420, margin: "20px auto 0", lineHeight: 1.6 }}>
            {isConsult
              ? "We’ve emailed you the meeting link and a calendar invite. See you then."
              : "Thank you — we have your request. A confirmation email will be sent to you within 24 – 48 hours. We’ve also emailed you a copy."}
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="book-grid">
        {/* ── Left: what the visit is ─────────────────────────────────────── */}
        <aside style={{ padding: "28px 26px", borderRight: `1px solid ${LINE}` }}>
          {step === "details" && (
            <button
              onClick={() => { setStep("pick"); setError(""); }}
              aria-label="Back to choosing a time"
              style={{
                width: 36, height: 36, borderRadius: 999, border: `1px solid ${LINE}`,
                background: "#fff", cursor: "pointer", fontSize: 17, color: INK, marginBottom: 18,
              }}
            >
              ←
            </button>
          )}
          <div style={{ color: MUTED, fontWeight: 700, fontSize: 14 }}>Sing in Chinese</div>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: "6px 0 18px", color: INK, lineHeight: 1.25 }}>
            {tour?.name ?? "Preschool Tour"}
          </h1>
          <Meta icon="🕐">{tour?.duration_minutes ?? 30} min</Meta>
          {tour?.location && <Meta icon="📍">{tour.location}</Meta>}
          {picked && <Meta icon="📅"><strong>{whenLabel(picked)}</strong></Meta>}
          <Meta icon="🌐">Pacific Time — US &amp; Canada</Meta>
          {tour?.description && (
            <p style={{ color: MUTED, marginTop: 18, lineHeight: 1.6, fontSize: 14 }}>{tour.description}</p>
          )}
        </aside>

        {/* ── Right: one job at a time ────────────────────────────────────── */}
        <section style={{ padding: "28px 26px", minWidth: 0 }}>
          {error && (
            <div style={{
              background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b",
              padding: "10px 14px", borderRadius: 10, marginBottom: 16, fontSize: 14, fontWeight: 600,
            }}>
              {error}
            </div>
          )}

          {step === "pick" ? (
            <>
              <h2 style={{ fontSize: 19, fontWeight: 800, margin: "0 0 18px", color: INK }}>Select a Date &amp; Time</h2>
              <div className="cal-split">
                <div>
                  <div className="row-between" style={{ alignItems: "center", marginBottom: 10 }}>
                    <NavBtn onClick={() => { setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1)); setDay(null); setPicked(null); }} label="‹" />
                    <div style={{ fontWeight: 800, color: INK }}>{monthLabel}</div>
                    <NavBtn onClick={() => { setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1)); setDay(null); setPicked(null); }} label="›" />
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                      <div key={d} style={{ textAlign: "center", fontSize: 12, color: MUTED, fontWeight: 700, padding: "4px 0" }}>{d}</div>
                    ))}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
                    {grid.map((d, i) => {
                      if (!d) return <div key={`b${i}`} />;
                      const key = iso(d);
                      const has = (byDay.get(key)?.length ?? 0) > 0;
                      const on = day === key;
                      return (
                        <button
                          key={key}
                          disabled={!has}
                          onClick={() => chooseDay(key)}
                          aria-label={longDay(key) + (has ? "" : " — no times")}
                          style={{
                            aspectRatio: "1", borderRadius: 999, border: "none", position: "relative",
                            cursor: has ? "pointer" : "default",
                            fontWeight: has ? 800 : 500, fontSize: 14,
                            background: on ? PINK : has ? "rgba(230,23,141,0.08)" : "transparent",
                            color: on ? "#fff" : has ? PINK : "#cbd5e1",
                          }}
                        >
                          {d.getDate()}
                        </button>
                      );
                    })}
                  </div>

                  {loading && <div style={{ color: MUTED, fontSize: 13, marginTop: 12 }}>Loading times…</div>}
                  {!loading && byDay.size === 0 && (
                    <div style={{ color: MUTED, fontSize: 13, marginTop: 12 }}>
                      No times available this month — try the arrow above.
                    </div>
                  )}
                </div>

                {/* Times for the chosen day */}
                <div style={{ minWidth: 0 }}>
                  {day ? (
                    <>
                      <div style={{ fontWeight: 700, color: INK, marginBottom: 10 }}>{longDay(day)}</div>
                      <div style={{ display: "grid", gap: 8, maxHeight: 320, overflowY: "auto" }}>
                        {times.map((t) => {
                          const on = picked === t;
                          return on ? (
                            // Confirm in place, exactly where the eye already is.
                            <div key={t} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                              <div style={{
                                padding: "12px 10px", borderRadius: 8, background: "#9ca3af",
                                color: "#fff", fontWeight: 800, textAlign: "center", fontSize: 15,
                              }}>
                                {timeLabel(t)}
                              </div>
                              <button
                                onClick={() => { setStep("details"); setError(""); }}
                                style={{
                                  padding: "12px 10px", borderRadius: 8, border: "none", background: PINK,
                                  color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer",
                                }}
                              >
                                Next
                              </button>
                            </div>
                          ) : (
                            <button
                              key={t}
                              onClick={() => setPicked(t)}
                              style={{
                                padding: "12px 10px", borderRadius: 8, border: `1.5px solid ${PINK}`,
                                background: "#fff", color: PINK, fontWeight: 800, fontSize: 15, cursor: "pointer",
                              }}
                            >
                              {timeLabel(t)}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <div style={{ color: MUTED, fontSize: 14, paddingTop: 34 }}>
                      Pick a highlighted day to see its times.
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            /* ── Details ──────────────────────────────────────────────────── */
            <>
              <h2 style={{ fontSize: 19, fontWeight: 800, margin: "0 0 4px", color: INK }}>Enter Details</h2>
              <div style={{ color: MUTED, fontSize: 13, marginBottom: 18 }}>
                So we can prepare for your visit. All fields are required.
              </div>

              <Legend>About you</Legend>
              <Field label="First and last name *"><input style={input} value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Two>
                <Field label="Email *"><input style={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
                <Field label="Phone *"><input style={input} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
              </Two>
              <Two>
                <Field label="City *"><input style={input} value={city} onChange={(e) => setCity(e.target.value)} /></Field>
                <Field label="Preferred language *">
                  <select style={input} value={language} onChange={(e) => setLanguage(e.target.value)}>
                    {["English", "Mandarin", "Cantonese", "Spanish", "Other"].map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </Field>
              </Two>
              <Two>
                <Field label="Your time zone *">
                  <select style={input} value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
                    {["Pacific (Los Angeles)", "Mountain (Denver)", "Central (Chicago)", "Eastern (New York)", "Other"]
                      .map((z) => <option key={z} value={z}>{z}</option>)}
                  </select>
                </Field>
                <Field label="How did you hear about us? *">
                  <select style={input} value={heard} onChange={(e) => setHeard(e.target.value)}>
                    <option value="">— Choose —</option>
                    {["Google", "Instagram", "Facebook", "Yelp", "Drive by / Sign", "Sibling / Returning Family", "Friend or Family", "Other"]
                      .map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </Field>
              </Two>
              {/* Only asked when a person referred them — there's nobody to
                  name otherwise. */}
              {needsReferrer && (
                <Field label="Who told you about us? *">
                  <input style={input} value={referredBy} onChange={(e) => setReferredBy(e.target.value)} />
                </Field>
              )}

              <Legend>About your child</Legend>
              <Two>
                <Field label="Child's full name *"><input style={input} value={childName} onChange={(e) => setChildName(e.target.value)} /></Field>
                <Field label="Date of birth *"><input style={input} type="date" value={childDob} onChange={(e) => setChildDob(e.target.value)} /></Field>
              </Two>
              {isConsult ? (
                <>
                  <Field label="Does your child have any current knowledge of Chinese? *">
                    <input style={input} value={chineseLevel} onChange={(e) => setChineseLevel(e.target.value)} />
                  </Field>
                  <Field label="What are the learning goals for your child? *">
                    <input style={input} value={goals} onChange={(e) => setGoals(e.target.value)} placeholder="Speaking, Reading, Writing…" />
                  </Field>
                  <Two>
                    <Field label="Which program are you interested in? *">
                      <select style={input} value={whichProgram} onChange={(e) => setWhichProgram(e.target.value)}>
                        <option value="">— Choose —</option>
                        {[
                          "Chinese Classes", "Homework Club 2 Days a Week", "Homework Club 3 Days a Week",
                          "Homework Club 4 Days a Week", "Homework Club 5 Days a Week", "Not sure yet",
                        ].map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </Field>
                    <Field label="Currently taking Chinese lessons? If so, where? *">
                      <input style={input} value={takingLessons} onChange={(e) => setTakingLessons(e.target.value)} placeholder="No / at home / school name" />
                    </Field>
                  </Two>
                </>
              ) : (
                <Two>
                  {/* Free text on the staff-side lead form, but a fixed set here:
                      parents shouldn't be inventing schedule descriptions. Still
                      stored as the same text field. */}
                  <Field label="Days / schedule / after care *">
                    <select style={input} value={schedule} onChange={(e) => setSchedule(e.target.value)}>
                      <option value="">— Choose —</option>
                      {["AM", "PM", "Full Care", "None"].map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </Field>
                  <Field label="Does your child know any Chinese? *">
                    <input style={input} value={chineseLevel} onChange={(e) => setChineseLevel(e.target.value)} />
                  </Field>
                </Two>
              )}
              {/* A start date only makes sense when there's a place to start. */}
              {!isConsult && (
                <Two>
                  <Field label="Desired start date *"><input style={input} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
                  <Field label="…or in your own words">
                    <input style={input} value={startNote} onChange={(e) => setStartNote(e.target.value)} placeholder="Sometime next fall" />
                  </Field>
                </Two>
              )}
              <Field label={isConsult ? "Anything that will help prepare for our meeting? *" : "Anything that will help us prepare? *"}>
                <textarea style={{ ...input, minHeight: 76, resize: "vertical" }} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>

              {/* Honeypot — hidden from people, tempting to bots. */}
              <input
                value={website} onChange={(e) => setWebsite(e.target.value)}
                tabIndex={-1} autoComplete="off" aria-hidden="true"
                style={{ position: "absolute", left: "-9999px", width: 1, height: 1 }}
              />

              <button
                onClick={() => void submit()}
                disabled={busy}
                style={{
                  marginTop: 18, width: "100%", padding: "14px 18px", borderRadius: 10, border: "none",
                  background: busy ? "#f9a8d4" : PINK, color: "#fff", fontWeight: 800, fontSize: 16,
                  cursor: busy ? "default" : "pointer",
                }}
              >
                {busy ? "Sending…" : isConsult ? "Book this consultation" : "Request this tour"}
              </button>
              <div style={{ color: MUTED, fontSize: 12, textAlign: "center", marginTop: 10 }}>
                {isConsult
                  ? "You’ll get the meeting link and a calendar invite by email straight away."
                  : "We’ll confirm your request by email within 24 – 48 hours."}
              </div>
            </>
          )}
        </section>
      </div>
    </Shell>
  );
}

// ── Chrome ──────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ minHeight: "100vh", background: "#f7f7f8", padding: "28px 16px", fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" }}>
      <div style={{
        maxWidth: 940, margin: "0 auto", background: "#fff",
        border: `1px solid ${LINE}`, borderRadius: 16, overflow: "hidden",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}>
        {children}
      </div>
      <style>{`
        .book-grid { display: grid; grid-template-columns: 320px 1fr; }
        .cal-split { display: grid; grid-template-columns: 1fr 200px; gap: 26px; }
        .row-between { display: flex; justify-content: space-between; }
        /* One column on phones: the calendar needs the full width, and the
           left panel becomes a header rather than a sidebar. */
        @media (max-width: 760px) {
          .book-grid { grid-template-columns: 1fr; }
          .book-grid > aside { border-right: none; border-bottom: 1px solid ${LINE}; }
          .cal-split { grid-template-columns: 1fr; gap: 18px; }
        }
      `}</style>
    </main>
  );
}

function NavBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 34, height: 34, borderRadius: 999, border: `1px solid ${LINE}`,
        background: "#fff", cursor: "pointer", fontSize: 17, color: PINK, fontWeight: 800, lineHeight: 1,
      }}
    >
      {label}
    </button>
  );
}

function Meta({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", color: MUTED, fontSize: 14, marginBottom: 9 }}>
      <span style={{ flexShrink: 0 }}>{icon}</span>
      <span style={{ color: INK }}>{children}</span>
    </div>
  );
}

function Legend({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontWeight: 800, fontSize: 12, color: MUTED, letterSpacing: 0.4, textTransform: "uppercase", margin: "18px 0 4px" }}>
      {children}
    </div>
  );
}

function Two({ children }: { children: React.ReactNode }) {
  return <div className="two-col">{children}<style>{`
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 560px) { .two-col { grid-template-columns: 1fr; } }
  `}</style></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 5 }}>{label}</span>
      {children}
    </label>
  );
}

const input: React.CSSProperties = {
  width: "100%", padding: "11px 12px", borderRadius: 9, border: `1.5px solid ${LINE}`,
  fontSize: 15, fontFamily: "inherit", outline: "none", background: "#fff", color: INK,
};
