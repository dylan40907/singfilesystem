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

  // ✅ This is what you actually have on hr_employees:
  // attendance_points: int (1–5) or numeric (we display like a score)
  attendance_points?: number | null;
};

type ReviewQuestion = {
  id: string;
  question_text: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type ReviewAnswer = {
  employee_id: string;
  question_id: string;
  score: number; // 1..5
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

function clampScore(n: any) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(1, Math.min(5, v));
}

// ceil to 1 decimal place (e.g. 4.134 -> 4.2)
function ceil1dp(n: number) {
  return Math.ceil(n * 10) / 10;
}

function recommendedRaisePct(total: number) {
  if (total >= 8) return 4;
  if (total >= 7) return 3;
  if (total >= 6) return 2;
  return 0;
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
  const [questions, setQuestions] = useState<ReviewQuestion[]>([]);
  const [answers, setAnswers] = useState<ReviewAnswer[]>([]);

  // Change questions modal
  const [editOpen, setEditOpen] = useState(false);
  const [editQuestions, setEditQuestions] = useState<EditQuestion[]>([]);
  const editRef = useRef<HTMLDivElement | null>(null);

  // Review modal (per employee)
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewEmployeeId, setReviewEmployeeId] = useState<string>("");
  const [reviewValues, setReviewValues] = useState<Record<string, number>>({}); // question_id -> 1..5
  const reviewRef = useRef<HTMLDivElement | null>(null);

  const employeesById = useMemo(() => {
    const m = new Map<string, HrEmployee>();
    for (const e of employees) m.set(e.id, e);
    return m;
  }, [employees]);

  const reviewQuestions = useMemo(() => {
    return (questions ?? [])
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.question_text.localeCompare(b.question_text));
  }, [questions]);

  const answersByEmployee = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const a of answers) {
      const inner = m.get(a.employee_id) ?? new Map<string, number>();
      inner.set(a.question_id, a.score);
      m.set(a.employee_id, inner);
    }
    return m;
  }, [answers]);

  function computePerformanceScore(employeeId: string) {
    const inner = answersByEmployee.get(employeeId);
    if (!inner) return null;

    const vals: number[] = [];
    for (const q of reviewQuestions) {
      const v = inner.get(q.id);
      if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
    }
    if (vals.length === 0) return null;

    const avg = vals.reduce((s, x) => s + x, 0) / vals.length;
    return ceil1dp(avg);
  }

  function computeAttendanceScore(e: HrEmployee) {
    const v = e.attendance_points; // ✅ FIXED: use attendance_points
    if (v === null || v === undefined) return null;

    const n = Number(v);
    if (!Number.isFinite(n)) return null;

    // Attendance score is meant to be a 1–5 scale
    const clamped = Math.max(1, Math.min(5, n));
    return ceil1dp(clamped);
  }

  function computeTotalScore(att: number | null, perf: number | null) {
    const a = Number.isFinite(Number(att)) ? Number(att) : 0;
    const p = Number.isFinite(Number(perf)) ? Number(perf) : 0;
    return ceil1dp(a + p);
  }

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

    const empRes = await supabase
      .from("hr_employees")
      .select("*")
      .order("legal_last_name", { ascending: true })
      .order("legal_first_name", { ascending: true })
      .order("legal_middle_name", { ascending: true });

    if (empRes.error) throw empRes.error;

    const empList = ((empRes.data ?? []) as HrEmployee[]).slice().sort(safeSortByName);
    setEmployees(empList);

    const qRes = await supabase
      .from("hr_performance_review_questions")
      .select("id, question_text, sort_order, created_at, updated_at")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (qRes.error) throw qRes.error;

    const qList = (qRes.data ?? []) as ReviewQuestion[];
    setQuestions(qList);

    const qIds = qList.map((q) => q.id);
    if (qIds.length === 0) {
      setAnswers([]);
      setStatus("");
      return;
    }

    const aRes = await supabase
      .from("hr_performance_review_answers")
      .select("*")
      .in("question_id", qIds);

    if (aRes.error) throw aRes.error;

    const seen = new Set<string>();
    const dedup: ReviewAnswer[] = [];
    for (const r of (aRes.data ?? []) as ReviewAnswer[]) {
      const k = `${r.employee_id}:${r.question_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push(r);
    }

    setAnswers(dedup);
    setStatus("");
  }

  // ----- Change Questions modal -----
  function openEditQuestions() {
    const list: EditQuestion[] = (questions ?? [])
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.question_text.localeCompare(b.question_text))
      .map((q, idx) => ({
        id: q.id,
        question_text: q.question_text ?? "",
        sort_order: Number.isFinite(Number(q.sort_order)) ? Number(q.sort_order) : idx,
      }));

    if (list.length === 0) {
      list.push({ id: `new:${crypto.randomUUID()}`, question_text: "Quality of work", sort_order: 0 });
      list.push({ id: `new:${crypto.randomUUID()}`, question_text: "Communication", sort_order: 1 });
      list.push({ id: `new:${crypto.randomUUID()}`, question_text: "Reliability", sort_order: 2 });
    }

    list.forEach((q, i) => (q.sort_order = i));
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
      const cleaned = editQuestions
        .map((q, i) => ({
          ...q,
          sort_order: i,
          question_text: (q.question_text ?? "").trim(),
        }))
        .filter((q) => q.question_text.length > 0); // drop empty rows silently

      if (cleaned.length === 0) {
        setStatus("Add at least 1 question.");
        return;
      }

      const existingIds = new Set((questions ?? []).map((q) => q.id));
      const desiredExistingIds = new Set(cleaned.filter((q) => !q.id.startsWith("new:")).map((q) => q.id));

      const toDelete = Array.from(existingIds).filter((id) => !desiredExistingIds.has(id));
      if (toDelete.length > 0) {
        const ok = confirm(
          `Delete ${toDelete.length} question(s)? This will also delete their saved answers (for all employees).`
        );
        if (!ok) {
          setStatus("");
          return;
        }

        const { error: delErr } = await supabase.from("hr_performance_review_questions").delete().in("id", toDelete);
        if (delErr) throw delErr;
      }

      const newRows = cleaned.filter((q) => q.id.startsWith("new:"));
      if (newRows.length > 0) {
        const insertRows = newRows.map((q) => ({
          question_text: q.question_text,
          sort_order: q.sort_order,
        }));

        const { error } = await supabase.from("hr_performance_review_questions").insert(insertRows);
        if (error) throw error;
      }

      const existing = cleaned.filter((q) => !q.id.startsWith("new:"));
      for (const q of existing) {
        const { error } = await supabase
          .from("hr_performance_review_questions")
          .update({
            question_text: q.question_text,
            sort_order: q.sort_order,
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

  // ----- Review modal (per employee) -----
  function openReview(employeeId: string) {
    const inner = answersByEmployee.get(employeeId);
    const init: Record<string, number> = {};

    for (const q of reviewQuestions) {
      const v = inner?.get(q.id);
      if (typeof v === "number" && Number.isFinite(v)) init[q.id] = v;
      else init[q.id] = 3; // default mid score for new questions
    }

    setReviewEmployeeId(employeeId);
    setReviewValues(init);
    setReviewOpen(true);
  }

  function closeReview() {
    setReviewOpen(false);
    setReviewEmployeeId("");
    setReviewValues({});
  }

  async function saveReview() {
    if (!reviewEmployeeId) return;

    if (reviewQuestions.length === 0) {
      setStatus("No questions. Click “Change questions” first.");
      return;
    }

    setStatus("Saving review...");
    try {
      const rows = reviewQuestions.map((q) => {
        const v = clampScore(reviewValues[q.id]);
        return {
          employee_id: reviewEmployeeId,
          question_id: q.id,
          score: v ?? 3,
        };
      });

      const { error } = await supabase
        .from("hr_performance_review_answers")
        .upsert(rows, { onConflict: "employee_id,question_id" });

      if (error) throw error;

      closeReview();
      await loadAll();
      setStatus("✅ Saved.");
      setTimeout(() => setStatus(""), 900);
    } catch (e: any) {
      setStatus("Save review error: " + (e?.message ?? "unknown"));
    }
  }

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

  const rows = useMemo(() => {
    return (employees ?? []).map((e) => {
      const attendance = computeAttendanceScore(e);
      const perf = computePerformanceScore(e.id);
      const total = computeTotalScore(attendance, perf);
      const raisePct = recommendedRaisePct(total);
      return { e, attendance, perf, total, raisePct };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees, reviewQuestions, answersByEmployee]);

  const reviewEmployee = useMemo(() => {
    if (!reviewEmployeeId) return null;
    return employeesById.get(reviewEmployeeId) ?? null;
  }, [employeesById, reviewEmployeeId]);

  return (
    <main className="stack">
      <div className="container">
        <div className="row-between" style={{ marginTop: 16, gap: 10, flexWrap: "wrap" }}>
          <div className="stack" style={{ gap: 6 }}>
            <h1 className="h1">Performance Reviews</h1>
            <div className="subtle">
              Questions are editable any time. Performance score is the average of the current question set (1–5), rounded up to 1 decimal.
            </div>
          </div>

          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button className="btn" type="button" onClick={openEditQuestions} disabled={!isAdmin}>
              Change questions
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
                  Questions: <b>{reviewQuestions.length}</b>
                </div>
                <div className="subtle">
                  Raise rule: total ≥ 8 → 4% · total ≥ 7 → 3% · total ≥ 6 → 2% · else 0%
                </div>
              </div>
            </div>

            <div className="card" style={{ marginTop: 14, padding: 0, overflow: "auto" }}>
              <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ minWidth: 240 }}>Employee</th>
                    <th style={{ width: 150 }}>Attendance</th>
                    <th style={{ width: 160 }}>Performance</th>
                    <th style={{ width: 120 }}>Total</th>
                    <th style={{ width: 220 }}>Recommended increase</th>
                    <th style={{ width: 140 }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ padding: 14 }}>
                        <span className="subtle">(No employees found.)</span>
                      </td>
                    </tr>
                  ) : (
                    rows.map(({ e, attendance, perf, total, raisePct }) => (
                      <tr key={e.id}>
                        <td style={{ padding: 12 }}>
                          <div style={{ fontWeight: 900, lineHeight: 1.2 }}>{employeeLabel(e)}</div>
                          <div className="subtle" style={{ marginTop: 4 }}>ID: {e.id}</div>
                        </td>
                        <td style={{ padding: 12, fontWeight: 900 }}>
                          {attendance === null ? <span className="subtle">—</span> : attendance.toFixed(1)}
                        </td>
                        <td style={{ padding: 12, fontWeight: 900 }}>
                          {perf === null ? <span className="subtle">—</span> : perf.toFixed(1)}
                        </td>
                        <td style={{ padding: 12, fontWeight: 950 }}>{total.toFixed(1)}</td>
                        <td style={{ padding: 12 }}>
                          <span style={{ fontWeight: 950 }}>{raisePct}%</span>{" "}
                          <span className="subtle">(based on total)</span>
                        </td>
                        <td style={{ padding: 12, textAlign: "right" }}>
                          <button
                            className="btn btn-primary"
                            type="button"
                            onClick={() => openReview(e.id)}
                            disabled={reviewQuestions.length === 0}
                            title={reviewQuestions.length === 0 ? "Add questions first" : "Answer review questions (1–5)"}
                          >
                            Review
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* CHANGE QUESTIONS MODAL */}
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
                      <div style={{ fontWeight: 950, fontSize: 16 }}>Change review questions</div>
                      <div className="subtle">Questions are always answered 1–5. Deactivation is not supported—delete removes it.</div>
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
                            placeholder="Question text (e.g., 'Communication')"
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

            {/* REVIEW MODAL */}
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
                    width: "min(860px, 100%)",
                    padding: 16,
                    borderRadius: 16,
                    maxHeight: "min(780px, 90vh)",
                    overflow: "auto",
                  }}
                >
                  <div className="row-between" style={{ gap: 10 }}>
                    <div className="stack" style={{ gap: 4 }}>
                      <div style={{ fontWeight: 950, fontSize: 16 }}>Performance review</div>
                      <div className="subtle">
                        Employee: <b>{reviewEmployee ? employeeLabel(reviewEmployee) : reviewEmployeeId}</b>
                      </div>
                    </div>
                    <button className="btn" type="button" onClick={closeReview} title="Close (Esc)">
                      ✕
                    </button>
                  </div>

                  <div className="hr" />

                  {reviewQuestions.length === 0 ? (
                    <div className="subtle">(No questions. Close this and click “Change questions”.)</div>
                  ) : (
                    <div className="stack" style={{ gap: 10 }}>
                      {reviewQuestions.map((q) => (
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
                            <div className="subtle" style={{ minWidth: 130 }}>
                              Score (1–5)
                            </div>

                            <select
                              className="select"
                              value={String(reviewValues[q.id] ?? 3)}
                              onChange={(e) => {
                                const v = clampScore(e.target.value) ?? 3;
                                setReviewValues((cur) => ({ ...cur, [q.id]: v }));
                              }}
                              style={{ width: 140 }}
                            >
                              <option value="1">1</option>
                              <option value="2">2</option>
                              <option value="3">3</option>
                              <option value="4">4</option>
                              <option value="5">5</option>
                            </select>

                            <div className="subtle">1 = needs improvement · 5 = excellent</div>
                          </div>
                        </div>
                      ))}

                      <div className="row-between" style={{ gap: 10, flexWrap: "wrap", marginTop: 4 }}>
                        <div className="subtle">
                          Performance score (auto):{" "}
                          <b>
                            {(() => {
                              const vals = reviewQuestions.map((q) => clampScore(reviewValues[q.id]) ?? 3);
                              const avg = vals.reduce((s, x) => s + x, 0) / Math.max(1, vals.length);
                              return ceil1dp(avg).toFixed(1);
                            })()}
                          </b>
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
