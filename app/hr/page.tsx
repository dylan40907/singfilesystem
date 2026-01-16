"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile } from "@/lib/teachers";

type AttendanceTypeRow = {
  id: string;
  name: string;
  points_deduct: number;
};

type EmployeeAttendanceRow = {
  id: string;
  employee_id: string;
  attendance_type_id: string;
  occurred_on: string; // YYYY-MM-DD
  notes: string | null;
  created_at: string;
  attendance_type?: AttendanceTypeRow | null;
};

type ReviewFormType = "monthly" | "annual";

type HrReviewForm = {
  id: string;
  form_type: ReviewFormType;
  title: string;
  scale_max: number;
  is_active: boolean;
};

type ReviewQuestion = {
  id: string;
  form_id: string;
  question_text: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type HrReview = {
  id: string;
  employee_id: string;
  form_type: ReviewFormType;
  period_year: number;
  period_month: number | null;
  created_at: string;
  updated_at: string;
};

type HrReviewAnswer = {
  review_id: string;
  question_id: string;
  score: number;
  created_at: string;
  updated_at: string;
};

type EmployeeHeader = {
  id: string;
  legal_first_name: string;
  legal_middle_name: string | null;
  legal_last_name: string;
  is_active: boolean;
  attendance_points: number;
};

function asSingle<T>(v: any): T | null {
  if (!v) return null;
  if (Array.isArray(v)) return (v[0] ?? null) as T | null;
  return v as T;
}

function formatYmd(ymd: string) {
  try {
    const d = new Date(`${ymd}T00:00:00`);
    return d.toLocaleDateString();
  } catch {
    return ymd;
  }
}

// Green if 3, Yellow if 1-2, Red if anything lower
function scoreColor(points: number) {
  if (points <= 0) return "#dc2626"; // red
  if (points <= 2) return "#ca8a04"; // yellow
  return "#16a34a"; // green
}

function monthName(m: number) {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return names[m - 1] ?? `M${m}`;
}

function formatReviewLabel(r: HrReview) {
  if (r.form_type === "annual") return `Annual ${r.period_year}`;
  const mm = r.period_month ?? 1;
  return `Monthly ${monthName(mm)} ${r.period_year}`;
}

function reviewMostRecentAt(r: HrReview) {
  const t = r.updated_at || r.created_at;
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

function round1dp(n: number) {
  return Math.round(n * 10) / 10;
}

function clampScore(n: any, scaleMax: number) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(1, Math.min(scaleMax, Math.trunc(v)));
}

async function getMyEmployeeId(): Promise<string> {
  // fetchMyProfile() should return the current user's row from user_profiles
  const p: any = await fetchMyProfile();
  const profileId = String(p?.id ?? "");
  if (!profileId) throw new Error("Could not load your profile.");

  // Map user_profiles.id -> hr_employees.profile_id
  const res = await supabase
    .from("hr_employees")
    .select("id")
    .eq("profile_id", profileId)
    .maybeSingle();

  if (res.error) throw res.error;
  if (res.data?.id) return String(res.data.id);

  throw new Error(
    "No HR employee record is linked to your profile yet. Ask an admin to set hr_employees.profile_id to your user_profiles.id."
  );
}

async function fetchEmployeeHeader(employeeId: string): Promise<EmployeeHeader> {
  const { data, error } = await supabase
    .from("hr_employees")
    .select("id, legal_first_name, legal_middle_name, legal_last_name, is_active, attendance_points")
    .eq("id", employeeId)
    .single();

  if (error) throw error;
  return data as EmployeeHeader;
}

function ReadOnlyAttendanceTab({ employeeId, attPoints }: { employeeId: string; attPoints: number }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  const [rows, setRows] = useState<EmployeeAttendanceRow[]>([]);

  async function load() {
    if (!employeeId) return;
    setError("");
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("hr_employee_attendance")
        .select(
          `
            id,
            employee_id,
            attendance_type_id,
            occurred_on,
            notes,
            created_at,
            attendance_type:hr_attendance_types!hr_employee_attendance_attendance_type_id_fkey(id,name,points_deduct)
          `
        )
        .eq("employee_id", employeeId)
        .order("occurred_on", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw error;

      const normalized = (data ?? []).map((x: any) => ({
        ...x,
        attendance_type: asSingle<AttendanceTypeRow>(x.attendance_type),
      })) as EmployeeAttendanceRow[];

      setRows(normalized);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load attendance.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
      <div className="row-between" style={{ gap: 12, alignItems: "center" }}>
        <div style={{ fontWeight: 900 }}>
          Attendance{" "}
          <span style={{ marginLeft: 10, fontWeight: 900, color: scoreColor(attPoints) }}>
            ({attPoints})
          </span>
        </div>

        <button className="btn" type="button" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      <div className="subtle" style={{ marginTop: 6 }}>
        Records are read-only. Score colors:{" "}
        <span style={{ color: "#16a34a", fontWeight: 900 }}>3</span> green,{" "}
        <span style={{ color: "#ca8a04", fontWeight: 900 }}>1–2</span> yellow,{" "}
        <span style={{ color: "#dc2626", fontWeight: 900 }}>0 or lower</span> red.
      </div>

      {error ? (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 12,
            border: "1px solid rgba(239,68,68,0.35)",
            background: "rgba(239,68,68,0.06)",
            color: "#991b1b",
            fontWeight: 700,
          }}
        >
          {error}
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>
          Records ({rows.length}) {loading ? <span className="subtle" style={{ marginLeft: 10 }}>Loading…</span> : null}
        </div>

        {rows.length === 0 ? (
          <div className="subtle">No attendance records yet.</div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {rows.map((a) => {
              const deduct = a.attendance_type?.points_deduct ?? 0;
              return (
                <div key={a.id} style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
                  <div className="row-between" style={{ gap: 12, alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontWeight: 900 }}>
                        {a.attendance_type?.name ?? "—"}{" "}
                        <span className="subtle" style={{ fontWeight: 800 }}>
                          • −{deduct}
                        </span>{" "}
                        • {formatYmd(a.occurred_on)}
                      </div>

                      {a.notes ? (
                        <div className="subtle" style={{ marginTop: 4 }}>
                          {a.notes}
                        </div>
                      ) : (
                        <div className="subtle" style={{ marginTop: 4 }}>
                          —
                        </div>
                      )}

                      <div className="subtle" style={{ marginTop: 6, fontSize: 12 }}>
                        Created: {a.created_at ? new Date(a.created_at).toLocaleString() : "—"}
                      </div>
                    </div>

                    <div className="subtle" style={{ fontWeight: 800, whiteSpace: "nowrap" }}>
                      ID:{" "}
                      <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                        {a.id.slice(0, 8)}…
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ReadOnlyReviewsTab({ employeeId }: { employeeId: string }) {
  const [status, setStatus] = useState<string>("");

  const [showAnnual, setShowAnnual] = useState<boolean>(false);

  const [forms, setForms] = useState<HrReviewForm[]>([]);
  const [questions, setQuestions] = useState<ReviewQuestion[]>([]);
  const [reviews, setReviews] = useState<HrReview[]>([]);

  // view modal
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<HrReview | null>(null);
  const [answersByQ, setAnswersByQ] = useState<Map<string, number>>(new Map());
  const modalRef = useRef<HTMLDivElement | null>(null);

  const formsByType = useMemo(() => {
    const m = new Map<ReviewFormType, HrReviewForm>();
    for (const f of forms) m.set(f.form_type, f);
    return m;
  }, [forms]);

  const questionsByType = useMemo(() => {
    const annualId = formsByType.get("annual")?.id ?? "";
    const monthlyId = formsByType.get("monthly")?.id ?? "";

    const annual = (questions ?? []).filter((q) => q.form_id === annualId && q.is_active !== false);
    const monthly = (questions ?? []).filter((q) => q.form_id === monthlyId && q.is_active !== false);

    const sortFn = (a: ReviewQuestion, b: ReviewQuestion) =>
      (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
      (a.question_text ?? "").localeCompare(b.question_text ?? "");

    return {
      annual: annual.slice().sort(sortFn),
      monthly: monthly.slice().sort(sortFn),
    };
  }, [questions, formsByType]);

  const filteredReviews = useMemo(() => {
    const ft: ReviewFormType = showAnnual ? "annual" : "monthly";
    return (reviews ?? [])
      .filter((r) => r.form_type === ft)
      .slice()
      .sort((a, b) => reviewMostRecentAt(b) - reviewMostRecentAt(a));
  }, [reviews, showAnnual]);

  async function loadMetaAndReviews() {
    setStatus("Loading reviews...");
    try {
      const [formRes, qRes, revRes] = await Promise.all([
        supabase.from("hr_review_forms").select("id, form_type, title, scale_max, is_active").eq("is_active", true),
        supabase
          .from("hr_review_questions")
          .select("id, form_id, question_text, sort_order, is_active, created_at, updated_at")
          .eq("is_active", true)
          .order("sort_order", { ascending: true })
          .order("created_at", { ascending: true }),
        supabase
          .from("hr_reviews")
          .select("id, employee_id, form_type, period_year, period_month, created_at, updated_at")
          .eq("employee_id", employeeId),
      ]);

      if (formRes.error) throw formRes.error;
      if (qRes.error) throw qRes.error;
      if (revRes.error) throw revRes.error;

      setForms((formRes.data ?? []) as HrReviewForm[]);
      setQuestions((qRes.data ?? []) as ReviewQuestion[]);
      setReviews((revRes.data ?? []) as HrReview[]);

      setStatus("");
    } catch (e: any) {
      setStatus("Load error: " + (e?.message ?? "unknown"));
      setForms([]);
      setQuestions([]);
      setReviews([]);
    }
  }

  async function openView(r: HrReview) {
    setViewing(r);
    setAnswersByQ(new Map());
    setOpen(true);

    try {
      setStatus("Loading evaluation...");
      const ansRes = await supabase
        .from("hr_review_answers")
        .select("review_id, question_id, score, created_at, updated_at")
        .eq("review_id", r.id);

      if (ansRes.error) throw ansRes.error;

      const m = new Map<string, number>();
      for (const a of (ansRes.data ?? []) as HrReviewAnswer[]) {
        m.set(a.question_id, a.score);
      }
      setAnswersByQ(m);
      setStatus("");
    } catch (e: any) {
      setStatus("Load evaluation error: " + (e?.message ?? "unknown"));
    }
  }

  function closeModal() {
    setOpen(false);
    setViewing(null);
    setAnswersByQ(new Map());
  }

  const activeQuestions = useMemo(() => {
    if (!viewing) return [];
    return viewing.form_type === "annual" ? questionsByType.annual : questionsByType.monthly;
  }, [viewing, questionsByType]);

  const scaleMax = useMemo(() => {
    if (!viewing) return 5;
    return formsByType.get(viewing.form_type)?.scale_max ?? (viewing.form_type === "monthly" ? 3 : 5);
  }, [formsByType, viewing]);

  const computedAvg = useMemo(() => {
    if (!viewing) return null;
    if (!activeQuestions || activeQuestions.length === 0) return null;

    const max = scaleMax;
    const vals = activeQuestions
      .map((q) => clampScore(answersByQ.get(q.id), max))
      .filter((v): v is number => typeof v === "number");

    if (vals.length === 0) return null;
    return round1dp(vals.reduce((s, x) => s + x, 0) / vals.length);
  }, [activeQuestions, answersByQ, scaleMax, viewing]);

  useEffect(() => {
    if (!employeeId) return;
    void loadMetaAndReviews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  // ESC + outside click to close
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    const onDown = (e: MouseEvent) => {
      const el = modalRef.current;
      if (el && !el.contains(e.target as any)) closeModal();
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
      <div className="row-between" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>Performance Reviews</div>
          <div className="subtle">Read-only view of your evaluations.</div>
        </div>

        <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn" type="button" onClick={() => void loadMetaAndReviews()}>
            Refresh
          </button>
          {status ? <span className="subtle" style={{ fontWeight: 800 }}>{status}</span> : null}
        </div>
      </div>

      <div style={{ height: 12 }} />

      <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800 }}>
        <input
          type="checkbox"
          checked={showAnnual}
          onChange={(e) => setShowAnnual(e.target.checked)}
        />
        Show annual evaluations (unchecked = monthly)
      </label>

      <div style={{ height: 12 }} />

      <div style={{ fontWeight: 800, marginBottom: 8 }}>
        {showAnnual ? "Annual evaluations" : "Monthly evaluations"} ({filteredReviews.length})
      </div>

      {filteredReviews.length === 0 ? (
        <div className="subtle">(No evaluations yet.)</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filteredReviews.map((r) => (
            <div key={r.id} style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
              <div className="row-between" style={{ gap: 12, alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontWeight: 900 }}>{formatReviewLabel(r)}</div>
                  <div className="subtle" style={{ marginTop: 4, fontSize: 12 }}>
                    Updated: {r.updated_at ? new Date(r.updated_at).toLocaleString() : "—"}
                    {r.created_at ? ` • Created: ${new Date(r.created_at).toLocaleString()}` : ""}
                  </div>
                </div>

                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <button className="btn" type="button" onClick={() => void openView(r)} style={{ padding: "6px 10px" }}>
                    View
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* VIEW MODAL */}
      {open && viewing ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 260,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 14,
          }}
        >
          <div
            ref={modalRef}
            className="card"
            style={{
              width: "min(920px, 100%)",
              padding: 16,
              borderRadius: 16,
              maxHeight: "min(820px, 90vh)",
              overflow: "auto",
            }}
          >
            <div className="row-between" style={{ gap: 10 }}>
              <div className="stack" style={{ gap: 4 }}>
                <div style={{ fontWeight: 950, fontSize: 16 }}>
                  {formatReviewLabel(viewing)}
                </div>
                <div className="subtle">
                  Scale: <b>1–{scaleMax}</b> • Average:{" "}
                  <b>{computedAvg === null ? "—" : computedAvg.toFixed(1)}</b>
                </div>
              </div>

              <button className="btn" type="button" onClick={closeModal} title="Close (Esc)">
                ✕
              </button>
            </div>

            <div className="hr" />

            {activeQuestions.length === 0 ? (
              <div className="subtle">
                No questions are configured for this review type.
              </div>
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                {activeQuestions.map((q) => {
                  const score = answersByQ.get(q.id);
                  return (
                    <div
                      key={q.id}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 14,
                        padding: 12,
                        background: "white",
                      }}
                    >
                      <div style={{ fontWeight: 900, marginBottom: 8 }}>{q.question_text}</div>
                      <div className="subtle" style={{ fontWeight: 800 }}>
                        Score: <b>{typeof score === "number" ? score : "—"}</b> / {scaleMax}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function HrPortalPage() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>("");
  const [employeeId, setEmployeeId] = useState<string>("");
  const [employee, setEmployee] = useState<EmployeeHeader | null>(null);

  const [activeTab, setActiveTab] = useState<"attendance" | "reviews">("attendance");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setErr("");

      try {
        const empId = await getMyEmployeeId();
        if (cancelled) return;

        setEmployeeId(empId);

        const header = await fetchEmployeeHeader(empId);
        if (cancelled) return;

        // If someone is inactive, still allow them to view? You can change this rule.
        setEmployee(header);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message ?? "Failed to load HR portal.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const titleName = employee
    ? [employee.legal_first_name, employee.legal_middle_name, employee.legal_last_name].filter(Boolean).join(" ")
    : "HR Portal";

  const attPoints = Number(employee?.attendance_points ?? 3);

  return (
    <div style={{ padding: 16 }}>
      <div className="row-between" style={{ gap: 12, alignItems: "center" }}>
        <div>
          <h1 style={{ margin: 0 }}>{titleName}</h1>
          <div className="subtle" style={{ marginTop: 6 }}>
            Your HR Portal (read-only)
            {employeeId ? (
              <>
                {" "}
                • Employee ID:{" "}
                <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                  {employeeId}
                </span>
              </>
            ) : null}
            {employee ? (
              <>
                <span style={{ marginLeft: 10 }}>
                  • Attendance score:{" "}
                  <span style={{ fontWeight: 900, color: scoreColor(attPoints) }}>{attPoints}</span>
                </span>
              </>
            ) : null}
          </div>
        </div>

        <div className="row" style={{ gap: 10 }}>
          <button className="btn" onClick={() => router.refresh()} disabled={loading}>
            {loading ? "Loading..." : "Refresh page"}
          </button>
        </div>
      </div>

      {err ? (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 12,
            border: "1px solid rgba(239,68,68,0.35)",
            background: "rgba(239,68,68,0.06)",
            color: "#991b1b",
            fontWeight: 700,
            whiteSpace: "pre-wrap",
          }}
        >
          {err}
        </div>
      ) : null}

      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "240px 1fr", gap: 14 }}>
        {/* LEFT NAV */}
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, overflow: "hidden", height: "fit-content" }}>
          <div style={{ padding: 12, borderBottom: "1px solid #e5e7eb", fontWeight: 900 }}>Sections</div>

          <button
            type="button"
            className="btn"
            onClick={() => setActiveTab("attendance")}
            style={{
              width: "100%",
              textAlign: "left",
              padding: 12,
              border: "none",
              borderRadius: 0,
              background: activeTab === "attendance" ? "rgba(0,0,0,0.04)" : "transparent",
              fontWeight: 900,
            }}
          >
            Attendance{" "}
            {employee ? (
              <span style={{ marginLeft: 8, fontWeight: 900, color: scoreColor(attPoints) }}>
                {attPoints}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            className="btn"
            onClick={() => setActiveTab("reviews")}
            style={{
              width: "100%",
              textAlign: "left",
              padding: 12,
              border: "none",
              borderRadius: 0,
              background: activeTab === "reviews" ? "rgba(0,0,0,0.04)" : "transparent",
              fontWeight: 900,
            }}
          >
            Performance Reviews
          </button>
        </div>

        {/* RIGHT CONTENT */}
        <div>
          {loading ? (
            <div className="subtle" style={{ padding: 12 }}>
              Loading…
            </div>
          ) : !employeeId ? (
            <div className="card" style={{ padding: 14 }}>
              Could not determine your employee record.
            </div>
          ) : (
            <>
              {activeTab === "attendance" && (
                <ReadOnlyAttendanceTab employeeId={employeeId} attPoints={attPoints} />
              )}
              {activeTab === "reviews" && <ReadOnlyReviewsTab employeeId={employeeId} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
