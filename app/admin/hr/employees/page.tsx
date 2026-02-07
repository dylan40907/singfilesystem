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

        <button type="button" className="btn" onClick={() => void loadEmployees()}>
          Refresh
        </button>
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