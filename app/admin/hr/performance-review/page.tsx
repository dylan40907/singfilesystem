"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";

type HrEmployee = {
  id: string;
  legal_first_name?: string | null;
  legal_middle_name?: string | null;
  legal_last_name?: string | null;
  nicknames?: string[] | null;
  is_active?: boolean | null;
};

type ReviewFormType = "monthly" | "annual";

type HrReviewForm = {
  id: string;
  form_type: ReviewFormType;
  title: string;
  scale_max: number; // 3 or 5
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

function employeeLabel(e: HrEmployee) {
  const fn = (e.legal_first_name ?? "").trim();
  const mn = (e.legal_middle_name ?? "").trim();
  const ln = (e.legal_last_name ?? "").trim();
  const legal = [fn, mn, ln].filter(Boolean).join(" ").trim();
  return legal || e.id;
}

function safeSortByName(a: HrEmployee, b: HrEmployee) {
  const al = (a.legal_last_name ?? "").toLowerCase();
  const bl = (b.legal_last_name ?? "").toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;

  const af = (a.legal_first_name ?? "").toLowerCase();
  const bf = (b.legal_first_name ?? "").toLowerCase();
  if (af !== bf) return af < bf ? -1 : 1;

  const am = (a.legal_middle_name ?? "").toLowerCase();
  const bm = (b.legal_middle_name ?? "").toLowerCase();
  if (am !== bm) return am < bm ? -1 : 1;

  return a.id < b.id ? -1 : 1;
}

function clampScore(n: any, scaleMax: number) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(1, Math.min(scaleMax, Math.trunc(v)));
}

// normal rounding to 1 decimal (4.11 -> 4.1, 4.15 -> 4.2)
function round1dp(n: number) {
  return Math.round(n * 10) / 10;
}

function monthName(m: number) {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return names[m - 1] ?? `M${m}`;
}

function IconButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="btn"
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "6px 10px",
        borderRadius: 10,
        border: "1px solid var(--border)",
        background: disabled ? "rgba(0,0,0,0.04)" : "white",
        fontWeight: 800,
        fontSize: 12,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {children}
    </button>
  );
}

type EditQuestion = {
  id: string; // can be "new:..."
  question_text: string;
  sort_order: number;
};

export default function HrPerformanceReviewsPage() {
  const [status, setStatus] = useState("");
  const [profile, setProfile] = useState<TeacherProfile | null>(null);
  const isAdmin = !!profile?.is_active && profile.role === "admin";

  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [forms, setForms] = useState<HrReviewForm[]>([]);
  const [questions, setQuestions] = useState<ReviewQuestion[]>([]);

  // ---- Question editor modal
  const [editOpen, setEditOpen] = useState(false);
  const [editFormType, setEditFormType] = useState<ReviewFormType>("annual");
  const [editQuestions, setEditQuestions] = useState<EditQuestion[]>([]);
  const editRef = useRef<HTMLDivElement | null>(null);

  // ---- Review modal
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewEmployeeId, setReviewEmployeeId] = useState<string>("");

  const now = useMemo(() => new Date(), []);
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const [reviewFormType, setReviewFormType] = useState<ReviewFormType>("annual");
  const [reviewYear, setReviewYear] = useState<number>(currentYear);
  const [reviewMonth, setReviewMonth] = useState<number>(currentMonth);

  const [reviewId, setReviewId] = useState<string>(""); // resolved/created when loading
  const [reviewValues, setReviewValues] = useState<Record<string, number>>({}); // question_id -> score
  const reviewRef = useRef<HTMLDivElement | null>(null);

  const employeesById = useMemo(() => {
    const m = new Map<string, HrEmployee>();
    for (const e of employees) m.set(e.id, e);
    return m;
  }, [employees]);

  const formsByType = useMemo(() => {
    const m = new Map<ReviewFormType, HrReviewForm>();
    for (const f of forms) m.set(f.form_type, f);
    return m;
  }, [forms]);

  const questionsByFormType = useMemo(() => {
    const annualForm = formsByType.get("annual");
    const monthlyForm = formsByType.get("monthly");

    const annualId = annualForm?.id ?? "";
    const monthlyId = monthlyForm?.id ?? "";

    const annualQs = (questions ?? []).filter((q) => q.form_id === annualId && q.is_active !== false);
    const monthlyQs = (questions ?? []).filter((q) => q.form_id === monthlyId && q.is_active !== false);

    const sortFn = (a: ReviewQuestion, b: ReviewQuestion) =>
      (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.question_text ?? "").localeCompare(b.question_text ?? "");

    return {
      annual: annualQs.slice().sort(sortFn),
      monthly: monthlyQs.slice().sort(sortFn),
    };
  }, [questions, formsByType]);

  const activeReviewQuestions = useMemo(() => {
    return reviewFormType === "annual" ? questionsByFormType.annual : questionsByFormType.monthly;
  }, [questionsByFormType, reviewFormType]);

  const reviewScaleMax = useMemo(() => {
    return formsByType.get(reviewFormType)?.scale_max ?? (reviewFormType === "monthly" ? 3 : 5);
  }, [formsByType, reviewFormType]);

  const reviewEmployee = useMemo(() => {
    if (!reviewEmployeeId) return null;
    return employeesById.get(reviewEmployeeId) ?? null;
  }, [employeesById, reviewEmployeeId]);

  async function loadBoot() {
    setStatus("Loading...");
    try {
      const p = await fetchMyProfile();
      setProfile(p);

      if (!p?.is_active || p.role !== "admin") {
        setStatus("Admin access required.");
        return;
      }

      await loadAll();
      setStatus("");
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    }
  }

  async function loadAll() {
    setStatus("Loading data...");

    const [empRes, formRes, qRes] = await Promise.all([
      supabase
        .from("hr_employees")
        .select("id, legal_first_name, legal_middle_name, legal_last_name, nicknames, is_active")
        .order("legal_last_name", { ascending: true })
        .order("legal_first_name", { ascending: true })
        .order("legal_middle_name", { ascending: true }),

      supabase.from("hr_review_forms").select("id, form_type, title, scale_max, is_active").eq("is_active", true),

      supabase
        .from("hr_review_questions")
        .select("id, form_id, question_text, sort_order, is_active, created_at, updated_at")
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true }),
    ]);

    if (empRes.error) throw empRes.error;
    if (formRes.error) throw formRes.error;
    if (qRes.error) throw qRes.error;

    setEmployees(((empRes.data ?? []) as HrEmployee[]).slice().sort(safeSortByName));
    setForms((formRes.data ?? []) as HrReviewForm[]);
    setQuestions((qRes.data ?? []) as ReviewQuestion[]);

    setStatus("");
  }

  // ----------------------------
  // Question editor helpers
  // ----------------------------
  function openEditQuestions(which: ReviewFormType) {
    const form = formsByType.get(which);
    if (!form) {
      setStatus("Missing hr_review_forms rows. Run the SQL schema block first.");
      return;
    }

    const list: EditQuestion[] = (which === "annual" ? questionsByFormType.annual : questionsByFormType.monthly)
      .slice()
      .map((q, idx) => ({
        id: q.id,
        question_text: q.question_text ?? "",
        sort_order: Number.isFinite(Number(q.sort_order)) ? Number(q.sort_order) : idx,
      }));

    // If empty, give starter questions
    if (list.length === 0) {
      if (which === "annual") {
        list.push({ id: `new:${crypto.randomUUID()}`, question_text: "Quality of work", sort_order: 0 });
        list.push({ id: `new:${crypto.randomUUID()}`, question_text: "Communication", sort_order: 1 });
        list.push({ id: `new:${crypto.randomUUID()}`, question_text: "Reliability", sort_order: 2 });
      } else {
        list.push({ id: `new:${crypto.randomUUID()}`, question_text: "Preparedness", sort_order: 0 });
        list.push({ id: `new:${crypto.randomUUID()}`, question_text: "Classroom management", sort_order: 1 });
        list.push({ id: `new:${crypto.randomUUID()}`, question_text: "Team collaboration", sort_order: 2 });
      }
    }

    list.forEach((q, i) => (q.sort_order = i));
    setEditFormType(which);
    setEditQuestions(list);
    setEditOpen(true);
  }

  function closeEditQuestions() {
    setEditOpen(false);
    setEditQuestions([]);
  }

  function addEditQuestionRow() {
    setEditQuestions((cur) => {
      const next = cur.slice();
      next.push({
        id: `new:${crypto.randomUUID()}`,
        question_text: "",
        sort_order: next.length,
      });
      return next;
    });
  }

  function moveEditQuestion(id: string, dir: -1 | 1) {
    setEditQuestions((cur) => {
      const idx = cur.findIndex((q) => q.id === id);
      if (idx < 0) return cur;
      const j = idx + dir;
      if (j < 0 || j >= cur.length) return cur;
      const next = cur.slice();
      const tmp = next[idx];
      next[idx] = next[j];
      next[j] = tmp;
      next.forEach((q, i) => (q.sort_order = i));
      return next;
    });
  }

  function deleteEditQuestionRow(id: string) {
    setEditQuestions((cur) => cur.filter((q) => q.id !== id).map((q, i) => ({ ...q, sort_order: i })));
  }

  async function saveQuestions() {
    setStatus("Saving questions...");
    try {
      const form = formsByType.get(editFormType);
      if (!form) {
        setStatus("Missing hr_review_forms rows. Run the SQL schema block first.");
        return;
      }

      const cleaned = editQuestions
        .map((q, i) => ({
          ...q,
          sort_order: i,
          question_text: (q.question_text ?? "").trim(),
        }))
        .filter((q) => q.question_text.length > 0);

      if (cleaned.length === 0) {
        setStatus("Add at least 1 question.");
        return;
      }

      const currentIds = new Set(
        (editFormType === "annual" ? questionsByFormType.annual : questionsByFormType.monthly).map((q) => q.id)
      );
      const desiredExistingIds = new Set(cleaned.filter((q) => !q.id.startsWith("new:")).map((q) => q.id));
      const toDelete = Array.from(currentIds).filter((id) => !desiredExistingIds.has(id));

      if (toDelete.length > 0) {
        const ok = confirm(
          `Delete ${toDelete.length} question(s) from ${editFormType}? This will also delete their saved answers for any reviews that used them.`
        );
        if (!ok) {
          setStatus("");
          return;
        }
        const { error: delErr } = await supabase.from("hr_review_questions").delete().in("id", toDelete);
        if (delErr) throw delErr;
      }

      const newRows = cleaned.filter((q) => q.id.startsWith("new:"));
      if (newRows.length > 0) {
        const insertRows = newRows.map((q) => ({
          form_id: form.id,
          question_text: q.question_text,
          sort_order: q.sort_order,
          is_active: true,
        }));
        const { error } = await supabase.from("hr_review_questions").insert(insertRows);
        if (error) throw error;
      }

      const existing = cleaned.filter((q) => !q.id.startsWith("new:"));
      for (const q of existing) {
        const { error } = await supabase
          .from("hr_review_questions")
          .update({
            question_text: q.question_text,
            sort_order: q.sort_order,
            is_active: true,
          })
          .eq("id", q.id);
        if (error) throw error;
      }

      closeEditQuestions();
      await loadAll();
      setStatus("✅ Saved.");
      setTimeout(() => setStatus(""), 900);
    } catch (e: any) {
      setStatus("Save error: " + (e?.message ?? "unknown"));
    }
  }

  // ----------------------------
  // Review modal helpers
  // ----------------------------
  function openReview(employeeId: string) {
    setReviewEmployeeId(employeeId);
    setReviewId("");
    setReviewFormType("annual");
    setReviewYear(currentYear);
    setReviewMonth(currentMonth);
    setReviewValues({});
    setReviewOpen(true);
  }

  function closeReview() {
    setReviewOpen(false);
    setReviewEmployeeId("");
    setReviewId("");
    setReviewValues({});
  }

  function periodKey(ft: ReviewFormType, y: number, m: number) {
    return ft === "annual" ? `annual:${y}` : `monthly:${y}-${String(m).padStart(2, "0")}`;
  }

  async function loadReviewForSelection(employeeId: string, formType: ReviewFormType, year: number, month: number) {
    const qs = formType === "annual" ? questionsByFormType.annual : questionsByFormType.monthly;
    const scaleMax = formsByType.get(formType)?.scale_max ?? (formType === "monthly" ? 3 : 5);

    // If no questions yet, just clear
    if (!qs || qs.length === 0) {
      setReviewId("");
      setReviewValues({});
      return;
    }

    // Find review row if it exists
    const base = supabase
      .from("hr_reviews")
      .select("id, employee_id, form_type, period_year, period_month, created_at, updated_at")
      .eq("employee_id", employeeId)
      .eq("form_type", formType)
      .eq("period_year", year);

    const revRes = formType === "annual" ? await base.is("period_month", null).maybeSingle() : await base.eq("period_month", month).maybeSingle();

    if (revRes.error) throw revRes.error;

    const existingReview = (revRes.data ?? null) as HrReview | null;

    if (!existingReview?.id) {
      // No review yet: initialize defaults (annual mid=3 of 5; monthly mid=2 of 3)
      const init: Record<string, number> = {};
      const def = formType === "monthly" ? 2 : 3;
      for (const q of qs) init[q.id] = def;

      setReviewId("");
      setReviewValues(init);
      return;
    }

    // Load answers
    const ansRes = await supabase
      .from("hr_review_answers")
      .select("review_id, question_id, score, created_at, updated_at")
      .eq("review_id", existingReview.id);

    if (ansRes.error) throw ansRes.error;

    const init: Record<string, number> = {};
    const byQ = new Map<string, number>();
    for (const a of (ansRes.data ?? []) as HrReviewAnswer[]) byQ.set(a.question_id, a.score);

    const def = formType === "monthly" ? 2 : 3;
    for (const q of qs) {
      const v = byQ.get(q.id);
      init[q.id] = typeof v === "number" && Number.isFinite(v) ? clampScore(v, scaleMax) ?? def : def;
    }

    setReviewId(existingReview.id);
    setReviewValues(init);
  }

  async function ensureReviewRow(employeeId: string, formType: ReviewFormType, year: number, month: number) {
    // Upsert the review row to get an ID
    const payload: any = {
      employee_id: employeeId,
      form_type: formType,
      period_year: year,
      period_month: formType === "annual" ? null : month,
    };

    const up = await supabase
      .from("hr_reviews")
      .upsert(payload, { onConflict: "employee_id,form_type,period_year,period_month" })
      .select("id")
      .single();

    if (up.error) throw up.error;
    return String((up.data as any)?.id ?? "");
  }

  async function saveReview() {
    if (!reviewEmployeeId) return;

    const qs = activeReviewQuestions;
    if (!qs || qs.length === 0) {
      setStatus("No questions for this review type. Edit questions first.");
      return;
    }

    if (!Number.isFinite(Number(reviewYear)) || reviewYear < 2000 || reviewYear > 2100) {
      setStatus("Invalid year.");
      return;
    }
    if (reviewFormType === "monthly") {
      if (!Number.isFinite(Number(reviewMonth)) || reviewMonth < 1 || reviewMonth > 12) {
        setStatus("Invalid month.");
        return;
      }
    }

    setStatus("Saving review...");
    try {
      const scaleMax = reviewScaleMax;

      const rid = await ensureReviewRow(reviewEmployeeId, reviewFormType, reviewYear, reviewMonth);
      setReviewId(rid);

      const rows = qs.map((q) => {
        const v = clampScore(reviewValues[q.id], scaleMax);
        const fallback = reviewFormType === "monthly" ? 2 : 3;
        return {
          review_id: rid,
          question_id: q.id,
          score: v ?? fallback,
        };
      });

      const { error } = await supabase.from("hr_review_answers").upsert(rows, { onConflict: "review_id,question_id" });
      if (error) throw error;

      setStatus("✅ Saved.");
      setTimeout(() => setStatus(""), 900);
      closeReview();
    } catch (e: any) {
      setStatus("Save review error: " + (e?.message ?? "unknown"));
    }
  }

  const computedAvg = useMemo(() => {
    const qs = activeReviewQuestions;
    if (!qs || qs.length === 0) return null;
    const scaleMax = reviewScaleMax;

    const vals = qs.map((q) => clampScore(reviewValues[q.id], scaleMax)).filter((v): v is number => typeof v === "number");
    if (vals.length === 0) return null;

    const avg = vals.reduce((s, x) => s + x, 0) / vals.length;
    return round1dp(avg);
  }, [activeReviewQuestions, reviewValues, reviewScaleMax]);

  // Auto-load review answers whenever selection changes while modal is open
  useEffect(() => {
    if (!reviewOpen) return;
    if (!reviewEmployeeId) return;
    const k = periodKey(reviewFormType, reviewYear, reviewMonth);

    let cancelled = false;
    (async () => {
      try {
        setStatus(`Loading ${reviewFormType} review (${k})...`);
        await loadReviewForSelection(reviewEmployeeId, reviewFormType, reviewYear, reviewMonth);
        if (!cancelled) {
          setStatus("");
        }
      } catch (e: any) {
        if (!cancelled) setStatus("Load review error: " + (e?.message ?? "unknown"));
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewOpen, reviewEmployeeId, reviewFormType, reviewYear, reviewMonth, questionsByFormType, formsByType]);

  // Close modals on outside click / escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (reviewOpen) closeReview();
      if (editOpen) closeEditQuestions();
    };

    const onDown = (e: MouseEvent) => {
      if (reviewOpen) {
        const el = reviewRef.current;
        if (el && !el.contains(e.target as any)) closeReview();
      }
      if (editOpen) {
        const el = editRef.current;
        if (el && !el.contains(e.target as any)) closeEditQuestions();
      }
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewOpen, editOpen]);

  useEffect(() => {
    void loadBoot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="stack">
      <div className="container">
        <div className="row-between" style={{ marginTop: 16, gap: 10, flexWrap: "wrap" }}>
          <div className="stack" style={{ gap: 6 }}>
            <h1 className="h1">Performance Reviews</h1>
            <div className="subtle">
              Two review types:
              <b> Annual (1–5)</b> and <b>Monthly (1–3)</b>. Averages are computed with normal rounding to 1 decimal.
            </div>
          </div>

          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button className="btn" type="button" onClick={() => openEditQuestions("annual")} disabled={!isAdmin}>
              Edit annual questions
            </button>
            <button className="btn" type="button" onClick={() => openEditQuestions("monthly")} disabled={!isAdmin}>
              Edit monthly questions
            </button>
            <IconButton title="Reload" onClick={() => void loadAll()} disabled={!isAdmin}>
              ↻
            </IconButton>
            {status ? <span className="badge badge-pink">{status}</span> : null}
          </div>
        </div>

        {!isAdmin ? (
          <div className="card" style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 900, color: "#b00020" }}>Admin access required.</div>
            <div className="subtle" style={{ marginTop: 6 }}>This page is only available to admin accounts.</div>
          </div>
        ) : (
          <>
            <div className="card" style={{ marginTop: 14, padding: 16 }}>
              <div className="row-between" style={{ gap: 10, flexWrap: "wrap" }}>
                <div className="subtle">
                  Annual questions: <b>{questionsByFormType.annual.length}</b>
                </div>
                <div className="subtle">
                  Monthly questions: <b>{questionsByFormType.monthly.length}</b>
                </div>
              </div>
            </div>

            <div className="card" style={{ marginTop: 14, padding: 0, overflow: "auto" }}>
              <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ minWidth: 260 }}>Employee</th>
                    <th style={{ width: 160 }}>Status</th>
                    <th style={{ width: 170 }} />
                  </tr>
                </thead>
                <tbody>
                  {employees.length === 0 ? (
                    <tr>
                      <td colSpan={3} style={{ padding: 14 }}>
                        <span className="subtle">(No employees found.)</span>
                      </td>
                    </tr>
                  ) : (
                    employees.map((e) => (
                      <tr key={e.id}>
                        <td style={{ padding: 12 }}>
                          <div style={{ fontWeight: 900, lineHeight: 1.2 }}>{employeeLabel(e)}</div>
                          <div className="subtle" style={{ marginTop: 4 }}>ID: {e.id}</div>
                        </td>
                        <td style={{ padding: 12 }}>
                          {e.is_active === false ? <span className="badge">inactive</span> : <span className="badge badge-green">active</span>}
                        </td>
                        <td style={{ padding: 12, textAlign: "right" }}>
                          <button className="btn btn-primary" type="button" onClick={() => openReview(e.id)}>
                            Write / edit review
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* ===========================
                EDIT QUESTIONS MODAL
               =========================== */}
            {editOpen ? (
              <div
                role="dialog"
                aria-modal="true"
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "rgba(0,0,0,0.55)",
                  zIndex: 220,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 14,
                }}
              >
                <div
                  ref={editRef}
                  className="card"
                  style={{
                    width: "min(860px, 100%)",
                    padding: 16,
                    borderRadius: 16,
                    maxHeight: "min(720px, 90vh)",
                    overflow: "auto",
                  }}
                >
                  <div className="row-between" style={{ gap: 10 }}>
                    <div className="stack" style={{ gap: 4 }}>
                      <div style={{ fontWeight: 950, fontSize: 16 }}>
                        Edit {editFormType === "annual" ? "Annual" : "Monthly"} questions
                      </div>
                      <div className="subtle">
                        {editFormType === "annual" ? "Annual answers are 1–5." : "Monthly answers are 1–3."}
                      </div>
                    </div>
                    <button className="btn" type="button" onClick={closeEditQuestions} title="Close">
                      ✕
                    </button>
                  </div>

                  <div className="hr" />

                  <div className="stack" style={{ gap: 10 }}>
                    {editQuestions.map((q, idx) => (
                      <div
                        key={q.id}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr auto",
                          gap: 10,
                          alignItems: "start",
                          padding: "10px 10px",
                          border: "1px solid var(--border)",
                          borderRadius: 14,
                          background: "white",
                        }}
                      >
                        <div className="stack" style={{ gap: 8 }}>
                          <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                            <div style={{ fontWeight: 900 }}>#{idx + 1}</div>
                          </div>

                          <input
                            className="input"
                            value={q.question_text}
                            placeholder="Question text"
                            onChange={(e) => {
                              const v = e.target.value;
                              setEditQuestions((cur) => cur.map((x) => (x.id === q.id ? { ...x, question_text: v } : x)));
                            }}
                          />
                        </div>

                        <div className="stack" style={{ gap: 8, alignItems: "flex-end" }}>
                          <div className="row" style={{ gap: 8 }}>
                            <IconButton title="Move up" disabled={idx === 0} onClick={() => moveEditQuestion(q.id, -1)}>
                              ↑
                            </IconButton>
                            <IconButton
                              title="Move down"
                              disabled={idx === editQuestions.length - 1}
                              onClick={() => moveEditQuestion(q.id, 1)}
                            >
                              ↓
                            </IconButton>
                          </div>

                          <button
                            className="btn"
                            type="button"
                            onClick={() => {
                              const isExisting = !q.id.startsWith("new:");
                              if (isExisting) {
                                const ok = confirm("Delete this question? This will also delete saved answers for it.");
                                if (!ok) return;
                              }
                              deleteEditQuestionRow(q.id);
                            }}
                            title="Delete question"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}

                    <div className="row-between" style={{ gap: 10, flexWrap: "wrap", marginTop: 6 }}>
                      <button className="btn" type="button" onClick={addEditQuestionRow}>
                        + Add question
                      </button>

                      <div className="row" style={{ gap: 10 }}>
                        <button className="btn" type="button" onClick={closeEditQuestions}>
                          Cancel
                        </button>
                        <button className="btn btn-primary" type="button" onClick={() => void saveQuestions()}>
                          Save
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {/* ===========================
                REVIEW MODAL
               =========================== */}
            {reviewOpen && reviewEmployeeId ? (
              <div
                role="dialog"
                aria-modal="true"
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "rgba(0,0,0,0.55)",
                  zIndex: 230,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 14,
                }}
              >
                <div
                  ref={reviewRef}
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
                      <div style={{ fontWeight: 950, fontSize: 16 }}>Write performance review</div>
                      <div className="subtle">
                        Employee: <b>{reviewEmployee ? employeeLabel(reviewEmployee) : reviewEmployeeId}</b>
                      </div>
                      <div className="subtle">
                        Saved review id:{" "}
                        {reviewId ? <b>{reviewId}</b> : <span>(not created yet — will create on Save)</span>}
                      </div>
                    </div>
                    <button className="btn" type="button" onClick={closeReview} title="Close (Esc)">
                      ✕
                    </button>
                  </div>

                  <div className="hr" />

                  {/* Type + period selection */}
                  <div
                    className="card"
                    style={{
                      padding: 12,
                      borderRadius: 14,
                      border: "1px solid var(--border)",
                      background: "rgba(0,0,0,0.015)",
                      marginBottom: 12,
                    }}
                  >
                    <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "end" }}>
                      <div style={{ minWidth: 220 }}>
                        <div style={{ fontWeight: 900, marginBottom: 6 }}>Review type</div>
                        <select
                          className="select"
                          value={reviewFormType}
                          onChange={(e) => {
                            const ft = e.target.value as ReviewFormType;
                            setReviewFormType(ft);
                            // reset default values when switching type
                            setReviewValues({});
                            setReviewId("");
                          }}
                        >
                          <option value="annual">Annual (1–5)</option>
                          <option value="monthly">Monthly (1–3)</option>
                        </select>
                      </div>

                      <div style={{ width: 140 }}>
                        <div style={{ fontWeight: 900, marginBottom: 6 }}>Year</div>
                        <input
                          className="input"
                          type="number"
                          value={reviewYear}
                          onChange={(e) => setReviewYear(Number(e.target.value))}
                          min={2000}
                          max={2100}
                        />
                      </div>

                      {reviewFormType === "monthly" ? (
                        <div style={{ width: 200 }}>
                          <div style={{ fontWeight: 900, marginBottom: 6 }}>Month</div>
                          <select className="select" value={reviewMonth} onChange={(e) => setReviewMonth(Number(e.target.value))}>
                            {Array.from({ length: 12 }).map((_, i) => {
                              const m = i + 1;
                              return (
                                <option key={m} value={m}>
                                  {monthName(m)}
                                </option>
                              );
                            })}
                          </select>
                        </div>
                      ) : null}

                      <div className="subtle" style={{ alignSelf: "center", marginLeft: "auto" }}>
                        {reviewFormType === "annual"
                          ? `Editing: Annual ${reviewYear}`
                          : `Editing: Monthly ${monthName(reviewMonth)} ${reviewYear}`}
                      </div>
                    </div>
                  </div>

                  {activeReviewQuestions.length === 0 ? (
                    <div className="subtle">
                      No questions for this review type yet. Close and click{" "}
                      <b>{reviewFormType === "annual" ? "Edit annual questions" : "Edit monthly questions"}</b>.
                    </div>
                  ) : (
                    <div className="stack" style={{ gap: 10 }}>
                      {activeReviewQuestions.map((q) => (
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

                          <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                            <div className="subtle" style={{ minWidth: 140 }}>
                              Score (1–{reviewScaleMax})
                            </div>

                            <select
                              className="select"
                              value={String(reviewValues[q.id] ?? (reviewFormType === "monthly" ? 2 : 3))}
                              onChange={(e) => {
                                const v = clampScore(e.target.value, reviewScaleMax) ?? (reviewFormType === "monthly" ? 2 : 3);
                                setReviewValues((cur) => ({ ...cur, [q.id]: v }));
                              }}
                              style={{ width: 140 }}
                            >
                              {Array.from({ length: reviewScaleMax }).map((_, i) => {
                                const v = i + 1;
                                return (
                                  <option key={v} value={v}>
                                    {v}
                                  </option>
                                );
                              })}
                            </select>

                            <div className="subtle">
                              {reviewFormType === "monthly" ? "1 = needs improvement · 3 = excellent" : "1 = needs improvement · 5 = excellent"}
                            </div>
                          </div>
                        </div>
                      ))}

                      <div className="row-between" style={{ gap: 10, flexWrap: "wrap", marginTop: 4 }}>
                        <div className="subtle">
                          Average (auto):{" "}
                          <b>{computedAvg === null ? "—" : computedAvg.toFixed(1)}</b>
                          <span className="subtle"> (normal rounding)</span>
                        </div>

                        <div className="row" style={{ gap: 10 }}>
                          <button className="btn" type="button" onClick={closeReview}>
                            Cancel
                          </button>
                          <button className="btn btn-primary" type="button" onClick={() => void saveReview()}>
                            Save review
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            <style jsx>{`
              th,
              td {
                border-bottom: 1px solid var(--border);
                vertical-align: top;
              }
              th {
                padding: 12px;
                background: rgba(0, 0, 0, 0.02);
                text-align: left;
                font-weight: 950;
                position: sticky;
                top: 0;
                z-index: 1;
              }
            `}</style>
          </>
        )}
      </div>
    </main>
  );
}
