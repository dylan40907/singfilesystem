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

type HrJobLevelRow = {
  id: string;
  name: string;
  responsibilities: string | null;
  tpv: string | null; // Postgres numrange serialized as string, e.g. "[18,20]"
  nt: string | null;  // Postgres numrange serialized as string
};

type JobLevelFormRow = {
  id: string;
  name: string;
  responsibilities: string;
  tpvMin: string;
  tpvMax: string;
  ntMin: string;
  ntMax: string;
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

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      style={{
        width: "100%",
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid #e5e7eb",
        outline: "none",
        fontSize: 14,
        minHeight: 96,
        resize: "vertical",
        ...(props.style ?? {}),
      }}
    />
  );
}

function parseNumRange(v: string | null | undefined): { min: string; max: string } {
  // Accepts strings like "[18,20)" or "(69000,89000]" or "[,]" etc.
  if (!v) return { min: "", max: "" };
  const s = String(v).trim();
  const m = s.match(/^[\[(]\s*([^,]*)\s*,\s*([^\])}]*)\s*[\])]/);
  if (!m) return { min: "", max: "" };
  const min = (m[1] ?? "").trim();
  const max = (m[2] ?? "").trim();
  return { min: min === "" ? "" : min, max: max === "" ? "" : max };
}

function buildNumRange(minStr: string, maxStr: string): { range: string | null; error?: string } {
  const minT = (minStr ?? "").trim();
  const maxT = (maxStr ?? "").trim();
  if (!minT && !maxT) return { range: null };

  if (!minT || !maxT) return { range: null, error: "Both min and max are required for ranges." };

  const min = Number(minT);
  const max = Number(maxT);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { range: null, error: "Ranges must be numeric." };
  if (min > max) return { range: null, error: "Range min must be ≤ max." };

  // Inclusive bounds by default.
  return { range: `[${min},${max}]` };
}
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

type PickerMode = "root" | "child" | "insertAbove";

export default function HrOrgChartPage() {
  const [status, setStatus] = useState("");
  const [profile, setProfile] = useState<TeacherProfile | null>(null);
  const isAdmin = !!profile?.is_active && profile.role === "admin";

  const [campuses, setCampuses] = useState<HrCampus[]>([]);
  const [selectedCampusId, setSelectedCampusId] = useState<string>("");

  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [nodes, setNodes] = useState<OrgNodeRow[]>([]);


  // Manage job levels modal
  const [showManageJobLevels, setShowManageJobLevels] = useState(false);
  const [jobLevels, setJobLevels] = useState<HrJobLevelRow[]>([]);
  const [jobLevelForms, setJobLevelForms] = useState<Record<string, JobLevelFormRow>>({});
  const [jobLevelsLoading, setJobLevelsLoading] = useState(false);
  const [jobLevelsError, setJobLevelsError] = useState<string | null>(null);

  const [newJobLevelName, setNewJobLevelName] = useState("");
  const [newJobLevelResponsibilities, setNewJobLevelResponsibilities] = useState("");
  const [newJobLevelTpvMin, setNewJobLevelTpvMin] = useState("");
  const [newJobLevelTpvMax, setNewJobLevelTpvMax] = useState("");
  const [newJobLevelNtMin, setNewJobLevelNtMin] = useState("");
  const [newJobLevelNtMax, setNewJobLevelNtMax] = useState("");

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

  const nodeByEmployeeId = useMemo(() => {
    const m = new Map<string, OrgNodeRow>();
    for (const n of nodes) m.set(n.employee_id, n);
    return m;
  }, [nodes]);


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


  async function loadJobLevels() {
    setJobLevelsLoading(true);
    setJobLevelsError(null);

    try {
      const { data, error } = await supabase
        .from("hr_job_levels")
        .select("id,name,responsibilities,tpv,nt")
        .order("name", { ascending: true });

      if (error) throw error;

      const rows = (data ?? []) as HrJobLevelRow[];
      setJobLevels(rows);

      const forms: Record<string, JobLevelFormRow> = {};
      for (const r of rows) {
        const tpv = parseNumRange(r.tpv);
        const nt = parseNumRange(r.nt);
        forms[r.id] = {
          id: r.id,
          name: r.name ?? "",
          responsibilities: r.responsibilities ?? "",
          tpvMin: tpv.min,
          tpvMax: tpv.max,
          ntMin: nt.min,
          ntMax: nt.max,
        };
      }
      setJobLevelForms(forms);
    } catch (e: any) {
      setJobLevelsError(e?.message ?? "Failed to load job levels.");
    } finally {
      setJobLevelsLoading(false);
    }
  }

  function openManageJobLevels() {
    setShowManageJobLevels(true);
    void loadJobLevels();
  }

  function closeManageJobLevels() {
    setShowManageJobLevels(false);
    setJobLevelsError(null);
  }

  function updateJobLevelForm(id: string, patch: Partial<JobLevelFormRow>) {
    setJobLevelForms((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { id, name: "", responsibilities: "", tpvMin: "", tpvMax: "", ntMin: "", ntMax: "" }), ...patch } }));
  }

  async function addJobLevel() {
    setJobLevelsError(null);
    const name = newJobLevelName.trim();
    if (!name) return;

    const tpv = buildNumRange(newJobLevelTpvMin, newJobLevelTpvMax);
    if (tpv.error) {
      setJobLevelsError("TPV: " + tpv.error);
      return;
    }
    const nt = buildNumRange(newJobLevelNtMin, newJobLevelNtMax);
    if (nt.error) {
      setJobLevelsError("NT: " + nt.error);
      return;
    }

    try {
      const { error } = await supabase.from("hr_job_levels").insert({
        name,
        responsibilities: newJobLevelResponsibilities.trim() || null,
        tpv: tpv.range,
        nt: nt.range,
      });

      if (error) throw error;

      setNewJobLevelName("");
      setNewJobLevelResponsibilities("");
      setNewJobLevelTpvMin("");
      setNewJobLevelTpvMax("");
      setNewJobLevelNtMin("");
      setNewJobLevelNtMax("");

      await loadJobLevels();
      // also refresh campus employees so job level names stay current if you’re viewing the org chart
      if (selectedCampusId) await loadCampusData(selectedCampusId);
    } catch (e: any) {
      setJobLevelsError(e?.message ?? "Failed to add job level.");
    }
  }

  async function saveJobLevel(id: string) {
    const form = jobLevelForms[id];
    if (!form) return;

    setJobLevelsError(null);

    const name = form.name.trim();
    if (!name) {
      setJobLevelsError("Job level name is required.");
      return;
    }

    const tpv = buildNumRange(form.tpvMin, form.tpvMax);
    if (tpv.error) {
      setJobLevelsError("TPV: " + tpv.error);
      return;
    }
    const nt = buildNumRange(form.ntMin, form.ntMax);
    if (nt.error) {
      setJobLevelsError("NT: " + nt.error);
      return;
    }

    try {
      const { error } = await supabase
        .from("hr_job_levels")
        .update({
          name,
          responsibilities: form.responsibilities.trim() || null,
          tpv: tpv.range,
          nt: nt.range,
        })
        .eq("id", id);

      if (error) throw error;

      await loadJobLevels();
      if (selectedCampusId) await loadCampusData(selectedCampusId);
    } catch (e: any) {
      setJobLevelsError(e?.message ?? "Failed to save job level.");
    }
  }

  async function deleteJobLevel(id: string) {
    const ok = confirm("Delete this job level? (If any employees are assigned to it, deletion will fail.)");
    if (!ok) return;

    setJobLevelsError(null);

    try {
      const { error } = await supabase.from("hr_job_levels").delete().eq("id", id);
      if (error) throw error;

      await loadJobLevels();
      if (selectedCampusId) await loadCampusData(selectedCampusId);
    } catch (e: any) {
      setJobLevelsError(e?.message ?? "Failed to delete job level.");
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


  function openInsertAbovePicker(targetEmployeeId: string) {
    setPickerMode("insertAbove");
    setPickerParentEmployeeId(targetEmployeeId);
    setPickerEmployeeId("");
    setPickerOpen(true);
  }

  async function addPickedEmployee() {
    if (!selectedCampusId) return;
    if (!pickerEmployeeId) return;

    setStatus("Saving org chart...");
    try {
      if (pickerMode === "insertAbove") {
        const targetId = pickerParentEmployeeId;
        if (!targetId) throw new Error("No target employee selected.");

        const currentParentId = nodeByEmployeeId.get(targetId)?.parent_employee_id ?? null;

        // 1) Insert the new manager above the target (inherits the target's current parent)
        const { error: insertErr } = await supabase.from("hr_org_chart_nodes").insert({
          campus_id: selectedCampusId,
          employee_id: pickerEmployeeId,
          parent_employee_id: currentParentId,
        });
        if (insertErr) throw insertErr;

        // 2) Re-parent the target under the new manager
        const { error: updateErr } = await supabase
          .from("hr_org_chart_nodes")
          .update({ parent_employee_id: pickerEmployeeId })
          .eq("campus_id", selectedCampusId)
          .eq("employee_id", targetId);

        if (updateErr) {
          // Best-effort rollback
          await supabase.from("hr_org_chart_nodes").delete().eq("campus_id", selectedCampusId).eq("employee_id", pickerEmployeeId);
          throw updateErr;
        }
      } else {
        const parentId = pickerMode === "child" ? pickerParentEmployeeId : null;

        const { error } = await supabase.from("hr_org_chart_nodes").insert({
          campus_id: selectedCampusId,
          employee_id: pickerEmployeeId,
          parent_employee_id: parentId,
        });

        if (error) throw error;
      }

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

  function openPopoverForNode(employeeId: string, anchorEl?: HTMLElement | null, clientX?: number, clientY?: number) {
    setPopoverEmployeeId(employeeId);

    // Prefer the actual click position; fall back to the node's bounding box (keyboard-friendly).
    if (typeof clientX === "number" && typeof clientY === "number" && (clientX > 0 || clientY > 0)) {
      setPopoverPos({ x: clientX, y: clientY });
    } else if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      setPopoverPos({ x: r.right, y: r.top });
    } else {
      setPopoverPos({ x: 0, y: 0 });
    }

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
        <button
          type="button"
          className="node-btn"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openPopoverForNode(employeeId, e.currentTarget as any, (e as any).clientX, (e as any).clientY);
          }}
          title="Click for actions"
          aria-label={`${label} — ${jl}`}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              openPopoverForNode(employeeId, e.currentTarget as any, undefined, undefined);
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
        </button>

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
                <button type="button" className="btn" onClick={openManageJobLevels} disabled={jobLevelsLoading}>
                  Manage Job Levels
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
                    openInsertAbovePicker(popoverEmployeeId);
                  }}
                  disabled={!selectedCampusId || availableEmployeesForCampus.length === 0}
                >
                  Add manager above
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
                      <div style={{ fontWeight: 950, fontSize: 16 }}>{pickerMode === "root" ? "Add top-level employee" : pickerMode === "child" ? "Add child employee" : "Insert manager above"}</div>
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
                        ) : pickerMode === "insertAbove" ? (
                          <>
                            Inserting above:{" "}
                            <b>
                              {(() => {
                                const t = employeesById.get(pickerParentEmployeeId);
                                return t ? employeeLabelWithJobLevel(t) : pickerParentEmployeeId;
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

            
            {/* Manage Job Levels modal */}
            {showManageJobLevels && (
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
                  zIndex: 230,
                }}
                onClick={closeManageJobLevels}
              >
                <div
                  style={{
                    width: "min(980px, 100%)",
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
                  <div className="row-between" style={{ padding: 12, borderBottom: "1px solid #e5e7eb" }}>
                    <div style={{ fontWeight: 900 }}>Manage Job Levels</div>
                    <button className="btn" onClick={closeManageJobLevels}>
                      Close
                    </button>
                  </div>

                  <div style={{ padding: 14, overflowY: "auto" }}>
                    {jobLevelsError && (
                      <div
                        style={{
                          marginBottom: 12,
                          padding: 12,
                          borderRadius: 12,
                          border: "1px solid rgba(239,68,68,0.35)",
                          background: "rgba(239,68,68,0.06)",
                          color: "#991b1b",
                          fontWeight: 700,
                        }}
                      >
                        {jobLevelsError}
                      </div>
                    )}

                    <div style={{ fontWeight: 900, marginBottom: 10 }}>Add new job level</div>

                    <div style={{ border: "1px dashed #e5e7eb", borderRadius: 14, padding: 12 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
                        <div>
                          <FieldLabel>Name</FieldLabel>
                          <TextInput value={newJobLevelName} onChange={(e) => setNewJobLevelName(e.target.value)} placeholder="e.g., Teacher II" />
                        </div>

                        <div>
                          <FieldLabel>Responsibilities</FieldLabel>
                          <TextArea
                            value={newJobLevelResponsibilities}
                            onChange={(e) => setNewJobLevelResponsibilities(e.target.value)}
                            placeholder="Optional responsibilities…"
                          />
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <div>
                            <FieldLabel>TPV range (min / max)</FieldLabel>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                              <TextInput value={newJobLevelTpvMin} onChange={(e) => setNewJobLevelTpvMin(e.target.value)} placeholder="min" inputMode="numeric" />
                              <TextInput value={newJobLevelTpvMax} onChange={(e) => setNewJobLevelTpvMax(e.target.value)} placeholder="max" inputMode="numeric" />
                            </div>
                          </div>
                          <div>
                            <FieldLabel>NT range (min / max)</FieldLabel>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                              <TextInput value={newJobLevelNtMin} onChange={(e) => setNewJobLevelNtMin(e.target.value)} placeholder="min" inputMode="numeric" />
                              <TextInput value={newJobLevelNtMax} onChange={(e) => setNewJobLevelNtMax(e.target.value)} placeholder="max" inputMode="numeric" />
                            </div>
                          </div>
                        </div>

                        <div className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
                          <button className="btn btn-primary" onClick={() => void addJobLevel()} disabled={!newJobLevelName.trim()}>
                            Add
                          </button>
                        </div>

                        <div className="subtle">
                          Tip: Leave TPV/NT blank if you don’t want a range. If you enter a range, provide both min and max (inclusive).
                        </div>
                      </div>
                    </div>

                    <div style={{ height: 16 }} />

                    <div className="row-between" style={{ gap: 10, marginBottom: 8 }}>
                      <div style={{ fontWeight: 800 }}>Existing job levels ({jobLevels.length})</div>
                      <button className="btn" onClick={() => void loadJobLevels()} disabled={jobLevelsLoading}>
                        {jobLevelsLoading ? "Loading..." : "Refresh"}
                      </button>
                    </div>

                    {jobLevelsLoading ? (
                      <div className="subtle" style={{ padding: 10 }}>
                        Loading…
                      </div>
                    ) : jobLevels.length === 0 ? (
                      <div className="subtle">No job levels yet.</div>
                    ) : (
                      <div style={{ display: "grid", gap: 10 }}>
                        {jobLevels.map((jl) => {
                          const f = jobLevelForms[jl.id];
                          if (!f) return null;

                          return (
                            <div key={jl.id} style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
                              <div className="row-between" style={{ gap: 10, alignItems: "flex-start" }}>
                                <div style={{ fontWeight: 900 }}>{jl.name}</div>
                                <div className="row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                                  <button className="btn btn-primary" onClick={() => void saveJobLevel(jl.id)} style={{ padding: "6px 10px" }}>
                                    Save
                                  </button>
                                  <button className="btn" onClick={() => void deleteJobLevel(jl.id)} style={{ padding: "6px 10px" }}>
                                    Delete
                                  </button>
                                </div>
                              </div>

                              <div style={{ height: 10 }} />

                              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
                                <div>
                                  <FieldLabel>Name</FieldLabel>
                                  <TextInput value={f.name} onChange={(e) => updateJobLevelForm(jl.id, { name: e.target.value })} />
                                </div>

                                <div>
                                  <FieldLabel>Responsibilities</FieldLabel>
                                  <TextArea value={f.responsibilities} onChange={(e) => updateJobLevelForm(jl.id, { responsibilities: e.target.value })} />
                                </div>

                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                                  <div>
                                    <FieldLabel>TPV range (min / max)</FieldLabel>
                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                      <TextInput value={f.tpvMin} onChange={(e) => updateJobLevelForm(jl.id, { tpvMin: e.target.value })} placeholder="min" inputMode="numeric" />
                                      <TextInput value={f.tpvMax} onChange={(e) => updateJobLevelForm(jl.id, { tpvMax: e.target.value })} placeholder="max" inputMode="numeric" />
                                    </div>
                                  </div>
                                  <div>
                                    <FieldLabel>NT range (min / max)</FieldLabel>
                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                      <TextInput value={f.ntMin} onChange={(e) => updateJobLevelForm(jl.id, { ntMin: e.target.value })} placeholder="min" inputMode="numeric" />
                                      <TextInput value={f.ntMax} onChange={(e) => updateJobLevelForm(jl.id, { ntMax: e.target.value })} placeholder="max" inputMode="numeric" />
                                    </div>
                                  </div>
                                </div>
                              </div>

                              <div className="subtle" style={{ marginTop: 10 }}>
                                Note: deletion will fail if employees are assigned to this level (foreign key from hr_employees.job_level_id).
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}


<style jsx>{`
              .orgchart-wrap {
                min-width: 1100px;
                overflow-x: auto;
                padding-bottom: 8px;
              }

              /* Classic UL/LI org chart connectors */
              .tree ul {
                display: flex;
                justify-content: center;
                align-items: flex-start;
                gap: 34px;
                padding-top: 26px;
                position: relative;
                transition: all 0.2s;
              }

              .tree li {
                text-align: center;
                list-style-type: none;
                position: relative;
                padding: 26px 18px 0 18px; /* horizontal spacing */
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

              /* Node UI: rounded, clickable rectangles */
              .node-btn {
                appearance: none;
                border: 0;
                background: transparent;
                padding: 0;
                margin: 0;
                cursor: pointer;
                user-select: none;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border-radius: 18px;
              }

              .node-btn:focus-visible .name-box {
                outline: 2px solid rgba(236, 72, 153, 0.8); /* pink-ish focus ring */
                outline-offset: 2px;
              }

              .name-box {
                min-width: 210px; /* forces siblings to spread out */
                max-width: 280px;
                padding: 12px 14px;
                border-radius: 18px;
                border: 1px solid var(--border);
                background: white;
                box-shadow: 0 10px 22px rgba(0, 0, 0, 0.06);
                text-align: left;
                transition: transform 120ms ease, box-shadow 120ms ease;
              }

              .node-btn:hover .name-box {
                transform: translateY(-1px);
                box-shadow: 0 14px 26px rgba(0, 0, 0, 0.1);
              }

              .node-btn:active .name-box {
                transform: translateY(0px);
                box-shadow: 0 10px 22px rgba(0, 0, 0, 0.08);
              }

              .name-text {
                font-weight: 950;
                font-size: 13px;
                line-height: 1.25;
                color: #111;

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
