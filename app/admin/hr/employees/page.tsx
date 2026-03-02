"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";

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
};

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
  const [me, setMe] = useState<TeacherProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const [rows, setRows] = useState<EmployeeListRow[]>([]);
  const [error, setError] = useState<string>("");

  const [q, setQ] = useState("");

  // Export by Job Role by Month
  const [exportOpen, setExportOpen] = useState(false);
  const [jobLevels, setJobLevels] = useState<JobLevelRow[]>([]);
  const [exportJobLevelId, setExportJobLevelId] = useState<string>("");
  const [exportYear, setExportYear] = useState<number>(new Date().getFullYear());
  const [exportMonth, setExportMonth] = useState<number>(new Date().getMonth() + 1);
  const [exportBusy, setExportBusy] = useState(false);

  type SortKey = "name" | "campus" | "jobLevel" | "active";
  const defaultDirForKey: Record<SortKey, "asc" | "desc"> = {
    name: "asc",
    campus: "asc",
    jobLevel: "asc",
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
      alert("Select a job role.");
      return;
    }
    if (!exportYear || !exportMonth) {
      alert("Select a month and year.");
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
        alert("No active employees found for that job role.");
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
        alert("Cannot export: multiple monthly forms were used for this job role in the selected month.");
        return;
      }
      const formId = formIds[0] || null;
      if (!formId) {
        alert("No published monthly reviews found for that job role/month.");
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
        alert("No questions found for that monthly form.");
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
      alert(e?.message ?? "Failed to export.");
    } finally {
      setExportBusy(false);
    }
  }

  async function loadEmployees() {
    setError("");
    try {
      const { data, error } = await supabase
        .from("hr_employees")
        .select(
          `
          id,
          legal_first_name,
          legal_last_name,
          is_active,
          updated_at,
          campus:hr_campuses!hr_employees_campus_id_fkey(id,name),
          job_level:hr_job_levels!hr_employees_job_level_id_fkey(id,name)
        `
        )
        .order("legal_last_name", { ascending: true })
        .order("legal_first_name", { ascending: true });

      if (error) throw error;
      setRows((data || []) as any);
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

        // Only admins should access HR
        if (prof?.role !== "admin") {
          setError("Access denied: admin only.");
          return;
        }

        await loadEmployees();
        await loadJobLevels();
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  }, [filtered, sortState]);

  if (loading) {
    return <div style={{ padding: 20 }}>Loading…</div>;
  }

  return (
    <div style={{ padding: 20, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 26 }}>Employees</div>
          <div style={{ color: "#6b7280" }}>Directory (click an employee to view / edit)</div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={() => void openExportModal()}>
            Export by Job Role by Month
          </button>
          <button type="button" className="btn" onClick={() => void loadEmployees()}>
            Refresh
          </button>
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
              <th style={{ textAlign: "left", padding: 10, fontSize: 12, color: "#6b7280" }}><button type="button" onClick={() => toggleSort("active")} style={{ background: "transparent", border: "none", padding: 0, font: "inherit", cursor: "pointer" }}>{"Active" + sortIndicator("active")}</button></th>
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
                <td style={{ padding: 10, color: "#374151" }}>{e.is_active ? "Yes" : "No"}</td>
                <td style={{ padding: 10, textAlign: "right" }}>
                  <Link href={employeeHref(e.id)} className="btn-ghost">
                    View
                  </Link>
                </td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: 14, color: "#6b7280" }}>
                  (No employees found.)
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>



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