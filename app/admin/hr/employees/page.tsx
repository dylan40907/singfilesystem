"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import { useDialog } from "@/components/ui/useDialog";
import { useEscapeKey } from "@/components/ui/useEscapeKey";
import { applyCampusFilterToQuery, useCampusFilter } from "@/lib/CampusContext";
import { roleLabel, roleBadgeStyle, roleRank } from "@/lib/roles";
import { canSeeEmployeeWithRole, canUseHrPortal, hasAdminAccess } from "@/lib/hrAccess";
import AddUserModal from "@/components/hr/AddUserModal";

type CampusRow = { id: string; name: string };
type JobLevelRow = { id: string; name: string };

type EmployeeListRow = {
  id: string;
  legal_first_name: string | null;
  legal_last_name: string | null;
  is_active: boolean | null;
  campus: CampusRow | null;
  job_level: JobLevelRow | null;
  updated_at: string | null;
  profile_id: string | null;
};

/** Linked portal-account info, keyed by user_profiles.id. */
type ProfileMeta = { role: string | null; is_active: boolean; can_manage_learning: boolean | null };

function employeeHref(id: string) {
  return `/admin/hr/employees/${id}`;
}

function displayName(e: EmployeeListRow) {
  const first = (e.legal_first_name || "").trim();
  const last = (e.legal_last_name || "").trim();
  const name = `${first} ${last}`.trim();
  return name || "(Unnamed)";
}

export default function EmployeesPage() {
  const { alert, modal: dialogModal } = useDialog();
  const [me, setMe] = useState<TeacherProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const [rows, setRows] = useState<EmployeeListRow[]>([]);
  const [profileMeta, setProfileMeta] = useState<Map<string, ProfileMeta>>(new Map());
  const [error, setError] = useState<string>("");
  const [addOpen, setAddOpen] = useState(false);

  const [q, setQ] = useState("");

  // Export by Job Role by Month
  const [exportOpen, setExportOpen] = useState(false);
  const [jobLevels, setJobLevels] = useState<JobLevelRow[]>([]);
  const [exportJobLevelId, setExportJobLevelId] = useState<string>("");
  const [exportYear, setExportYear] = useState<number>(new Date().getFullYear());
  const [exportMonth, setExportMonth] = useState<number>(new Date().getMonth() + 1);
  const [exportBusy, setExportBusy] = useState(false);

  // Export monthly scorecards for every active employee over a month range.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkFromMonth, setBulkFromMonth] = useState<number>(1);
  const [bulkFromYear, setBulkFromYear] = useState<number>(new Date().getFullYear());
  const [bulkToMonth, setBulkToMonth] = useState<number>(new Date().getMonth() + 1);
  const [bulkToYear, setBulkToYear] = useState<number>(new Date().getFullYear());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState("");

  // House rule: every popup closes on Escape — but not mid-export, or the
  // workbook would keep building with nowhere to land.
  useEscapeKey(() => setBulkOpen(false), bulkOpen && !bulkBusy);
  useEscapeKey(() => setExportOpen(false), exportOpen && !exportBusy);

  type SortKey = "name" | "campus" | "jobLevel" | "role" | "active";
  const defaultDirForKey: Record<SortKey, "asc" | "desc"> = {
    name: "asc",
    campus: "asc",
    jobLevel: "asc",
    role: "asc",
    active: "desc",
  };

  const [sortState, setSortState] = useState<{ key: SortKey; dir: "asc" | "desc" }>(() => ({
    key: "name",
    dir: defaultDirForKey.name,
  }));

  function toggleSort(key: SortKey) {
    setSortState((prev) => {
      if (prev.key === key) {
        return { ...prev, dir: prev.dir === "asc" ? "desc" : "asc" };
      }
      return { key, dir: defaultDirForKey[key] };
    });
  }

  function sortIndicator(key: SortKey) {
    if (sortState.key !== key) return "";
    return sortState.dir === "asc" ? " ▲" : " ▼";
  }


  function downloadBlob(filename: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function totalsFillForMonthly(total: number) {
    if (total >= 22) return "FFB7E1CD";
    if (total >= 18) return "FFFFF2CC";
    if (total >= 15) return "FFFCE5CD";
    return "FFF8CBAD";
  }

  const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // Row shapes for the bulk scorecard export.
  type BulkEmp = {
    id: string;
    legal_first_name: string | null;
    legal_middle_name: string | null;
    legal_last_name: string | null;
  };
  type BulkReview = { id: string; employee_id: string; form_id: string; period_month: number; period_year: number };
  type BulkQuestion = { id: string; form_id: string; question_text: string; sort_order: number; kind: string | null };
  type BulkAnswer = { review_id: string; question_id: string; score: number | null };

  /** Inclusive list of {year, month} from one month to another, across year ends. */
  function monthRange(fromY: number, fromM: number, toY: number, toM: number) {
    const out: { year: number; month: number; label: string }[] = [];
    let y = fromY;
    let m = fromM;
    // Guard against a reversed or absurd range producing an endless loop.
    for (let guard = 0; guard < 600; guard++) {
      if (y > toY || (y === toY && m > toM)) break;
      out.push({ year: y, month: m, label: `${MONTH_NAMES[m - 1]} ${String(y).slice(2)}` });
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }

  /**
   * One workbook, one sheet per active employee: questions down the side,
   * the chosen months across the top. Same layout as the single-employee
   * "Export Monthly Reviews by Year", so the two read the same way — this one
   * just spans an arbitrary month range and covers everyone at once.
   */
  async function exportAllMonthlyScorecards() {
    const months = monthRange(bulkFromYear, bulkFromMonth, bulkToYear, bulkToMonth);
    if (months.length === 0) {
      await alert("The end month is before the start month.");
      return;
    }

    setBulkBusy(true);
    setBulkProgress("Loading employees…");
    try {
      // Active employees only, respecting the campus filter that's on screen.
      let empQ = supabase
        .from("hr_employees")
        .select("id, legal_first_name, legal_middle_name, legal_last_name, campus_id, is_active")
        .eq("is_active", true);
      empQ = applyCampusFilterToQuery(empQ, campusFilter, "campus_id");
      const { data: empRows, error: empErr } = await empQ;
      if (empErr) throw empErr;

      const employees = ((empRows ?? []) as BulkEmp[]).sort((a, b) =>
        `${a.legal_last_name ?? ""} ${a.legal_first_name ?? ""}`.trim()
          .localeCompare(`${b.legal_last_name ?? ""} ${b.legal_first_name ?? ""}`.trim())
      );
      if (employees.length === 0) {
        await alert("No active employees to export.");
        return;
      }

      // Every published monthly review in the window, for everyone, in one go.
      const firstY = months[0].year;
      const lastY = months[months.length - 1].year;
      setBulkProgress("Loading reviews…");
      const { data: revRows, error: revErr } = await supabase
        .from("hr_reviews")
        .select("id, employee_id, form_id, period_month, period_year")
        .eq("form_type", "monthly")
        .eq("published", true)
        .gte("period_year", firstY)
        .lte("period_year", lastY)
        .in("employee_id", employees.map((e) => e.id));
      if (revErr) throw revErr;

      const inWindow = new Set(months.map((m) => `${m.year}-${m.month}`));
      const reviews = ((revRows ?? []) as BulkReview[])
        .filter((r) => inWindow.has(`${r.period_year}-${Number(r.period_month)}`));

      if (reviews.length === 0) {
        await alert("No published monthly scorecards in that range.");
        return;
      }

      // Questions for every form used in the window.
      const formIds = Array.from(new Set(reviews.map((r) => r.form_id).filter(Boolean)));
      const { data: qRows, error: qErr } = await supabase
        .from("hr_review_questions")
        .select("id, form_id, question_text, sort_order, is_active, kind")
        .in("form_id", formIds)
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (qErr) throw qErr;
      const questionsByForm = new Map<string, BulkQuestion[]>();
      for (const q of (qRows ?? []) as BulkQuestion[]) {
        if ((q.kind ?? "question") !== "question") continue;
        const arr = questionsByForm.get(q.form_id) ?? [];
        arr.push(q);
        questionsByForm.set(q.form_id, arr);
      }

      // Answers, chunked — `in` on a few thousand ids is asking for a 414.
      setBulkProgress("Loading scores…");
      const scoreByReviewQ = new Map<string, number>();
      const reviewIds = reviews.map((r) => r.id);
      for (let i = 0; i < reviewIds.length; i += 200) {
        const { data: ans, error: ansErr } = await supabase
          .from("hr_review_answers")
          .select("review_id, question_id, score")
          .in("review_id", reviewIds.slice(i, i + 200));
        if (ansErr) throw ansErr;
        for (const a of (ans ?? []) as BulkAnswer[]) {
          if (typeof a.score !== "number") continue;
          scoreByReviewQ.set(`${a.review_id}:${a.question_id}`, a.score);
        }
      }

      const reviewsByEmployee = new Map<string, BulkReview[]>();
      for (const r of reviews) {
        const arr = reviewsByEmployee.get(r.employee_id) ?? [];
        arr.push(r);
        reviewsByEmployee.set(r.employee_id, arr);
      }

      setBulkProgress("Building workbook…");
      const ExcelJSMod = await import("exceljs");
      const ExcelJS = ExcelJSMod.default ?? ExcelJSMod;
      const wb = new ExcelJS.Workbook();

      const rangeLabel = `${MONTH_NAMES[months[0].month - 1]} ${months[0].year} - ${MONTH_NAMES[months[months.length - 1].month - 1]} ${months[months.length - 1].year}`;

      const usedSheetNames = new Set<string>();
      let sheetsWritten = 0;

      // One sheet per employee, laid out exactly like the single-employee
      // "Export Monthly Reviews by Year" — same columns, totals, colour bands
      // and legend. The only change is that the months come from the chosen
      // range rather than always being Jan–Dec.
      for (const emp of employees) {
        const mine = reviewsByEmployee.get(emp.id) ?? [];
        const name = [emp.legal_first_name, emp.legal_middle_name, emp.legal_last_name]
          .map((s) => (s ?? "").trim()).filter(Boolean).join(" ") || "(Unnamed)";

        const totalsByMonth = new Map<string, number>();
        for (const m of months) {
          const rev = mine.find((r) => r.period_year === m.year && Number(r.period_month) === m.month);
          if (!rev) continue;
          const qs = questionsByForm.get(rev.form_id) ?? [];
          let sum = 0;
          let any = false;
          for (const q of qs) {
            const s = scoreByReviewQ.get(`${rev.id}:${q.id}`);
            if (typeof s === "number") { sum += s; any = true; }
          }
          if (any) totalsByMonth.set(`${m.year}-${m.month}`, sum);
        }

        const vals = Array.from(totalsByMonth.values());

        // Nothing published in the window → no tab. An empty sheet would just
        // be noise in a workbook that already has one tab per person.
        if (mine.length === 0) continue;

        // Excel sheet names: 31 chars, no []:*?/\ , and must be unique.
        const base = (name.replace(/[[\]:*?/\\]/g, " ").trim() || "Employee").slice(0, 28);
        let sheetName = base;
        let n = 2;
        while (usedSheetNames.has(sheetName.toLowerCase())) sheetName = `${base} ${n++}`;
        usedSheetNames.add(sheetName.toLowerCase());

        const ws = wb.addWorksheet(sheetName);
        ws.columns = [{ width: 4 }, { width: 78 }, ...months.map(() => ({ width: 6 })), { width: 16 }];

        ws.mergeCells(1, 2, 1, 2 + months.length);
        ws.getCell(1, 2).value = `Monthly Reviews for ${name} In ${rangeLabel}`;
        ws.getCell(1, 2).font = { bold: true, size: 14 };

        ws.getCell(2, 2).value = "Questions";
        ws.getCell(2, 2).font = { bold: true };
        months.forEach((m, i) => {
          const c = ws.getCell(2, 3 + i);
          c.value = m.label;
          c.font = { bold: true };
          c.alignment = { horizontal: "center" };
        });

        // The question list comes from the forms this employee was actually
        // reviewed on. If the form changed mid-range, each question still lands
        // on its own row and only fills the months that used that form.
        const orderedQuestions: BulkQuestion[] = [];
        const seenQ = new Set<string>();
        for (const m of months) {
          const rev = mine.find((r) => r.period_year === m.year && Number(r.period_month) === m.month);
          if (!rev) continue;
          for (const q of questionsByForm.get(rev.form_id) ?? []) {
            if (seenQ.has(q.id)) continue;
            seenQ.add(q.id);
            orderedQuestions.push(q);
          }
        }

        orderedQuestions.forEach((q, idx) => {
          const rowNum = 3 + idx;
          ws.getCell(rowNum, 1).value = idx + 1;
          ws.getCell(rowNum, 2).value = q.question_text;
          ws.getCell(rowNum, 2).alignment = { wrapText: true };
          months.forEach((m, i) => {
            const rev = mine.find((r) => r.period_year === m.year && Number(r.period_month) === m.month);
            if (!rev) return;
            const s = scoreByReviewQ.get(`${rev.id}:${q.id}`);
            if (typeof s !== "number") return;
            const cell = ws.getCell(rowNum, 3 + i);
            cell.value = s;
            cell.alignment = { horizontal: "center" };
          });
        });

        const totalsRow = 3 + orderedQuestions.length;
        ws.getCell(totalsRow, 2).value = "Totals";
        ws.getCell(totalsRow, 2).font = { bold: true };
        months.forEach((m, i) => {
          const t = totalsByMonth.get(`${m.year}-${m.month}`);
          if (t === undefined) return;
          const cell = ws.getCell(totalsRow, 3 + i);
          cell.value = t;
          cell.font = { bold: true };
          cell.alignment = { horizontal: "center" };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: totalsFillForMonthly(t) } };
        });

        const avgCol = 3 + months.length;
        ws.getCell(totalsRow - 1, avgCol).value = "Current Average";
        ws.getCell(totalsRow - 1, avgCol).font = { bold: true };
        if (vals.length) {
          ws.getCell(totalsRow, avgCol).value = Number((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1));
          ws.getCell(totalsRow, avgCol).font = { bold: true };
        }

        const legend: [string, string][] = [
          ["22 - 24 (3.5% Teachers/TA, 4% for office)", "FFB7E1CD"],
          ["18 - 21 (2.5% Teachers/TA, 3% for office)", "FFFFF2CC"],
          ["15 - 17 (1% Teachers/TA, 1.5% for office)", "FFFCE5CD"],
          ["14 and below (0%)", "FFF8CBAD"],
        ];
        legend.forEach(([text, argb], i) => {
          const rr = totalsRow + 2 + i;
          ws.getCell(rr, 2).value = text;
          ws.getCell(rr, 2).fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
        });

        sheetsWritten += 1;
        setBulkProgress(`Building workbook… ${sheetsWritten} employee(s)`);
      }

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      downloadBlob(`Monthly Reviews - All Staff - ${rangeLabel}.xlsx`, blob);
      setBulkOpen(false);
    } catch (e) {
      await alert((e as Error)?.message ?? "Failed to export scorecards.");
    } finally {
      setBulkBusy(false);
      setBulkProgress("");
    }
  }

  async function loadJobLevels() {
    try {
      const { data, error } = await supabase.from("hr_job_levels").select("id,name").order("name", { ascending: true });
      if (error) throw error;
      setJobLevels((data || []) as any);
      if (!exportJobLevelId && (data || []).length) setExportJobLevelId((data as any[])[0].id);
    } catch (e: any) {
      // non-fatal
      console.error("loadJobLevels error", e);
    }
  }

  async function openExportModal() {
    await loadJobLevels();
    setExportOpen(true);
  }

  async function exportByJobRoleByMonth() {
    if (!exportJobLevelId) {
      await alert("Select a job role.");
      return;
    }
    if (!exportYear || !exportMonth) {
      await alert("Select a month and year.");
      return;
    }

    setExportBusy(true);
    try {
      const jl = jobLevels.find((j) => j.id === exportJobLevelId);
      const jlName = jl?.name ?? "Job Role";
      const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const monthLabel = `${monthNames[exportMonth-1] ?? exportMonth} ${exportYear}`;

      // Employees for the role
      const { data: emps, error: eerr } = await supabase
        .from("hr_employees")
        .select("id, legal_first_name, legal_middle_name, legal_last_name, is_active, job_level_id")
        .eq("job_level_id", exportJobLevelId)
        .eq("is_active", true)
        .order("legal_last_name", { ascending: true })
        .order("legal_first_name", { ascending: true });

      if (eerr) throw eerr;
      const employees = (emps || []) as any[];
      if (!employees.length) {
        await alert("No active employees found for that job role.");
        return;
      }

      const empIds = employees.map((e) => e.id);

      // Reviews for selected month/year (published only)
      const { data: revs, error: rerr } = await supabase
        .from("hr_reviews")
        .select("id, employee_id, form_id, period_year, period_month, published")
        .in("employee_id", empIds)
        .eq("form_type", "monthly")
        .eq("period_year", exportYear)
        .eq("period_month", exportMonth)
        .eq("published", true);

      if (rerr) throw rerr;
      const reviews = (revs || []) as any[];

      // Validate single form_id among reviews that exist
      const formIds = Array.from(new Set(reviews.map((r) => String(r.form_id ?? "")))).filter(Boolean);
      if (formIds.length > 1) {
        await alert("Cannot export: multiple monthly forms were used for this job role in the selected month.");
        return;
      }
      const formId = formIds[0] || null;
      if (!formId) {
        await alert("No published monthly reviews found for that job role/month.");
        return;
      }

      // Questions
      const { data: qs, error: qerr } = await supabase
        .from("hr_review_questions")
        .select("id, question_text, sort_order, kind, is_active")
        .eq("form_id", formId)
        .eq("is_active", true)
        .order("sort_order", { ascending: true });

      if (qerr) throw qerr;
      const questions = ((qs || []) as any[]).filter((q) => (q.kind ?? "question") !== "section");
      if (!questions.length) {
        await alert("No questions found for that monthly form.");
        return;
      }

      // Answers for all reviews
      const reviewIds = reviews.map((r) => r.id);
      const { data: ans, error: aerr } = await supabase
        .from("hr_review_answers")
        .select("review_id, question_id, score")
        .in("review_id", reviewIds);

      if (aerr) throw aerr;

      const scoreByReviewQ = new Map<string, number>();
      for (const a of (ans || []) as any[]) {
        if (typeof a.score !== "number") continue;
        scoreByReviewQ.set(`${a.review_id}:${a.question_id}`, a.score);
      }

      const reviewByEmployee = new Map<string, any>();
      for (const r of reviews) reviewByEmployee.set(String(r.employee_id), r);

      const ExcelJSMod: any = await import("exceljs");
      const ExcelJS = ExcelJSMod?.default ?? ExcelJSMod;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Job Role By Month");

      const colCount = 2 + employees.length; // A index + B questions + employees columns
      // set column widths
      ws.getColumn(1).width = 4;
      ws.getColumn(2).width = 60;
      for (let i = 0; i < employees.length; i++) ws.getColumn(3 + i).width = 12;

      // Title row
      ws.mergeCells(1, 2, 1, 1 + colCount); // B1 : last col
      ws.getCell(1, 2).value = `Monthly Reviews for ${jlName} for ${monthLabel}`;
      ws.getCell(1, 2).font = { bold: true, size: 14 };

      // Header row
      ws.getCell(2, 2).value = "Questions";
      ws.getCell(2, 2).font = { bold: true };
      for (let i = 0; i < employees.length; i++) {
        const e = employees[i];
        const name = `${(e.legal_first_name || "").trim()} ${(e.legal_last_name || "").trim()}`.trim() || "—";
        const c = 3 + i;
        ws.getCell(2, c).value = name.split(" ")[0]; // like template first names
        ws.getCell(2, c).font = { bold: true };
        ws.getCell(2, c).alignment = { horizontal: "center" };
      }

      const rowStart = 3;
      for (let qi = 0; qi < questions.length; qi++) {
        const rowNum = rowStart + qi;
        ws.getCell(rowNum, 1).value = qi + 1;
        ws.getCell(rowNum, 2).value = questions[qi].question_text;
        ws.getCell(rowNum, 2).alignment = { wrapText: true };

        for (let i = 0; i < employees.length; i++) {
          const emp = employees[i];
          const review = reviewByEmployee.get(String(emp.id));
          if (!review) continue;
          const key = `${review.id}:${questions[qi].id}`;
          const score = scoreByReviewQ.get(key);
          if (typeof score === "number") {
            ws.getCell(rowNum, 3 + i).value = score;
            ws.getCell(rowNum, 3 + i).alignment = { horizontal: "center" };
          }
        }
      }

      // Totals row
      const totalsRow = rowStart + questions.length;
      ws.getCell(totalsRow, 2).value = "Totals";
      ws.getCell(totalsRow, 2).font = { bold: true };

      for (let i = 0; i < employees.length; i++) {
        const emp = employees[i];
        const review = reviewByEmployee.get(String(emp.id));
        if (!review) continue;

        let sum = 0;
        for (let qi = 0; qi < questions.length; qi++) {
          const key = `${review.id}:${questions[qi].id}`;
          const score = scoreByReviewQ.get(key);
          if (typeof score === "number") sum += score;
        }

        const cell = ws.getCell(totalsRow, 3 + i);
        cell.value = sum;
        cell.alignment = { horizontal: "center" };
        cell.font = { bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: totalsFillForMonthly(sum) } };
      }

      // Legend
      const legendStart = totalsRow + 2;
      const legend = [
        ["22 - 24 (3.5% Teachers/TA, 4% for office)", "FFB7E1CD"],
        ["18 - 21 (2.5% Teachers/TA, 3% for office)", "FFFFF2CC"],
        ["15 - 17 (1% Teachers/TA, 1.5% for office)", "FFFCE5CD"],
        ["14 and below (0%)", "FFF8CBAD"],
      ];
      for (let i = 0; i < legend.length; i++) {
        const rr = legendStart + i;
        ws.getCell(rr, 2).value = legend[i][0];
        ws.getCell(rr, 2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: legend[i][1] } };
      }

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      downloadBlob(`Job Role By Month - ${jlName} - ${monthLabel}.xlsx`, blob);
      setExportOpen(false);
    } catch (e: any) {
      await alert(e?.message ?? "Failed to export.");
    } finally {
      setExportBusy(false);
    }
  }

  const { filter: campusFilter, isCampusAdmin } = useCampusFilter();

  /** `viewer` is passed in because state hasn't settled on first load yet. */
  async function loadEmployees(viewer?: TeacherProfile | null) {
    const meProfile = viewer ?? me;
    setError("");
    try {
      let q = supabase
        .from("hr_employees")
        .select(
          `
          id,
          legal_first_name,
          legal_last_name,
          is_active,
          updated_at,
          campus_id,
          profile_id,
          campus:hr_campuses!hr_employees_campus_id_fkey(id,name),
          job_level:hr_job_levels!hr_employees_job_level_id_fkey(id,name)
        `
        );
      q = applyCampusFilterToQuery(q, campusFilter);
      const { data, error } = await q
        .order("legal_last_name", { ascending: true })
        .order("legal_first_name", { ascending: true });

      if (error) throw error;
      let list = (data || []) as any as EmployeeListRow[];

      // Pull the linked portal accounts so we can show role + deactivated state
      // (and apply the campus-admin visibility rules).
      const profIds = list.map((r) => r.profile_id).filter((v): v is string => !!v);
      const metaById = new Map<string, ProfileMeta>();
      if (profIds.length) {
        const { data: profs } = await supabase
          .from("user_profiles")
          .select("id, role, is_active, can_manage_learning")
          .in("id", profIds);
        for (const p of (profs ?? []) as any[]) {
          metaById.set(p.id as string, {
            role: p.role ?? null,
            is_active: !!p.is_active,
            can_manage_learning: p.can_manage_learning ?? null,
          });
        }
      }

      // Campus admins are peers of other campus admins and below full admins —
      // they must not see (or be able to manage) either. Supervisors see only
      // non-privileged staff. One rule, in lib/hrAccess, so this can't drift
      // from what the database enforces.
      list = list.filter((r) => {
        const role = r.profile_id ? metaById.get(r.profile_id)?.role : null;
        return canSeeEmployeeWithRole(meProfile, role);
      });

      setProfileMeta(metaById);
      setRows(list);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load employees");
    }
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const prof = await fetchMyProfile();
        setMe(prof);

        if (!canUseHrPortal(prof)) {
          setError("Access denied: HR access required.");
          return;
        }

        await loadEmployees(prof);
        await loadJobLevels();
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload when the campus filter changes (after initial mount)
  useEffect(() => {
    if (!canUseHrPortal(me)) return;
    loadEmployees(me);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campusFilter]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((e) => {
      const name = displayName(e).toLowerCase();
      const campus = (e.campus?.name || "").toLowerCase();
      const jl = (e.job_level?.name || "").toLowerCase();
      return name.includes(s) || campus.includes(s) || jl.includes(s);
    });
  }, [q, rows]);
  const displayed = useMemo(() => {
    const arr = (filtered ?? []).slice();

    const getVal = (e: EmployeeListRow, key: SortKey): string | number => {
      if (key === "name") return displayName(e).toLowerCase();
      if (key === "campus") return (e.campus?.name ?? "").toLowerCase();
      if (key === "jobLevel") return (e.job_level?.name ?? "").toLowerCase();
      if (key === "role") {
        const meta = e.profile_id ? profileMeta.get(e.profile_id) : undefined;
        return roleRank(meta?.role, meta?.can_manage_learning);
      }
      // active
      return e.is_active ? 1 : 0;
    };

    arr.sort((a, b) => {
      const va = getVal(a, sortState.key);
      const vb = getVal(b, sortState.key);

      let cmp = 0;
      if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb));

      return sortState.dir === "asc" ? cmp : -cmp;
    });

    return arr;
  }, [filtered, sortState, profileMeta]);

  if (loading) {
    return <div style={{ padding: 20 }}>Loading…</div>;
  }

  return (
    <div style={{ padding: 20, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 26 }}>Employees</div>
          <div style={{ color: "#6b7280" }}>
            {hasAdminAccess(me)
              ? "Directory (click an employee to view / edit)"
              : "Directory — view only. Shows the staff you supervise."}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={() => void openExportModal()}>
            Export by Job Role by Month
          </button>
          <button type="button" className="btn" onClick={() => setBulkOpen(true)}>
            Export All Scorecards
          </button>
          {/* Supervisors read this directory; they don't create accounts. */}
          {hasAdminAccess(me) && (
            <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
              + Add user
            </button>
          )}
        </div>
      </div>

      {error ? (
        <div style={{ color: "#b91c1c", fontWeight: 700, border: "1px solid #fecaca", background: "#fef2f2", padding: 10, borderRadius: 12 }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, campus, or job level…"
          style={{
            flex: 1,
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            padding: "10px 12px",
            outline: "none",
          }}
        />
        <div style={{ color: "#6b7280", fontWeight: 700 }}>{filtered.length}</div>
      </div>

      <div style={{ overflowX: "auto", border: "1px solid #e5e7eb", borderRadius: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f9fafb" }}>
              <th style={{ textAlign: "left", padding: 10, fontSize: 12, color: "#6b7280" }}><button type="button" onClick={() => toggleSort("name")} style={{ background: "transparent", border: "none", padding: 0, font: "inherit", cursor: "pointer" }}>{"Name" + sortIndicator("name")}</button></th>
              <th style={{ textAlign: "left", padding: 10, fontSize: 12, color: "#6b7280" }}><button type="button" onClick={() => toggleSort("campus")} style={{ background: "transparent", border: "none", padding: 0, font: "inherit", cursor: "pointer" }}>{"Campus" + sortIndicator("campus")}</button></th>
              <th style={{ textAlign: "left", padding: 10, fontSize: 12, color: "#6b7280" }}><button type="button" onClick={() => toggleSort("jobLevel")} style={{ background: "transparent", border: "none", padding: 0, font: "inherit", cursor: "pointer" }}>{"Job level" + sortIndicator("jobLevel")}</button></th>
              <th style={{ textAlign: "left", padding: 10, fontSize: 12, color: "#6b7280" }}><button type="button" onClick={() => toggleSort("role")} style={{ background: "transparent", border: "none", padding: 0, font: "inherit", cursor: "pointer" }}>{"Role" + sortIndicator("role")}</button></th>
              <th style={{ textAlign: "left", padding: 10, fontSize: 12, color: "#6b7280" }}><button type="button" onClick={() => toggleSort("active")} style={{ background: "transparent", border: "none", padding: 0, font: "inherit", cursor: "pointer" }}>{"Status" + sortIndicator("active")}</button></th>
              <th style={{ padding: 10 }} />
            </tr>
          </thead>
          <tbody>
            {displayed.map((e) => (
              <tr key={e.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                <td style={{ padding: 10, fontWeight: 800 }}>
                  <Link href={employeeHref(e.id)} style={{ textDecoration: "none", color: "inherit" }}>
                    {displayName(e)}
                  </Link>
                </td>
                <td style={{ padding: 10, color: "#374151" }}>{e.campus?.name || "—"}</td>
                <td style={{ padding: 10, color: "#374151" }}>{e.job_level?.name || "—"}</td>
                <td style={{ padding: 10 }}>
                  {(() => {
                    const meta = e.profile_id ? profileMeta.get(e.profile_id) : undefined;
                    if (!meta) return <span style={{ color: "#9ca3af" }}>—</span>;
                    return (
                      <span style={{ ...roleBadgeStyle(meta.role), padding: "3px 10px", borderRadius: 999, fontWeight: 800, fontSize: 12, whiteSpace: "nowrap" }}>
                        {roleLabel(meta.role, meta.can_manage_learning)}
                      </span>
                    );
                  })()}
                </td>
                <td style={{ padding: 10 }}>
                  {(() => {
                    const meta = e.profile_id ? profileMeta.get(e.profile_id) : undefined;
                    // An employee is "deactivated" if their HR record OR their
                    // portal account is switched off.
                    const off = !e.is_active || (meta ? !meta.is_active : false);
                    return (
                      <span style={{
                        padding: "3px 10px", borderRadius: 999, fontWeight: 800, fontSize: 12, whiteSpace: "nowrap",
                        background: off ? "#fee2e2" : "#dcfce7",
                        color: off ? "#991b1b" : "#166534",
                        border: `1.5px solid ${off ? "#fca5a5" : "#86efac"}`,
                      }}>
                        {off ? "Deactivated" : "Active"}
                      </span>
                    );
                  })()}
                </td>
                <td style={{ padding: 10, textAlign: "right" }}>
                  <Link href={employeeHref(e.id)} className="btn-ghost">
                    View
                  </Link>
                </td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: 14, color: "#6b7280" }}>
                  (No employees found.)
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>



      {dialogModal}

      {addOpen ? (
        <AddUserModal
          viewerRole={me?.role ?? null}
          viewerCampusId={me?.campus_id ?? null}
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); void loadEmployees(); }}
        />
      ) : null}

      {bulkOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => { if (e.currentTarget === e.target && !bulkBusy) setBulkOpen(false); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 260,
            display: "flex", alignItems: "center", justifyContent: "center", padding: 14,
          }}
        >
          <div style={{ background: "white", borderRadius: 16, padding: 16, width: "min(560px, 96vw)" }}>
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 4 }}>Export All Scorecards</div>
            <div style={{ color: "#6b7280", fontSize: 13, marginBottom: 12 }}>
              Published monthly scorecards for every active employee — one sheet per person, in the
              same layout as a single employee&apos;s export.
            </div>

            <div style={{ display: "grid", gap: 12 }}>
              <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontWeight: 850, marginBottom: 6 }}>From</div>
                  <div className="row" style={{ gap: 8 }}>
                    <select
                      value={bulkFromMonth}
                      onChange={(e) => setBulkFromMonth(Number(e.target.value))}
                      style={{ flex: 1, padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 12 }}
                    >
                      {MONTH_NAMES.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
                    </select>
                    <input
                      type="number"
                      value={bulkFromYear}
                      onChange={(e) => setBulkFromYear(Number(e.target.value))}
                      style={{ width: 96, padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 12 }}
                    />
                  </div>
                </div>

                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontWeight: 850, marginBottom: 6 }}>To</div>
                  <div className="row" style={{ gap: 8 }}>
                    <select
                      value={bulkToMonth}
                      onChange={(e) => setBulkToMonth(Number(e.target.value))}
                      style={{ flex: 1, padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 12 }}
                    >
                      {MONTH_NAMES.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
                    </select>
                    <input
                      type="number"
                      value={bulkToYear}
                      onChange={(e) => setBulkToYear(Number(e.target.value))}
                      style={{ width: 96, padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 12 }}
                    />
                  </div>
                </div>
              </div>

              {(() => {
                const n = monthRange(bulkFromYear, bulkFromMonth, bulkToYear, bulkToMonth).length;
                return (
                  <div style={{ fontSize: 13, color: n === 0 ? "#b91c1c" : "#6b7280", fontWeight: 600 }}>
                    {n === 0
                      ? "The end month is before the start month."
                      : `${n} month${n === 1 ? "" : "s"} will be included.`}
                  </div>
                );
              })()}

              {bulkBusy && bulkProgress ? (
                <div style={{ fontSize: 13, color: "#9d174d", fontWeight: 700 }}>{bulkProgress}</div>
              ) : null}

              <div className="row" style={{ gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button type="button" className="btn" onClick={() => setBulkOpen(false)} disabled={bulkBusy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void exportAllMonthlyScorecards()}
                  disabled={bulkBusy || monthRange(bulkFromYear, bulkFromMonth, bulkToYear, bulkToMonth).length === 0}
                >
                  {bulkBusy ? "Exporting…" : "Export (.xlsx)"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {exportOpen ? (
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
          <div style={{ background: "white", borderRadius: 16, padding: 14, width: "min(720px, 96vw)" }}>
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 8 }}>Export by Job Role by Month</div>

            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <div style={{ fontWeight: 850, marginBottom: 6 }}>Job Role</div>
                <select
                  value={exportJobLevelId}
                  onChange={(e) => setExportJobLevelId(e.target.value)}
                  style={{ width: "100%", padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 12 }}
                >
                  {jobLevels.map((j) => (
                    <option key={j.id} value={j.id}>{j.name}</option>
                  ))}
                </select>
              </div>

              <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontWeight: 850, marginBottom: 6 }}>Month</div>
                  <select
                    value={exportMonth}
                    onChange={(e) => setExportMonth(Number(e.target.value))}
                    style={{ width: "100%", padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 12 }}
                  >
                    {Array.from({ length: 12 }).map((_, i) => (
                      <option key={i + 1} value={i + 1}>{i + 1}</option>
                    ))}
                  </select>
                </div>

                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontWeight: 850, marginBottom: 6 }}>Year</div>
                  <input
                    type="number"
                    value={exportYear}
                    onChange={(e) => setExportYear(Number(e.target.value))}
                    style={{ width: "100%", padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 12 }}
                  />
                </div>
              </div>

              <div className="row" style={{ gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button type="button" className="btn" onClick={() => setExportOpen(false)} disabled={exportBusy}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void exportByJobRoleByMonth()} disabled={exportBusy}>
                  {exportBusy ? "Exporting…" : "Export (.xlsx)"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <style jsx global>{`
        .btn:hover {
          opacity: 0.92;
        }
        .btn-ghost {
          border: 1px solid #e5e7eb;
          background: #fff;
          padding: 8px 12px;
          border-radius: 12px;
          font-weight: 800;
          cursor: pointer;
          text-decoration: none;
          display: inline-block;
        }
        .btn-ghost:hover {
          background: #f9fafb;
        }
      `}</style>
    </div>
  );
}