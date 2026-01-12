"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { supabase } from "@/lib/supabaseClient";
import "@fortune-sheet/react/dist/index.css";

const FortuneWorkbook = dynamic(() => import("@fortune-sheet/react").then((m) => m.Workbook), { ssr: false });

type JobLevelRow = { id: string; name: string };
type CampusRow = { id: string; name: string };

type EventTypeRow = { id: string; name: string };

type EmployeeEventRow = {
  id: string;
  employee_id: string;
  event_type_id: string;
  event_date: string; // YYYY-MM-DD
  notes: string | null;
  created_at: string;
  event_type?: EventTypeRow | null;
};

type EmployeeEventReminderRow = {
  id: string;
  employee_event_id: string;
  days_before: number;
  sent_at: string | null;
  created_at: string;
};

type EmployeeRow = {
  id: string;
  legal_first_name: string;
  legal_middle_name: string | null;
  legal_last_name: string;
  nicknames: string[];
  rate_type: "salary" | "hourly";
  rate: number;
  employment_type: "full_time" | "part_time";
  is_active: boolean;

  benefits: string[];

  has_insurance: boolean;
  has_401k: boolean;
  has_pto: boolean;

  // ✅ PTO reminder fields
  pto_reminder_date: string | null; // YYYY-MM-DD
  pto_reminder_sent_at: string | null;

  job_level_id: string | null;
  campus_id: string | null;

  // ✅ persisted mini-sheet for insurance calculations
  insurance_sheet_doc: any[] | null;

  job_level?: JobLevelRow | null;
  campus?: CampusRow | null;

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

function Chip({ text, onRemove }: { text: string; onRemove: () => void }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 999,
        border: "1px solid #e5e7eb",
        background: "rgba(0,0,0,0.02)",
        fontSize: 13,
        fontWeight: 700,
      }}
    >
      {text}
      <button
        type="button"
        className="btn"
        onClick={onRemove}
        style={{ padding: "2px 8px", borderRadius: 999, fontWeight: 900 }}
        aria-label={`Remove ${text}`}
      >
        ×
      </button>
    </span>
  );
}

/**
 * Normalize relationship embeds:
 * sometimes PostgREST returns {job_level:{...}} and sometimes {job_level:[{...}]}
 */
function asSingle<T>(v: any): T | null {
  if (!v) return null;
  if (Array.isArray(v)) return (v[0] ?? null) as T | null;
  return v as T;
}

// ---- Sheet helpers (ported / simplified from my-plans) ----
function deepJsonClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

function normalizeSheetDoc(doc: any, fallback: any[]) {
  if (!doc) return fallback;
  if (Array.isArray(doc)) return doc;
  if (typeof doc === "object") return [doc];
  return fallback;
}

function ensureCelldata(sheet: any) {
  const sh = { ...(sheet ?? {}) };

  if (!Array.isArray(sh.celldata)) sh.celldata = [];
  if (sh.status == null) sh.status = 1;

  const grid = sh.data;
  if (sh.celldata.length === 0 && Array.isArray(grid)) {
    const celldata: any[] = [];

    for (let r = 0; r < grid.length; r++) {
      const row = grid[r];
      if (!Array.isArray(row)) continue;

      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (cell == null) continue;

        if (typeof cell === "object") {
          const v = (cell as any).v;
          if (v !== null && v !== undefined && String(v) !== "") {
            celldata.push({ r, c, v: cell });
          }
        } else {
          if (String(cell) !== "") {
            celldata.push({
              r,
              c,
              v: { v: cell, m: String(cell), ct: { t: "g", fa: "General" } },
            });
          }
        }
      }
    }

    sh.celldata = celldata;
  }

  return sh;
}

function normalizeForFortune(doc: any, fallback: any[]) {
  const arr = normalizeSheetDoc(doc, fallback);
  return arr.map(ensureCelldata);
}

function normalizeEmployee(raw: any): EmployeeRow {
  return {
    id: raw.id,
    legal_first_name: raw.legal_first_name,
    legal_middle_name: raw.legal_middle_name ?? null,
    legal_last_name: raw.legal_last_name,
    nicknames: Array.isArray(raw.nicknames) ? raw.nicknames : [],
    rate_type: raw.rate_type === "salary" ? "salary" : "hourly",
    rate: Number(raw.rate ?? 0),
    employment_type: raw.employment_type === "full_time" ? "full_time" : "part_time",
    is_active: !!raw.is_active,

    benefits: Array.isArray(raw.benefits) ? raw.benefits : [],

    has_insurance: !!raw.has_insurance,
    has_401k: !!raw.has_401k,
    has_pto: !!raw.has_pto,

    pto_reminder_date: raw.pto_reminder_date ?? null,
    pto_reminder_sent_at: raw.pto_reminder_sent_at ?? null,

    job_level_id: raw.job_level_id ?? null,
    campus_id: raw.campus_id ?? null,

    insurance_sheet_doc: raw.insurance_sheet_doc ?? null,

    job_level: asSingle<JobLevelRow>(raw.job_level),
    campus: asSingle<CampusRow>(raw.campus),

    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

function formatYmd(ymd: string) {
  try {
    const d = new Date(`${ymd}T00:00:00`);
    return d.toLocaleDateString();
  } catch {
    return ymd;
  }
}

export default function EmployeesPage() {
  // 6 columns x 15 rows
  const DEFAULT_INSURANCE_SHEET_DOC = useMemo(
    () => [
      {
        name: "Insurance",
        row: 15,
        column: 6,
        celldata: [],
        config: {},
      },
    ],
    []
  );

  const [loading, setLoading] = useState(true);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [jobLevels, setJobLevels] = useState<JobLevelRow[]>([]);
  const [campuses, setCampuses] = useState<CampusRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Milestone type tables
  const [eventTypes, setEventTypes] = useState<EventTypeRow[]>([]);

  // Per-employee details (when editing)
  const [empEvents, setEmpEvents] = useState<EmployeeEventRow[]>([]);
  const [empEventRemindersByEventId, setEmpEventRemindersByEventId] = useState<Record<string, EmployeeEventReminderRow[]>>({});

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // “+ dropdown” modals become manage modals (add + list + delete)
  const [showManageJobLevels, setShowManageJobLevels] = useState(false);
  const [showManageCampuses, setShowManageCampuses] = useState(false);
  const [showManageEventTypes, setShowManageEventTypes] = useState(false);

  const [legalFirst, setLegalFirst] = useState("");
  const [legalMiddle, setLegalMiddle] = useState("");
  const [legalLast, setLegalLast] = useState("");

  const [nicknamesInput, setNicknamesInput] = useState("");
  const [nicknames, setNicknames] = useState<string[]>([]);

  const [jobLevelId, setJobLevelId] = useState<string>("");
  const [campusId, setCampusId] = useState<string>("");

  const [rateType, setRateType] = useState<"salary" | "hourly">("hourly");
  const [rate, setRate] = useState<string>("0");

  const [employmentType, setEmploymentType] = useState<"full_time" | "part_time">("part_time");
  const [isActive, setIsActive] = useState(true);

  const [benefitInput, setBenefitInput] = useState("");
  const [benefits, setBenefits] = useState<string[]>([]);

  const [hasInsurance, setHasInsurance] = useState(false);
  const [has401k, setHas401k] = useState(false);
  const [hasPto, setHasPto] = useState(false);

  // PTO
  const [ptoReminderDate, setPtoReminderDate] = useState<string>("");
  const [ptoReminderSentAt, setPtoReminderSentAt] = useState<string | null>(null);

  // Manage modal inputs
  const [newJobLevelName, setNewJobLevelName] = useState("");
  const [newCampusName, setNewCampusName] = useState("");
  const [newEventTypeName, setNewEventTypeName] = useState("");

  // Insurance sheet
  const [insuranceSheetDoc, setInsuranceSheetDoc] = useState<any[]>(DEFAULT_INSURANCE_SHEET_DOC);
  const [insuranceWorkbookKey, setInsuranceWorkbookKey] = useState<string>("init");
  const [insuranceSheetDirty, setInsuranceSheetDirty] = useState(false);
  const insuranceWorkbookRef = useRef<any>(null);

  // Milestones UI (create new event)
  const [newEventTypeId, setNewEventTypeId] = useState<string>("");
  const [newEventDate, setNewEventDate] = useState<string>("");
  const [newEventNotes, setNewEventNotes] = useState<string>("");

  const [newReminderDays, setNewReminderDays] = useState<string>("");
  const [newEventReminderOffsets, setNewEventReminderOffsets] = useState<number[]>([]);

  const exportInsuranceSheetDoc = useCallback((): any[] => {
    const api = insuranceWorkbookRef.current;
    let latest: any;

    try {
      if (api?.getAllSheets) latest = api.getAllSheets();
    } catch (err) {
      console.warn("exportInsuranceSheetDoc: ref.getAllSheets() threw", err);
    }

    if (!latest) latest = insuranceSheetDoc;
    return deepJsonClone(latest);
  }, [insuranceSheetDoc]);

  const handleInsuranceSheetOp = useCallback((_ops: any[]) => {
    requestAnimationFrame(() => setInsuranceSheetDirty(true));
  }, []);

  const isEditing = !!editingId;

  const canSubmit = useMemo(() => {
    return legalFirst.trim() && legalLast.trim();
  }, [legalFirst, legalLast]);

  function resetForm() {
    setEditingId(null);

    setLegalFirst("");
    setLegalMiddle("");
    setLegalLast("");

    setNicknamesInput("");
    setNicknames([]);

    setJobLevelId("");
    setCampusId("");

    setRateType("hourly");
    setRate("0");

    setEmploymentType("part_time");
    setIsActive(true);

    setBenefitInput("");
    setBenefits([]);

    setHasInsurance(false);
    setHas401k(false);
    setHasPto(false);

    setPtoReminderDate("");
    setPtoReminderSentAt(null);

    setInsuranceSheetDoc(DEFAULT_INSURANCE_SHEET_DOC);
    setInsuranceWorkbookKey(`ins:${Date.now()}`);
    setInsuranceSheetDirty(false);

    // reset employee detail tabs
    setEmpEvents([]);
    setEmpEventRemindersByEventId({});

    // reset add-event forms
    setNewEventTypeId("");
    setNewEventDate("");
    setNewEventNotes("");
    setNewReminderDays("");
    setNewEventReminderOffsets([]);
  }

  function openCreate() {
    resetForm();
    setShowForm(true);
  }

  async function loadEmployeeDetails(employeeId: string) {
    // Events
    const [evRes] = await Promise.all([
      supabase
        .from("hr_employee_events")
        .select(
          `
            id,
            employee_id,
            event_type_id,
            event_date,
            notes,
            created_at,
            event_type:hr_event_types!hr_employee_events_event_type_id_fkey(id,name)
          `
        )
        .eq("employee_id", employeeId)
        .order("event_date", { ascending: false })
        .order("created_at", { ascending: false }),
    ]);

    if (evRes.error) throw evRes.error;

    const events = (evRes.data ?? []).map((x: any) => ({
      ...x,
      event_type: asSingle<EventTypeRow>(x.event_type),
    })) as EmployeeEventRow[];

    // Re-fetch reminders now that we know event ids
    let reminders: EmployeeEventReminderRow[] = [];
    if (events.length > 0) {
      const ids = events.map((e) => e.id);
      const r2 = await supabase
        .from("hr_employee_event_reminders")
        .select("id, employee_event_id, days_before, sent_at, created_at")
        .in("employee_event_id", ids)
        .order("days_before", { ascending: false })
        .order("created_at", { ascending: false });
      if (r2.error) throw r2.error;
      reminders = (r2.data ?? []) as EmployeeEventReminderRow[];
    }

    const map: Record<string, EmployeeEventReminderRow[]> = {};
    for (const r of reminders) {
      map[r.employee_event_id] = map[r.employee_event_id] ?? [];
      map[r.employee_event_id].push(r);
    }

    setEmpEvents(events);
    setEmpEventRemindersByEventId(map);
  }

  async function openEdit(emp: EmployeeRow) {
    setEditingId(emp.id);
    setShowForm(true);

    setLegalFirst(emp.legal_first_name ?? "");
    setLegalMiddle(emp.legal_middle_name ?? "");
    setLegalLast(emp.legal_last_name ?? "");

    setNicknamesInput("");
    setNicknames(Array.isArray(emp.nicknames) ? emp.nicknames : []);

    setJobLevelId(emp.job_level_id ?? "");
    setCampusId(emp.campus_id ?? "");

    setRateType(emp.rate_type === "salary" ? "salary" : "hourly");
    setRate(String(Number(emp.rate ?? 0)));

    setEmploymentType(emp.employment_type === "full_time" ? "full_time" : "part_time");
    setIsActive(!!emp.is_active);

    setBenefitInput("");
    setBenefits(Array.isArray(emp.benefits) ? emp.benefits : []);

    setHasInsurance(!!emp.has_insurance);
    setHas401k(!!emp.has_401k);
    setHasPto(!!emp.has_pto);

    setPtoReminderDate(emp.pto_reminder_date ?? "");
    setPtoReminderSentAt(emp.pto_reminder_sent_at ?? null);

    const normalized = normalizeForFortune(emp.insurance_sheet_doc, DEFAULT_INSURANCE_SHEET_DOC);
    setInsuranceSheetDoc(normalized);
    setInsuranceWorkbookKey(`ins:${emp.id}:${Date.now()}`);
    setInsuranceSheetDirty(false);

    try {
      await loadEmployeeDetails(emp.id);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load milestones.");
    }
  }

  function closeForm() {
    setShowForm(false);
    resetForm();
  }

  function addNickname() {
    const raw = nicknamesInput.trim();
    if (!raw) return;
    if (nicknames.some((n) => n.toLowerCase() === raw.toLowerCase())) return;
    setNicknames([...nicknames, raw]);
    setNicknamesInput("");
  }

  function addBenefit() {
    const raw = benefitInput.trim();
    if (!raw) return;
    if (benefits.some((b) => b.toLowerCase() === raw.toLowerCase())) return;
    setBenefits([...benefits, raw]);
    setBenefitInput("");
  }

  function addEventReminderOffset() {
    const n = Number(newReminderDays);
    if (!Number.isFinite(n) || n < 0) return;
    if (newEventReminderOffsets.includes(n)) return;
    setNewEventReminderOffsets((prev) => [...prev, n].sort((a, b) => b - a));
    setNewReminderDays("");
  }

  async function loadAll() {
    setLoading(true);
    setError(null);

    try {
      const [jlRes, cRes, eRes, etRes] = await Promise.all([
        supabase.from("hr_job_levels").select("id,name").order("name", { ascending: true }),
        supabase.from("hr_campuses").select("id,name").order("name", { ascending: true }),
        supabase
          .from("hr_employees")
          .select(
            `
              id,
              legal_first_name,
              legal_middle_name,
              legal_last_name,
              nicknames,
              rate_type,
              rate,
              employment_type,
              is_active,
              benefits,
              has_insurance,
              has_401k,
              has_pto,
              pto_reminder_date,
              pto_reminder_sent_at,
              job_level_id,
              campus_id,
              insurance_sheet_doc,
              created_at,
              updated_at,
              job_level:hr_job_levels!hr_employees_job_level_id_fkey(id,name),
              campus:hr_campuses!hr_employees_campus_id_fkey(id,name)
            `
          )
          .order("updated_at", { ascending: false }),
        supabase.from("hr_event_types").select("id,name").order("name", { ascending: true }),
      ]);

      if (jlRes.error) throw jlRes.error;
      if (cRes.error) throw cRes.error;
      if (eRes.error) throw eRes.error;
      if (etRes.error) throw etRes.error;

      setJobLevels((jlRes.data ?? []) as JobLevelRow[]);
      setCampuses((cRes.data ?? []) as CampusRow[]);
      setEventTypes((etRes.data ?? []) as EventTypeRow[]);

      const rawEmployees = (eRes.data ?? []) as unknown as any[];
      setEmployees(rawEmployees.map(normalizeEmployee));
    } catch (e: any) {
      setError(e?.message ?? "Failed to load employees.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (showManageJobLevels) setShowManageJobLevels(false);
        else if (showManageCampuses) setShowManageCampuses(false);
        else if (showManageEventTypes) setShowManageEventTypes(false);
        else if (showForm) closeForm();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm, showManageJobLevels, showManageCampuses, showManageEventTypes]);

  async function createEmployee() {
    setError(null);

    const parsedRate = Number(rate);
    const safeRate = Number.isFinite(parsedRate) ? parsedRate : 0;

    const insuranceDoc = hasInsurance ? normalizeForFortune(exportInsuranceSheetDoc(), DEFAULT_INSURANCE_SHEET_DOC) : null;

    const payload: any = {
      legal_first_name: legalFirst.trim(),
      legal_middle_name: legalMiddle.trim() || null,
      legal_last_name: legalLast.trim(),
      nicknames,
      rate_type: rateType,
      rate: safeRate,
      employment_type: employmentType,
      is_active: isActive,
      benefits,
      has_insurance: hasInsurance,
      has_401k: has401k,
      has_pto: hasPto,
      pto_reminder_date: hasPto ? (ptoReminderDate || null) : null,
      job_level_id: jobLevelId || null,
      campus_id: campusId || null,
      insurance_sheet_doc: insuranceDoc,
    };

    const { data, error } = await supabase.from("hr_employees").insert(payload).select("id").single();
    if (error) {
      setError(error.message);
      return;
    }

    closeForm();
    await loadAll();

    if (data?.id) {
      const created = employees.find((e) => e.id === data.id);
      if (created) void openEdit(created);
    }
  }

  async function updateEmployee() {
    if (!editingId) return;
    setError(null);

    const parsedRate = Number(rate);
    const safeRate = Number.isFinite(parsedRate) ? parsedRate : 0;

    const insuranceDoc = hasInsurance ? normalizeForFortune(exportInsuranceSheetDoc(), DEFAULT_INSURANCE_SHEET_DOC) : null;

    const payload: any = {
      legal_first_name: legalFirst.trim(),
      legal_middle_name: legalMiddle.trim() || null,
      legal_last_name: legalLast.trim(),
      nicknames,
      rate_type: rateType,
      rate: safeRate,
      employment_type: employmentType,
      is_active: isActive,
      benefits,
      has_insurance: hasInsurance,
      has_401k: has401k,
      has_pto: hasPto,
      pto_reminder_date: hasPto ? (ptoReminderDate || null) : null,
      job_level_id: jobLevelId || null,
      campus_id: campusId || null,
      insurance_sheet_doc: insuranceDoc,
    };

    const { error } = await supabase.from("hr_employees").update(payload).eq("id", editingId);
    if (error) {
      setError(error.message);
      return;
    }

    await loadAll();
    await loadEmployeeDetails(editingId);
  }

  async function resetPtoSentStatus() {
    if (!editingId) return;

    const ok = confirm("Reset PTO reminder sent status? This will allow the reminder to send again (when due).");
    if (!ok) return;

    setError(null);
    const { error } = await supabase.from("hr_employees").update({ pto_reminder_sent_at: null }).eq("id", editingId);
    if (error) {
      setError(error.message);
      return;
    }

    setPtoReminderSentAt(null);
    await loadAll();
  }

  // ----- Manage Job Levels / Campuses (add + delete) -----
  async function addJobLevel() {
    setError(null);
    const name = newJobLevelName.trim();
    if (!name) return;

    const { error } = await supabase.from("hr_job_levels").insert({ name });
    if (error) {
      setError(error.message);
      return;
    }

    setNewJobLevelName("");
    await loadAll();
  }

  async function deleteJobLevel(id: string) {
    const ok = confirm("Delete this job level? (If employees still reference it, deletion may fail.)");
    if (!ok) return;

    setError(null);
    const { error } = await supabase.from("hr_job_levels").delete().eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    await loadAll();
    if (jobLevelId === id) setJobLevelId("");
  }

  async function addCampus() {
    setError(null);
    const name = newCampusName.trim();
    if (!name) return;

    const { error } = await supabase.from("hr_campuses").insert({ name });
    if (error) {
      setError(error.message);
      return;
    }

    setNewCampusName("");
    await loadAll();
  }

  async function deleteCampus(id: string) {
    const ok = confirm("Delete this campus? (If employees still reference it, deletion may fail.)");
    if (!ok) return;

    setError(null);
    const { error } = await supabase.from("hr_campuses").delete().eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    await loadAll();
    if (campusId === id) setCampusId("");
  }

  // ----- Manage Event Types -----
  async function addEventType() {
    setError(null);
    const name = newEventTypeName.trim();
    if (!name) return;

    const { error } = await supabase.from("hr_event_types").insert({ name });
    if (error) {
      setError(error.message);
      return;
    }

    setNewEventTypeName("");
    await loadAll();
  }

  async function deleteEventType(id: string) {
    const ok = confirm("Delete this event type? (If events still use it, deletion will fail.)");
    if (!ok) return;

    setError(null);
    const { error } = await supabase.from("hr_event_types").delete().eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }

    await loadAll();
    if (newEventTypeId === id) setNewEventTypeId("");
  }

  // ----- Milestones & Dates (events + reminders) -----
  async function addMilestoneEvent() {
    if (!editingId) return;
    setError(null);

    if (!newEventTypeId) {
      setError("Choose an event type.");
      return;
    }
    if (!newEventDate) {
      setError("Choose an event date.");
      return;
    }

    const { data: ev, error: evErr } = await supabase
      .from("hr_employee_events")
      .insert({
        employee_id: editingId,
        event_type_id: newEventTypeId,
        event_date: newEventDate,
        notes: newEventNotes.trim() || null,
      })
      .select("id")
      .single();

    if (evErr) {
      setError(evErr.message);
      return;
    }

    const eventId = ev?.id as string | undefined;

    if (eventId && newEventReminderOffsets.length > 0) {
      const rows = newEventReminderOffsets.map((days_before) => ({
        employee_event_id: eventId,
        days_before,
      }));

      const { error: rErr } = await supabase.from("hr_employee_event_reminders").insert(rows);
      if (rErr) {
        setError(rErr.message);
      }
    }

    setNewEventTypeId("");
    setNewEventDate("");
    setNewEventNotes("");
    setNewReminderDays("");
    setNewEventReminderOffsets([]);

    await loadEmployeeDetails(editingId);
  }

  async function deleteMilestoneEvent(eventId: string) {
    const ok = confirm("Delete this milestone/event? (Its reminders will be deleted too.)");
    if (!ok) return;

    setError(null);
    const { error } = await supabase.from("hr_employee_events").delete().eq("id", eventId);
    if (error) {
      setError(error.message);
      return;
    }
    if (editingId) await loadEmployeeDetails(editingId);
  }

  async function resetMilestoneReminderSent(reminderId: string) {
    const ok = confirm("Reset this reminder sent status?");
    if (!ok) return;

    setError(null);
    const { error } = await supabase.from("hr_employee_event_reminders").update({ sent_at: null }).eq("id", reminderId);
    if (error) {
      setError(error.message);
      return;
    }
    if (editingId) await loadEmployeeDetails(editingId);
  }

  return (
    <div style={{ paddingTop: 8 }}>
      <div className="row-between" style={{ gap: 12, alignItems: "flex-start" }}>
        <div>
          <h1 style={{ margin: "8px 0 6px 0" }}>Employees</h1>
          <p className="subtle" style={{ marginTop: 0 }}>
            View, create, and edit employees for HR (admin-only).
          </p>
        </div>

        <div className="row" style={{ gap: 10 }}>
          <button className="btn" onClick={() => void loadAll()} disabled={loading}>
            {loading ? "Loading..." : "Refresh"}
          </button>
          <button className="btn btn-primary" onClick={openCreate}>
            + Add Employee
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
          Existing Employees ({employees.length})
        </div>

        {loading ? (
          <div style={{ padding: 14 }} className="subtle">
            Loading…
          </div>
        ) : employees.length === 0 ? (
          <div style={{ padding: 14 }} className="subtle">
            No employees yet. Click “Add Employee”.
          </div>
        ) : (
          <div style={{ width: "100%", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", background: "rgba(0,0,0,0.02)" }}>
                  <th style={{ padding: 10, borderBottom: "1px solid #e5e7eb" }}>Name</th>
                  <th style={{ padding: 10, borderBottom: "1px solid #e5e7eb" }}>Preferred</th>
                  <th style={{ padding: 10, borderBottom: "1px solid #e5e7eb" }}>Job Level</th>
                  <th style={{ padding: 10, borderBottom: "1px solid #e5e7eb" }}>Campus</th>
                  <th style={{ padding: 10, borderBottom: "1px solid #e5e7eb" }}>Rate</th>
                  <th style={{ padding: 10, borderBottom: "1px solid #e5e7eb" }}>FT/PT</th>
                  <th style={{ padding: 10, borderBottom: "1px solid #e5e7eb" }}>Active</th>
                  <th style={{ padding: 10, borderBottom: "1px solid #e5e7eb" }}>Updated</th>
                  <th style={{ padding: 10, borderBottom: "1px solid #e5e7eb" }} />
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => {
                  const legal = [e.legal_first_name, e.legal_middle_name, e.legal_last_name].filter(Boolean).join(" ");
                  const preferred = e.nicknames?.[0] || "";
                  const rateLabel =
                    e.rate_type === "salary"
                      ? `$${Number(e.rate).toLocaleString()}/yr`
                      : `$${Number(e.rate).toLocaleString()}/hr`;

                  return (
                    <tr key={e.id}>
                      <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6", fontWeight: 800 }}>{legal}</td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>
                        {preferred || <span className="subtle">—</span>}
                      </td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>
                        {e.job_level?.name || <span className="subtle">—</span>}
                      </td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>
                        {e.campus?.name || <span className="subtle">—</span>}
                      </td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>{rateLabel}</td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>
                        {e.employment_type === "full_time" ? "Full-time" : "Part-time"}
                      </td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>{e.is_active ? "Active" : "Inactive"}</td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>{new Date(e.updated_at).toLocaleString()}</td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>
                        <button className="btn" onClick={() => void openEdit(e)} style={{ padding: "6px 10px" }}>
                          Edit
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

      {/* ===== CREATE/EDIT EMPLOYEE MODAL ===== */}
      {showForm && (
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
            zIndex: 200,
            overflowY: "auto",
          }}
          onClick={closeForm}
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
              <div style={{ fontWeight: 900 }}>{isEditing ? "Edit Employee" : "Create Employee"}</div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" onClick={closeForm}>
                  Close
                </button>
                <button
                  className="btn btn-primary"
                  disabled={!canSubmit}
                  onClick={() => void (isEditing ? updateEmployee() : createEmployee())}
                >
                  {isEditing ? "Save Changes" : "Create"}
                </button>
              </div>
            </div>

            <div style={{ padding: 14, overflowY: "auto" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                {/* Legal Names */}
                <div style={{ gridColumn: "1 / -1", border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 10 }}>Legal Name</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                    <div>
                      <FieldLabel>Legal first name</FieldLabel>
                      <TextInput value={legalFirst} onChange={(e) => setLegalFirst(e.target.value)} />
                    </div>
                    <div>
                      <FieldLabel>Middle name (optional)</FieldLabel>
                      <TextInput value={legalMiddle} onChange={(e) => setLegalMiddle(e.target.value)} />
                    </div>
                    <div>
                      <FieldLabel>Legal last name</FieldLabel>
                      <TextInput value={legalLast} onChange={(e) => setLegalLast(e.target.value)} />
                    </div>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <FieldLabel>Nicknames / preferred names</FieldLabel>
                    <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                      <TextInput
                        value={nicknamesInput}
                        onChange={(e) => setNicknamesInput(e.target.value)}
                        placeholder='Type a name and press "Add"'
                        style={{ flex: 1, minWidth: 260 }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addNickname();
                          }
                        }}
                      />
                      <button className="btn" type="button" onClick={addNickname}>
                        Add
                      </button>
                    </div>

                    {nicknames.length > 0 && (
                      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {nicknames.map((n) => (
                          <Chip key={n} text={n} onRemove={() => setNicknames(nicknames.filter((x) => x !== n))} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Role & Location */}
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 10 }}>Role & Location</div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "end" }}>
                    <div>
                      <FieldLabel>Job level</FieldLabel>
                      <Select value={jobLevelId} onChange={(e) => setJobLevelId(e.target.value)}>
                        <option value="">— Select —</option>
                        {jobLevels.map((j) => (
                          <option key={j.id} value={j.id}>
                            {j.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <button className="btn" type="button" title="Manage job levels" onClick={() => setShowManageJobLevels(true)}>
                      +
                    </button>
                  </div>

                  <div style={{ height: 12 }} />

                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "end" }}>
                    <div>
                      <FieldLabel>Campus</FieldLabel>
                      <Select value={campusId} onChange={(e) => setCampusId(e.target.value)}>
                        <option value="">— Select —</option>
                        {campuses.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <button className="btn" type="button" title="Manage campuses" onClick={() => setShowManageCampuses(true)}>
                      +
                    </button>
                  </div>

                  <div style={{ height: 12 }} />

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <FieldLabel>Full-time / Part-time</FieldLabel>
                      <Select value={employmentType} onChange={(e) => setEmploymentType(e.target.value as any)}>
                        <option value="part_time">Part-time</option>
                        <option value="full_time">Full-time</option>
                      </Select>
                    </div>
                    <div>
                      <FieldLabel>Active</FieldLabel>
                      <Select value={isActive ? "active" : "inactive"} onChange={(e) => setIsActive(e.target.value === "active")}>
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                      </Select>
                    </div>
                  </div>
                </div>

                {/* Pay */}
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 10 }}>Pay</div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <FieldLabel>Rate type</FieldLabel>
                      <Select value={rateType} onChange={(e) => setRateType(e.target.value as any)}>
                        <option value="hourly">Hourly</option>
                        <option value="salary">Salary</option>
                      </Select>
                    </div>
                    <div>
                      <FieldLabel>{rateType === "salary" ? "Annual salary" : "Hourly rate"}</FieldLabel>
                      <TextInput inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
                    </div>
                  </div>
                </div>

                {/* Benefits */}
                <div style={{ gridColumn: "1 / -1", border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 10 }}>Benefits</div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                    <div>
                      <FieldLabel>Insurance</FieldLabel>
                      <Select value={hasInsurance ? "yes" : "no"} onChange={(e) => setHasInsurance(e.target.value === "yes")}>
                        <option value="no">No</option>
                        <option value="yes">Yes</option>
                      </Select>
                    </div>

                    <div>
                      <FieldLabel>401k</FieldLabel>
                      <Select value={has401k ? "yes" : "no"} onChange={(e) => setHas401k(e.target.value === "yes")}>
                        <option value="no">No</option>
                        <option value="yes">Yes</option>
                      </Select>
                    </div>

                    <div>
                      <FieldLabel>PTO</FieldLabel>
                      <Select value={hasPto ? "yes" : "no"} onChange={(e) => setHasPto(e.target.value === "yes")}>
                        <option value="no">No</option>
                        <option value="yes">Yes</option>
                      </Select>
                    </div>
                  </div>

                  <div style={{ height: 12 }} />

                  <FieldLabel>Current benefits receiving (free-form list)</FieldLabel>
                  <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                    <TextInput
                      value={benefitInput}
                      onChange={(e) => setBenefitInput(e.target.value)}
                      placeholder='Add a benefit item (e.g., "Paid holidays")'
                      style={{ flex: 1, minWidth: 260 }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addBenefit();
                        }
                      }}
                    />
                    <button className="btn" type="button" onClick={addBenefit}>
                      Add
                    </button>
                  </div>

                  {benefits.length > 0 && (
                    <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {benefits.map((b) => (
                        <Chip key={b} text={b} onRemove={() => setBenefits(benefits.filter((x) => x !== b))} />
                      ))}
                    </div>
                  )}

                  {hasInsurance && (
                    <div style={{ marginTop: 14, padding: 12, borderRadius: 14, border: "1px dashed #e5e7eb" }}>
                      <div className="row-between" style={{ gap: 10, alignItems: "center" }}>
                        <div style={{ fontWeight: 900 }}>
                          Insurance calculations
                          <span className="subtle" style={{ marginLeft: 10, fontWeight: 500 }}>
                            (6×15){insuranceSheetDirty ? " • unsaved" : ""}
                          </span>
                        </div>

                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            setInsuranceSheetDoc(DEFAULT_INSURANCE_SHEET_DOC);
                            setInsuranceWorkbookKey(`ins:reset:${Date.now()}`);
                            setInsuranceSheetDirty(true);
                          }}
                        >
                          Reset
                        </button>
                      </div>

                      <div style={{ marginTop: 10, border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                        <div style={{ height: 360, width: "100%" }}>
                          <FortuneWorkbook
                            key={insuranceWorkbookKey}
                            ref={insuranceWorkbookRef as any}
                            data={insuranceSheetDoc}
                            onOp={handleInsuranceSheetOp}
                          />
                        </div>
                      </div>

                      <div className="subtle" style={{ marginTop: 8 }}>
                        This sheet is saved to the employee record when you click <strong>{isEditing ? "Save Changes" : "Create"}</strong>.
                      </div>
                    </div>
                  )}

                  {hasPto && (
                    <div style={{ marginTop: 14, padding: 12, borderRadius: 14, border: "1px dashed #e5e7eb" }}>
                      <div style={{ fontWeight: 900, marginBottom: 10 }}>PTO Reminder</div>

                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "end" }}>
                        <div>
                          <FieldLabel>PTO reminder date</FieldLabel>
                          <TextInput type="date" value={ptoReminderDate} onChange={(e) => setPtoReminderDate(e.target.value)} />
                          <div className="subtle" style={{ marginTop: 6 }}>When this date is due, the system emails the admin.</div>
                        </div>

                        <div>
                          <FieldLabel>Reminder sent at</FieldLabel>
                          <TextInput value={ptoReminderSentAt ? new Date(ptoReminderSentAt).toLocaleString() : "—"} readOnly />
                          {isEditing && (
                            <div className="row" style={{ gap: 8, marginTop: 8 }}>
                              <button className="btn" type="button" onClick={() => void resetPtoSentStatus()}>
                                Reset sent status
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* ===== Milestones & Dates ===== */}
                <div style={{ gridColumn: "1 / -1", border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 10 }}>Milestones & Dates</div>

                  {!isEditing ? (
                    <div className="subtle">Create the employee first, then you can add milestones and reminders.</div>
                  ) : (
                    <>
                      {/* Add new milestone */}
                      <div style={{ padding: 12, borderRadius: 14, border: "1px dashed #e5e7eb" }}>
                        <div style={{ fontWeight: 800, marginBottom: 10 }}>Add milestone/event</div>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "end" }}>
                          <div>
                            <FieldLabel>Event type</FieldLabel>
                            <Select value={newEventTypeId} onChange={(e) => setNewEventTypeId(e.target.value)}>
                              <option value="">— Select —</option>
                              {eventTypes.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}
                                </option>
                              ))}
                            </Select>
                          </div>

                          <button className="btn" type="button" title="Manage event types" onClick={() => setShowManageEventTypes(true)}>
                            +
                          </button>

                          <div>
                            <FieldLabel>Event date</FieldLabel>
                            <TextInput type="date" value={newEventDate} onChange={(e) => setNewEventDate(e.target.value)} />
                          </div>
                        </div>

                        <div style={{ height: 10 }} />

                        <div>
                          <FieldLabel>Notes (optional)</FieldLabel>
                          <TextInput value={newEventNotes} onChange={(e) => setNewEventNotes(e.target.value)} placeholder="Optional details…" />
                        </div>

                        <div style={{ height: 12 }} />

                        <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 12 }}>
                          <div style={{ fontWeight: 800, marginBottom: 8 }}>Reminders (email admin)</div>
                          <div className="subtle" style={{ marginBottom: 10 }}>
                            Add “days before” offsets (example: 15 means “remind me 15 days before the event date”).
                          </div>

                          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                            <TextInput
                              inputMode="numeric"
                              value={newReminderDays}
                              onChange={(e) => setNewReminderDays(e.target.value)}
                              placeholder="Days before (e.g., 15)"
                              style={{ width: 220 }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  addEventReminderOffset();
                                }
                              }}
                            />
                            <button className="btn" type="button" onClick={addEventReminderOffset}>
                              Add reminder
                            </button>
                          </div>

                          {newEventReminderOffsets.length > 0 && (
                            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {newEventReminderOffsets
                                .slice()
                                .sort((a, b) => b - a)
                                .map((d) => (
                                  <Chip
                                    key={d}
                                    text={`${d} days before`}
                                    onRemove={() => setNewEventReminderOffsets((prev) => prev.filter((x) => x !== d))}
                                  />
                                ))}
                            </div>
                          )}

                          <div className="row" style={{ gap: 10, marginTop: 12 }}>
                            <button className="btn btn-primary" type="button" onClick={() => void addMilestoneEvent()}>
                              Add milestone
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Existing milestones list */}
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontWeight: 800, marginBottom: 8 }}>Existing milestones ({empEvents.length})</div>

                        {empEvents.length === 0 ? (
                          <div className="subtle">No milestones yet.</div>
                        ) : (
                          <div style={{ display: "grid", gap: 10 }}>
                            {empEvents.map((ev) => {
                              const reminders = empEventRemindersByEventId[ev.id] ?? [];
                              return (
                                <div key={ev.id} style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
                                  <div className="row-between" style={{ gap: 12, alignItems: "flex-start" }}>
                                    <div>
                                      <div style={{ fontWeight: 900 }}>
                                        {ev.event_type?.name ?? "—"} • {formatYmd(ev.event_date)}
                                      </div>
                                      {ev.notes ? (
                                        <div className="subtle" style={{ marginTop: 4 }}>
                                          {ev.notes}
                                        </div>
                                      ) : (
                                        <div className="subtle" style={{ marginTop: 4 }}>
                                          —
                                        </div>
                                      )}
                                    </div>

                                    <button className="btn" type="button" onClick={() => void deleteMilestoneEvent(ev.id)} style={{ padding: "6px 10px" }}>
                                      Delete
                                    </button>
                                  </div>

                                  <div style={{ marginTop: 10, borderTop: "1px solid #f3f4f6", paddingTop: 10 }}>
                                    <div style={{ fontWeight: 800, marginBottom: 6 }}>Reminders</div>
                                    {reminders.length === 0 ? (
                                      <div className="subtle">No reminders configured.</div>
                                    ) : (
                                      <div style={{ display: "grid", gap: 6 }}>
                                        {reminders
                                          .slice()
                                          .sort((a, b) => b.days_before - a.days_before)
                                          .map((r) => (
                                            <div key={r.id} className="row-between" style={{ gap: 10 }}>
                                              <div className="subtle">
                                                {r.days_before} days before • sent_at:{" "}
                                                <strong>{r.sent_at ? new Date(r.sent_at).toLocaleString() : "—"}</strong>
                                              </div>
                                              <button className="btn" type="button" onClick={() => void resetMilestoneReminderSent(r.id)} style={{ padding: "6px 10px" }}>
                                                Reset sent
                                              </button>
                                            </div>
                                          ))}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>

                <div style={{ height: 4 }} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================
          MANAGE MODALS (add + list + delete)
         ========================= */}

      {/* Manage Job Levels */}
      {showManageJobLevels && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 220 }}
          onClick={() => setShowManageJobLevels(false)}
        >
          <div
            style={{ width: "min(620px, 100%)", background: "white", borderRadius: 16, border: "1px solid #e5e7eb", boxShadow: "0 20px 50px rgba(0,0,0,0.12)", overflow: "hidden" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row-between" style={{ padding: 12, borderBottom: "1px solid #e5e7eb" }}>
              <div style={{ fontWeight: 900 }}>Manage Job Levels</div>
              <button className="btn" onClick={() => setShowManageJobLevels(false)}>
                Close
              </button>
            </div>

            <div style={{ padding: 14 }}>
              <FieldLabel>Add new job level</FieldLabel>
              <div className="row" style={{ gap: 10 }}>
                <TextInput value={newJobLevelName} onChange={(e) => setNewJobLevelName(e.target.value)} placeholder="e.g., Lead Teacher" />
                <button className="btn btn-primary" onClick={() => void addJobLevel()}>
                  Add
                </button>
              </div>

              <div style={{ height: 14 }} />

              <div style={{ fontWeight: 800, marginBottom: 8 }}>Existing</div>
              {jobLevels.length === 0 ? (
                <div className="subtle">No job levels yet.</div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {jobLevels.map((j) => (
                    <div key={j.id} className="row-between" style={{ gap: 10, border: "1px solid #e5e7eb", borderRadius: 12, padding: 10 }}>
                      <div style={{ fontWeight: 700 }}>{j.name}</div>
                      <button className="btn" onClick={() => void deleteJobLevel(j.id)} style={{ padding: "6px 10px" }}>
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="subtle" style={{ marginTop: 10 }}>
                Note: if a job level is still referenced by employees, deletion may fail (foreign key).
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Manage Campuses */}
      {showManageCampuses && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 220 }}
          onClick={() => setShowManageCampuses(false)}
        >
          <div
            style={{ width: "min(620px, 100%)", background: "white", borderRadius: 16, border: "1px solid #e5e7eb", boxShadow: "0 20px 50px rgba(0,0,0,0.12)", overflow: "hidden" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row-between" style={{ padding: 12, borderBottom: "1px solid #e5e7eb" }}>
              <div style={{ fontWeight: 900 }}>Manage Campuses</div>
              <button className="btn" onClick={() => setShowManageCampuses(false)}>
                Close
              </button>
            </div>

            <div style={{ padding: 14 }}>
              <FieldLabel>Add new campus</FieldLabel>
              <div className="row" style={{ gap: 10 }}>
                <TextInput value={newCampusName} onChange={(e) => setNewCampusName(e.target.value)} placeholder="e.g., Torrance" />
                <button className="btn btn-primary" onClick={() => void addCampus()}>
                  Add
                </button>
              </div>

              <div style={{ height: 14 }} />

              <div style={{ fontWeight: 800, marginBottom: 8 }}>Existing</div>
              {campuses.length === 0 ? (
                <div className="subtle">No campuses yet.</div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {campuses.map((c) => (
                    <div key={c.id} className="row-between" style={{ gap: 10, border: "1px solid #e5e7eb", borderRadius: 12, padding: 10 }}>
                      <div style={{ fontWeight: 700 }}>{c.name}</div>
                      <button className="btn" onClick={() => void deleteCampus(c.id)} style={{ padding: "6px 10px" }}>
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="subtle" style={{ marginTop: 10 }}>
                Note: if a campus is still referenced by employees, deletion may fail (foreign key).
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Manage Event Types */}
      {showManageEventTypes && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 220 }}
          onClick={() => setShowManageEventTypes(false)}
        >
          <div
            style={{ width: "min(620px, 100%)", background: "white", borderRadius: 16, border: "1px solid #e5e7eb", boxShadow: "0 20px 50px rgba(0,0,0,0.12)", overflow: "hidden" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row-between" style={{ padding: 12, borderBottom: "1px solid #e5e7eb" }}>
              <div style={{ fontWeight: 900 }}>Manage Event Types</div>
              <button className="btn" onClick={() => setShowManageEventTypes(false)}>
                Close
              </button>
            </div>

            <div style={{ padding: 14 }}>
              <FieldLabel>Add new event type</FieldLabel>
              <div className="row" style={{ gap: 10 }}>
                <TextInput value={newEventTypeName} onChange={(e) => setNewEventTypeName(e.target.value)} placeholder="e.g., Probation / Visa / Sick" />
                <button className="btn btn-primary" onClick={() => void addEventType()}>
                  Add
                </button>
              </div>

              <div style={{ height: 14 }} />

              <div style={{ fontWeight: 800, marginBottom: 8 }}>Existing</div>
              {eventTypes.length === 0 ? (
                <div className="subtle">No event types yet.</div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {eventTypes.map((t) => (
                    <div key={t.id} className="row-between" style={{ gap: 10, border: "1px solid #e5e7eb", borderRadius: 12, padding: 10 }}>
                      <div style={{ fontWeight: 700 }}>{t.name}</div>
                      <button className="btn" onClick={() => void deleteEventType(t.id)} style={{ padding: "6px 10px" }}>
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="subtle" style={{ marginTop: 10 }}>
                Note: if events already use a type, deletion will fail (foreign key).
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
