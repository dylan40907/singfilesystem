"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";

type EmployeeRow = {
  id: string;
  legal_first_name: string;
  legal_middle_name: string | null;
  legal_last_name: string;
  nicknames: string[];
  is_active: boolean;
  attendance_points: number;
  updated_at: string;
};

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

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>{children}</div>;
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        width: "100%",
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid #e5e7eb",
        outline: "none",
        fontSize: 14,
        ...(props.style ?? {}),
      }}
    />
  );
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      style={{
        width: "100%",
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid #e5e7eb",
        outline: "none",
        fontSize: 14,
        background: "white",
        ...(props.style ?? {}),
      }}
    />
  );
}

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

function scoreColor(points: number) {
  if (points <= 0) return "#dc2626"; // red
  if (points <= 2) return "#ca8a04"; // yellow
  return "#16a34a"; // green
}

type AttSortKey = "name" | "attendance_points" | "is_active" | "updated_at";
type SortDir = "asc" | "desc";

function cmp(a: any, b: any) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
}

export default function AttendancePage() {
  // Access gate (admin OR supervisor)
  const [profile, setProfile] = useState<TeacherProfile | null>(null);
  const [accessStatus, setAccessStatus] = useState<string>("Loading...");

  const canUseHr = !!profile?.is_active && (profile.role === "admin" || profile.role === "supervisor");

  const [loading, setLoading] = useState(true);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [attendanceTypes, setAttendanceTypes] = useState<AttendanceTypeRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  // show inactive + sorting
  const [showInactive, setShowInactive] = useState<boolean>(false);
  const [sort, setSort] = useState<{ key: AttSortKey; dir: SortDir }>({ key: "attendance_points", dir: "asc" });

  // Manage types modal
  const [showManageAttendanceTypes, setShowManageAttendanceTypes] = useState(false);
  const [newAttendanceTypeName, setNewAttendanceTypeName] = useState("");
  const [newAttendanceTypePoints, setNewAttendanceTypePoints] = useState<string>("1");

  // Attendance modal
  const [showAttendanceModal, setShowAttendanceModal] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeRow | null>(null);
  const [empAttendance, setEmpAttendance] = useState<EmployeeAttendanceRow[]>([]);
  const [empAttendanceLoading, setEmpAttendanceLoading] = useState(false);

  // Add record inputs
  const [newAttendanceTypeId, setNewAttendanceTypeId] = useState<string>("");
  const [newAttendanceDate, setNewAttendanceDate] = useState<string>("");
  const [newAttendanceNotes, setNewAttendanceNotes] = useState<string>("");

  const selectedEmployeeName = useMemo(() => {
    if (!selectedEmployee) return "";
    return [selectedEmployee.legal_first_name, selectedEmployee.legal_middle_name, selectedEmployee.legal_last_name]
      .filter(Boolean)
      .join(" ");
  }, [selectedEmployee]);

  function defaultDirForKey(k: AttSortKey): SortDir {
    if (k === "name") return "asc";
    if (k === "attendance_points") return "asc"; // lowest first
    if (k === "is_active") return "desc"; // active first
    if (k === "updated_at") return "desc";
    return "asc";
  }

  function toggleSort(k: AttSortKey) {
    setSort((prev) => {
      if (prev.key === k) return { key: k, dir: prev.dir === "asc" ? "desc" : "asc" };
      return { key: k, dir: defaultDirForKey(k) };
    });
  }

  function sortLabel(k: AttSortKey) {
    if (sort.key !== k) return "";
    return sort.dir === "asc" ? " ▲" : " ▼";
  }

  function SortTh({ label, k }: { label: string; k: AttSortKey }) {
    return (
      <th style={{ padding: 10, borderBottom: "1px solid #e5e7eb" }}>
        <button
          type="button"
          className="btn"
          onClick={() => toggleSort(k)}
          style={{
            padding: 0,
            border: "none",
            background: "transparent",
            fontWeight: 900,
            cursor: "pointer",
            textAlign: "left",
            width: "100%",
          }}
          title="Sort"
        >
          {label}
          <span style={{ fontWeight: 900 }}>{sortLabel(k)}</span>
        </button>
      </th>
    );
  }

  const sortedAndFilteredEmployees = useMemo(() => {
    const base = showInactive ? employees : employees.filter((e) => e.is_active);
    const rows = base.slice();
    const dir = sort.dir === "asc" ? 1 : -1;

    rows.sort((a, b) => {
      let av: any = null;
      let bv: any = null;

      if (sort.key === "name") {
        av = `${a.legal_last_name ?? ""}|${a.legal_first_name ?? ""}|${a.legal_middle_name ?? ""}`;
        bv = `${b.legal_last_name ?? ""}|${b.legal_first_name ?? ""}|${b.legal_middle_name ?? ""}`;
      } else if (sort.key === "attendance_points") {
        av = Number(a.attendance_points ?? 3);
        bv = Number(b.attendance_points ?? 3);
      } else if (sort.key === "is_active") {
        av = a.is_active ? 1 : 0;
        bv = b.is_active ? 1 : 0;
      } else if (sort.key === "updated_at") {
        av = new Date(a.updated_at).getTime();
        bv = new Date(b.updated_at).getTime();
      }

      const primary = cmp(av, bv) * dir;
      if (primary !== 0) return primary;

      // tie-breakers
      const p = cmp(Number(a.attendance_points ?? 3), Number(b.attendance_points ?? 3));
      if (p !== 0) return p;

      const n = cmp(`${a.legal_last_name}|${a.legal_first_name}`, `${b.legal_last_name}|${b.legal_first_name}`);
      if (n !== 0) return n;

      return cmp(a.id, b.id);
    });

    return rows;
  }, [employees, showInactive, sort]);

  // Load profile first
  useEffect(() => {
    (async () => {
      try {
        const p = await fetchMyProfile();
        setProfile(p);
        if (!!p?.is_active && (p.role === "admin" || p.role === "supervisor")) setAccessStatus("");
        else setAccessStatus("HR access required (admin or supervisor).");
      } catch {
        setAccessStatus("HR access required (admin or supervisor).");
      }
    })();
  }, []);

  async function loadEmployeesAndTypes() {
    setLoading(true);
    setError(null);

    try {
      const [eRes, tRes] = await Promise.all([
        supabase
          .from("hr_employees")
          .select("id, legal_first_name, legal_middle_name, legal_last_name, nicknames, is_active, attendance_points, updated_at")
          .order("attendance_points", { ascending: true })
          .order("legal_last_name", { ascending: true })
          .order("legal_first_name", { ascending: true }),
        supabase.from("hr_attendance_types").select("id,name,points_deduct").order("name", { ascending: true }),
      ]);

      if (eRes.error) throw eRes.error;
      if (tRes.error) throw tRes.error;

      const emps = (eRes.data ?? []) as any[];
      const normalized: EmployeeRow[] = emps.map((r) => ({
        ...r,
        nicknames: Array.isArray(r.nicknames) ? r.nicknames : [],
        attendance_points: Number(r.attendance_points ?? 3),
        is_active: !!r.is_active,
      }));

      setEmployees(normalized);
      setAttendanceTypes((tRes.data ?? []) as AttendanceTypeRow[]);

      // keep selectedEmployee fresh (points change via trigger)
      if (selectedEmployee) {
        const updated = normalized.find((x) => x.id === selectedEmployee.id);
        if (updated) setSelectedEmployee(updated);
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to load attendance.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!canUseHr) return;
    void loadEmployeesAndTypes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseHr]);

  async function loadEmployeeAttendance(employeeId: string) {
    setEmpAttendanceLoading(true);
    setError(null);

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

      const rows = (data ?? []).map((x: any) => ({
        ...x,
        attendance_type: asSingle<AttendanceTypeRow>(x.attendance_type),
      })) as EmployeeAttendanceRow[];

      setEmpAttendance(rows);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load attendance records.");
    } finally {
      setEmpAttendanceLoading(false);
    }
  }

  async function openAttendance(employee: EmployeeRow) {
    setSelectedEmployee(employee);
    setShowAttendanceModal(true);

    // reset add form
    setNewAttendanceTypeId("");
    setNewAttendanceDate("");
    setNewAttendanceNotes("");

    await loadEmployeeAttendance(employee.id);
  }

  function closeAttendance() {
    setShowAttendanceModal(false);
    setSelectedEmployee(null);
    setEmpAttendance([]);
    setEmpAttendanceLoading(false);
  }

  async function addAttendanceType() {
    setError(null);
    const name = newAttendanceTypeName.trim();
    if (!name) return;

    const parsed = Number(newAttendanceTypePoints);
    const pts = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;

    const { error } = await supabase.from("hr_attendance_types").insert({ name, points_deduct: pts });
    if (error) {
      setError(error.message);
      return;
    }

    setNewAttendanceTypeName("");
    setNewAttendanceTypePoints("1");
    await loadEmployeesAndTypes();
  }

  async function deleteAttendanceType(id: string) {
    const ok = confirm("Delete this attendance type? (If attendance records still use it, deletion will fail.)");
    if (!ok) return;

    setError(null);
    const { error } = await supabase.from("hr_attendance_types").delete().eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }

    await loadEmployeesAndTypes();
    if (newAttendanceTypeId === id) setNewAttendanceTypeId("");
  }

  async function addAttendanceRecord() {
    if (!selectedEmployee) return;
    setError(null);

    if (!newAttendanceTypeId) {
      setError("Choose an attendance type.");
      return;
    }
    if (!newAttendanceDate) {
      setError("Choose an attendance date.");
      return;
    }

    const { error } = await supabase.from("hr_employee_attendance").insert({
      employee_id: selectedEmployee.id,
      attendance_type_id: newAttendanceTypeId,
      occurred_on: newAttendanceDate,
      notes: newAttendanceNotes.trim() || null,
    });

    if (error) {
      setError(error.message);
      return;
    }

    // Clear inputs
    setNewAttendanceTypeId("");
    setNewAttendanceDate("");
    setNewAttendanceNotes("");

    // Reload both: records + employee list (because score changed via trigger)
    await Promise.all([loadEmployeeAttendance(selectedEmployee.id), loadEmployeesAndTypes()]);
  }

  async function deleteAttendanceRecord(id: string) {
    if (!selectedEmployee) return;
    const ok = confirm("Delete this attendance record? (This will restore points automatically.)");
    if (!ok) return;

    setError(null);
    const { error } = await supabase.from("hr_employee_attendance").delete().eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }

    await Promise.all([loadEmployeeAttendance(selectedEmployee.id), loadEmployeesAndTypes()]);
  }

  // Block page if no HR access
  if (accessStatus) {
    return (
      <main className="stack">
        <div className="container">
          <div className="card" style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 900, color: "#b00020" }}>{accessStatus}</div>
            <div className="subtle" style={{ marginTop: 6 }}>
              This page is available to admin and supervisor accounts.
            </div>
          </div>
        </div>
      </main>
    );
  }

  const totalCount = employees.length;
  const shownCount = sortedAndFilteredEmployees.length;

  return (
    <div style={{ paddingTop: 8 }}>
      <div className="row-between" style={{ gap: 12, alignItems: "flex-start" }}>
        <div>
          <h1 style={{ margin: "8px 0 6px 0" }}>Attendance</h1>
        </div>

        <div className="row" style={{ gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <label className="row" style={{ gap: 8, alignItems: "center", fontWeight: 800 }}>
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              style={{ width: 16, height: 16 }}
            />
            Show inactive
          </label>

          <button className="btn" onClick={() => void loadEmployeesAndTypes()} disabled={loading}>
            {loading ? "Loading..." : "Refresh"}
          </button>
          <button className="btn" onClick={() => setShowManageAttendanceTypes(true)}>
            Manage Types
          </button>
        </div>
      </div>

      {error && (
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
      )}

      <div style={{ marginTop: 14, border: "1px solid #e5e7eb", borderRadius: 16, overflow: "hidden" }}>
        <div style={{ padding: 12, borderBottom: "1px solid #e5e7eb", fontWeight: 900 }}>
          Employees ({shownCount} shown / {totalCount} total)
        </div>

        {loading ? (
          <div style={{ padding: 14 }} className="subtle">
            Loading…
          </div>
        ) : shownCount === 0 ? (
          <div style={{ padding: 14 }} className="subtle">
            No employees match this view. {showInactive ? "" : "Try enabling “Show inactive”."}
          </div>
        ) : (
          <div style={{ width: "100%", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", background: "rgba(0,0,0,0.02)" }}>
                  <SortTh label="Name" k="name" />
                  <SortTh label="Attendance score" k="attendance_points" />
                  <SortTh label="Active" k="is_active" />
                  <SortTh label="Updated" k="updated_at" />
                  <th style={{ padding: 10, borderBottom: "1px solid #e5e7eb" }} />
                </tr>
              </thead>
              <tbody>
                {sortedAndFilteredEmployees.map((e) => {
                  const legal = [e.legal_first_name, e.legal_middle_name, e.legal_last_name].filter(Boolean).join(" ");
                  const preferred = e.nicknames?.length ? e.nicknames.join(", ") : "";
                  const pts = Number(e.attendance_points ?? 3);

                  return (
                    <tr key={e.id}>
                      <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>
                        <div style={{ fontWeight: 900 }}>{legal}</div>
                        <div className="subtle" style={{ marginTop: 2 }}>
                          Preferred: {preferred || "—"}
                          {!e.is_active ? (
                            <span style={{ marginLeft: 10, fontWeight: 800, color: "#6b7280" }}>(inactive)</span>
                          ) : null}
                        </div>
                      </td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6", fontWeight: 900, color: scoreColor(pts) }}>
                        {pts}
                      </td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>{e.is_active ? "Active" : "Inactive"}</td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>{new Date(e.updated_at).toLocaleString()}</td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>
                        <button className="btn" onClick={() => void openAttendance(e)} style={{ padding: "6px 10px" }}>
                          View / Add Records
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showManageAttendanceTypes && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 220,
          }}
          onClick={() => setShowManageAttendanceTypes(false)}
        >
          <div
            style={{
              width: "min(720px, 100%)",
              background: "white",
              borderRadius: 16,
              border: "1px solid #e5e7eb",
              boxShadow: "0 20px 50px rgba(0,0,0,0.12)",
              overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row-between" style={{ padding: 12, borderBottom: "1px solid #e5e7eb" }}>
              <div style={{ fontWeight: 900 }}>Manage Attendance Types</div>
              <button className="btn" onClick={() => setShowManageAttendanceTypes(false)}>
                Close
              </button>
            </div>

            <div style={{ padding: 14 }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>Add new type</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 180px auto", gap: 10, alignItems: "end" }}>
                <div>
                  <FieldLabel>Name</FieldLabel>
                  <TextInput
                    value={newAttendanceTypeName}
                    onChange={(e) => setNewAttendanceTypeName(e.target.value)}
                    placeholder="e.g., Tardy / Absent"
                  />
                </div>
                <div>
                  <FieldLabel>Points to deduct</FieldLabel>
                  <TextInput
                    inputMode="numeric"
                    value={newAttendanceTypePoints}
                    onChange={(e) => setNewAttendanceTypePoints(e.target.value)}
                    placeholder="e.g., 1"
                  />
                </div>
                <button className="btn btn-primary" onClick={() => void addAttendanceType()}>
                  Add
                </button>
              </div>

              <div style={{ height: 16 }} />

              <div style={{ fontWeight: 800, marginBottom: 8 }}>Existing</div>

              {attendanceTypes.length === 0 ? (
                <div className="subtle">No attendance types yet.</div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {attendanceTypes.map((t) => (
                    <div
                      key={t.id}
                      className="row-between"
                      style={{ gap: 10, border: "1px solid #e5e7eb", borderRadius: 12, padding: 10 }}
                    >
                      <div style={{ fontWeight: 800 }}>
                        {t.name}{" "}
                        <span className="subtle" style={{ fontWeight: 700 }}>
                          • deduct {t.points_deduct} pt(s)
                        </span>
                      </div>
                      <button className="btn" onClick={() => void deleteAttendanceType(t.id)} style={{ padding: "6px 10px" }}>
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="subtle" style={{ marginTop: 10 }}>
                Note: if attendance records already use a type, deletion will fail (foreign key).
              </div>
            </div>
          </div>
        </div>
      )}

      {showAttendanceModal && selectedEmployee && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: 16,
            paddingTop: 24,
            paddingBottom: 24,
            zIndex: 240,
            overflowY: "auto",
          }}
          onClick={closeAttendance}
        >
          <div
            style={{
              width: "min(920px, 100%)",
              background: "white",
              borderRadius: 16,
              border: "1px solid #e5e7eb",
              boxShadow: "0 20px 50px rgba(0,0,0,0.12)",
              overflow: "hidden",
              maxHeight: "calc(100vh - 48px)",
              display: "flex",
              flexDirection: "column",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="row-between"
              style={{
                padding: 12,
                borderBottom: "1px solid #e5e7eb",
                position: "sticky",
                top: 0,
                background: "white",
                zIndex: 1,
              }}
            >
              <div style={{ fontWeight: 900 }}>
                Attendance Record • {selectedEmployeeName}
                <span style={{ marginLeft: 10, fontWeight: 900, color: scoreColor(selectedEmployee.attendance_points) }}>
                  ({selectedEmployee.attendance_points})
                </span>
              </div>
              <button className="btn" onClick={closeAttendance}>
                Close
              </button>
            </div>

            <div style={{ padding: 14, overflowY: "auto" }}>
              <div style={{ padding: 12, borderRadius: 14, border: "1px dashed #e5e7eb" }}>
                <div style={{ fontWeight: 800, marginBottom: 10 }}>Add attendance record</div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <div className="row-between" style={{ alignItems: "end", gap: 10 }}>
                      <div style={{ flex: 1 }}>
                        <FieldLabel>Type</FieldLabel>
                        <Select value={newAttendanceTypeId} onChange={(e) => setNewAttendanceTypeId(e.target.value)}>
                          <option value="">— Select —</option>
                          {attendanceTypes.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name} (−{t.points_deduct})
                            </option>
                          ))}
                        </Select>
                      </div>
                    </div>
                  </div>

                  <div>
                    <FieldLabel>Date</FieldLabel>
                    <TextInput type="date" value={newAttendanceDate} onChange={(e) => setNewAttendanceDate(e.target.value)} />
                  </div>
                </div>

                <div style={{ height: 10 }} />

                <div>
                  <FieldLabel>Notes (optional)</FieldLabel>
                  <TextInput value={newAttendanceNotes} onChange={(e) => setNewAttendanceNotes(e.target.value)} placeholder="Optional details…" />
                </div>

                <div className="row" style={{ gap: 10, marginTop: 12 }}>
                  <button className="btn btn-primary" type="button" onClick={() => void addAttendanceRecord()}>
                    Add record
                  </button>
                </div>

                <div className="subtle" style={{ marginTop: 8 }}>
                  When you add a record, points are automatically deducted based on the type.
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 800, marginBottom: 8 }}>
                  Existing attendance ({empAttendance.length})
                  {empAttendanceLoading ? <span className="subtle" style={{ marginLeft: 10 }}>Loading…</span> : null}
                </div>

                {empAttendance.length === 0 ? (
                  <div className="subtle">No attendance records yet.</div>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
                    {empAttendance.map((a) => {
                      const deduct = a.attendance_type?.points_deduct ?? 0;
                      return (
                        <div key={a.id} style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
                          <div className="row-between" style={{ gap: 12, alignItems: "flex-start" }}>
                            <div>
                              <div style={{ fontWeight: 900 }}>
                                {a.attendance_type?.name ?? "—"} <span className="subtle" style={{ fontWeight: 800 }}>• −{deduct}</span> •{" "}
                                {formatYmd(a.occurred_on)}
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
                            </div>

                            <button className="btn" type="button" onClick={() => void deleteAttendanceRecord(a.id)} style={{ padding: "6px 10px" }}>
                              Delete
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div style={{ height: 6 }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
