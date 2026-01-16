"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";

type HrCampus = {
  id: string;
  name: string;
};

type HrJobLevel = {
  id: string;
  name: string;
};

type HrEmployee = {
  id: string;
  legal_first_name?: string | null;
  legal_middle_name?: string | null;
  legal_last_name?: string | null;
  nicknames?: string[] | null;
  campus_id?: string | null;
  is_active?: boolean | null;

  job_level_id?: string | null;
  job_level?: HrJobLevel | HrJobLevel[] | null;
};

type OrgNodeRow = {
  campus_id: string;
  employee_id: string;
  parent_employee_id: string | null;
  created_at: string;
  updated_at: string;
};

function employeeLabel(e: HrEmployee) {
  const nick = (Array.isArray(e.nicknames) && e.nicknames.length > 0 ? String(e.nicknames[0] ?? "") : "").trim();

  const fn = (e.legal_first_name ?? "").trim();
  const mn = (e.legal_middle_name ?? "").trim();
  const ln = (e.legal_last_name ?? "").trim();

  const legal = [fn, mn, ln].filter(Boolean).join(" ").trim();

  if (nick && legal) return `${nick} (${legal})`;
  return nick || legal || e.id;
}

function jobLevelName(e?: HrEmployee | null) {
  if (!e) return "No job level assigned";
  const jl = (e as any).job_level;
  const single = Array.isArray(jl) ? jl[0] : jl;
  const name = (single?.name ?? "").trim();
  return name || "No job level assigned";
}

function employeeLabelWithJobLevel(e: HrEmployee) {
  return `${employeeLabel(e)} — ${jobLevelName(e)}`;
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

type PickerMode = "root" | "child";

export default function HrOrgChartPage() {
  const [status, setStatus] = useState("");
  const [profile, setProfile] = useState<TeacherProfile | null>(null);
  const isAdmin = !!profile?.is_active && profile.role === "admin";

  const [campuses, setCampuses] = useState<HrCampus[]>([]);
  const [selectedCampusId, setSelectedCampusId] = useState<string>("");

  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [nodes, setNodes] = useState<OrgNodeRow[]>([]);

  // Picker modal
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<PickerMode>("root");
  const [pickerParentEmployeeId, setPickerParentEmployeeId] = useState<string>("");
  const [pickerEmployeeId, setPickerEmployeeId] = useState<string>("");

  // Node context popover
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverEmployeeId, setPopoverEmployeeId] = useState<string>("");
  const [popoverPos, setPopoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const employeesById = useMemo(() => {
    const m = new Map<string, HrEmployee>();
    for (const e of employees) m.set(e.id, e);
    return m;
  }, [employees]);

  const childrenByParentId = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const n of nodes) {
      if (!n.parent_employee_id) continue;
      const arr = m.get(n.parent_employee_id) ?? [];
      arr.push(n.employee_id);
      m.set(n.parent_employee_id, arr);
    }
    // deterministic ordering by employee label
    for (const [pid, arr] of m.entries()) {
      arr.sort((a, b) => {
        const ea = employeesById.get(a);
        const eb = employeesById.get(b);
        const la = ea ? employeeLabelWithJobLevel(ea) : a;
        const lb = eb ? employeeLabelWithJobLevel(eb) : b;
        return la.localeCompare(lb);
      });
      m.set(pid, arr);
    }
    return m;
  }, [nodes, employeesById]);

  const rootEmployeeIds = useMemo(() => {
    const roots = nodes.filter((n) => !n.parent_employee_id).map((n) => n.employee_id);
    roots.sort((a, b) => {
      const ea = employeesById.get(a);
      const eb = employeesById.get(b);
      const la = ea ? employeeLabelWithJobLevel(ea) : a;
      const lb = eb ? employeeLabelWithJobLevel(eb) : b;
      return la.localeCompare(lb);
    });
    return roots;
  }, [nodes, employeesById]);

  const availableEmployeesForCampus = useMemo(() => {
    // Only employees for the campus (already loaded by campus), that are not already in the chart.
    const used = new Set(nodes.map((n) => n.employee_id));
    return (employees ?? []).filter((e) => !used.has(e.id)).sort(safeSortByName);
  }, [employees, nodes]);

  async function loadBoot() {
    setStatus("Loading...");
    try {
      const p = await fetchMyProfile();
      setProfile(p);

      if (!p?.is_active || p.role !== "admin") {
        setStatus("Admin access required.");
        return;
      }

      const { data: campusData, error: campusErr } = await supabase.from("hr_campuses").select("*").order("name", { ascending: true });
      if (campusErr) throw campusErr;

      setCampuses((campusData ?? []) as HrCampus[]);
      setStatus("");
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    }
  }

  async function loadCampusData(campusId: string) {
    if (!campusId) {
      setEmployees([]);
      setNodes([]);
      return;
    }

    setStatus("Loading campus org chart...");
    try {
      const [empRes, nodeRes] = await Promise.all([
        supabase
          .from("hr_employees")
          .select(
            `
              *,
              job_level:hr_job_levels!hr_employees_job_level_id_fkey(id,name)
            `
          )
          .eq("campus_id", campusId)
          .order("legal_last_name", { ascending: true })
          .order("legal_first_name", { ascending: true })
          .order("legal_middle_name", { ascending: true }),
        supabase.from("hr_org_chart_nodes").select("*").eq("campus_id", campusId),
      ]);

      if (empRes.error) throw empRes.error;
      if (nodeRes.error) throw nodeRes.error;

      setEmployees((empRes.data ?? []) as HrEmployee[]);

      // de-dupe just in case
      const seen = new Set<string>();
      const dedup: OrgNodeRow[] = [];
      for (const r of (nodeRes.data ?? []) as OrgNodeRow[]) {
        const k = `${r.campus_id}:${r.employee_id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        dedup.push(r);
      }
      setNodes(dedup);

      setStatus("");
    } catch (e: any) {
      setStatus("Load error: " + (e?.message ?? "unknown"));
    }
  }

  function closePicker() {
    setPickerOpen(false);
    setPickerMode("root");
    setPickerParentEmployeeId("");
    setPickerEmployeeId("");
  }

  function openRootPicker() {
    setPickerMode("root");
    setPickerParentEmployeeId("");
    setPickerEmployeeId("");
    setPickerOpen(true);
  }

  function openChildPicker(parentEmployeeId: string) {
    setPickerMode("child");
    setPickerParentEmployeeId(parentEmployeeId);
    setPickerEmployeeId("");
    setPickerOpen(true);
  }

  async function addPickedEmployee() {
    if (!selectedCampusId) return;
    if (!pickerEmployeeId) return;

    const parentId = pickerMode === "child" ? pickerParentEmployeeId : null;

    setStatus("Saving org chart...");
    try {
      const { error } = await supabase.from("hr_org_chart_nodes").insert({
        campus_id: selectedCampusId,
        employee_id: pickerEmployeeId,
        parent_employee_id: parentId,
      });

      if (error) throw error;

      closePicker();
      await loadCampusData(selectedCampusId);

      setStatus("✅ Saved.");
      setTimeout(() => setStatus(""), 900);
    } catch (e: any) {
      setStatus("Save error: " + (e?.message ?? "unknown"));
    }
  }

  async function makeTopLevel(employeeId: string) {
    if (!selectedCampusId) return;

    setStatus("Saving...");
    try {
      const { error } = await supabase
        .from("hr_org_chart_nodes")
        .update({ parent_employee_id: null })
        .eq("campus_id", selectedCampusId)
        .eq("employee_id", employeeId);

      if (error) throw error;

      await loadCampusData(selectedCampusId);
      setStatus("✅ Saved.");
      setTimeout(() => setStatus(""), 900);
    } catch (e: any) {
      setStatus("Save error: " + (e?.message ?? "unknown"));
    }
  }

  async function removeFromChart(employeeId: string) {
    if (!selectedCampusId) return;
    const ok = confirm("Remove this employee from the org chart? (Children will become top-level.)");
    if (!ok) return;

    setStatus("Removing...");
    try {
      // detach children first
      const { error: detachErr } = await supabase
        .from("hr_org_chart_nodes")
        .update({ parent_employee_id: null })
        .eq("campus_id", selectedCampusId)
        .eq("parent_employee_id", employeeId);

      if (detachErr) throw detachErr;

      const { error } = await supabase.from("hr_org_chart_nodes").delete().eq("campus_id", selectedCampusId).eq("employee_id", employeeId);
      if (error) throw error;

      await loadCampusData(selectedCampusId);
      setStatus("✅ Removed.");
      setTimeout(() => setStatus(""), 900);
    } catch (e: any) {
      setStatus("Remove error: " + (e?.message ?? "unknown"));
    }
  }

  function openPopoverForNode(employeeId: string, clientX: number, clientY: number) {
    setPopoverEmployeeId(employeeId);
    setPopoverPos({ x: clientX, y: clientY });
    setPopoverOpen(true);
  }

  function closePopover() {
    setPopoverOpen(false);
    setPopoverEmployeeId("");
  }

  // Close popover on outside click / escape
  useEffect(() => {
    if (!popoverOpen) return;

    const onDown = (e: MouseEvent) => {
      const el = popoverRef.current;
      if (!el) return;
      if (el.contains(e.target as any)) return;
      closePopover();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePopover();
    };

    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [popoverOpen]);

  useEffect(() => {
    void loadBoot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadCampusData(selectedCampusId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCampusId]);

  function renderTree(employeeId: string) {
    const emp = employeesById.get(employeeId);
    const kids = childrenByParentId.get(employeeId) ?? [];
    const label = emp ? employeeLabel(emp) : employeeId;
    const jl = jobLevelName(emp);

    return (
      <li key={employeeId}>
        <div
          className="node-card"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openPopoverForNode(employeeId, (e as any).clientX, (e as any).clientY);
          }}
          title="Click for actions"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              openPopoverForNode(employeeId, (e as any).clientX ?? 0, (e as any).clientY ?? 0);
            }
          }}
        >
          <div className="name-box">
            <div className="name-text" title={`${label} — ${jl}`}>
              {label}
            </div>
            <div className="joblevel-text" title={jl}>
              {jl}
            </div>
          </div>
        </div>

        {kids.length > 0 ? <ul>{kids.map((k) => renderTree(k))}</ul> : null}
      </li>
    );
  }

  return (
    <main className="stack">
      <div className="container">
        <div className="row-between" style={{ marginTop: 16 }}>
          <div className="stack" style={{ gap: 6 }}>
            <h1 className="h1">Org Chart</h1>
            <div className="subtle">Build a campus-based org chart by assigning parent/child relationships.</div>
          </div>

          {status ? <span className="badge badge-pink">{status}</span> : null}
        </div>

        {!isAdmin ? (
          <div className="card" style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 900, color: "#b00020" }}>Admin access required.</div>
            <div className="subtle" style={{ marginTop: 6 }}>
              This page is only available to admin accounts.
            </div>
          </div>
        ) : (
          <>
            <div className="card" style={{ marginTop: 14, padding: 16 }}>
              <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "end" }}>
                <div style={{ width: "min(520px, 100%)" }}>
                  <div style={{ fontWeight: 900, marginBottom: 8 }}>Campus</div>
                  <select className="select" value={selectedCampusId} onChange={(e) => setSelectedCampusId(e.target.value)}>
                    <option value="">— Select a campus —</option>
                    {campuses.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <div className="subtle" style={{ marginTop: 8 }}>
                    Org charts are campus-scoped. You can only place employees from the selected campus.
                  </div>
                </div>

                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!selectedCampusId || availableEmployeesForCampus.length === 0}
                  onClick={openRootPicker}
                  title={
                    !selectedCampusId
                      ? "Select a campus first"
                      : availableEmployeesForCampus.length === 0
                      ? "No more employees available"
                      : "Add a top-level employee"
                  }
                >
                  Add top-level employee
                </button>

                <IconButton
                  title="Reload"
                  onClick={() => {
                    if (!selectedCampusId) return;
                    void loadCampusData(selectedCampusId);
                  }}
                  disabled={!selectedCampusId}
                >
                  ↻
                </IconButton>
              </div>
            </div>

            {!selectedCampusId ? (
              <div className="card" style={{ marginTop: 14 }}>
                <div className="subtle">(Pick a campus to view/build its org chart.)</div>
              </div>
            ) : (
              <div className="card" style={{ marginTop: 14, padding: 16, overflow: "auto" }}>
                {nodes.length === 0 ? (
                  <div className="subtle">
                    This campus org chart is empty. Click <b>Add top-level employee</b> to start.
                  </div>
                ) : rootEmployeeIds.length === 0 ? (
                  <div className="subtle">No top-level nodes found (everything has a parent). Use “Make top-level” from a node menu.</div>
                ) : (
                  <div className="orgchart-wrap">
                    <div className="tree">
                      <ul className="root">{rootEmployeeIds.map((rid) => renderTree(rid))}</ul>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Node actions popover */}
            {popoverOpen && popoverEmployeeId ? (
              <div
                ref={popoverRef}
                style={{
                  position: "fixed",
                  left: Math.min(popoverPos.x + 10, typeof window !== "undefined" ? window.innerWidth - 260 : popoverPos.x + 10),
                  top: Math.min(popoverPos.y + 10, typeof window !== "undefined" ? window.innerHeight - 220 : popoverPos.y + 10),
                  width: 250,
                  background: "white",
                  border: "1px solid var(--border)",
                  borderRadius: 14,
                  boxShadow: "0 18px 40px rgba(0,0,0,0.18)",
                  zIndex: 200,
                  padding: 10,
                }}
              >
                <div style={{ fontWeight: 900, marginBottom: 8 }}>Actions</div>

                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: "100%", marginBottom: 8 }}
                  onClick={() => {
                    closePopover();
                    openChildPicker(popoverEmployeeId);
                  }}
                  disabled={!selectedCampusId || availableEmployeesForCampus.length === 0}
                >
                  Add child
                </button>

                <button
                  type="button"
                  className="btn"
                  style={{ width: "100%", marginBottom: 8 }}
                  onClick={() => {
                    closePopover();
                    void makeTopLevel(popoverEmployeeId);
                  }}
                  disabled={!selectedCampusId}
                >
                  Make top-level
                </button>

                <button
                  type="button"
                  className="btn"
                  style={{ width: "100%" }}
                  onClick={() => {
                    closePopover();
                    void removeFromChart(popoverEmployeeId);
                  }}
                  disabled={!selectedCampusId}
                >
                  Remove from chart
                </button>

                <div className="subtle" style={{ marginTop: 10 }}>
                  Tip: “Remove” detaches children to top-level.
                </div>
              </div>
            ) : null}

            {/* Picker modal */}
            {pickerOpen ? (
              <div
                role="dialog"
                aria-modal="true"
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "rgba(0,0,0,0.55)",
                  zIndex: 210,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                onMouseDown={(e) => {
                  if (e.currentTarget === e.target) closePicker();
                }}
              >
                <div
                  className="card"
                  style={{
                    width: "min(720px, 100%)",
                    padding: 16,
                    borderRadius: 16,
                  }}
                >
                  <div className="row-between" style={{ gap: 10 }}>
                    <div className="stack" style={{ gap: 4 }}>
                      <div style={{ fontWeight: 950, fontSize: 16 }}>{pickerMode === "root" ? "Add top-level employee" : "Add child employee"}</div>
                      <div className="subtle">
                        {pickerMode === "child" ? (
                          <>
                            Parent:{" "}
                            <b>
                              {(() => {
                                const p = employeesById.get(pickerParentEmployeeId);
                                return p ? employeeLabelWithJobLevel(p) : pickerParentEmployeeId;
                              })()}
                            </b>
                          </>
                        ) : (
                          "Choose an employee to place at the top level."
                        )}
                      </div>
                    </div>

                    <button type="button" className="btn" onClick={closePicker} title="Close">
                      ✕
                    </button>
                  </div>

                  <div className="hr" />

                  {availableEmployeesForCampus.length === 0 ? (
                    <div className="subtle">(No available employees to add. Everyone is already placed.)</div>
                  ) : (
                    <div className="stack" style={{ gap: 10 }}>
                      <select className="select" value={pickerEmployeeId} onChange={(e) => setPickerEmployeeId(e.target.value)}>
                        <option value="">— Select an employee —</option>
                        {availableEmployeesForCampus.map((e) => (
                          <option key={e.id} value={e.id}>
                            {employeeLabelWithJobLevel(e)}
                          </option>
                        ))}
                      </select>

                      <div className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
                        <button type="button" className="btn" onClick={closePicker}>
                          Cancel
                        </button>
                        <button type="button" className="btn btn-primary" disabled={!pickerEmployeeId} onClick={() => void addPickedEmployee()}>
                          Add
                        </button>
                      </div>

                      <div className="subtle">Note: this version only allows adding employees not already in the chart (keeps the tree consistent).</div>
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            <style jsx>{`
              .orgchart-wrap {
                min-width: 1100px;
              }

              /* Classic UL/LI org chart connectors */
              .tree ul {
                padding-top: 26px;
                position: relative;
                transition: all 0.2s;
              }

              .tree li {
                float: left;
                text-align: center;
                list-style-type: none;
                position: relative;
                padding: 26px 22px 0 22px; /* more horizontal spacing to prevent overlap */
                transition: all 0.2s;
              }

              .tree li::before,
              .tree li::after {
                content: "";
                position: absolute;
                top: 0;
                right: 50%;
                border-top: 1px solid rgba(0, 0, 0, 0.22);
                width: 50%;
                height: 26px;
              }

              .tree li::after {
                right: auto;
                left: 50%;
                border-left: 1px solid rgba(0, 0, 0, 0.22);
              }

              .tree li:only-child::after,
              .tree li:only-child::before {
                display: none;
              }

              .tree li:only-child {
                padding-top: 0;
              }

              .tree li:first-child::before,
              .tree li:last-child::after {
                border: 0 none;
              }

              .tree li:last-child::before {
                border-right: 1px solid rgba(0, 0, 0, 0.22);
                border-radius: 0 10px 0 0;
              }

              .tree li:first-child::after {
                border-left: 1px solid rgba(0, 0, 0, 0.22);
                border-radius: 10px 0 0 0;
              }

              .tree ul ul::before {
                content: "";
                position: absolute;
                top: 0;
                left: 50%;
                border-left: 1px solid rgba(0, 0, 0, 0.22);
                width: 0;
                height: 26px;
              }

              .tree .root {
                padding-left: 0;
                margin: 0;
              }

              .tree:after,
              .tree ul:after {
                content: "";
                display: table;
                clear: both;
              }

              /* Node UI: clean rounded name boxes (no initials) */
              .node-card {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                user-select: none;
                cursor: pointer;
              }

              .name-box {
                min-width: 210px; /* forces siblings to spread out */
                max-width: 260px;
                padding: 12px 14px;
                border-radius: 16px;
                border: 1px solid var(--border);
                background: white;
                box-shadow: 0 10px 22px rgba(0, 0, 0, 0.06);
                text-align: left;
              }

              .node-card:hover .name-box {
                box-shadow: 0 14px 26px rgba(0, 0, 0, 0.1);
              }

              .name-text {
                font-weight: 900;
                font-size: 13px;
                line-height: 1.25;
                color: #111;

                /* readable, non-overlapping labels */
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
                overflow: hidden;
                word-break: break-word;
              }

              .joblevel-text {
                margin-top: 6px;
                font-size: 12px;
                font-weight: 800;
                color: rgba(0, 0, 0, 0.62);
                line-height: 1.2;

                display: -webkit-box;
                -webkit-line-clamp: 1;
                -webkit-box-orient: vertical;
                overflow: hidden;
                word-break: break-word;
              }
            `}</style>
          </>
        )}
      </div>
    </main>
  );
}
