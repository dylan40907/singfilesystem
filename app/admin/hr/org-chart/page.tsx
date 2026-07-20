"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import { useDialog } from "@/components/ui/useDialog";
import { useCampusFilter } from "@/lib/CampusContext";

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

// Depth-based accent palette for org-chart nodes.
const ORG_ACCENTS = ["#e6178d", "#7c3aed", "#2563eb", "#0891b2", "#059669", "#d97706"];
function accentForDepth(d: number) {
  return ORG_ACCENTS[((d % ORG_ACCENTS.length) + ORG_ACCENTS.length) % ORG_ACCENTS.length];
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

type PickerMode = "root" | "child" | "insertAbove";

export default function HrOrgChartPage() {
  const { confirm, modal: dialogModal } = useDialog();
  const [status, setStatus] = useState("");
  const [profile, setProfile] = useState<TeacherProfile | null>(null);
  const isAdmin = !!profile?.is_active && (profile.role === "admin" || profile.role === "campus_admin");

  const { filter: campusFilter, isCampusAdmin, lockedCampusId } = useCampusFilter();

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

  // Move (reparent) modal
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveEmployeeId, setMoveEmployeeId] = useState<string>("");
  const [moveTargetParentId, setMoveTargetParentId] = useState<string>("");

  // Node context popover
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverEmployeeId, setPopoverEmployeeId] = useState<string>("");
  const [popoverPos, setPopoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Hover tooltip — reveals the full name/job level since the boxes truncate.
  // Follows the cursor and has pointer-events:none so it never blocks the click popover.
  const [tooltip, setTooltip] = useState<{ x: number; y: number; name: string; jl: string } | null>(null);

  // Canvas view state: zoom level, collapsed subtrees, and drag-to-pan bookkeeping.
  const [zoom, setZoom] = useState(1);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{ dragging: boolean; startX: number; startY: number; scrollLeft: number; scrollTop: number }>({
    dragging: false,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    scrollTop: 0,
  });
  const [isPanning, setIsPanning] = useState(false);

  function toggleCollapse(employeeId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });
  }

  function clampZoom(z: number) {
    return Math.min(1.6, Math.max(0.4, Math.round(z * 100) / 100));
  }

  function onCanvasMouseDown(e: React.MouseEvent) {
    // Only pan when grabbing empty canvas space, not when interacting with a node.
    if ((e.target as HTMLElement).closest(".node")) return;
    const el = canvasRef.current;
    if (!el) return;
    panRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    };
    setIsPanning(true);
    setTooltip(null);
  }

  function onCanvasMouseMove(e: React.MouseEvent) {
    if (!panRef.current.dragging) return;
    const el = canvasRef.current;
    if (!el) return;
    el.scrollLeft = panRef.current.scrollLeft - (e.clientX - panRef.current.startX);
    el.scrollTop = panRef.current.scrollTop - (e.clientY - panRef.current.startY);
  }

  function endPan() {
    if (!panRef.current.dragging) return;
    panRef.current.dragging = false;
    setIsPanning(false);
  }

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

      if (!p?.is_active || (p.role !== "admin" && p.role !== "campus_admin")) {
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
    const ok = await confirm("Delete this job level? (If any employees are assigned to it, deletion will fail.)", { title: "Delete Job Level", confirmLabel: "Delete", danger: true });
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

  // Collect an employee and all of its descendants (used to prevent reparent cycles).
  function collectSubtree(rootId: string): Set<string> {
    const out = new Set<string>();
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      for (const k of childrenByParentId.get(id) ?? []) stack.push(k);
    }
    return out;
  }

  function openMove(employeeId: string) {
    setMoveEmployeeId(employeeId);
    setMoveTargetParentId(nodeByEmployeeId.get(employeeId)?.parent_employee_id ?? "");
    setMoveOpen(true);
  }

  function closeMove() {
    setMoveOpen(false);
    setMoveEmployeeId("");
    setMoveTargetParentId("");
  }

  async function reparentEmployee() {
    if (!selectedCampusId || !moveEmployeeId) return;

    const newParent = moveTargetParentId || null;

    // Guards: can't parent to self or to one of your own descendants (would create a cycle).
    if (newParent === moveEmployeeId) {
      setStatus("Cannot set a node as its own manager.");
      return;
    }
    if (newParent && collectSubtree(moveEmployeeId).has(newParent)) {
      setStatus("Cannot move a node under one of its own reports.");
      return;
    }

    setStatus("Moving...");
    try {
      const { error } = await supabase
        .from("hr_org_chart_nodes")
        .update({ parent_employee_id: newParent })
        .eq("campus_id", selectedCampusId)
        .eq("employee_id", moveEmployeeId);

      if (error) throw error;

      closeMove();
      await loadCampusData(selectedCampusId);
      setStatus("✅ Moved.");
      setTimeout(() => setStatus(""), 900);
    } catch (e: any) {
      setStatus("Move error: " + (e?.message ?? "unknown"));
    }
  }

  async function removeFromChart(employeeId: string) {
    if (!selectedCampusId) return;
    const ok = await confirm("Remove this employee from the org chart? (Children will become top-level.)", { title: "Remove from Chart", confirmLabel: "Remove", danger: true });
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

  // Sync the global campus filter (from HrNavbar) into the page's local selection.
  // - A specific campus UUID in the navbar forces this page to that campus.
  // - "all" / "unassigned" leave the existing selection alone (org chart is single-campus).
  useEffect(() => {
    if (campusFilter !== "all" && campusFilter !== "unassigned") {
      if (selectedCampusId !== campusFilter) setSelectedCampusId(campusFilter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campusFilter]);

  // Filter the campus dropdown to ones the user is allowed to manage
  const accessibleCampuses = useMemo(() => {
    if (isCampusAdmin && lockedCampusId) {
      return campuses.filter((c) => c.id === lockedCampusId);
    }
    return campuses;
  }, [campuses, isCampusAdmin, lockedCampusId]);

  function renderTree(employeeId: string, depth: number = 0) {
    const emp = employeesById.get(employeeId);
    const kids = childrenByParentId.get(employeeId) ?? [];
    const label = emp ? employeeLabel(emp) : employeeId;
    const jl = jobLevelName(emp);
    const hasKids = kids.length > 0;
    const isCollapsed = collapsed.has(employeeId);
    const accent = accentForDepth(depth);
    const canAddChild = !!selectedCampusId && availableEmployeesForCampus.length > 0;

    return (
      <li key={employeeId} className={hasKids && !isCollapsed ? "has-children" : undefined}>
        <div className="node">
          <button
            type="button"
            className="node-btn"
            style={{ ["--accent" as any]: accent }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setTooltip(null);
              openPopoverForNode(employeeId, e.currentTarget as any, (e as any).clientX, (e as any).clientY);
            }}
            onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY, name: label, jl })}
            onMouseMove={(e) => setTooltip({ x: e.clientX, y: e.clientY, name: label, jl })}
            onMouseLeave={() => setTooltip(null)}
            aria-label={`${label} — ${jl}`}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                openPopoverForNode(employeeId, e.currentTarget as any, undefined, undefined);
              }
            }}
          >
            <span className="node-body">
              <span className="name-text">
                {label}
              </span>
              <span className="joblevel-text">
                {jl}
              </span>
              {hasKids ? (
                <span className="reports-pill">
                  {kids.length} {kids.length === 1 ? "report" : "reports"}
                </span>
              ) : null}
            </span>
          </button>

          {/* Hover quick-action: add a direct report under this node */}
          <button
            type="button"
            className="quick-add"
            title={canAddChild ? "Add direct report" : "No available employees to add"}
            disabled={!canAddChild}
            onClick={(e) => {
              e.stopPropagation();
              openChildPicker(employeeId);
            }}
          >
            ＋
          </button>

          {/* Collapse / expand subtree */}
          {hasKids ? (
            <button
              type="button"
              className={`collapse-toggle${isCollapsed ? " collapsed" : ""}`}
              title={isCollapsed ? `Expand ${kids.length} ${kids.length === 1 ? "report" : "reports"}` : "Collapse"}
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapse(employeeId);
              }}
            >
              {isCollapsed ? `+${kids.length}` : "−"}
            </button>
          ) : null}
        </div>

        {hasKids && !isCollapsed ? <ul>{kids.map((k) => renderTree(k, depth + 1))}</ul> : null}
      </li>
    );
  }

  return (
    <main className="stack">
      <div className="container">
        <div className="row-between" style={{ marginTop: 16, gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div className="stack" style={{ gap: 6 }}>
            <h1 className="h1">Org Chart</h1>
            <div className="subtle">Build a campus-based org chart by assigning parent/child relationships.</div>
          </div>

          {isAdmin ? (
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end" }}>
              {status ? <span className="badge badge-pink">{status}</span> : null}

              <select
                className="select"
                style={{ width: "min(240px, 60vw)" }}
                value={selectedCampusId}
                onChange={(e) => setSelectedCampusId(e.target.value)}
                disabled={isCampusAdmin}
                title="Org charts are campus-scoped. You can only place employees from the selected campus."
              >
                <option value="">— Select a campus —</option>
                {accessibleCampuses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>

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
            </div>
          ) : status ? (
            <span className="badge badge-pink">{status}</span>
          ) : null}
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
            {!selectedCampusId ? (
              <div className="card" style={{ marginTop: 14 }}>
                <div className="subtle">(Pick a campus to view/build its org chart.)</div>
              </div>
            ) : (
              <div className="card orgchart-card" style={{ marginTop: 14, padding: 0, overflow: "hidden" }}>
                <div className="orgchart-toolbar">
                  <div className="orgchart-toolbar-info">
                    <span className="orgchart-count">{nodes.length}</span>
                    <span className="subtle">{nodes.length === 1 ? "person placed" : "people placed"}</span>
                    {availableEmployeesForCampus.length > 0 ? (
                      <span className="subtle orgchart-unplaced">· {availableEmployeesForCampus.length} not yet placed</span>
                    ) : null}
                  </div>

                  <div className="orgchart-zoom">
                    <button
                      type="button"
                      className="zoom-btn"
                      title="Collapse all"
                      onClick={() => setCollapsed(new Set(nodes.map((n) => n.employee_id)))}
                    >
                      Collapse all
                    </button>
                    <button type="button" className="zoom-btn" title="Expand all" onClick={() => setCollapsed(new Set())}>
                      Expand all
                    </button>
                    <span className="zoom-divider" />
                    <button type="button" className="zoom-btn icon" title="Zoom out" onClick={() => setZoom((z) => clampZoom(z - 0.1))}>
                      −
                    </button>
                    <button type="button" className="zoom-pct" title="Reset zoom" onClick={() => setZoom(1)}>
                      {Math.round(zoom * 100)}%
                    </button>
                    <button type="button" className="zoom-btn icon" title="Zoom in" onClick={() => setZoom((z) => clampZoom(z + 0.1))}>
                      ＋
                    </button>
                  </div>
                </div>

                {nodes.length === 0 ? (
                  <div className="orgchart-empty">
                    <div className="orgchart-empty-icon">🗂️</div>
                    <div className="orgchart-empty-title">This campus org chart is empty</div>
                    <div className="subtle">
                      Click <b>Add top-level employee</b> above to place the first person at the top of the chart.
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ marginTop: 12 }}
                      disabled={availableEmployeesForCampus.length === 0}
                      onClick={openRootPicker}
                    >
                      Add top-level employee
                    </button>
                  </div>
                ) : rootEmployeeIds.length === 0 ? (
                  <div className="orgchart-empty">
                    <div className="orgchart-empty-icon">⚠️</div>
                    <div className="orgchart-empty-title">No top-level nodes found</div>
                    <div className="subtle">Everything has a parent. Use “Make top-level” from a node’s action menu to set a root.</div>
                  </div>
                ) : (
                  <div
                    ref={canvasRef}
                    className={`orgchart-canvas${isPanning ? " panning" : ""}`}
                    onMouseDown={onCanvasMouseDown}
                    onMouseMove={onCanvasMouseMove}
                    onMouseUp={endPan}
                    onMouseLeave={endPan}
                  >
                    <div className="orgchart-scale" style={{ zoom }}>
                      <div className="tree">
                        <ul className="root">{rootEmployeeIds.map((rid) => renderTree(rid))}</ul>
                      </div>
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
                  top: Math.min(popoverPos.y + 10, typeof window !== "undefined" ? window.innerHeight - 360 : popoverPos.y + 10),
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
                    openMove(popoverEmployeeId);
                  }}
                  disabled={!selectedCampusId || nodes.length < 2}
                  title={nodes.length < 2 ? "No other nodes to move under" : "Change this person's manager"}
                >
                  Move under…
                </button>

                <button
                  type="button"
                  className="btn"
                  style={{ width: "100%", marginBottom: 8 }}
                  onClick={() => {
                    closePopover();
                    void makeTopLevel(popoverEmployeeId);
                  }}
                  disabled={!selectedCampusId || !nodeByEmployeeId.get(popoverEmployeeId)?.parent_employee_id}
                  title={!nodeByEmployeeId.get(popoverEmployeeId)?.parent_employee_id ? "Already at the top level" : "Detach from manager and place at top level"}
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

            {/* Move (reparent) modal */}
            {moveOpen ? (
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
                  if (e.currentTarget === e.target) closeMove();
                }}
              >
                <div className="card" style={{ width: "min(560px, 100%)", padding: 16, borderRadius: 16 }}>
                  <div className="row-between" style={{ gap: 10 }}>
                    <div className="stack" style={{ gap: 4 }}>
                      <div style={{ fontWeight: 950, fontSize: 16 }}>Move employee</div>
                      <div className="subtle">
                        Moving:{" "}
                        <b>
                          {(() => {
                            const m = employeesById.get(moveEmployeeId);
                            return m ? employeeLabelWithJobLevel(m) : moveEmployeeId;
                          })()}
                        </b>
                      </div>
                    </div>
                    <button type="button" className="btn" onClick={closeMove} title="Close">
                      ✕
                    </button>
                  </div>

                  <div className="hr" />

                  <div className="stack" style={{ gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>New manager</div>
                      <select className="select" value={moveTargetParentId} onChange={(e) => setMoveTargetParentId(e.target.value)}>
                        <option value="">— Top level (no manager) —</option>
                        {(() => {
                          const subtree = collectSubtree(moveEmployeeId);
                          return nodes
                            .map((n) => n.employee_id)
                            .filter((id) => !subtree.has(id))
                            .map((id) => employeesById.get(id))
                            .filter((e): e is HrEmployee => !!e)
                            .sort((a, b) => employeeLabelWithJobLevel(a).localeCompare(employeeLabelWithJobLevel(b)))
                            .map((e) => (
                              <option key={e.id} value={e.id}>
                                {employeeLabelWithJobLevel(e)}
                              </option>
                            ));
                        })()}
                      </select>
                    </div>

                    <div className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
                      <button type="button" className="btn" onClick={closeMove}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={moveTargetParentId === (nodeByEmployeeId.get(moveEmployeeId)?.parent_employee_id ?? "")}
                        onClick={() => void reparentEmployee()}
                      >
                        Move
                      </button>
                    </div>

                    <div className="subtle">
                      The employee keeps their own reports — the whole subtree moves with them. Their own reports are excluded as
                      targets to prevent loops.
                    </div>
                  </div>
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
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}


<style jsx global>{`
              /* NOTE: global (not scoped) because the chart nodes are produced by the
                 renderTree() helper, whose JSX styled-jsx does not tag with its scope
                 class. Every selector is namespaced under .orgchart-card so nothing leaks. */

              /* ── Card / toolbar / canvas shell ───────────────────────── */
              .orgchart-card {
                display: flex;
                flex-direction: column;
              }

              .orgchart-card .orgchart-toolbar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                flex-wrap: wrap;
                padding: 12px 16px;
                border-bottom: 1px solid var(--border);
                background: #fbfbfd;
              }

              .orgchart-card .orgchart-toolbar-info {
                display: flex;
                align-items: baseline;
                gap: 6px;
              }

              .orgchart-card .orgchart-count {
                font-size: 18px;
                font-weight: 850;
                color: var(--pink);
              }

              .orgchart-card .orgchart-unplaced {
                opacity: 0.85;
              }

              .orgchart-card .orgchart-zoom {
                display: flex;
                align-items: center;
                gap: 6px;
              }

              .orgchart-card .zoom-btn {
                appearance: none;
                border: 1px solid var(--border);
                background: white;
                color: var(--text);
                border-radius: 9px;
                padding: 6px 10px;
                font-size: 12px;
                font-weight: 750;
                cursor: pointer;
                line-height: 1;
                transition: background 120ms ease, border-color 120ms ease;
              }
              .orgchart-card .zoom-btn:hover {
                background: #f5f5f7;
              }
              .orgchart-card .zoom-btn.icon {
                width: 30px;
                height: 30px;
                font-size: 16px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
              }

              .orgchart-card .zoom-pct {
                appearance: none;
                border: 1px solid var(--border);
                background: white;
                border-radius: 9px;
                min-width: 52px;
                height: 30px;
                font-size: 12px;
                font-weight: 800;
                cursor: pointer;
                color: var(--text);
              }
              .orgchart-card .zoom-pct:hover {
                background: #f5f5f7;
              }

              .orgchart-card .zoom-divider {
                width: 1px;
                height: 20px;
                background: var(--border);
                margin: 0 2px;
              }

              /* ── Empty states ────────────────────────────────────────── */
              .orgchart-card .orgchart-empty {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                text-align: center;
                padding: 56px 24px;
                gap: 6px;
              }
              .orgchart-card .orgchart-empty-icon {
                font-size: 40px;
                margin-bottom: 4px;
              }
              .orgchart-card .orgchart-empty-title {
                font-weight: 850;
                font-size: 16px;
              }

              /* ── Pannable / zoomable canvas ──────────────────────────── */
              .orgchart-card .orgchart-canvas {
                overflow: auto;
                max-height: min(84vh, 1200px);
                min-height: 520px;
                cursor: grab;
                background-color: #fcfcfd;
                background-image: radial-gradient(rgba(17, 24, 39, 0.07) 1px, transparent 1px);
                background-size: 22px 22px;
              }
              .orgchart-card .orgchart-canvas.panning {
                cursor: grabbing;
              }

              .orgchart-card .orgchart-scale {
                display: inline-block;
                min-width: 100%;
                padding: 44px 48px 56px;
                --line: #c7cfdb;
              }

              .orgchart-card .tree {
                display: inline-block;
                min-width: 100%;
              }

              /* ── Classic UL/LI org-chart connectors ──────────────────── */
              .orgchart-card .tree ul {
                display: flex;
                justify-content: center;
                align-items: flex-start;
                gap: 26px;
                padding-top: 34px;
                position: relative;
                margin: 0;
                padding-left: 0;
              }

              .orgchart-card .tree li {
                list-style: none;
                text-align: center;
                position: relative;
                padding: 34px 14px 0 14px;
              }

              /* Top connector: each child reaches up to a shared horizontal bar */
              .orgchart-card .tree li::before,
              .orgchart-card .tree li::after {
                content: "";
                position: absolute;
                top: 0;
                right: 50%;
                border-top: 2px solid var(--line);
                width: 50%;
                height: 34px;
              }
              .orgchart-card .tree li::after {
                right: auto;
                left: 50%;
                border-left: 2px solid var(--line);
              }

              /* Single child: just a straight vertical line, no horizontal bar */
              .orgchart-card .tree li:only-child::after,
              .orgchart-card .tree li:only-child::before {
                display: none;
              }
              .orgchart-card .tree li:only-child {
                padding-top: 0;
              }

              /* Trim the outer halves of the first/last children's bars */
              .orgchart-card .tree li:first-child::before,
              .orgchart-card .tree li:last-child::after {
                border: 0 none;
              }
              .orgchart-card .tree li:last-child::before {
                border-right: 2px solid var(--line);
                border-radius: 0 8px 0 0;
              }
              .orgchart-card .tree li:first-child::after {
                border-left: 2px solid var(--line);
                border-radius: 8px 0 0 0;
              }

              /* Vertical drop from a parent node down into its children's row */
              .orgchart-card .tree ul ul::before,
              .orgchart-card .tree .has-children > ul::before {
                content: "";
                position: absolute;
                top: 0;
                left: 50%;
                border-left: 2px solid var(--line);
                width: 0;
                height: 34px;
              }

              .orgchart-card .tree .root {
                padding: 0;
                margin: 0;
              }
              .orgchart-card .tree .root > li {
                padding-top: 0;
              }
              .orgchart-card .tree .root > li::before,
              .orgchart-card .tree .root > li::after {
                display: none;
              }

              /* ── Node card ───────────────────────────────────────────── */
              .orgchart-card .node {
                position: relative;
                display: inline-block;
              }

              .orgchart-card .node-btn {
                appearance: none;
                position: relative;
                margin: 0;
                cursor: pointer;
                user-select: none;
                display: flex;
                align-items: center;
                text-align: left;
                /* Width is driven by the NAME only (max-content ignores the wide
                   subtree below); the job level is excluded from sizing and
                   truncated to fit. Capped so very long names wrap to two lines. */
                width: max-content;
                min-width: 64px;
                max-width: 150px;
                padding: 10px 12px;
                border-radius: 14px;
                border: 1px solid var(--border);
                border-top: 3px solid var(--accent, var(--pink));
                background: white;
                box-shadow: 0 6px 16px rgba(17, 24, 39, 0.07);
                transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
              }
              .orgchart-card .node-btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 14px 28px rgba(17, 24, 39, 0.14);
              }
              .orgchart-card .node-btn:active {
                transform: translateY(0);
                box-shadow: 0 6px 16px rgba(17, 24, 39, 0.1);
              }
              .orgchart-card .node-btn:focus-visible {
                outline: 2px solid var(--accent, var(--pink));
                outline-offset: 2px;
              }

              .orgchart-card .node-body {
                min-width: 0;
                max-width: 100%;
                flex: 0 1 auto;
                display: flex;
                flex-direction: column;
                align-items: flex-start;
                gap: 3px;
              }

              .orgchart-card .name-text {
                font-weight: 800;
                font-size: 13.5px;
                line-height: 1.25;
                color: #111827;
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
                overflow: hidden;
                word-break: break-word;
              }

              .orgchart-card .joblevel-text {
                font-size: 11.5px;
                font-weight: 650;
                color: var(--muted);
                line-height: 1.2;
                /* Don't let the (often long) job level widen the box: contribute 0
                   to intrinsic width, then fill the name-driven width and truncate. */
                width: 0;
                min-width: 100%;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
              }

              .orgchart-card .reports-pill {
                align-self: flex-start;
                margin-top: 4px;
                font-size: 10.5px;
                font-weight: 750;
                color: #475569;
                background: #eef1f6;
                border-radius: 999px;
                padding: 2px 8px;
                line-height: 1.4;
              }

              /* ── Hover quick-add (＋) ─────────────────────────────────── */
              .orgchart-card .quick-add {
                position: absolute;
                top: -10px;
                right: -10px;
                width: 26px;
                height: 26px;
                border-radius: 50%;
                border: 1px solid var(--border);
                background: white;
                color: var(--pink);
                font-size: 16px;
                font-weight: 800;
                line-height: 1;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 4px 10px rgba(17, 24, 39, 0.16);
                opacity: 0;
                transform: scale(0.8);
                transition: opacity 120ms ease, transform 120ms ease, background 120ms ease, color 120ms ease;
              }
              .orgchart-card .node:hover .quick-add {
                opacity: 1;
                transform: scale(1);
              }
              .orgchart-card .quick-add:hover:not(:disabled) {
                background: var(--pink);
                color: white;
                border-color: var(--pink);
              }
              .orgchart-card .quick-add:disabled {
                opacity: 0;
                cursor: not-allowed;
              }

              /* ── Collapse / expand toggle ────────────────────────────── */
              .orgchart-card .collapse-toggle {
                position: absolute;
                bottom: -13px;
                left: 50%;
                transform: translateX(-50%);
                min-width: 24px;
                height: 22px;
                padding: 0 7px;
                border-radius: 999px;
                border: 2px solid var(--line);
                background: white;
                color: #374151;
                font-size: 12px;
                font-weight: 800;
                line-height: 1;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1;
                transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
              }
              .orgchart-card .collapse-toggle:hover {
                background: #f5f5f7;
              }
              .orgchart-card .collapse-toggle.collapsed {
                border-color: var(--pink);
                color: var(--pink);
                background: rgba(230, 23, 141, 0.06);
              }
            `}</style>
          </>
        )}
      </div>
      {dialogModal}

      {/* Hover tooltip (full name + job level). Rendered to <body>, follows the
          cursor, pointer-events:none so it never interferes with the click popover. */}
      {tooltip && typeof document !== "undefined"
        ? createPortal(
            <div
              style={{
                position: "fixed",
                left: tooltip.x + 14,
                top: tooltip.y - 12,
                zIndex: 99999,
                background: "#1e293b",
                color: "white",
                borderRadius: 8,
                padding: "8px 12px",
                fontSize: 12,
                fontWeight: 500,
                maxWidth: 320,
                boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
                pointerEvents: "none",
                lineHeight: 1.5,
              }}
            >
              <div style={{ fontWeight: 800 }}>{tooltip.name}</div>
              <div style={{ color: "#94a3b8" }}>{tooltip.jl}</div>
            </div>,
            document.body
          )
        : null}
    </main>
  );
}
