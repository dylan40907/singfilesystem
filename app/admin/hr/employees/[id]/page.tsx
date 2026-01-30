"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type AttendanceTypeRow = {
  id: string;
  name: string;
  points_deduct: number;
};

type PtoScheduleRow = {
  id: string;
  employee_id: string;
  begin_date: string | null;
  end_date: string | null;
  hours_per_annum: number | null;
  created_at?: string | null;
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

  job_level_id: string | null;
  campus_id: string | null;

  insurance_sheet_doc: any[] | null;

  pto_meta: any;

  attendance_points: number;

  job_level?: JobLevelRow | null;
  campus?: CampusRow | null;

  created_at: string;
  updated_at: string;
};

/* =========================
   HR Meetings (employee-scoped)
========================= */

async function readJsonSafely(res: Response) {
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (!ct.includes("application/json")) return { __nonJson: true, text };
  try {
    return JSON.parse(text);
  } catch {
    return { __nonJson: true, text };
  }
}

async function getFreshAccessToken() {
  // Always try session first
  const { data: s1 } = await supabase.auth.getSession();
  let token = s1.session?.access_token ?? null;

  // If missing or close to expiring, force refresh
  const expiresAt = s1.session?.expires_at ? Number(s1.session.expires_at) * 1000 : 0;
  const msLeft = expiresAt ? expiresAt - Date.now() : 0;

  if (!token || msLeft < 60_000) {
    const { data: s2, error: rErr } = await supabase.auth.refreshSession();
    if (rErr) throw new Error("Invalid session token");
    token = s2.session?.access_token ?? null;
  }

  if (!token) throw new Error("Invalid session token");
  return token;
}

async function authedJsonPost(path: string, payload: any) {
  // Attempt 1
  let token = await getFreshAccessToken();

  const doReq = async (t: string) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify(payload),
    });
    const body = await readJsonSafely(res);
    return { res, body };
  };

  let { res, body } = await doReq(token);

  // If backend says token invalid/expired, refresh once and retry
  if (!res.ok) {
    const msg =
      (body as any)?.error ||
      ((body as any)?.__nonJson ? (body as any).text.slice(0, 300) : `Request failed (${res.status})`);

    const looksLikeAuth =
      res.status === 401 ||
      res.status === 403 ||
      /invalid session token/i.test(msg) ||
      /jwt/i.test(msg) ||
      /token/i.test(msg);

    if (looksLikeAuth) {
      const { data: s2, error: rErr } = await supabase.auth.refreshSession();
      if (rErr || !s2.session?.access_token) throw new Error("Invalid session token");

      ({ res, body } = await doReq(s2.session.access_token));
    }
  }

  if (!res.ok) {
    const msg =
      (body as any)?.error ||
      ((body as any)?.__nonJson ? (body as any).text.slice(0, 300) : `Request failed (${res.status})`);
    throw new Error(msg);
  }

  if ((body as any)?.__nonJson) throw new Error("Server returned non-JSON response.");
  return body as any;
}


type MeetingType = {
  id: string;
  name: string;
  // Schema is now just (id, name, created_at). Keep created_at optional so older rows/queries don't break.
  created_at?: string;
};

type HrMeeting = {
  id: string;
  employee_id: string;
  meeting_type_id: string | null;
  meeting_at: string; // timestamptz
  notes: string;
  created_at: string;
  updated_at: string;
  type?: { id: string; name: string } | null; // joined alias
};

type HrMeetingAttendee = {
  id: string;
  meeting_id: string;
  attendee_name: string;
  attendee_employee_id: string | null;
  created_at: string;
};

type HrMeetingDocument = {
  id: string;
  meeting_id: string;
  name: string;
  object_key: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
};

type HrEmployeeDocument = {
  id: string;
  employee_id: string;
  name: string;
  object_key: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
};

type PreviewMode = "pdf" | "image" | "text" | "csv" | "office" | "video" | "audio" | "unknown";

type EmployeeLite = {
  id: string;
  legal_first_name: string;
  legal_middle_name: string | null;
  legal_last_name: string;
  nicknames: string[];
  is_active: boolean;
};

function formatEmployeeName(e: EmployeeLite) {
  // Prefer legal names (matches hr_employees schema). You can optionally extend to include nicknames.
  return `${e.legal_first_name} ${e.legal_last_name}`.trim();
}

function extOf(name: string) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}
function isOfficeExt(ext: string) {
  return ext === "docx" || ext === "pptx" || ext === "xlsx";
}
function isPdfExt(ext: string) {
  return ext === "pdf";
}
function isImageExt(ext: string) {
  return ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp" || ext === "svg";
}
function isTextExt(ext: string) {
  return ext === "txt" || ext === "md" || ext === "csv" || ext === "json" || ext === "log";
}
function isVideoExt(ext: string) {
  return ext === "mp4" || ext === "mov" || ext === "webm" || ext === "m4v" || ext === "avi" || ext === "mkv" || ext === "mpeg" || ext === "mpg";
}
function isAudioExt(ext: string) {
  return ext === "mp3" || ext === "wav" || ext === "m4a" || ext === "aac" || ext === "ogg" || ext === "flac";
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }

    if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i += 1;
      continue;
    }

    if (c === "\r") {
      i += 1;
      if (text[i] === "\n") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        i += 1;
      }
      continue;
    }

    field += c;
    i += 1;
  }

  row.push(field);
  rows.push(row);

  const last = rows[rows.length - 1];
  if (text.endsWith("\n") && last.length === 1 && last[0] === "") rows.pop();

  return rows;
}

/**
 * PDF canvas preview.
 */
function PdfCanvasPreview({ url, maxPages = 50 }: { url: string; maxPages?: number }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [err, setErr] = useState<string>("");
  const [pdfjs, setPdfjs] = useState<any>(null);
  const [vp, setVp] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const update = () => {
      const w = Math.floor(el.clientWidth);
      const h = Math.floor(el.clientHeight);
      setVp((cur) => (cur.w === w && cur.h === h ? cur : { w, h }));
    };

    update();

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => update());
      ro.observe(el);
      return () => ro.disconnect();
    }

    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        let mod: any = null;

        try {
          // @ts-ignore
          mod = await import("pdfjs-dist/build/pdf");
        } catch {}

        if (!mod) {
          try {
            // @ts-ignore
            mod = await import("pdfjs-dist/build/pdf.mjs");
          } catch {}
        }

        if (!mod) {
          try {
            // @ts-ignore
            mod = await import("pdfjs-dist/legacy/build/pdf");
          } catch {}
        }

        if (!mod) throw new Error("PDF.js failed to load (pdfjs-dist).");

        try {
          mod.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        } catch {
          try {
            mod.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
          } catch {}
        }

        if (!cancelled) setPdfjs(mod);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message ?? "Failed to load PDF renderer");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!pdfjs) return;
      if (!vp.w || !vp.h) return;

      setErr("");

      const container = containerRef.current;
      if (!container) return;

      container.innerHTML = "";

      try {
        const loadingTask = pdfjs.getDocument({ url });
        const pdf = await loadingTask.promise;

        const pagesToRender = Math.min(pdf.numPages, maxPages);

        const OUTER_PAD = 16;
        const INNER_PAD = 12;
        const availW = Math.max(1, vp.w - OUTER_PAD * 2 - INNER_PAD * 2);
        const availH = Math.max(1, vp.h - OUTER_PAD * 2 - INNER_PAD * 2);

        const rawDpr = Math.max(1, (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1);
        const DPR_CAP = 3;
        const QUALITY_BOOST = 1.25;
        const dpr = Math.min(rawDpr, DPR_CAP);

        for (let pageNum = 1; pageNum <= pagesToRender; pageNum++) {
          if (cancelled) return;

          const page = await pdf.getPage(pageNum);
          const base = page.getViewport({ scale: 1 });

          const fitScale = Math.min(availW / base.width, availH / base.height);

          const cssViewport = page.getViewport({ scale: fitScale });
          const renderViewport = page.getViewport({ scale: fitScale * dpr * QUALITY_BOOST });

          const pageCard = document.createElement("div");
          pageCard.style.display = "flex";
          pageCard.style.alignItems = "center";
          pageCard.style.justifyContent = "center";
          pageCard.style.padding = `${INNER_PAD}px`;
          pageCard.style.minHeight = `${vp.h - OUTER_PAD * 2}px`;
          pageCard.style.boxSizing = "border-box";

          const stage = document.createElement("div");
          stage.style.position = "relative";
          stage.style.width = `${Math.floor(cssViewport.width)}px`;
          stage.style.height = `${Math.floor(cssViewport.height)}px`;
          stage.style.borderRadius = "12px";
          stage.style.boxShadow = "inset 0 0 0 1px rgba(0,0,0,0.10)";
          stage.style.background = "white";
          stage.style.overflow = "hidden";

          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d", { alpha: false });
          if (!ctx) continue;

          canvas.width = Math.max(1, Math.floor(renderViewport.width));
          canvas.height = Math.max(1, Math.floor(renderViewport.height));
          canvas.style.width = `${Math.floor(cssViewport.width)}px`;
          canvas.style.height = `${Math.floor(cssViewport.height)}px`;
          canvas.style.display = "block";
          canvas.style.background = "white";

          stage.appendChild(canvas);
          pageCard.appendChild(stage);
          container.appendChild(pageCard);

          const renderTask = page.render({
            canvas,
            canvasContext: ctx,
            viewport: renderViewport,
          } as any);

          await renderTask.promise;
        }

        if (pdf.numPages > pagesToRender) {
          const note = document.createElement("div");
          note.style.padding = "12px 16px 18px";
          note.style.color = "#666";
          note.style.fontWeight = "700";
          note.textContent = `Preview truncated: showing ${pagesToRender} of ${pdf.numPages} pages.`;
          container.appendChild(note);
        }
      } catch (e: any) {
        setErr(e?.message ?? "Failed to render PDF");
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [url, maxPages, pdfjs, vp.w, vp.h]);

  return (
    <div
      ref={scrollRef}
      style={{
        height: "100%",
        overflow: "auto",
        background: "#f6f6f6",
        padding: 16,
        boxSizing: "border-box",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {err ? (
        <div style={{ padding: 14, background: "white", color: "#b00020", fontWeight: 800 }}>PDF preview failed: {err}</div>
      ) : (
        <div ref={containerRef} />
      )}
    </div>
  );
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
        border: "1px solid #e5e7eb",
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

/* =========================
   Shared UI helpers
========================= */

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

function asSingle<T>(v: any): T | null {
  if (!v) return null;
  if (Array.isArray(v)) return (v[0] ?? null) as T | null;
  return v as T;
}

function deepJsonClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

function normalizeSheetDoc(doc: any, fallback: any[]) {
  if (!doc) return fallback;
  if (Array.isArray(doc)) return doc;
  if (typeof doc === "object") return [doc];
  return fallback;
}

function isEmptyInsuranceDoc(doc: any): boolean {
  if (!doc) return true;
  const arr = Array.isArray(doc) ? doc : typeof doc === "object" ? [doc] : [];
  if (arr.length === 0) return true;

  for (const sh of arr) {
    const cd = (sh as any)?.celldata;
    const hasCells = Array.isArray(cd) && cd.length > 0;
    if (hasCells) return false;

    const grid = (sh as any)?.data;
    if (
      Array.isArray(grid) &&
      grid.some((row: any[]) => Array.isArray(row) && row.some((c) => c != null && String((c?.v ?? c) ?? "") !== ""))
    ) {
      return false;
    }
  }

  return true;
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

    job_level_id: raw.job_level_id ?? null,
    campus_id: raw.campus_id ?? null,

    insurance_sheet_doc: raw.insurance_sheet_doc ?? null,


    pto_meta: raw.pto_meta ?? {},
    attendance_points: Number(raw.attendance_points ?? 3),

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

// Green if 3, Yellow if 1-2, Red if anything lower
function scoreColor(points: number) {
  if (points <= 0) return "#dc2626"; // red
  if (points <= 2) return "#ca8a04"; // yellow
  return "#16a34a"; // green
}

async function fetchEmployeeData(employeeId: string) {
  const { data, error } = await supabase
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
      job_level_id,
      campus_id,
      insurance_sheet_doc,
      pto_meta,
      attendance_points,
      created_at,
      updated_at,
      job_level:hr_job_levels!hr_employees_job_level_id_fkey(id,name),
      campus:hr_campuses!hr_employees_campus_id_fkey(id,name)
    `
    )
    .eq("id", employeeId)
    .single();

  if (error) throw error;
  return data;
}

type ReviewFormType = "monthly" | "annual";

type HrReviewForm = {
  id: string;
  form_type: ReviewFormType;
  title: string;
  scale_max: number;
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
  notes: string;
  attendance_points_snapshot: number | null;
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

function clampScore(n: any, scaleMax: number) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(1, Math.min(scaleMax, Math.trunc(v)));
}

function round1dp(n: number) {
  return Math.round(n * 10) / 10;
}

function monthName(m: number) {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return names[m - 1] ?? `M${m}`;
}

function formatReviewLabel(r: HrReview) {
  if (r.form_type === "annual") return `Annual ${r.period_year}`;
  const mm = r.period_month ?? 1;
  return `Monthly ${monthName(mm)} ${r.period_year}`;
}

function formatOneDecimal(n: number) {
  const r = Math.round(n * 10) / 10;
  const s = r.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function recommendedIncreasePercent(total: number) {
  if (total >= 8) return 4;
  if (total >= 7) return 3;
  if (total >= 6) return 2;
  return 0;
}


function reviewMostRecentAt(r: HrReview) {
  const t = r.updated_at || r.created_at;
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

function EmployeePerformanceReviewsTab({
  employeeId,
  attendancePoints,
}: {
  employeeId: string;
  /** Snapshot source for new annual reviews. We do NOT overwrite existing snapshots. */
  attendancePoints: number | null;
}) {
  const now = useMemo(() => new Date(), []);
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const [status, setStatus] = useState<string>("");

  // Toggle display type (default monthly)
  const [showAnnual, setShowAnnual] = useState<boolean>(false);

  // Forms + questions (read-only here)
  const [forms, setForms] = useState<HrReviewForm[]>([]);
  const [questions, setQuestions] = useState<ReviewQuestion[]>([]);

  // ---- Question editor modal (edit annual/monthly question bank)
  type EditQuestion = { id: string; question_text: string; sort_order: number };

  const [editOpen, setEditOpen] = useState(false);
  const [editFormType, setEditFormType] = useState<ReviewFormType>("annual");
  const [editQuestions, setEditQuestions] = useState<EditQuestion[]>([]);
  const editRef = useRef<HTMLDivElement | null>(null);

  // Existing reviews for this employee
  const [reviews, setReviews] = useState<HrReview[]>([]);
  const [reviewAverages, setReviewAverages] = useState<Record<string, number>>({});
  const [reviewTotalPoints, setReviewTotalPoints] = useState<Record<string, number>>({});
  const [reviewAnswerCounts, setReviewAnswerCounts] = useState<Record<string, number>>({});


  // Modal state
  const [open, setOpen] = useState(false);
  const [formType, setFormType] = useState<ReviewFormType>("monthly");
  const [year, setYear] = useState<number>(currentYear);
  const [month, setMonth] = useState<number>(currentMonth);

  const [reviewId, setReviewId] = useState<string>("");
  const [values, setValues] = useState<Record<string, number>>({});
  const [reviewNotes, setReviewNotes] = useState<string>("");
  const modalRef = useRef<HTMLDivElement | null>(null);

  const formsByType = useMemo(() => {
    const m = new Map<ReviewFormType, HrReviewForm>();
    for (const f of forms) m.set(f.form_type, f);
    return m;
  }, [forms]);

  const questionsByType = useMemo(() => {
    const annualId = formsByType.get("annual")?.id ?? "";
    const monthlyId = formsByType.get("monthly")?.id ?? "";

    const annual = (questions ?? []).filter((q) => q.form_id === annualId && q.is_active !== false);
    const monthly = (questions ?? []).filter((q) => q.form_id === monthlyId && q.is_active !== false);

    const sortFn = (a: ReviewQuestion, b: ReviewQuestion) =>
      (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
      (a.question_text ?? "").localeCompare(b.question_text ?? "");

    return {
      annual: annual.slice().sort(sortFn),
      monthly: monthly.slice().sort(sortFn),
    };
  }, [questions, formsByType]);


  function makeLocalId() {
    try {
      // @ts-ignore
      return (globalThis.crypto?.randomUUID?.() as string) || `${Date.now()}-${Math.random()}`;
    } catch {
      return `${Date.now()}-${Math.random()}`;
    }
  }

  // ----------------------------
  // Question editor helpers
  // ----------------------------
  function openEditQuestions(which: ReviewFormType) {
    const form = formsByType.get(which);
    if (!form) {
      setStatus("Missing hr_review_forms rows. Create the annual/monthly forms first.");
      return;
    }

    const list: EditQuestion[] = (which === "annual" ? questionsByType.annual : questionsByType.monthly)
      .slice()
      .map((q, idx) => ({
        id: q.id,
        question_text: q.question_text ?? "",
        sort_order: Number.isFinite(Number(q.sort_order)) ? Number(q.sort_order) : idx,
      }));

    if (list.length === 0) {
      if (which === "annual") {
        list.push({ id: `new:${makeLocalId()}`, question_text: "Quality of work", sort_order: 0 });
        list.push({ id: `new:${makeLocalId()}`, question_text: "Communication", sort_order: 1 });
        list.push({ id: `new:${makeLocalId()}`, question_text: "Reliability", sort_order: 2 });
      } else {
        list.push({ id: `new:${makeLocalId()}`, question_text: "Preparedness", sort_order: 0 });
        list.push({ id: `new:${makeLocalId()}`, question_text: "Classroom management", sort_order: 1 });
        list.push({ id: `new:${makeLocalId()}`, question_text: "Team collaboration", sort_order: 2 });
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
      next.push({ id: `new:${makeLocalId()}`, question_text: "", sort_order: next.length });
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
        setStatus("Missing hr_review_forms rows. Create the annual/monthly forms first.");
        return;
      }

      const cleaned = editQuestions
        .map((q, i) => ({ ...q, sort_order: i, question_text: (q.question_text ?? "").trim() }))
        .filter((q) => q.question_text.length > 0);

      if (cleaned.length === 0) {
        setStatus("Add at least 1 question.");
        return;
      }

      const currentIds = new Set(
        (editFormType === "annual" ? questionsByType.annual : questionsByType.monthly).map((q) => q.id)
      );
      const desiredExistingIds = new Set(cleaned.filter((q) => !q.id.startsWith("new:")).map((q) => q.id));
      const toDelete = Array.from(currentIds).filter((id) => !desiredExistingIds.has(id));

      if (toDelete.length > 0) {
        const ok = confirm(
          `Delete ${toDelete.length} question(s) from ${editFormType}? This will also delete any saved answers for those questions.`
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
          .update({ question_text: q.question_text, sort_order: q.sort_order, is_active: true })
          .eq("id", q.id);
        if (error) throw error;
      }

      closeEditQuestions();
      await loadMeta();
      setStatus("✅ Saved.");
      setTimeout(() => setStatus(""), 900);
    } catch (e: any) {
      setStatus("Save error: " + (e?.message ?? "unknown"));
    }
  }

  const activeQuestions = useMemo(() => {
    return formType === "annual" ? questionsByType.annual : questionsByType.monthly;
  }, [formType, questionsByType]);

  const scaleMax = useMemo(() => {
    return formsByType.get(formType)?.scale_max ?? (formType === "monthly" ? 3 : 5);
  }, [formsByType, formType]);

  const filteredReviews = useMemo(() => {
    const ft: ReviewFormType = showAnnual ? "annual" : "monthly";
    return (reviews ?? [])
      .filter((r) => r.form_type === ft)
      .slice()
      .sort((a, b) => reviewMostRecentAt(b) - reviewMostRecentAt(a));
  }, [reviews, showAnnual]);

  async function loadMeta() {
    const [formRes, qRes] = await Promise.all([
      supabase.from("hr_review_forms").select("id, form_type, title, scale_max, is_active").eq("is_active", true),
      supabase
        .from("hr_review_questions")
        .select("id, form_id, question_text, sort_order, is_active, created_at, updated_at")
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true }),
    ]);

    if (formRes.error) throw formRes.error;
    if (qRes.error) throw qRes.error;

    setForms((formRes.data ?? []) as HrReviewForm[]);
    setQuestions((qRes.data ?? []) as ReviewQuestion[]);
  }

  async function loadEmployeeReviews() {
    const res = await supabase
      .from("hr_reviews")
      .select("id, employee_id, form_type, period_year, period_month, notes, attendance_points_snapshot, created_at, updated_at")
      .eq("employee_id", employeeId);

    if (res.error) throw res.error;
    const rows = (res.data ?? []) as HrReview[];
    setReviews(rows);

    if (!rows.length) {
      setReviewAverages({});
      setReviewTotalPoints({});
      setReviewAnswerCounts({});
      return;
    }

    const ids = rows.map((r) => r.id);

    // hr_review_answers uses the column name `score`.
    const ansRes = await supabase.from("hr_review_answers").select("review_id, score").in("review_id", ids);
    if (ansRes.error) throw ansRes.error;

    const sums: Record<string, { sum: number; count: number }> = {};
    for (const row of (ansRes.data ?? []) as Array<{ review_id: string; score: number | null }>) {
      const rid = String(row.review_id);
      const v = typeof row.score === "number" ? row.score : null;
      if (v === null) continue;
      const cur = sums[rid] ?? { sum: 0, count: 0 };
      cur.sum += v;
      cur.count += 1;
      sums[rid] = cur;
    }

    const avgsAnnual: Record<string, number> = {};
    const totalsMonthly: Record<string, number> = {};
    const countsByReview: Record<string, number> = {};

    for (const r of rows) {
      const cur = sums[r.id];
      const count = cur?.count ?? 0;
      countsByReview[r.id] = count;

      if (r.form_type === "annual") {
        avgsAnnual[r.id] = count ? cur!.sum / count : 0;
      } else {
        totalsMonthly[r.id] = cur?.sum ?? 0;
      }
    }

    setReviewAverages(avgsAnnual);
    setReviewTotalPoints(totalsMonthly);
    setReviewAnswerCounts(countsByReview);
  }

  function openCreate(which: ReviewFormType) {
    setFormType(which);
    setYear(currentYear);
    setMonth(currentMonth);
    setReviewId("");
    setValues({});
    setReviewNotes("");
    setOpen(true);
  }

  function openEdit(r: HrReview) {
    setFormType(r.form_type);
    setYear(Number(r.period_year ?? currentYear));
    setMonth(Number(r.period_month ?? currentMonth));
    setReviewId(r.id);
    setValues({});
    setReviewNotes(r.notes ?? "");
    setOpen(true);
  }

  function closeModal() {
    setOpen(false);
    setReviewId("");
    setValues({});
    setReviewNotes("");
  }

  async function loadReviewForSelection(empId: string, ft: ReviewFormType, y: number, m: number) {
    const qs = ft === "annual" ? questionsByType.annual : questionsByType.monthly;
    const max = formsByType.get(ft)?.scale_max ?? (ft === "monthly" ? 3 : 5);

    if (!qs || qs.length === 0) {
      setReviewId("");
      setValues({});
      setReviewNotes("");
      return;
    }

    const base = supabase
      .from("hr_reviews")
      .select("id, employee_id, form_type, period_year, period_month, notes, attendance_points_snapshot, created_at, updated_at")
      .eq("employee_id", empId)
      .eq("form_type", ft)
      .eq("period_year", y);

    const revRes = ft === "annual"
      ? await base.is("period_month", null).maybeSingle()
      : await base.eq("period_month", m).maybeSingle();

    if (revRes.error) throw revRes.error;

    const existing = (revRes.data ?? null) as HrReview | null;

    if (!existing?.id) {
      const init: Record<string, number> = {};
      const def = ft === "monthly" ? 2 : 3;
      for (const q of qs) init[q.id] = def;
      setReviewId("");
      setValues(init);
      setReviewNotes("");
      return;
    }

    const ansRes = await supabase
      .from("hr_review_answers")
      .select("review_id, question_id, score, created_at, updated_at")
      .eq("review_id", existing.id);

    if (ansRes.error) throw ansRes.error;

    const byQ = new Map<string, number>();
    for (const a of (ansRes.data ?? []) as HrReviewAnswer[]) byQ.set(a.question_id, a.score);

    const init: Record<string, number> = {};
    const def = ft === "monthly" ? 2 : 3;
    for (const q of qs) {
      const v = byQ.get(q.id);
      init[q.id] = typeof v === "number" && Number.isFinite(v) ? (clampScore(v, max) ?? def) : def;
    }

    setReviewId(existing.id);
    setValues(init);
    setReviewNotes(existing.notes ?? "");
  }

  async function ensureReviewRow(
    empId: string,
    ft: ReviewFormType,
    y: number,
    m: number | null,
    attendancePointsSnapshot: number | null,
  ) {
    // IMPORTANT: don't overwrite a previously-captured snapshot when editing.
    // If the row exists and snapshot is null, then (and only then) we backfill it.
    const base = supabase
      .from("hr_reviews")
      .select("id, attendance_points_snapshot")
      .eq("employee_id", empId)
      .eq("form_type", ft)
      .eq("period_year", y);

    const existingRes =
      ft === "annual"
        ? await base.is("period_month", null).maybeSingle()
        : await base.eq("period_month", m).maybeSingle();

    if (existingRes.error) throw existingRes.error;

    const existing = (existingRes.data ?? null) as { id: string; attendance_points_snapshot: number | null } | null;
    if (existing?.id) {
      if (existing.attendance_points_snapshot == null && attendancePointsSnapshot != null) {
        const { error: snapErr } = await supabase
          .from("hr_reviews")
          .update({ attendance_points_snapshot: attendancePointsSnapshot })
          .eq("id", existing.id);
        if (snapErr) throw snapErr;
      }
      return String(existing.id);
    }

    const payload: any = {
      employee_id: empId,
      form_type: ft,
      period_year: y,
      period_month: ft === "annual" ? null : m,
      attendance_points_snapshot: attendancePointsSnapshot,
    };

    const ins = await supabase
      .from("hr_reviews")
      .insert(payload)
      .select("id")
      .single();

    if (ins.error) throw ins.error;
    return String((ins.data as any)?.id ?? "");
  }

  async function saveReview() {
    if (!employeeId) return;

    const qs = activeQuestions;
    if (!qs || qs.length === 0) {
      setStatus("No questions for this review type yet.");
      return;
    }

    if (!Number.isFinite(Number(year)) || year < 2000 || year > 2100) {
      setStatus("Invalid year.");
      return;
    }
    if (formType === "monthly") {
      if (!Number.isFinite(Number(month)) || month < 1 || month > 12) {
        setStatus("Invalid month.");
        return;
      }
    }

    setStatus("Saving review...");
    try {
      const rid = await ensureReviewRow(employeeId, formType, year, month, attendancePoints ?? null);
      setReviewId(rid);

      // Persist freeform notes on the review itself.
      {
        const { error: notesErr } = await supabase.from("hr_reviews").update({ notes: reviewNotes }).eq("id", rid);
        if (notesErr) throw notesErr;
      }

      const max = scaleMax;
      const fallback = formType === "monthly" ? 2 : 3;

      const rows = qs.map((q) => ({
        review_id: rid,
        question_id: q.id,
        score: clampScore(values[q.id], max) ?? fallback,
      }));

      const { error } = await supabase
        .from("hr_review_answers")
        .upsert(rows, { onConflict: "review_id,question_id" });

      if (error) throw error;

      await loadEmployeeReviews();
      setStatus("✅ Saved.");
      setTimeout(() => setStatus(""), 900);
      closeModal();
    } catch (e: any) {
      setStatus("Save error: " + (e?.message ?? "unknown"));
    }
  }

  async function deleteReview(r: HrReview) {
    const ok = confirm("Delete this evaluation and all its answers?");
    if (!ok) return;

    setStatus("Deleting...");
    try {
      const { error } = await supabase.from("hr_reviews").delete().eq("id", r.id);
      if (error) throw error;

      await loadEmployeeReviews();
      setStatus("✅ Deleted.");
      setTimeout(() => setStatus(""), 900);
    } catch (e: any) {
      setStatus("Delete error: " + (e?.message ?? "unknown"));
    }
  }

  const computedAvg = useMemo(() => {
    const qs = activeQuestions;
    if (!qs || qs.length === 0) return null;

    const max = scaleMax;
    const valsArr = qs
      .map((q) => clampScore(values[q.id], max))
      .filter((v): v is number => typeof v === "number");

    if (valsArr.length === 0) return null;
    return round1dp(valsArr.reduce((s, x) => s + x, 0) / valsArr.length);
  }, [activeQuestions, values, scaleMax]);

  // Boot
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!employeeId) return;
      try {
        setStatus("Loading review data...");
        await loadMeta();
        await loadEmployeeReviews();
        if (!cancelled) setStatus("");
      } catch (e: any) {
        if (!cancelled) setStatus("Load error: " + (e?.message ?? "unknown"));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  // When modal open + selection changes, load existing or seed defaults
  useEffect(() => {
    if (!open && !editOpen) return;
    if (!employeeId) return;

    let cancelled = false;
    (async () => {
      try {
        setStatus("Loading evaluation...");
        await loadReviewForSelection(employeeId, formType, year, month);
        if (!cancelled) setStatus("");
      } catch (e: any) {
        if (!cancelled) setStatus("Load evaluation error: " + (e?.message ?? "unknown"));
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employeeId, formType, year, month, questionsByType, formsByType]);

  // ESC + outside click to close modal
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editOpen) closeEditQuestions();
        else if (open) closeModal();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (open) {
        const el = modalRef.current;
        if (el && !el.contains(e.target as any)) closeModal();
      }
      if (editOpen) {
        const el2 = editRef.current;
        if (el2 && !el2.contains(e.target as any)) closeEditQuestions();
      }
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editOpen]);

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
      <div className="row-between" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>Performance Reviews</div>
          <div className="subtle">
            Monthly uses <b>1–3</b>. Annual uses <b>1–5</b>.
          </div>
        </div>

        <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn btn-primary" type="button" onClick={() => openCreate("annual")}>
            + Create Annual Evaluation
          </button>
          <button className="btn btn-primary" type="button" onClick={() => openCreate("monthly")}>
            + Create Monthly Scorecard
          </button>

          <button className="btn" type="button" onClick={() => openEditQuestions("annual")}>
            Edit annual questions
          </button>
          <button className="btn" type="button" onClick={() => openEditQuestions("monthly")}>
            Edit monthly questions
          </button>

          {status ? <span className="subtle" style={{ fontWeight: 800 }}>{status}</span> : null}
        </div>
      </div>

      <div style={{ height: 12 }} />

      <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800 }}>
        <input
          type="checkbox"
          checked={showAnnual}
          onChange={(e) => setShowAnnual(e.target.checked)}
        />
        Show annual evaluations (unchecked = monthly)
      </label>

      <div style={{ height: 12 }} />

      <div style={{ fontWeight: 800, marginBottom: 8 }}>
        {showAnnual ? "Annual evaluations" : "Monthly evaluations"} ({filteredReviews.length})
      </div>

      {filteredReviews.length === 0 ? (
        <div className="subtle">(No evaluations yet.)</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filteredReviews.map((r) => (
            <div key={r.id} style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
              <div className="row-between" style={{ gap: 12, alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontWeight: 900 }}>{formatReviewLabel(r)}</div>

                  {/* Notes (freeform) */}
                  {r.notes ? (
                    <div style={{ marginTop: 4 }}>
                      {r.notes}
                    </div>
                  ) : null}

                  {/* Annual-only: Attendance + average -> recommended increase */}
                  {r.form_type === "annual" ? (() => {
                    const avg = round1dp(reviewAverages[r.id] ?? 0);
                    const att = typeof r.attendance_points_snapshot === "number" ? r.attendance_points_snapshot : null;
                    if (att === null) return null;
                    const total = round1dp(att + avg);
                    const pct = recommendedIncreasePercent(total);
                    return (
                      <div className="subtle" style={{ marginTop: 4 }}>
                        Attendance Score: <b>{att}</b> + Average: <b>{avg.toFixed(1)}</b> = <b>{total.toFixed(1)}</b>: <b>{pct}%</b> Increase
                      </div>
                    );
                  })() : null}

{/* Monthly-only: show Total Score as sum of 1–3 answers */}
{r.form_type === "monthly" ? (() => {
  const count = Number(reviewAnswerCounts[r.id] ?? 0) || 0;
  const total = Number(reviewTotalPoints[r.id] ?? 0) || 0;
  if (!count) return null;
  return (
    <div className="subtle" style={{ marginTop: 4 }}>
      Total Score: <b>{total}</b> <span className="subtle">({count} questions)</span>
    </div>
  );
})() : null}

                  <div className="subtle" style={{ marginTop: 4, fontSize: 12 }}>
                    Updated: {r.updated_at ? new Date(r.updated_at).toLocaleString() : "—"}
                    {r.created_at ? ` • Created: ${new Date(r.created_at).toLocaleString()}` : ""}
                  </div>
                </div>

                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <button className="btn" type="button" onClick={() => openEdit(r)} style={{ padding: "6px 10px" }}>
                    Edit
                  </button>
                  <button className="btn" type="button" onClick={() => void deleteReview(r)} style={{ padding: "6px 10px" }}>
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* =========================
          EDIT / CREATE MODAL
         ========================= */}
      {open ? (
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
          <div
            ref={modalRef}
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
                <div style={{ fontWeight: 950, fontSize: 16 }}>
                  {reviewId ? "Edit evaluation" : "Create evaluation"}
                </div>
                <div className="subtle">
                  Saved review id:{" "}
                  {reviewId ? <b>{reviewId}</b> : <span>(not created yet — will create on Save)</span>}
                </div>
              </div>

              <button className="btn" type="button" onClick={closeModal} title="Close (Esc)">
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
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>Type</div>
                  <select
                    className="select"
                    value={formType}
                    onChange={(e) => {
                      const ft = e.target.value as ReviewFormType;
                      setFormType(ft);
                      setValues({});
                      setReviewId("");
                    }}
                  >
                    <option value="monthly">Monthly (1–3)</option>
                    <option value="annual">Annual (1–5)</option>
                  </select>
                </div>

                <div style={{ width: 140 }}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>Year</div>
                  <input
                    className="input"
                    type="number"
                    value={year}
                    onChange={(e) => setYear(Number(e.target.value))}
                    min={2000}
                    max={2100}
                  />
                </div>

                {formType === "monthly" ? (
                  <div style={{ width: 200 }}>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>Month</div>
                    <select className="select" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
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
                  {formType === "annual" ? `Editing: Annual ${year}` : `Editing: Monthly ${monthName(month)} ${year}`}
                </div>
              </div>
            </div>

            {activeQuestions.length === 0 ? (
              <div className="subtle">
                No questions exist for this review type yet. (Configure them in the main Performance Reviews admin page.)
              </div>
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                {activeQuestions.map((q) => (
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
                        Score (1–{scaleMax})
                      </div>

                      <select
                        className="select"
                        value={String(values[q.id] ?? (formType === "monthly" ? 2 : 3))}
                        onChange={(e) => {
                          const v = clampScore(e.target.value, scaleMax) ?? (formType === "monthly" ? 2 : 3);
                          setValues((cur) => ({ ...cur, [q.id]: v }));
                        }}
                        style={{ width: 140 }}
                      >
                        {Array.from({ length: scaleMax }).map((_, i) => {
                          const v = i + 1;
                          return (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          );
                        })}
                      </select>

                      <div className="subtle">
                        {formType === "monthly" ? "1 = needs improvement · 3 = excellent" : "1 = needs improvement · 5 = excellent"}
                      </div>
                    </div>
                  </div>
                ))}
                <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>Notes</div>
              <textarea
                className="input"
                value={reviewNotes}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setReviewNotes(e.target.value)}
                placeholder="Additional notes..."
                style={{ minHeight: 90, resize: "vertical" }}
              />
            </div>

                <div className="row-between" style={{ gap: 10, flexWrap: "wrap", marginTop: 4 }}>
                  <div className="subtle">
                    Average (auto): <b>{computedAvg === null ? "—" : computedAvg.toFixed(1)}</b>{" "}
                    <span className="subtle">(normal rounding)</span>
                  </div>

                  <div className="row" style={{ gap: 10 }}>
                    <button className="btn" type="button" onClick={closeModal}>
                      Cancel
                    </button>
                    <button className="btn btn-primary" type="button" onClick={() => void saveReview()}>
                      Save evaluation
                    </button>
                  </div>
                </div>
              </div>
            )}
            
          </div>
        </div>
      ) : null}

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
            zIndex: 230,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 14,
          }}
        >
          <div
            ref={editRef}
            style={{
              width: "min(860px, 100%)",
              background: "white",
              borderRadius: 16,
              border: "1px solid #e5e7eb",
              padding: 16,
              maxHeight: "min(720px, 90vh)",
              overflow: "auto",
              boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
            }}
          >
            <div className="row-between" style={{ gap: 10 }}>
              <div style={{ display: "grid", gap: 4 }}>
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

            <div style={{ height: 12 }} />

            <div style={{ display: "grid", gap: 10 }}>
              {editQuestions.map((q, idx) => (
                <div
                  key={q.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 10,
                    alignItems: "start",
                    padding: "10px 10px",
                    border: "1px solid #e5e7eb",
                    borderRadius: 14,
                    background: "white",
                  }}
                >
                  <div style={{ display: "grid", gap: 8 }}>
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

                  <div style={{ display: "grid", gap: 8, justifyItems: "end" }}>
                    <div className="row" style={{ gap: 8 }}>
                      <button className="btn" type="button" title="Move up" disabled={idx === 0} onClick={() => moveEditQuestion(q.id, -1)}>
                        ↑
                      </button>
                      <button
                        className="btn"
                        type="button"
                        title="Move down"
                        disabled={idx === editQuestions.length - 1}
                        onClick={() => moveEditQuestion(q.id, 1)}
                      >
                        ↓
                      </button>
                    </div>

                    <button
                      className="btn-ghost"
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

    </div>
  );
}


export default function EmployeeByIdPage() {
  const params = useParams();
  const router = useRouter();

  // ✅ Fix: normalize ParamValue -> string
  const employeeId = useMemo(() => {
    const raw = (params as any)?.id as string | string[] | undefined;
    if (!raw) return "";
    return Array.isArray(raw) ? raw[0] ?? "" : raw;
  }, [params]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [employee, setEmployee] = useState<EmployeeRow | null>(null);

  // lookup data for selects
  const [jobLevels, setJobLevels] = useState<JobLevelRow[]>([]);
  const [campuses, setCampuses] = useState<CampusRow[]>([]);



// Manage Campuses / Event Types (popups)
const [showManageCampuses, setShowManageCampuses] = useState(false);
const [campusBusy, setCampusBusy] = useState(false);
const [newCampusName, setNewCampusName] = useState("");
const [campusEdits, setCampusEdits] = useState<Record<string, string>>({});

const [showManageEventTypes, setShowManageEventTypes] = useState(false);
const [eventTypeBusy, setEventTypeBusy] = useState(false);
const [newEventTypeName, setNewEventTypeName] = useState("");
const [eventTypeEdits, setEventTypeEdits] = useState<Record<string, string>>({});

  // Milestones lookup
  const [eventTypes, setEventTypes] = useState<EventTypeRow[]>([]);

  // Attendance
  const [attendanceTypes, setAttendanceTypes] = useState<AttendanceTypeRow[]>([]);
  const [empAttendance, setEmpAttendance] = useState<EmployeeAttendanceRow[]>([]);
  const [empAttendanceLoading, setEmpAttendanceLoading] = useState(false);

  // Add record inputs
  const [newAttendanceTypeId, setNewAttendanceTypeId] = useState<string>("");
  const [newAttendanceDate, setNewAttendanceDate] = useState<string>("");
  const [newAttendanceNotes, setNewAttendanceNotes] = useState<string>("");
  const [attSaving, setAttSaving] = useState(false);

  // left-nav (sections)
  const [activeTab, setActiveTab] =
  useState<"general" | "milestones" | "attendance" | "meetings" | "reviews" | "documents">("general");
  // form state (mirrors your modal)
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

  // insurance sheet + template
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

  const [insuranceTemplateDoc, setInsuranceTemplateDoc] = useState<any[] | null>(null);
  const [insuranceTemplateLoading, setInsuranceTemplateLoading] = useState(false);

  const insuranceFallbackDoc = useMemo(() => {
    return insuranceTemplateDoc ?? DEFAULT_INSURANCE_SHEET_DOC;
  }, [insuranceTemplateDoc, DEFAULT_INSURANCE_SHEET_DOC]);

  const [insuranceSheetDoc, setInsuranceSheetDoc] = useState<any[]>(DEFAULT_INSURANCE_SHEET_DOC);
  const [insuranceWorkbookKey, setInsuranceWorkbookKey] = useState<string>("init");
  const [insuranceSheetDirty, setInsuranceSheetDirty] = useState(false);
  const insuranceWorkbookRef = useRef<any>(null);



// PTO schedule history (only relevant when PTO = Yes)
  const [ptoSchedules, setPtoSchedules] = useState<PtoScheduleRow[]>([]);
  const [ptoSchedulesLoading, setPtoSchedulesLoading] = useState(false);
  const [ptoScheduleStatus, setPtoScheduleStatus] = useState<string>("");

  const [newPtoBegin, setNewPtoBegin] = useState<string>("");
  const [newPtoEnd, setNewPtoEnd] = useState<string>("");
  const [newPtoHours, setNewPtoHours] = useState<string>("");
  const [ptoSavingId, setPtoSavingId] = useState<string | null>(null);

  // Milestones state
  const [empEvents, setEmpEvents] = useState<EmployeeEventRow[]>([]);
  const [empEventRemindersByEventId, setEmpEventRemindersByEventId] = useState<Record<string, EmployeeEventReminderRow[]>>(
    {}
  );

  const [newEventTypeId, setNewEventTypeId] = useState<string>("");
  const [newEventDate, setNewEventDate] = useState<string>("");
  const [newEventNotes, setNewEventNotes] = useState<string>("");

  const [newReminderDays, setNewReminderDays] = useState<string>("");
  const [newEventReminderOffsets, setNewEventReminderOffsets] = useState<number[]>([]);

  /* =========================
     Meetings state (employee-scoped)
  ========================= */

  const [meetingStatus, setMeetingStatus] = useState<string>("");

  const [meetingTypes, setMeetingTypes] = useState<MeetingType[]>([]);
  const [meetings, setMeetings] = useState<HrMeeting[]>([]);
  const [attendeesByMeeting, setAttendeesByMeeting] = useState<Map<string, HrMeetingAttendee[]>>(new Map());
  const [docsByMeeting, setDocsByMeeting] = useState<Map<string, HrMeetingDocument[]>>(new Map());

  // All employees for attendee picker dropdown
  const [allEmployees, setAllEmployees] = useState<EmployeeLite[]>([]);

  // Attendee add UI state per meeting
  // - attendeeTextByMeeting is a search box value
  // - selectedAttendeeEmployeeIdByMeeting is set only when user picks a row from the dropdown
  const [attendeeTextByMeeting, setAttendeeTextByMeeting] = useState<Record<string, string>>({});
  const [selectedAttendeeEmployeeIdByMeeting, setSelectedAttendeeEmployeeIdByMeeting] = useState<
    Record<string, string | null>
  >({});
  const [attendeeDropdownOpenByMeeting, setAttendeeDropdownOpenByMeeting] = useState<Record<string, boolean>>({});
  const [addingAttendeeByMeeting, setAddingAttendeeByMeeting] = useState<Record<string, boolean>>({});

  // Upload UI state
  const [uploadingMeetingId, setUploadingMeetingId] = useState<string>("");

    /* =========================
    Employee Documents state (employee-scoped)
  ========================= */

  const [employeeDocsStatus, setEmployeeDocsStatus] = useState<string>("");
  const [employeeDocs, setEmployeeDocs] = useState<HrEmployeeDocument[]>([]);
  const [uploadingEmployeeDocs, setUploadingEmployeeDocs] = useState<boolean>(false);

  // separate preview modal for employee docs (keeps meetings preview untouched)
  const [empPreviewOpen, setEmpPreviewOpen] = useState(false);
  const [empPreviewDoc, setEmpPreviewDoc] = useState<HrEmployeeDocument | null>(null);
  const [empPreviewMode, setEmpPreviewMode] = useState<PreviewMode>("unknown");
  const [empPreviewSignedUrl, setEmpPreviewSignedUrl] = useState<string>("");
  const [empPreviewLoading, setEmpPreviewLoading] = useState(false);
  const [empPreviewCsvRows, setEmpPreviewCsvRows] = useState<string[][]>([]);
  const [empPreviewCsvError, setEmpPreviewCsvError] = useState<string>("");

  const empOfficeEmbedUrl = useMemo(() => {
    if (!empPreviewSignedUrl) return "";
    return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(empPreviewSignedUrl)}`;
  }, [empPreviewSignedUrl]);

  const empCsvRenderMeta = useMemo(() => {
    const rows = empPreviewCsvRows ?? [];
    const rowCount = rows.length;
    let maxCols = 0;
    for (const r of rows) maxCols = Math.max(maxCols, r.length);
    const colsToShow = Math.min(maxCols, 40);
    const rowsToShow = Math.min(rowCount, 200);
    return { rowCount, maxCols, colsToShow, rowsToShow };
  }, [empPreviewCsvRows]);

  const loadEmployeeDocuments = useCallback(async (empId: string) => {
    if (!empId) {
      setEmployeeDocs([]);
      return;
    }
    setEmployeeDocsStatus("Loading documents...");
    try {
      const res = await supabase
        .from("hr_employee_documents")
        .select("id, employee_id, name, object_key, mime_type, size_bytes, created_at")
        .eq("employee_id", empId)
        .order("created_at", { ascending: false });

      if (res.error) throw res.error;
      setEmployeeDocs((res.data ?? []) as HrEmployeeDocument[]);
      setEmployeeDocsStatus("");
    } catch (e: any) {
      setEmployeeDocsStatus("Error loading documents: " + (e?.message ?? "unknown"));
    }
  }, []);

  async function presignEmployeeDocUpload(empId: string, file: File, token: string) {
    const res = await fetch("/api/r2/presign-employee-doc", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        employeeId: empId,
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      }),
    });

    const body = await readJsonSafely(res);
    if (!res.ok) {
      const msg = (body as any)?.error || ((body as any)?.__nonJson ? (body as any).text.slice(0, 300) : "presign failed");
      throw new Error(msg);
    }
    if ((body as any)?.__nonJson) throw new Error("Presign returned non-JSON response.");
    return body as { uploadUrl: string; objectKey: string };
  }

  async function getSignedEmployeeDocDownloadUrl(documentId: string, mode: "inline" | "attachment" = "attachment") {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) throw new Error("No session token");

    const res = await fetch("/api/r2/download-employee-doc", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ documentId, mode }),
    });

    const body = await readJsonSafely(res);
    if (!res.ok) {
      const msg = (body as any)?.error || ((body as any)?.__nonJson ? (body as any).text.slice(0, 300) : "download failed");
      throw new Error(msg);
    }
    if ((body as any)?.__nonJson) throw new Error("Download returned non-JSON response.");
    if (!(body as any).url) throw new Error("Download response missing url");
    return (body as any).url as string;
  }

  async function handleUploadEmployeeDocs(fileList: FileList | null) {
    const filesArr = Array.from(fileList ?? []);
    if (filesArr.length === 0) return;
    if (!employeeId) return;

    setUploadingEmployeeDocs(true);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("No session token");

      for (let i = 0; i < filesArr.length; i++) {
        const file = filesArr[i];
        setEmployeeDocsStatus(`Uploading ${i + 1}/${filesArr.length}: ${file.name}`);

        const { uploadUrl, objectKey } = await presignEmployeeDocUpload(employeeId, file, token);

        const putRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);

        const { data: docRow, error } = await supabase
          .from("hr_employee_documents")
          .insert({
            employee_id: employeeId,
            name: file.name,
            object_key: objectKey,
            mime_type: file.type || "application/octet-stream",
            size_bytes: file.size,
          })
          .select("id, employee_id, name, object_key, mime_type, size_bytes, created_at")
          .single();

        if (error) throw error;

        setEmployeeDocs((cur) => [docRow as HrEmployeeDocument, ...cur]);
      }

      setEmployeeDocsStatus("✅ Upload complete.");
      setTimeout(() => setEmployeeDocsStatus(""), 900);
    } catch (e: any) {
      setEmployeeDocsStatus("Upload error: " + (e?.message ?? "unknown"));
    } finally {
      setUploadingEmployeeDocs(false);
    }
  }

  async function deleteEmployeeDoc(documentId: string) {
    if (!confirm("Delete this document?")) return;

    setEmployeeDocsStatus("Deleting document...");
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("No session token");

      const res = await fetch("/api/r2/delete-employee-doc", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ documentId }),
      });

      const body = await readJsonSafely(res);
      if (!res.ok) {
        const msg = (body as any)?.error || ((body as any)?.__nonJson ? (body as any).text.slice(0, 300) : "delete failed");
        throw new Error(msg);
      }

      setEmployeeDocs((cur) => cur.filter((d) => d.id !== documentId));
      setEmployeeDocsStatus("✅ Deleted.");
      setTimeout(() => setEmployeeDocsStatus(""), 900);
    } catch (e: any) {
      setEmployeeDocsStatus("Delete document error: " + (e?.message ?? "unknown"));
    }
  }

  function closeEmpPreview() {
    setEmpPreviewOpen(false);
    setEmpPreviewDoc(null);
    setEmpPreviewMode("unknown");
    setEmpPreviewSignedUrl("");
    setEmpPreviewLoading(false);
    setEmpPreviewCsvRows([]);
    setEmpPreviewCsvError("");
  }

  async function openEmpPreview(doc: HrEmployeeDocument) {
    setEmpPreviewDoc(doc);
    setEmpPreviewOpen(true);
    setEmpPreviewLoading(true);
    setEmpPreviewCsvRows([]);
    setEmpPreviewCsvError("");

    try {
      const url = await getSignedEmployeeDocDownloadUrl(doc.id, "inline");
      setEmpPreviewSignedUrl(url);

      const ext = extOf(doc.name);

      if (isOfficeExt(ext)) {
        setEmpPreviewMode("office");
        setEmpPreviewLoading(false);
        return;
      }
      if (isPdfExt(ext)) {
        setEmpPreviewMode("pdf");
        setEmpPreviewLoading(false);
        return;
      }
      if (isImageExt(ext)) {
        setEmpPreviewMode("image");
        setEmpPreviewLoading(false);
        return;
      }

      if (ext === "csv") {
        setEmpPreviewMode("csv");
        try {
          const r = await fetch(url, { method: "GET" });
          if (!r.ok) throw new Error(`Failed to load CSV (${r.status})`);
          const text = await r.text();
          setEmpPreviewCsvRows(parseCsv(text));
        } catch (e: any) {
          setEmpPreviewCsvError(e?.message ?? "Failed to load CSV preview.");
        } finally {
          setEmpPreviewLoading(false);
        }
        return;
      }

      if (isTextExt(ext)) {
        setEmpPreviewMode("text");
        setEmpPreviewLoading(false);
        return;
      }
      if (isVideoExt(ext)) {
        setEmpPreviewMode("video");
        setEmpPreviewLoading(false);
        return;
      }
      if (isAudioExt(ext)) {
        setEmpPreviewMode("audio");
        setEmpPreviewLoading(false);
        return;
      }

      setEmpPreviewMode("unknown");
      setEmpPreviewLoading(false);
    } catch (e: any) {
      setEmployeeDocsStatus("Preview error: " + (e?.message ?? "unknown"));
      setEmpPreviewMode("unknown");
      setEmpPreviewLoading(false);
    }
  }

  // ESC closes employee preview
  useEffect(() => {
    if (!empPreviewOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeEmpPreview();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empPreviewOpen]);

  // Lazy load employee docs when the user opens Documents tab
useEffect(() => {
  if (!employeeId) return;
  if (activeTab !== "documents") return;
  void loadEmployeeDocuments(employeeId);
}, [activeTab, employeeId, loadEmployeeDocuments]);


  // Manage meeting types
  const [showManageMeetingTypes, setShowManageMeetingTypes] = useState(false);
  const [meetingTypesError, setMeetingTypesError] = useState<string | null>(null);
  const [newMeetingTypeName, setNewMeetingTypeName] = useState("");
  const [meetingTypeEdits, setMeetingTypeEdits] = useState<Record<string, { name: string }>>({});
  const [savingMeetingTypeIds, setSavingMeetingTypeIds] = useState<Record<string, boolean>>({});

  // Preview modal
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<HrMeetingDocument | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("unknown");
  const [previewSignedUrl, setPreviewSignedUrl] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewCsvRows, setPreviewCsvRows] = useState<string[][]>([]);
  const [previewCsvError, setPreviewCsvError] = useState<string>("");

  const officeEmbedUrl = useMemo(() => {
    if (!previewSignedUrl) return "";
    return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(previewSignedUrl)}`;
  }, [previewSignedUrl]);

  const csvRenderMeta = useMemo(() => {
    const rows = previewCsvRows ?? [];
    const rowCount = rows.length;
    let maxCols = 0;
    for (const r of rows) maxCols = Math.max(maxCols, r.length);
    const colsToShow = Math.min(maxCols, 40);
    const rowsToShow = Math.min(rowCount, 200);
    return { rowCount, maxCols, colsToShow, rowsToShow };
  }, [previewCsvRows]);

  const meetingTypesSorted = useMemo(() => {
    return [...(meetingTypes ?? [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [meetingTypes]);

  const activeMeetingTypes = meetingTypesSorted;

  const reloadMeetingTypes = useCallback(async () => {
    const res = await supabase
      .from("hr_meeting_types")
      .select("id,name,created_at")
      .order("name", { ascending: true });

    if (res.error) throw res.error;
    setMeetingTypes((res.data ?? []) as MeetingType[]);
  }, []);

  const reloadAllEmployees = useCallback(async () => {
    const res = await supabase
      .from("hr_employees")
      .select("id,legal_first_name,legal_middle_name,legal_last_name,nicknames,is_active")
      .order("legal_last_name", { ascending: true })
      .order("legal_first_name", { ascending: true });

    if (res.error) throw res.error;
    setAllEmployees((res.data ?? []) as EmployeeLite[]);
  }, []);

  const loadEmployeeMeetings = useCallback(async (empId: string) => {
    if (!empId) {
      setMeetings([]);
      setAttendeesByMeeting(new Map());
      setDocsByMeeting(new Map());
      return;
    }

    setMeetingStatus("Loading meetings...");
    try {
      const { data, error } = await supabase
        .from("hr_meetings")
        .select("*, type:hr_meeting_types(id,name)")
        .eq("employee_id", empId)
        .order("meeting_at", { ascending: false });

      if (error) throw error;

      const list = (data ?? []) as HrMeeting[];
      setMeetings(list);

      const ids = list.map((m) => m.id);
      if (ids.length === 0) {
        setAttendeesByMeeting(new Map());
        setDocsByMeeting(new Map());
        setMeetingStatus("");
        return;
      }

      const [attRes, docRes] = await Promise.all([
        supabase.from("hr_meeting_attendees").select("*").in("meeting_id", ids).order("created_at", { ascending: true }),
        supabase.from("hr_meeting_documents").select("*").in("meeting_id", ids).order("created_at", { ascending: false }),
      ]);

      if (attRes.error) throw attRes.error;
      if (docRes.error) throw docRes.error;

      // IMPORTANT: de-dupe by id to avoid React "same key" crashes
      const attMap = new Map<string, HrMeetingAttendee[]>();
      const seen = new Set<string>();
      for (const a of (attRes.data ?? []) as HrMeetingAttendee[]) {
        if (!a?.id) continue;
        if (seen.has(a.id)) continue;
        seen.add(a.id);

        const arr = attMap.get(a.meeting_id) ?? [];
        arr.push(a);
        attMap.set(a.meeting_id, arr);
      }

      const docMap = new Map<string, HrMeetingDocument[]>();
      for (const d of (docRes.data ?? []) as HrMeetingDocument[]) {
        const arr = docMap.get(d.meeting_id) ?? [];
        arr.push(d);
        docMap.set(d.meeting_id, arr);
      }

      setAttendeesByMeeting(attMap);
      setDocsByMeeting(docMap);

      setMeetingStatus("");
    } catch (e: any) {
      setMeetingStatus("Error loading meetings: " + (e?.message ?? "unknown"));
    }
  }, []);

  async function addMeeting() {
    if (!employeeId) return;

    const defaultTypeId = activeMeetingTypes[0]?.id ?? null;

    setMeetingStatus("Creating meeting...");
    try {
      const { data, error } = await supabase
        .from("hr_meetings")
        .insert({
          employee_id: employeeId,
          meeting_type_id: defaultTypeId,
          meeting_at: new Date().toISOString(),
          notes: "",
        })
        .select("*")
        .single();

      if (error) throw error;

      setMeetingStatus("✅ Meeting created.");
      await loadEmployeeMeetings(employeeId);

      if (data?.id) {
        setAttendeeTextByMeeting((cur) => ({ ...cur, [data.id]: "" }));
      }
      setTimeout(() => setMeetingStatus(""), 900);
    } catch (e: any) {
      setMeetingStatus("Create error: " + (e?.message ?? "unknown"));
    }
  }

  async function deleteMeeting(meetingId: string) {
    if (!meetingId) return;
    if (!confirm("Delete this meeting and all its attendees/documents?")) return;

    setMeetingStatus("Deleting meeting...");
    try {
      const { error } = await supabase.from("hr_meetings").delete().eq("id", meetingId);
      if (error) throw error;
      setMeetingStatus("✅ Deleted.");
      await loadEmployeeMeetings(employeeId);
      setTimeout(() => setMeetingStatus(""), 900);
    } catch (e: any) {
      setMeetingStatus("Delete error: " + (e?.message ?? "unknown"));
    }
  }

  async function updateMeeting(meetingId: string, patch: Partial<Pick<HrMeeting, "meeting_type_id" | "meeting_at" | "notes">>) {
    setMeetingStatus("Saving...");
    try {
      const { error } = await supabase.from("hr_meetings").update(patch).eq("id", meetingId);
      if (error) throw error;

      // local optimistic update
      setMeetings((cur) => cur.map((m) => (m.id === meetingId ? ({ ...m, ...patch } as HrMeeting) : m)));

      setMeetingStatus("✅ Saved.");
      setTimeout(() => setMeetingStatus(""), 900);
    } catch (e: any) {
      setMeetingStatus("Save error: " + (e?.message ?? "unknown"));
    }
  }

  async function addAttendee(meetingId: string) {
    if (!meetingId) return;

    if (addingAttendeeByMeeting[meetingId]) return;
    setAddingAttendeeByMeeting((cur) => ({ ...cur, [meetingId]: true }));

    const selectedEmployeeId = selectedAttendeeEmployeeIdByMeeting[meetingId] ?? null;

    if (!selectedEmployeeId) {
      setMeetingStatus("Select an employee from the list.");
      setAddingAttendeeByMeeting((cur) => ({ ...cur, [meetingId]: false }));
      return;
    }

    const emp = allEmployees.find((e) => e.id === selectedEmployeeId) ?? null;
    if (!emp) {
      setMeetingStatus("Selected employee not found. Try again.");
      setAddingAttendeeByMeeting((cur) => ({ ...cur, [meetingId]: false }));
      return;
    }

    const attendeeName = formatEmployeeName(emp);

    // prevent duplicates
    const current = attendeesByMeeting.get(meetingId) ?? [];
    if (current.some((a) => a.attendee_employee_id === selectedEmployeeId)) {
      setMeetingStatus("That employee is already an attendee.");
      setAttendeeTextByMeeting((cur) => ({ ...cur, [meetingId]: "" }));
      setSelectedAttendeeEmployeeIdByMeeting((cur) => ({ ...cur, [meetingId]: null }));
      setAttendeeDropdownOpenByMeeting((cur) => ({ ...cur, [meetingId]: false }));
      setAddingAttendeeByMeeting((cur) => ({ ...cur, [meetingId]: false }));
      return;
    }

    setMeetingStatus("Adding attendee...");
    try {
      const { data, error } = await supabase
        .from("hr_meeting_attendees")
        .insert({ meeting_id: meetingId, attendee_name: attendeeName, attendee_employee_id: selectedEmployeeId })
        .select("*")
        .single();

      if (error) throw error;

      setAttendeesByMeeting((cur) => {
        const next = new Map(cur);
        const arr = next.get(meetingId) ?? [];
        const exists = arr.some((x) => x.id === (data as any)?.id);
        if (!exists) {
          arr.push(data as HrMeetingAttendee);
          next.set(meetingId, arr);
        }
        return next;
      });

      setAttendeeTextByMeeting((cur) => ({ ...cur, [meetingId]: "" }));
      setSelectedAttendeeEmployeeIdByMeeting((cur) => ({ ...cur, [meetingId]: null }));
      setAttendeeDropdownOpenByMeeting((cur) => ({ ...cur, [meetingId]: false }));

      setMeetingStatus("✅ Attendee added.");
      setTimeout(() => setMeetingStatus(""), 900);
    } catch (e: any) {
      setMeetingStatus("Add attendee error: " + (e?.message ?? "unknown"));
    } finally {
      setAddingAttendeeByMeeting((cur) => ({ ...cur, [meetingId]: false }));
    }
  }

  async function removeAttendee(attendeeId: string, meetingId: string) {
    setMeetingStatus("Removing attendee...");
    try {
      const { error } = await supabase.from("hr_meeting_attendees").delete().eq("id", attendeeId);
      if (error) throw error;

      setAttendeesByMeeting((cur) => {
        const next = new Map(cur);
        const arr = (next.get(meetingId) ?? []).filter((a) => a.id !== attendeeId);
        next.set(meetingId, arr);
        return next;
      });

      setMeetingStatus("✅ Removed.");
      setTimeout(() => setMeetingStatus(""), 900);
    } catch (e: any) {
      setMeetingStatus("Remove attendee error: " + (e?.message ?? "unknown"));
    }
  }

  async function presignMeetingUpload(meetingId: string, file: File, token: string) {
    const res = await fetch("/api/r2/presign-meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        meetingId,
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      }),
    });

    const body = await readJsonSafely(res);
    if (!res.ok) {
      const msg = (body as any)?.error || ((body as any)?.__nonJson ? (body as any).text.slice(0, 300) : "presign failed");
      throw new Error(msg);
    }
    if ((body as any)?.__nonJson) throw new Error("Presign returned non-JSON response.");
    return body as { uploadUrl: string; objectKey: string };
  }

  async function getSignedMeetingDownloadUrl(documentId: string, mode: "inline" | "attachment" = "attachment") {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) throw new Error("No session token");

    const res = await fetch("/api/r2/download-meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ documentId, mode }),
    });

    const body = await readJsonSafely(res);
    if (!res.ok) {
      const msg = (body as any)?.error || ((body as any)?.__nonJson ? (body as any).text.slice(0, 300) : "download failed");
      throw new Error(msg);
    }
    if ((body as any)?.__nonJson) throw new Error("Download returned non-JSON response.");
    if (!(body as any).url) throw new Error("Download response missing url");
    return (body as any).url as string;
  }

  async function handleUploadMeetingDocs(meetingId: string, fileList: FileList | null) {
    const filesArr = Array.from(fileList ?? []);
    if (filesArr.length === 0) return;

    setUploadingMeetingId(meetingId);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("No session token");

      for (let i = 0; i < filesArr.length; i++) {
        const file = filesArr[i];
        setMeetingStatus(`Uploading ${i + 1}/${filesArr.length}: ${file.name}`);

        const { uploadUrl, objectKey } = await presignMeetingUpload(meetingId, file, token);

        const putRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);

        const { data: docRow, error } = await supabase
          .from("hr_meeting_documents")
          .insert({
            meeting_id: meetingId,
            name: file.name,
            object_key: objectKey,
            mime_type: file.type || "application/octet-stream",
            size_bytes: file.size,
          })
          .select("*")
          .single();

        if (error) throw error;

        setDocsByMeeting((cur) => {
          const next = new Map(cur);
          const arr = next.get(meetingId) ?? [];
          arr.unshift(docRow as HrMeetingDocument);
          next.set(meetingId, arr);
          return next;
        });
      }

      setMeetingStatus("✅ Upload complete.");
      setTimeout(() => setMeetingStatus(""), 900);
    } catch (e: any) {
      setMeetingStatus("Upload error: " + (e?.message ?? "unknown"));
    } finally {
      setUploadingMeetingId("");
    }
  }

  async function deleteMeetingDoc(documentId: string, meetingId: string) {
    if (!confirm("Delete this document?")) return;

    setMeetingStatus("Deleting document...");
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("No session token");

      const res = await fetch("/api/r2/delete-meeting", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ documentId }),
      });

      const body = await readJsonSafely(res);
      if (!res.ok) {
        const msg = (body as any)?.error || ((body as any)?.__nonJson ? (body as any).text.slice(0, 300) : "delete failed");
        throw new Error(msg);
      }

      setDocsByMeeting((cur) => {
        const next = new Map(cur);
        const arr = (next.get(meetingId) ?? []).filter((d) => d.id !== documentId);
        next.set(meetingId, arr);
        return next;
      });

      setMeetingStatus("✅ Deleted.");
      setTimeout(() => setMeetingStatus(""), 900);
    } catch (e: any) {
      setMeetingStatus("Delete document error: " + (e?.message ?? "unknown"));
    }
  }

  function closePreview() {
    setPreviewOpen(false);
    setPreviewDoc(null);
    setPreviewMode("unknown");
    setPreviewSignedUrl("");
    setPreviewLoading(false);
    setPreviewCsvRows([]);
    setPreviewCsvError("");
  }

  async function openPreview(doc: HrMeetingDocument) {
    setPreviewDoc(doc);
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewCsvRows([]);
    setPreviewCsvError("");

    try {
      const url = await getSignedMeetingDownloadUrl(doc.id, "inline");
      setPreviewSignedUrl(url);

      const ext = extOf(doc.name);

      if (isOfficeExt(ext)) {
        setPreviewMode("office");
        setPreviewLoading(false);
        return;
      }
      if (isPdfExt(ext)) {
        setPreviewMode("pdf");
        setPreviewLoading(false);
        return;
      }
      if (isImageExt(ext)) {
        setPreviewMode("image");
        setPreviewLoading(false);
        return;
      }

      if (ext === "csv") {
        setPreviewMode("csv");
        try {
          const res = await fetch(url, { method: "GET" });
          if (!res.ok) throw new Error(`Failed to load CSV (${res.status})`);
          const text = await res.text();
          const rows = parseCsv(text);
          setPreviewCsvRows(rows);
        } catch (e: any) {
          setPreviewCsvError(e?.message ?? "Failed to load CSV preview.");
        } finally {
          setPreviewLoading(false);
        }
        return;
      }

      if (isTextExt(ext)) {
        setPreviewMode("text");
        setPreviewLoading(false);
        return;
      }
      if (isVideoExt(ext)) {
        setPreviewMode("video");
        setPreviewLoading(false);
        return;
      }
      if (isAudioExt(ext)) {
        setPreviewMode("audio");
        setPreviewLoading(false);
        return;
      }

      setPreviewMode("unknown");
      setPreviewLoading(false);
    } catch (e: any) {
      setMeetingStatus("Preview error: " + (e?.message ?? "unknown"));
      setPreviewMode("unknown");
      setPreviewLoading(false);
    }
  }

  // Meeting type management helpers
  function openManageMeetingTypes() {
    setMeetingTypesError(null);

    const edits: Record<string, { name: string }> = {};
    for (const t of meetingTypes) {
      edits[t.id] = {
        name: t.name ?? "",
      };
    }
    setMeetingTypeEdits(edits);
    setShowManageMeetingTypes(true);
  }

  
async function addMeetingType() {
    const name = newMeetingTypeName.trim();
    if (!name) return;

    const { error } = await supabase.from("hr_meeting_types").insert({ name });
    if (error) {
      console.error("addMeetingType error", error);
      return;
    }
    setNewMeetingTypeName("");
    await reloadMeetingTypes();
  }

  async function saveMeetingType(id: string) {
    const draft = meetingTypeEdits[id];
    if (!draft) return;

    const name = (draft.name || "").trim();
    if (!name) return;

    const { error } = await supabase.from("hr_meeting_types").update({ name }).eq("id", id);
    if (error) {
      console.error("saveMeetingType error", error);
      return;
    }
    await reloadMeetingTypes();
  }

  async function deleteMeetingType(id: string) {
    const ok = confirm("Delete this meeting type? (If meetings still reference it, deletion may fail.)");
    if (!ok) return;

    setMeetingTypesError(null);
    try {
      const { error } = await supabase.from("hr_meeting_types").delete().eq("id", id);
      if (error) throw error;

      await reloadMeetingTypes();

      setMeetings((cur) => cur.map((m) => (m.meeting_type_id === id ? { ...m, meeting_type_id: null } : m)));
    } catch (e: any) {
      setMeetingTypesError(e?.message ?? "Failed to delete meeting type.");
    }
  }

  // ESC closes preview
  useEffect(() => {
    if (!previewOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePreview();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewOpen]);

  // ESC closes meeting type modal
  useEffect(() => {
    if (!showManageMeetingTypes) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowManageMeetingTypes(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showManageMeetingTypes]);



  // ESC closes manage campuses modal
  useEffect(() => {
    if (!showManageCampuses) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowManageCampuses(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showManageCampuses]);

  // ESC closes manage event types modal
  useEffect(() => {
    if (!showManageEventTypes) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowManageEventTypes(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showManageEventTypes]);
  // When switching to Meetings tab, lazy-load meetings + meeting types
  useEffect(() => {
    if (!employeeId) return;
    if (activeTab !== "meetings") return;
    (async () => {
      try {
        await reloadMeetingTypes();
        await reloadAllEmployees();
      } catch (e: any) {
        setMeetingStatus("Failed to load meeting types: " + (e?.message ?? "unknown"));
      }
      await loadEmployeeMeetings(employeeId);
    })();
  }, [activeTab, employeeId, reloadMeetingTypes, reloadAllEmployees, loadEmployeeMeetings]);

  /* =========================
     Existing page logic
  ========================= */

  const exportInsuranceSheetDoc = useCallback((): any[] => {
    const api = insuranceWorkbookRef.current;
    let latest: any;
    try {
      if (api?.getAllSheets) latest = api.getAllSheets();
    } catch {
      // no-op
    }
    if (!latest) latest = insuranceSheetDoc;
    return deepJsonClone(latest);
  }, [insuranceSheetDoc]);

  const handleInsuranceSheetOp = useCallback((_ops: any[]) => {
    requestAnimationFrame(() => setInsuranceSheetDirty(true));
  }, []);


  const addNickname = useCallback(() => {
    const raw = nicknamesInput.trim();
    if (!raw) return;
    if (nicknames.some((n) => n.toLowerCase() === raw.toLowerCase())) return;
    setNicknames([...nicknames, raw]);
    setNicknamesInput("");
  }, [nicknames, nicknamesInput]);

  const addBenefit = useCallback(() => {
    const raw = benefitInput.trim();
    if (!raw) return;
    if (benefits.some((b) => b.toLowerCase() === raw.toLowerCase())) return;
    setBenefits([...benefits, raw]);
    setBenefitInput("");
  }, [benefits, benefitInput]);

  const loadInsuranceTemplate = useCallback(async (): Promise<any[] | null> => {
    setInsuranceTemplateLoading(true);
    try {
      const { data, error } = await supabase.rpc("hr_get_template", { p_key: "insurance_sheet" });
      if (error) throw error;
      const normalized = normalizeForFortune(data, DEFAULT_INSURANCE_SHEET_DOC);
      setInsuranceTemplateDoc(normalized);
      return normalized;
    } catch (e: any) {
      console.warn("Failed to load insurance template:", e?.message ?? e);
      setInsuranceTemplateDoc(null);
      return null;
    } finally {
      setInsuranceTemplateLoading(false);
    }
  }, [DEFAULT_INSURANCE_SHEET_DOC]);

  const loadEmployeeMilestones = useCallback(async (empId: string) => {
    const evRes = await supabase
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
      .eq("employee_id", empId)
      .order("event_date", { ascending: false })
      .order("created_at", { ascending: false });

    if (evRes.error) throw evRes.error;

    const events = (evRes.data ?? []).map((x: any) => ({
      ...x,
      event_type: asSingle<EventTypeRow>(x.event_type),
    })) as EmployeeEventRow[];

    // reminders
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
  }, []);

  const loadEmployeeAttendance = useCallback(async (empId: string) => {
    setEmpAttendanceLoading(true);
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
        .eq("employee_id", empId)
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
      setEmpAttendance([]);
    } finally {
      setEmpAttendanceLoading(false);
    }
  }, []);

  const loadAttendanceTypes = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("hr_attendance_types")
        .select("id,name,points_deduct")
        .order("name", { ascending: true });
      if (error) throw error;
      setAttendanceTypes((data ?? []) as AttendanceTypeRow[]);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load attendance types.");
      setAttendanceTypes([]);
    }
  }, []);

  const reloadCampuses = useCallback(async () => {
    const { data, error } = await supabase.from("hr_campuses").select("id,name").order("name", { ascending: true });
    if (error) throw error;
    setCampuses((data ?? []) as CampusRow[]);
    return (data ?? []) as CampusRow[];
  }, []);

  const reloadEventTypes = useCallback(async () => {
    const { data, error } = await supabase.from("hr_event_types").select("id,name").order("name", { ascending: true });
    if (error) throw error;
    setEventTypes((data ?? []) as EventTypeRow[]);
    return (data ?? []) as EventTypeRow[];
  }, []);

  async function addCampus() {
    const name = newCampusName.trim();
    if (!name) return;
    setCampusBusy(true);
    setError(null);
    try {
      const { error } = await supabase.from("hr_campuses").insert({ name });
      if (error) throw error;
      setNewCampusName("");
      await reloadCampuses();
    } catch (e: any) {
      setError(e?.message ?? "Failed to add campus.");
    } finally {
      setCampusBusy(false);
    }
  }

  async function saveCampusName(id: string) {
    const name = (campusEdits[id] ?? "").trim();
    if (!name) return;
    setCampusBusy(true);
    setError(null);
    try {
      const { error } = await supabase.from("hr_campuses").update({ name }).eq("id", id);
      if (error) throw error;
      await reloadCampuses();
    } catch (e: any) {
      setError(e?.message ?? "Failed to update campus.");
    } finally {
      setCampusBusy(false);
    }
  }

  async function deleteCampus(id: string) {
    const ok = confirm("Delete this campus? (Employees linked to it will be set to no campus.)");
    if (!ok) return;
    setCampusBusy(true);
    setError(null);
    try {
      const { error } = await supabase.from("hr_campuses").delete().eq("id", id);
      if (error) throw error;
      await reloadCampuses();
      setCampusId((cur) => (cur === id ? "" : cur));
    } catch (e: any) {
      setError(e?.message ?? "Failed to delete campus.");
    } finally {
      setCampusBusy(false);
    }
  }

  async function addEventType() {
    const name = newEventTypeName.trim();
    if (!name) return;
    setEventTypeBusy(true);
    setError(null);
    try {
      const { error } = await supabase.from("hr_event_types").insert({ name });
      if (error) throw error;
      setNewEventTypeName("");
      await reloadEventTypes();
    } catch (e: any) {
      setError(e?.message ?? "Failed to add event type.");
    } finally {
      setEventTypeBusy(false);
    }
  }

  async function saveEventTypeName(id: string) {
    const name = (eventTypeEdits[id] ?? "").trim();
    if (!name) return;
    setEventTypeBusy(true);
    setError(null);
    try {
      const { error } = await supabase.from("hr_event_types").update({ name }).eq("id", id);
      if (error) throw error;
      await reloadEventTypes();
    } catch (e: any) {
      setError(e?.message ?? "Failed to update event type.");
    } finally {
      setEventTypeBusy(false);
    }
  }

  async function deleteEventType(id: string) {
    const ok = confirm("Delete this event type? (Existing employee events will lose the label.)");
    if (!ok) return;
    setEventTypeBusy(true);
    setError(null);
    try {
      const { error } = await supabase.from("hr_event_types").delete().eq("id", id);
      if (error) throw error;
      await reloadEventTypes();
      setNewEventTypeId((cur) => (cur === id ? "" : cur));
    } catch (e: any) {
      setError(e?.message ?? "Failed to delete event type.");
    } finally {
      setEventTypeBusy(false);
    }
  }

  async function addAttendanceRecord() {
    if (!employeeId) return;
    setError(null);

    if (!newAttendanceTypeId) {
      setError("Choose an attendance type.");
      return;
    }
    if (!newAttendanceDate) {
      setError("Choose an attendance date.");
      return;
    }

    setAttSaving(true);
    try {
      const { error } = await supabase.from("hr_employee_attendance").insert({
        employee_id: employeeId,
        attendance_type_id: newAttendanceTypeId,
        occurred_on: newAttendanceDate,
        notes: newAttendanceNotes.trim() || null,
      });

      if (error) throw error;

      // Clear inputs
      setNewAttendanceTypeId("");
      setNewAttendanceDate("");
      setNewAttendanceNotes("");

      // Reload records + refresh employee score (trigger updates attendance_points)
      await loadEmployeeAttendance(employeeId);
      const fresh = normalizeEmployee(await fetchEmployeeData(employeeId));
      setEmployee(fresh);
    } catch (e: any) {
      setError(e?.message ?? "Failed to add attendance record.");
    } finally {
      setAttSaving(false);
    }
  }

  async function deleteAttendanceRecord(attId: string) {
    const ok = confirm("Delete this attendance record? (This will restore points automatically.)");
    if (!ok) return;

    setError(null);
    try {
      const { error } = await supabase.from("hr_employee_attendance").delete().eq("id", attId);
      if (error) throw error;

      await loadEmployeeAttendance(employeeId);
      const fresh = normalizeEmployee(await fetchEmployeeData(employeeId));
      setEmployee(fresh);
    } catch (e: any) {
      setError(e?.message ?? "Failed to delete attendance record.");
    }
  }

  function addEventReminderOffset() {
    const n = Number(newReminderDays);
    if (!Number.isFinite(n) || n < 0) return;
    if (newEventReminderOffsets.includes(n)) return;
    setNewEventReminderOffsets((prev) => [...prev, n].sort((a, b) => b - a));
    setNewReminderDays("");
  }

  async function addMilestoneEvent() {
    if (!employeeId) return;
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
        employee_id: employeeId,
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
      if (rErr) setError(rErr.message);
    }

    setNewEventTypeId("");
    setNewEventDate("");
    setNewEventNotes("");
    setNewReminderDays("");
    setNewEventReminderOffsets([]);

    await loadEmployeeMilestones(employeeId);
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

    if (employeeId) await loadEmployeeMilestones(employeeId);
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

    if (employeeId) await loadEmployeeMilestones(employeeId);
  }

  async function loadPtoSchedules(employeeId: string) {
    setPtoSchedulesLoading(true);
    setPtoScheduleStatus("");
    try {
      const { data, error } = await supabase
        .from("hr_pto_schedules")
        .select("id,employee_id,begin_date,end_date,hours_per_annum,created_at")
        .eq("employee_id", employeeId)
        .order("begin_date", { ascending: false });

      if (error) throw error;
      setPtoSchedules((data || []) as any);
    } catch (e: any) {
      setPtoScheduleStatus(e?.message ?? "Failed to load PTO schedules");
    } finally {
      setPtoSchedulesLoading(false);
    }
  }

  async function savePtoSchedule(employeeId: string) {
    try {
      const begin_date = newPtoBegin ? newPtoBegin : null;
      const end_date = newPtoEnd ? newPtoEnd : null;
      const hours_per_annum = newPtoHours ? Number(newPtoHours) : null;

      setPtoSavingId("new");

      const { error } = await supabase.from("hr_pto_schedules").insert({
        employee_id: employeeId,
        begin_date,
        end_date,
        hours_per_annum,
      });
      if (error) throw error;

      setNewPtoBegin("");
      setNewPtoEnd("");
      setNewPtoHours("");
      await loadPtoSchedules(employeeId);
      setPtoScheduleStatus("Saved.");
      setTimeout(() => setPtoScheduleStatus(""), 1200);
    } catch (e: any) {
      setPtoScheduleStatus(e?.message ?? "Failed to save PTO schedule");
    } finally {
      setPtoSavingId(null);
    }
  }

  async function deletePtoSchedule(employeeId: string, scheduleId: string) {
    try {
      const ok = confirm("Delete this PTO schedule entry?");
      if (!ok) return;
      const { error } = await supabase.from("hr_pto_schedules").delete().eq("id", scheduleId).eq("employee_id", employeeId);
      if (error) throw error;
      await loadPtoSchedules(employeeId);
    } catch (e: any) {
      alert(e?.message ?? "Failed to delete PTO schedule");
    }
  }


// bootstrap: load selects + employee + milestones + attendance
  useEffect(() => {
    (async () => {
      if (!employeeId) return;

      setLoading(true);
      setError(null);

      try {
        // fetch template and use it immediately (don’t rely on async state timing)
        const template = await loadInsuranceTemplate();
        const localFallback = template ?? DEFAULT_INSURANCE_SHEET_DOC;

        const [jlRes, cRes, etRes, empRaw, atRes] = await Promise.all([
          supabase.from("hr_job_levels").select("id,name").order("name", { ascending: true }),
          supabase.from("hr_campuses").select("id,name").order("name", { ascending: true }),
          supabase.from("hr_event_types").select("id,name").order("name", { ascending: true }),
          fetchEmployeeData(employeeId),
          supabase.from("hr_attendance_types").select("id,name,points_deduct").order("name", { ascending: true }),
        ]);

        if (jlRes.error) throw jlRes.error;
        if (cRes.error) throw cRes.error;
        if (etRes.error) throw etRes.error;
        if (atRes.error) throw atRes.error;

        setJobLevels((jlRes.data ?? []) as JobLevelRow[]);
        setCampuses((cRes.data ?? []) as CampusRow[]);
        setEventTypes((etRes.data ?? []) as EventTypeRow[]);
        setAttendanceTypes((atRes.data ?? []) as AttendanceTypeRow[]);

        const emp = normalizeEmployee(empRaw);
        setEmployee(emp);

        // hydrate form fields
        setLegalFirst(emp.legal_first_name ?? "");
        setLegalMiddle(emp.legal_middle_name ?? "");
        setLegalLast(emp.legal_last_name ?? "");
        setNicknames(Array.isArray(emp.nicknames) ? emp.nicknames : []);

        setJobLevelId(emp.job_level_id ?? "");
        setCampusId(emp.campus_id ?? "");

        setRateType(emp.rate_type === "salary" ? "salary" : "hourly");
        setRate(String(Number(emp.rate ?? 0)));

        setEmploymentType(emp.employment_type === "full_time" ? "full_time" : "part_time");
        setIsActive(!!emp.is_active);

        setBenefits(Array.isArray(emp.benefits) ? emp.benefits : []);
        setHasInsurance(!!emp.has_insurance);
        setHas401k(!!emp.has_401k);
        setHasPto(!!emp.has_pto);

        const normalized = normalizeForFortune(emp.insurance_sheet_doc, localFallback);
        const shouldTemplate = !!emp.has_insurance && isEmptyInsuranceDoc(emp.insurance_sheet_doc);

        setInsuranceSheetDoc(shouldTemplate ? deepJsonClone(localFallback) : normalized);
        setInsuranceWorkbookKey(`ins:${emp.id}:${Date.now()}`);
        setInsuranceSheetDirty(false);


        

        if ((emp as any)?.has_pto) {
          await loadPtoSchedules(employeeId);
        } else {
          setPtoSchedules([]);
        }

        // milestones
        await loadEmployeeMilestones(employeeId);

        // attendance
        await loadEmployeeAttendance(employeeId);
      } catch (e: any) {
        setError(e?.message ?? "Failed to load employee.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  // If user clicks Attendance tab later, refresh attendance + types (keeps it current)
  useEffect(() => {
    if (!employeeId) return;
    if (activeTab !== "attendance") return;
    void loadEmployeeAttendance(employeeId);
    void loadAttendanceTypes();
  }, [activeTab, employeeId, loadEmployeeAttendance, loadAttendanceTypes]);

  async function saveChanges() {
    if (!employeeId) return;

    setError(null);
    try {
      const parsedRate = Number(rate);
      const safeRate = Number.isFinite(parsedRate) ? parsedRate : 0;

      const insuranceDoc = hasInsurance ? normalizeForFortune(exportInsuranceSheetDoc(), insuranceFallbackDoc) : null;
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
        job_level_id: jobLevelId || null,
        campus_id: campusId || null,
        insurance_sheet_doc: insuranceDoc,
};

      const { error } = await supabase.from("hr_employees").update(payload).eq("id", employeeId);
      if (error) throw error;

      // refresh header name etc.
      const fresh = normalizeEmployee(await fetchEmployeeData(employeeId));
      setEmployee(fresh);
      setInsuranceSheetDirty(false);
      alert("Saved.");
    } catch (e: any) {
      setError(e?.message ?? "Failed to save.");
    }
  }

  if (!employeeId) {
    return (
      <main className="stack">
        <div className="container">
          <div className="card" style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 900, color: "#b00020" }}>Missing employee id</div>
            <div className="subtle" style={{ marginTop: 6 }}>
              Go back to{" "}
              <Link href="/admin/hr/employees" style={{ textDecoration: "underline" }}>
                Employees
              </Link>
              .
            </div>
          </div>
        </div>
      </main>
    );
  }

  const titleName = employee
    ? [employee.legal_first_name, employee.legal_middle_name, employee.legal_last_name].filter(Boolean).join(" ")
    : "Employee";

  const attPoints = Number(employee?.attendance_points ?? 3);

  return (
    <div style={{ padding: 16 }}>
      <div className="row-between" style={{ gap: 12, alignItems: "center" }}>
        <div>
          <div className="subtle" style={{ marginBottom: 6 }}>
            <Link href="/admin/hr/employees" style={{ textDecoration: "underline" }}>
              ← Employees
            </Link>
          </div>
          <h1 style={{ margin: 0 }}>{titleName}</h1>
          <div className="subtle" style={{ marginTop: 6 }}>
            Employee ID: <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{employeeId}</span>
            <span style={{ marginLeft: 10 }}>
              • Attendance score: <span style={{ fontWeight: 900, color: scoreColor(attPoints) }}>{attPoints}</span>
            </span>
            {meetingStatus ? <span style={{ marginLeft: 10 }}>• <span style={{ fontWeight: 800 }}>{meetingStatus}</span></span> : null}
          </div>
        </div>

        <div className="row" style={{ gap: 10 }}>
          <button className="btn" onClick={() => router.refresh()} disabled={loading}>
            {loading ? "Loading..." : "Refresh"}
          </button>
          <button className="btn btn-primary" onClick={() => void saveChanges()} disabled={loading}>
            Save
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

      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "240px 1fr", gap: 14 }}>
        {/* LEFT VERTICAL NAV */}
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, overflow: "hidden", height: "fit-content" }}>
          <div style={{ padding: 12, borderBottom: "1px solid #e5e7eb", fontWeight: 900 }}>Sections</div>

          <button
            type="button"
            className="btn"
            onClick={() => setActiveTab("general")}
            style={{
              width: "100%",
              textAlign: "left",
              padding: 12,
              border: "none",
              borderRadius: 0,
              background: activeTab === "general" ? "rgba(0,0,0,0.04)" : "transparent",
              fontWeight: 900,
            }}
          >
            General Info
          </button>

          <button
            type="button"
            className="btn"
            onClick={() => setActiveTab("milestones")}
            style={{
              width: "100%",
              textAlign: "left",
              padding: 12,
              border: "none",
              borderRadius: 0,
              background: activeTab === "milestones" ? "rgba(0,0,0,0.04)" : "transparent",
              fontWeight: 900,
            }}
          >
            Milestones & Dates
          </button>

          <button
            type="button"
            className="btn"
            onClick={() => setActiveTab("attendance")}
            style={{
              width: "100%",
              textAlign: "left",
              padding: 12,
              border: "none",
              borderRadius: 0,
              background: activeTab === "attendance" ? "rgba(0,0,0,0.04)" : "transparent",
              fontWeight: 900,
            }}
          >
            Attendance {employee ? <span style={{ marginLeft: 8, fontWeight: 900, color: scoreColor(attPoints) }}>{attPoints}</span> : null}
          </button>

          <button
            type="button"
            className="btn"
            onClick={() => setActiveTab("meetings")}
            style={{
              width: "100%",
              textAlign: "left",
              padding: 12,
              border: "none",
              borderRadius: 0,
              background: activeTab === "meetings" ? "rgba(0,0,0,0.04)" : "transparent",
              fontWeight: 900,
            }}
          >
            Meetings
          </button>

          <button
            type="button"
            className="btn"
            onClick={() => setActiveTab("reviews")}
            style={{
              width: "100%",
              textAlign: "left",
              padding: 12,
              border: "none",
              borderRadius: 0,
              background: activeTab === "reviews" ? "rgba(0,0,0,0.04)" : "transparent",
              fontWeight: 900,
            }}
          >
            Performance Reviews
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setActiveTab("documents")}
            style={{
              width: "100%",
              textAlign: "left",
              padding: 12,
              border: "none",
              borderRadius: 0,
              background: activeTab === "documents" ? "rgba(0,0,0,0.04)" : "transparent",
              fontWeight: 900,
            }}
          >
            Documents
          </button>
        </div>

        {/* RIGHT CONTENT */}
        <div>
          {loading ? (
            <div className="subtle" style={{ padding: 12 }}>
              Loading…
            </div>
          ) : !employee ? (
            <div className="card" style={{ padding: 14 }}>
              Employee not found.
            </div>
          ) : (
            <>
              {activeTab === "general" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  {/* Legal Name */}
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

                    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
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

<div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
  <div style={{ flex: 1 }}>
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

  <button
    type="button"
    className="btn"
    onClick={() => {
      // seed edit map
      const seed: Record<string, string> = {};
      campuses.forEach((c) => (seed[c.id] = c.name));
      setCampusEdits(seed);
      setShowManageCampuses(true);
    }}
    title="Manage campuses"
    style={{ padding: "6px 10px" }}
  >
    +
  </button>
</div>

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
                        <Select
                          value={hasInsurance ? "yes" : "no"}
                          onChange={(e) => {
                            const next = e.target.value === "yes";
                            setHasInsurance(next);

                            if (next) {
                              const latest = exportInsuranceSheetDoc();
                              if (isEmptyInsuranceDoc(latest)) {
                                const seed = deepJsonClone(insuranceFallbackDoc);
                                setInsuranceSheetDoc(seed);
                                setInsuranceWorkbookKey(`ins:seed:${employeeId}:${Date.now()}`);
                                setInsuranceSheetDirty(true);
                              }
                            }
                          }}
                        >
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
                        <Select
                          value={hasPto ? "yes" : "no"}
                          onChange={(e) => {
                            const next = e.target.value === "yes";
                            setHasPto(next);
                            if (!employeeId) return;
                            if (next) {
                              void loadPtoSchedules(employeeId);
                            } else {
                              setPtoSchedules([]);
                            }
                          }}
                        >
                          <option value="no">No</option>
                          <option value="yes">Yes</option>
                        </Select>
                      </div>
                    </div>

{hasPto ? (
                      <>
                        <div style={{ height: 14 }} />
                        <div style={{ fontWeight: 900, fontSize: 18 }}>PTO schedule history</div>
                        <div className="subtle" style={{ marginTop: 2 }}>
                          Track how many PTO hours per annum the employee accrues over time.
                        </div>

                        <div style={{ height: 10 }} />

                        <div
                          style={{
                            border: "1px solid #e5e7eb",
                            borderRadius: 14,
                            padding: 12,
                            display: "grid",
                            gap: 10,
                          }}
                        >
                          <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "end" }}>
                            <div style={{ minWidth: 180 }}>
                              <FieldLabel>Begin date</FieldLabel>
                              <TextInput type="date" value={newPtoBegin} onChange={(e) => setNewPtoBegin(e.target.value)} />
                            </div>

                            <div style={{ minWidth: 180 }}>
                              <FieldLabel>End date (optional)</FieldLabel>
                              <TextInput type="date" value={newPtoEnd} onChange={(e) => setNewPtoEnd(e.target.value)} />
                            </div>

                            <div style={{ minWidth: 160 }}>
                              <FieldLabel>Hours / annum</FieldLabel>
                              <TextInput
                                inputMode="numeric"
                                value={newPtoHours}
                                onChange={(e) => setNewPtoHours(e.target.value)}
                                placeholder="e.g., 40"
                              />
                            </div>

                            <button
                              type="button"
                              className="btn"
                              onClick={() => void savePtoSchedule(employeeId)}
                              disabled={ptoSavingId === "new" || ptoSchedulesLoading}
                            >
                              {ptoSavingId === "new" ? "Saving…" : "Add entry"}
                            </button>

                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() => void loadPtoSchedules(employeeId)}
                              disabled={ptoSchedulesLoading}
                            >
                              Refresh
                            </button>

                            {ptoScheduleStatus ? <span className="subtle">{ptoScheduleStatus}</span> : null}
                          </div>

                          {ptoSchedulesLoading ? (
                            <div className="subtle">Loading PTO schedule…</div>
                          ) : ptoSchedules.length === 0 ? (
                            <div className="subtle">(No PTO schedule entries yet.)</div>
                          ) : (
                            <div style={{ overflowX: "auto" }}>
                              <table className="table">
                                <thead>
                                  <tr>
                                    <th style={{ minWidth: 130 }}>Begin</th>
                                    <th style={{ minWidth: 130 }}>End</th>
                                    <th style={{ minWidth: 130 }}>Hours / annum</th>
                                    <th style={{ minWidth: 120 }} />
                                  </tr>
                                </thead>
                                <tbody>
                                  {ptoSchedules.map((s) => (
                                    <tr key={s.id}>
                                      <td>{s.begin_date || "—"}</td>
                                      <td>{s.end_date || "—"}</td>
                                      <td>{s.hours_per_annum ?? "—"}</td>
                                      <td style={{ textAlign: "right" }}>
                                        <button type="button" className="btn-ghost" onClick={() => void deletePtoSchedule(employeeId, s.id)}>
                                          Delete
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      </>
                    ) : null}



                    {/* Notes live in the Performance Review modal (not the Benefits section) */}

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
                              {insuranceTemplateLoading ? " • loading template" : ""}
                            </span>
                          </div>

                          <div className="row" style={{ gap: 8 }}>
                            <button
                              type="button"
                              className="btn"
                              onClick={async () => {
                                try {
                                  const latest = normalizeForFortune(exportInsuranceSheetDoc(), insuranceFallbackDoc);
                                  const ok = confirm("Save the current insurance sheet as the default template for all employees?");
                                  if (!ok) return;

                                  const { error } = await supabase.rpc("hr_upsert_template", {
                                    p_key: "insurance_sheet",
                                    p_sheet_doc: latest,
                                  });
                                  if (error) throw error;

                                  setInsuranceTemplateDoc(deepJsonClone(latest));
                                  alert("Template saved.");
                                } catch (e: any) {
                                  alert(e?.message ?? "Failed to save template.");
                                }
                              }}
                              title="Set the default template used when an employee has insurance enabled but no sheet saved yet."
                            >
                              Save as template
                            </button>

                            <button
                              type="button"
                              className="btn"
                              onClick={() => {
                                setInsuranceSheetDoc(deepJsonClone(insuranceFallbackDoc));
                                setInsuranceWorkbookKey(`ins:reset:${Date.now()}`);
                                setInsuranceSheetDirty(true);
                              }}
                              disabled={insuranceTemplateLoading}
                            >
                              Reset
                            </button>
                          </div>
                        </div>

                        <div style={{ marginTop: 10, border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                          <div style={{ height: 360, width: "100%" }}>
                            <FortuneWorkbook key={insuranceWorkbookKey} ref={insuranceWorkbookRef as any} data={insuranceSheetDoc} onOp={handleInsuranceSheetOp} />
                          </div>
                        </div>

                        <div className="subtle" style={{ marginTop: 8 }}>
                          This sheet is saved to the employee record when you click <strong>Save</strong>.
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === "milestones" && (
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 10 }}>Milestones & Dates</div>

                  <div style={{ padding: 12, borderRadius: 14, border: "1px dashed #e5e7eb" }}>
                    <div style={{ fontWeight: 800, marginBottom: 10 }}>Add milestone/event</div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "end" }}>
<div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
  <div style={{ flex: 1 }}>
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

  <button
    type="button"
    className="btn"
    onClick={() => {
      const seed: Record<string, string> = {};
      eventTypes.forEach((t) => (seed[t.id] = t.name));
      setEventTypeEdits(seed);
      setShowManageEventTypes(true);
    }}
    title="Manage event types"
    style={{ padding: "6px 10px" }}
  >
    +
  </button>
</div>

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
                              <Chip key={d} text={`${d} days before`} onRemove={() => setNewEventReminderOffsets((prev) => prev.filter((x) => x !== d))} />
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
                                            {r.days_before} days before • sent_at: <strong>{r.sent_at ? new Date(r.sent_at).toLocaleString() : "—"}</strong>
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
                </div>
              )}

              {activeTab === "attendance" && (
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
                  <div className="row-between" style={{ gap: 12, alignItems: "center" }}>
                    <div style={{ fontWeight: 900 }}>
                      Attendance <span style={{ marginLeft: 10, fontWeight: 900, color: scoreColor(attPoints) }}>({attPoints})</span>
                    </div>

                    <div className="row" style={{ gap: 10 }}>
                      <button className="btn" type="button" onClick={() => void loadEmployeeAttendance(employeeId)} disabled={empAttendanceLoading}>
                        {empAttendanceLoading ? "Loading..." : "Refresh records"}
                      </button>
                    </div>
                  </div>

                  <div className="subtle" style={{ marginTop: 6 }}>
                    Records are shown most recent first. Score colors: <span style={{ color: "#16a34a", fontWeight: 900 }}>3</span> green,{" "}
                    <span style={{ color: "#ca8a04", fontWeight: 900 }}>1–2</span> yellow,{" "}
                    <span style={{ color: "#dc2626", fontWeight: 900 }}>0 or lower</span> red.
                  </div>

                  {/* ADD RECORD (inline, no link-out) */}
                  <div style={{ marginTop: 12, padding: 12, borderRadius: 14, border: "1px dashed #e5e7eb" }}>
                    <div style={{ fontWeight: 800, marginBottom: 10 }}>Add attendance record</div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "end" }}>
                      <div>
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
                      <button className="btn btn-primary" type="button" onClick={() => void addAttendanceRecord()} disabled={attSaving}>
                        {attSaving ? "Adding..." : "Add record"}
                      </button>

                      <button
                        className="btn"
                        type="button"
                        onClick={() => {
                          setNewAttendanceTypeId("");
                          setNewAttendanceDate("");
                          setNewAttendanceNotes("");
                        }}
                        disabled={attSaving}
                      >
                        Clear
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
                                    {a.attendance_type?.name ?? "—"}{" "}
                                    <span className="subtle" style={{ fontWeight: 800 }}>
                                      • −{deduct}
                                    </span>{" "}
                                    • {formatYmd(a.occurred_on)}
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

                                  <div className="subtle" style={{ marginTop: 6, fontSize: 12 }}>
                                    Created: {a.created_at ? new Date(a.created_at).toLocaleString() : "—"}
                                  </div>
                                </div>

                                <div className="row" style={{ gap: 8, alignItems: "center" }}>
                                  <button className="btn" type="button" onClick={() => void deleteAttendanceRecord(a.id)} style={{ padding: "6px 10px" }}>
                                    Delete
                                  </button>
                                  <div className="subtle" style={{ fontWeight: 800, whiteSpace: "nowrap" }}>
                                    ID:{" "}
                                    <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                                      {a.id.slice(0, 8)}…
                                    </span>
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
              )}
              {activeTab === "reviews" && (
                  <EmployeePerformanceReviewsTab
                    employeeId={employeeId}
                    attendancePoints={employee?.attendance_points ?? null}
                  />
              )}
              {activeTab === "meetings" && (
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
                  <div className="row-between" style={{ gap: 12, alignItems: "center" }}>
                    <div style={{ fontWeight: 900 }}>Meetings</div>

                    <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                      <button className="btn" type="button" onClick={() => void loadEmployeeMeetings(employeeId)}>
                        Refresh
                      </button>
                      <button className="btn btn-primary" type="button" onClick={() => void addMeeting()}>
                        Add meeting
                      </button>
                    </div>
                  </div>

                  <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                    {meetings.length === 0 ? (
                      <div className="subtle">(No meetings yet.)</div>
                    ) : (
                      meetings.map((m) => {
                        const attendees = attendeesByMeeting.get(m.id) ?? [];
                        const docs = docsByMeeting.get(m.id) ?? [];

                        const currentType = meetingTypes.find((t) => t.id === m.meeting_type_id) ?? null;
                        const currentTypeInactive = !!currentType;

                        return (
                          <div key={m.id} style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
                            <div className="row-between" style={{ gap: 12, alignItems: "flex-start" }}>
                              <div style={{ minWidth: 260 }}>
                                <div style={{ fontWeight: 950, fontSize: 16 }}>Meeting</div>
                                <div className="subtle" style={{ marginTop: 4 }}>
                                  Created: {new Date(m.created_at).toLocaleString()}
                                  {m.updated_at ? ` · Updated: ${new Date(m.updated_at).toLocaleString()}` : ""}
                                </div>
                              </div>

                              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                                <IconButton title="Delete meeting" onClick={() => deleteMeeting(m.id)}>
                                  🗑️
                                </IconButton>
                              </div>
                            </div>

                            <div style={{ height: 12 }} />

                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                              {/* Left: meeting fields */}
                              <div style={{ display: "grid", gap: 12 }}>
                                <div>
                                  <FieldLabel>Type</FieldLabel>

                                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "end" }}>
                                    <Select
                                      value={m.meeting_type_id ?? ""}
                                      onChange={(e) => updateMeeting(m.id, { meeting_type_id: e.target.value || null })}
                                    >
                                      <option value="">(No type)</option>

                                      {currentTypeInactive ? (
                                        <option value={currentType!.id} disabled>
                                          {currentType!.name} (inactive)
                                        </option>
                                      ) : null}

                                      {activeMeetingTypes.map((t) => (
                                        <option key={t.id} value={t.id}>
                                          {t.name}
                                        </option>
                                      ))}
                                    </Select>

                                    <button type="button" className="btn" title="Manage meeting types" onClick={openManageMeetingTypes}>
                                      +
                                    </button>
                                  </div>
                                </div>

                                <div>
                                  <FieldLabel>Meeting time</FieldLabel>
                                  <TextInput
                                    type="datetime-local"
                                    value={(() => {
                                      const d = new Date(m.meeting_at);
                                      const pad = (n: number) => String(n).padStart(2, "0");
                                      const yyyy = d.getFullYear();
                                      const mm = pad(d.getMonth() + 1);
                                      const dd = pad(d.getDate());
                                      const hh = pad(d.getHours());
                                      const min = pad(d.getMinutes());
                                      return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
                                    })()}
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      const dt = new Date(v);
                                      updateMeeting(m.id, { meeting_at: dt.toISOString() });
                                    }}
                                  />
                                </div>

                                <div>
                                  <FieldLabel>Notes</FieldLabel>
                                  <textarea
                                    value={m.notes ?? ""}
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      setMeetings((cur) => cur.map((x) => (x.id === m.id ? { ...x, notes: v } : x)));
                                    }}
                                    onBlur={() => updateMeeting(m.id, { notes: (m.notes ?? "") as any })}
                                    rows={6}
                                    style={{
                                      width: "100%",
                                      padding: "10px 12px",
                                      borderRadius: 12,
                                      border: "1px solid #e5e7eb",
                                      outline: "none",
                                      fontSize: 14,
                                      resize: "vertical",
                                    }}
                                    placeholder="Meeting notes..."
                                  />
                                  <div className="subtle" style={{ marginTop: 6 }}>
                                    Notes save when you click out of the box.
                                  </div>
                                </div>
                              </div>

                              {/* Right: attendees + documents */}
                              <div style={{ display: "grid", gap: 12 }}>
                                {/* Attendees */}
                                <div style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
                                  <div style={{ fontWeight: 900 }}>Attendees</div>
                                  <div style={{ height: 10 }} />

                                  {attendees.length === 0 ? (
                                    <div className="subtle">(No attendees yet)</div>
                                  ) : (
                                    <div style={{ display: "grid", gap: 8 }}>
                                      {attendees.map((a) => (
                                        <div
                                          key={a.id}
                                          className="row-between"
                                          style={{
                                            padding: "8px 10px",
                                            borderRadius: 12,
                                            border: "1px solid #e5e7eb",
                                            background: "white",
                                          }}
                                        >
                                          <div style={{ fontWeight: 750 }}>{a.attendee_name}</div>
                                          <IconButton title="Remove attendee" onClick={() => removeAttendee(a.id, m.id)}>
                                            ✕
                                          </IconButton>
                                        </div>
                                      ))}
                                    </div>
                                  )}

                                  <div style={{ height: 12 }} />

                                  <FieldLabel>Add attendee</FieldLabel>

                                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "end" }}>
                                    <div style={{ position: "relative" }}>
                                      <TextInput
                                        placeholder="Search employees..."
                                        value={attendeeTextByMeeting[m.id] ?? ""}
                                        onFocus={() => setAttendeeDropdownOpenByMeeting((cur) => ({ ...cur, [m.id]: true }))}
                                        onBlur={() => {
                                          // Allow click selection from the dropdown before closing.
                                          window.setTimeout(() => {
                                            setAttendeeDropdownOpenByMeeting((cur) => ({ ...cur, [m.id]: false }));
                                          }, 120);
                                        }}
                                        onChange={(e) => {
                                          const v = e.target.value;
                                          setAttendeeTextByMeeting((cur) => ({ ...cur, [m.id]: v }));
                                          // typing invalidates the previous selection
                                          setSelectedAttendeeEmployeeIdByMeeting((cur) => ({ ...cur, [m.id]: null }));
                                          setMeetingStatus("");
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") {
                                            e.preventDefault();
                                            void addAttendee(m.id);
                                          }
                                        }}
                                      />

                                      {attendeeDropdownOpenByMeeting[m.id] && (
                                        <div
                                          style={{
                                            position: "absolute",
                                            left: 0,
                                            right: 0,
                                            top: "calc(100% + 6px)",
                                            background: "white",
                                            border: "1px solid #e5e7eb",
                                            borderRadius: 12,
                                            boxShadow: "0 10px 24px rgba(0,0,0,0.08)",
                                            maxHeight: 240,
                                            overflow: "auto",
                                            zIndex: 50,
                                          }}
                                        >
                                          {(() => {
                                            const q = (attendeeTextByMeeting[m.id] ?? "").trim().toLowerCase();
                                            const rows = (allEmployees ?? [])
                                              .filter((e) => {
                                                const name = formatEmployeeName(e).toLowerCase();
                                                const nick = (e.nicknames ?? []).join(" ").toLowerCase();
                                                return !q || name.includes(q) || nick.includes(q);
                                              })
                                              .slice(0, 50);

                                            if (rows.length === 0) {
                                              return (
                                                <div className="subtle" style={{ padding: 10 }}>
                                                  (No matches)
                                                </div>
                                              );
                                            }

                                            return (
                                              <div style={{ display: "grid" }}>
                                                {rows.map((e) => {
                                                  const selected = (selectedAttendeeEmployeeIdByMeeting[m.id] ?? null) === e.id;
                                                  return (
                                                    <button
                                                      key={e.id}
                                                      type="button"
                                                      onMouseDown={(ev) => {
                                                        // Prevent input blur before we can set the selection.
                                                        ev.preventDefault();
                                                        const nm = formatEmployeeName(e);
                                                        setAttendeeTextByMeeting((cur) => ({ ...cur, [m.id]: nm }));
                                                        setSelectedAttendeeEmployeeIdByMeeting((cur) => ({ ...cur, [m.id]: e.id }));
                                                        setMeetingStatus("");
                                                      }}
                                                      style={{
                                                        textAlign: "left",
                                                        padding: "10px 12px",
                                                        border: "none",
                                                        background: selected ? "rgba(236, 72, 153, 0.08)" : "transparent",
                                                        cursor: "pointer",
                                                      }}
                                                    >
                                                      <div style={{ fontWeight: 700 }}>{formatEmployeeName(e)}</div>
                                                      <div className="subtle" style={{ marginTop: 2 }}>
                                                        {e.id}
                                                        {!e.is_active ? " • inactive" : ""}
                                                      </div>
                                                    </button>
                                                  );
                                                })}
                                              </div>
                                            );
                                          })()}
                                        </div>
                                      )}
                                    </div>

                                    <button
                                      type="button"
                                      className="btn btn-primary"
                                      onClick={() => addAttendee(m.id)}
                                      disabled={!!addingAttendeeByMeeting[m.id] || !selectedAttendeeEmployeeIdByMeeting[m.id]}
                                      title={!selectedAttendeeEmployeeIdByMeeting[m.id] ? "Select an employee from the list" : "Add attendee"}
                                    >
                                      {addingAttendeeByMeeting[m.id] ? "Adding…" : "Add"}
                                    </button>
                                  </div>

                                  <div className="subtle" style={{ marginTop: 8 }}>
                                    Start typing to filter. Select an employee from the list, then click Add.
                                  </div>
                                </div>

                                {/* Documents */}
                                <div style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
                                  <div className="row-between" style={{ gap: 10 }}>
                                    <div style={{ fontWeight: 900 }}>Documents</div>
                                    <div className="subtle">
                                      Stored in R2 under <code>meetings/</code>
                                    </div>
                                  </div>

                                  <div style={{ height: 10 }} />

                                  <input
                                    type="file"
                                    multiple
                                    disabled={uploadingMeetingId === m.id}
                                    onChange={(e) => {
                                      void handleUploadMeetingDocs(m.id, e.target.files);
                                      e.currentTarget.value = "";
                                    }}
                                    style={{
                                      width: "100%",
                                      padding: "10px 12px",
                                      borderRadius: 12,
                                      border: "1px solid #e5e7eb",
                                      background: "white",
                                    }}
                                  />

                                  {docs.length === 0 ? (
                                    <div className="subtle" style={{ marginTop: 10 }}>
                                      (No documents)
                                    </div>
                                  ) : (
                                    <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                                      {docs.map((d) => (
                                        <div
                                          key={d.id}
                                          className="row-between"
                                          style={{
                                            padding: "8px 10px",
                                            borderRadius: 12,
                                            border: "1px solid #e5e7eb",
                                            background: "white",
                                          }}
                                        >
                                          <div style={{ minWidth: 0 }}>
                                            <div style={{ fontWeight: 750, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                              📄 {d.name}
                                            </div>
                                            <div className="subtle" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                              {d.mime_type} · {Math.round((d.size_bytes || 0) / 1024)} KB
                                            </div>
                                          </div>

                                          <div className="row" style={{ gap: 8 }}>
                                            <IconButton title="Preview" onClick={() => openPreview(d)}>
                                              👁️
                                            </IconButton>
                                            <IconButton
                                              title="Download"
                                              onClick={async () => {
                                                try {
                                                  const url = await getSignedMeetingDownloadUrl(d.id, "attachment");
                                                  window.location.href = url;
                                                } catch (e: any) {
                                                  setMeetingStatus("Download error: " + (e?.message ?? "unknown"));
                                                }
                                              }}
                                            >
                                              ⬇️
                                            </IconButton>
                                            <IconButton title="Delete" onClick={() => deleteMeetingDoc(d.id, m.id)}>
                                              🗑️
                                            </IconButton>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* MANAGE MEETING TYPES MODAL */}
                  {showManageMeetingTypes ? (
                    <div
                      role="dialog"
                      aria-modal="true"
                      style={{
                        position: "fixed",
                        inset: 0,
                        background: "rgba(0,0,0,0.55)",
                        zIndex: 121,
                        display: "flex",
                        flexDirection: "column",
                      }}
                      onMouseDown={(e) => {
                        if (e.currentTarget === e.target) setShowManageMeetingTypes(false);
                      }}
                    >
                      <div
                        style={{
                          background: "white",
                          width: "min(920px, 100%)",
                          margin: "48px auto",
                          borderRadius: 16,
                          overflow: "hidden",
                          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
                          display: "flex",
                          flexDirection: "column",
                          maxHeight: "calc(100vh - 96px)",
                        }}
                      >
                        <div className="row-between" style={{ padding: 12, borderBottom: "1px solid #e5e7eb" }}>
                          <div>
                            <div style={{ fontWeight: 950, fontSize: 16 }}>Manage meeting types</div>
                            <div className="subtle">Add, edit, or delete types (Esc to close).</div>
                          </div>

                          <button type="button" className="btn" onClick={() => setShowManageMeetingTypes(false)} title="Close (Esc)">
                            ✕
                          </button>
                        </div>

                        <div style={{ padding: 14, overflow: "auto" }}>
                          {meetingTypesError ? (
                            <div style={{ padding: 12, borderRadius: 12, background: "rgba(176,0,32,0.08)", color: "#b00020", fontWeight: 800, marginBottom: 12 }}>
                              {meetingTypesError}
                            </div>
                          ) : null}

                          <div style={{ padding: 12, borderRadius: 12, border: "1px solid #e5e7eb" }}>
                            <div style={{ fontWeight: 900, marginBottom: 8 }}>Add new type</div>
                            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                              <TextInput
                                placeholder="Type name"
                                value={newMeetingTypeName}
                                onChange={(e) => setNewMeetingTypeName(e.target.value)}
                                style={{ width: "min(520px, 100%)" }}
                              />
                              <button type="button" className="btn btn-primary" onClick={addMeetingType} disabled={!newMeetingTypeName.trim()}>
                                Add
                              </button>
                            </div>
                            <div className="subtle" style={{ marginTop: 8 }}>
                              New types default to active and get a sort_order after the current max.
                            </div>
                          </div>

                          <div style={{ height: 14 }} />

                          {meetingTypes.length === 0 ? (
                            <div className="subtle">(No meeting types.)</div>
                          ) : (
                            <div style={{ display: "grid", gap: 10 }}>
                              {meetingTypes.map((t) => {
                                const d = meetingTypeEdits[t.id] ?? { name: t.name ?? "" };
                                const saving = !!savingMeetingTypeIds[t.id];

                                return (
                                  <div key={t.id} style={{ padding: 12, borderRadius: 12, border: "1px solid #e5e7eb" }}>
                                    <div
                                      style={{
                                        display: "grid",
                                        gridTemplateColumns: "1fr auto auto",
                                        gap: 10,
                                        alignItems: "end",
                                      }}
                                    >
                                      <div>
                                        <div className="subtle" style={{ fontWeight: 800, marginBottom: 6 }}>
                                          Name
                                        </div>
                                        <TextInput
                                          value={d.name}
                                          onChange={(e) =>
                                            setMeetingTypeEdits((cur) => ({
                                              ...cur,
                                              [t.id]: { ...d, name: e.target.value },
                                            }))
                                          }
                                        />
                                      </div>

                                      <button type="button" className="btn btn-primary" onClick={() => saveMeetingType(t.id)} disabled={saving}>
                                        {saving ? "Saving…" : "Save"}
                                      </button>

                                      <button type="button" className="btn" onClick={() => deleteMeetingType(t.id)} title="Delete meeting type">
                                        🗑️
                                      </button>
                                    </div>

                                    <div className="subtle" style={{ marginTop: 8 }}>
                                      id: <code>{t.id}</code>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {/* PREVIEW MODAL */}
                  {previewOpen && previewDoc ? (
                    <div
                      role="dialog"
                      aria-modal="true"
                      style={{
                        position: "fixed",
                        inset: 0,
                        background: "rgba(0,0,0,0.55)",
                        zIndex: 120,
                        display: "flex",
                        flexDirection: "column",
                      }}
                      onMouseDown={(e) => {
                        if (e.currentTarget === e.target) closePreview();
                      }}
                    >
                      <div
                        style={{
                          background: "white",
                          height: "100%",
                          width: "100%",
                          display: "flex",
                          flexDirection: "column",
                        }}
                      >
                        <div
                          className="row-between"
                          style={{
                            padding: 12,
                            borderBottom: "1px solid #e5e7eb",
                            gap: 10,
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 900 }}>{previewDoc.name}</div>
                            <div className="subtle">
                              {previewMode === "office"
                                ? "Office preview"
                                : previewMode === "pdf"
                                ? "PDF preview"
                                : previewMode === "image"
                                ? "Image preview"
                                : previewMode === "csv"
                                ? "CSV preview"
                                : previewMode === "text"
                                ? "Text preview"
                                : previewMode === "video"
                                ? "Video preview"
                                : previewMode === "audio"
                                ? "Audio preview"
                                : "Preview"}
                            </div>
                          </div>

                          <button type="button" className="btn" onClick={closePreview} title="Close (Esc)">
                            ✕
                          </button>
                        </div>

                        <div style={{ flex: 1, minHeight: 0, background: "#111" }}>
                          {previewLoading ? (
                            <div style={{ padding: 14, color: "white" }}>Loading preview…</div>
                          ) : previewMode === "office" ? (
                            previewSignedUrl ? (
                              <iframe src={officeEmbedUrl} style={{ width: "100%", height: "100%", border: 0, background: "white" }} allowFullScreen />
                            ) : (
                              <div style={{ padding: 14, color: "white" }}>No preview URL.</div>
                            )
                          ) : previewMode === "pdf" ? (
                            previewSignedUrl ? (
                              <div style={{ width: "100%", height: "100%", background: "white" }}>
                                <PdfCanvasPreview url={previewSignedUrl} />
                              </div>
                            ) : (
                              <div style={{ padding: 14, color: "white" }}>PDF preview unavailable.</div>
                            )
                          ) : previewMode === "image" ? (
                            previewSignedUrl ? (
                              <div style={{ height: "100%", width: "100%", display: "flex", justifyContent: "center", alignItems: "center" }}>
                                <img
                                  src={previewSignedUrl}
                                  alt={previewDoc.name}
                                  style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", background: "white" }}
                                />
                              </div>
                            ) : (
                              <div style={{ padding: 14, color: "white" }}>Image preview unavailable.</div>
                            )
                          ) : previewMode === "csv" ? (
                            <div style={{ height: "100%", background: "white", display: "flex", flexDirection: "column" }}>
                              <div style={{ padding: 12, borderBottom: "1px solid #e5e7eb" }}>
                                {previewCsvError ? (
                                  <div className="subtle" style={{ color: "#b00020", fontWeight: 700 }}>
                                    CSV preview failed: {previewCsvError}
                                  </div>
                                ) : previewCsvRows.length === 0 ? (
                                  <div className="subtle">(No CSV data)</div>
                                ) : (
                                  <div className="subtle">
                                    Showing up to {csvRenderMeta.rowsToShow} rows and {csvRenderMeta.colsToShow} columns
                                    {csvRenderMeta.rowCount > csvRenderMeta.rowsToShow || csvRenderMeta.maxCols > csvRenderMeta.colsToShow ? " (truncated)" : ""}.
                                  </div>
                                )}
                              </div>

                              <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                                {!previewCsvError && previewCsvRows.length > 0 ? (
                                  <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                                    <thead>
                                      <tr>
                                        {previewCsvRows[0].slice(0, csvRenderMeta.colsToShow).map((h, idx) => (
                                          <th key={idx} style={{ position: "sticky", top: 0, background: "white", zIndex: 1, textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>
                                            <div style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                              {h || <span className="subtle">(empty)</span>}
                                            </div>
                                          </th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {previewCsvRows.slice(1, csvRenderMeta.rowsToShow).map((r, ridx) => (
                                        <tr key={ridx}>
                                          {r.slice(0, csvRenderMeta.colsToShow).map((cell, cidx) => (
                                            <td key={cidx} style={{ padding: 8, borderBottom: "1px solid #f3f4f6" }}>
                                              <div title={cell} style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                {cell}
                                              </div>
                                            </td>
                                          ))}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                ) : null}
                              </div>
                            </div>
                          ) : previewMode === "text" ? (
                            previewSignedUrl ? (
                              <iframe src={previewSignedUrl} style={{ width: "100%", height: "100%", border: 0, background: "white" }} />
                            ) : (
                              <div style={{ padding: 14, color: "white" }}>Text preview unavailable.</div>
                            )
                          ) : previewMode === "video" ? (
                            previewSignedUrl ? (
                              <div style={{ height: "100%", width: "100%", display: "flex", justifyContent: "center", alignItems: "center" }}>
                                <video
                                  controls
                                  controlsList="nodownload noplaybackrate noremoteplayback"
                                  disablePictureInPicture
                                  disableRemotePlayback
                                  onContextMenu={(e) => e.preventDefault()}
                                  src={previewSignedUrl}
                                  style={{ width: "min(1100px, 100%)", height: "min(700px, 100%)", background: "black" }}
                                />
                              </div>
                            ) : (
                              <div style={{ padding: 14, color: "white" }}>Video preview unavailable.</div>
                            )
                          ) : previewMode === "audio" ? (
                            previewSignedUrl ? (
                              <div style={{ padding: 18, background: "white" }}>
                                <audio controls src={previewSignedUrl} style={{ width: "100%" }} />
                              </div>
                            ) : (
                              <div style={{ padding: 14, color: "white" }}>Audio preview unavailable.</div>
                            )
                          ) : (
                            <div style={{ padding: 14, color: "white" }}>
                              No in-app preview for this file type.
                              <div className="subtle" style={{ marginTop: 10, color: "rgba(255,255,255,0.8)" }}>
                                Use Download to view it locally.
                              </div>

                              <div style={{ marginTop: 10 }}>
                                <button
                                  type="button"
                                  className="btn btn-primary"
                                  onClick={async () => {
                                    try {
                                      const url = await getSignedMeetingDownloadUrl(previewDoc.id, "attachment");
                                      window.location.href = url;
                                    } catch (e: any) {
                                      setMeetingStatus("Download error: " + (e?.message ?? "unknown"));
                                    }
                                  }}
                                >
                                  Download
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
              {activeTab === "documents" && (
                            <>
                              <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
                                <div className="row-between" style={{ gap: 10, alignItems: "center" }}>
                                  <div style={{ fontWeight: 800, fontSize: 26 }}>Documents</div>
                                  <div className="subtle">Stored in R2 under hr/employees/</div>
                                </div>

                                <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                                  <label className="doc-upload">
                                    <input
                                      type="file"
                                      multiple
                                      onChange={(e) => void handleUploadEmployeeDocs(e.target.files)}
                                      disabled={uploadingEmployeeDocs}
                                    />
                                    <div className="subtle">Upload one or more files.</div>
                                  </label>
                                </div>

                                {employeeDocsStatus ? (
                                  <span className="subtle" style={{ fontWeight: 800 }}>
                                    {employeeDocsStatus}
                                  </span>
                                ) : null}
                              </div>

                              <div style={{ height: 12 }} />

                              {uploadingEmployeeDocs ? (
                                <div className="subtle">Loading documents…</div>
                              ) : employeeDocs.length === 0 ? (
                                <div className="subtle">(No documents yet.)</div>
                              ) : (
                                <div style={{ display: "grid", gap: 10 }}>
                                  {employeeDocs.map((doc) => (
                                    <div
                                      key={doc.id}
                                      className="row-between"
                                      style={{
                                        border: "1px solid #e5e7eb",
                                        borderRadius: 18,
                                        padding: 12,
                                        gap: 12,
                                        alignItems: "center",
                                      }}
                                    >
                                      <div className="row" style={{ gap: 12, alignItems: "center" }}>
                                        <div
                                          style={{
                                            width: 36,
                                            height: 36,
                                            borderRadius: 12,
                                            background: "#f3f4f6",
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "center",
                                            fontSize: 18,
                                          }}
                                        >
                                          <span aria-hidden>📄</span>
                                        </div>
                                        <div>
                                          <div style={{ fontWeight: 900, fontSize: 22, lineHeight: 1.1 }}>{doc.name}</div>
                                          <div className="subtle">
                                            {doc.mime_type || "—"} • {Math.round((doc.size_bytes ?? 0) / 1024)} KB
                                          </div>
                                        </div>
                                      </div>

                                      <div className="row" style={{ gap: 10 }}>
                                        <IconButton title="Preview" onClick={() => void openEmpPreview(doc)}>
                                          👁️
                                        </IconButton>

                                        <IconButton
                                          title="Download"
                                          onClick={() => {
                                            void (async () => {
                                              try {
                                                const url = await getSignedEmployeeDocDownloadUrl(doc.id, "attachment");
                                                window.open(url, "_blank", "noopener,noreferrer");
                                              } catch (e: any) {
                                                setEmployeeDocsStatus("Download error: " + (e?.message ?? "unknown"));
                                              }
                                            })();
                                          }}
                                        >
                                          ⬇️
                                        </IconButton>

                                        <IconButton
                                          title="Delete"
                                          onClick={() => {
                                            void (async () => {
                                              const ok = confirm(`Delete "${doc.name}"? This cannot be undone.`);
                                              if (!ok) return;
                                              await deleteEmployeeDoc(doc.id);
                                            })();
                                          }}
                                        >
                                          🗑️
                                        </IconButton>
                                      </div>

                                    </div>
                                  ))}
                                </div>
                              )}
                            </>
              )}
              {/* =========================
    EMPLOYEE DOCUMENT PREVIEW MODAL
========================= */}
              {empPreviewOpen ? (
                <div
                  role="dialog"
                  aria-modal="true"
                  style={{
                    position: "fixed",
                    inset: 0,
                    background: "rgba(0,0,0,0.55)",
                    zIndex: 300,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 14,
                  }}
                  onMouseDown={(e) => {
                    // click outside closes
                    if (e.target === e.currentTarget) closeEmpPreview();
                  }}
                >
                  <div
                    className="card"
                    style={{
                      width: "min(1180px, 100%)",
                      height: "min(860px, 90vh)",
                      padding: 14,
                      borderRadius: 16,
                      display: "grid",
                      gridTemplateRows: "auto 1fr",
                      overflow: "hidden",
                    }}
                  >
                    <div className="row-between" style={{ gap: 10, alignItems: "center" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 950, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {empPreviewDoc?.name ?? "Document Preview"}
                        </div>
                        <div className="subtle" style={{ marginTop: 2, fontSize: 12 }}>
                          {empPreviewMode.toUpperCase()} preview
                        </div>
                      </div>

                      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="btn"
                          onClick={async () => {
                            if (!empPreviewDoc) return;
                            try {
                              const url = await getSignedEmployeeDocDownloadUrl(empPreviewDoc.id, "attachment");
                              window.open(url, "_blank", "noopener,noreferrer");
                            } catch (e: any) {
                              setEmployeeDocsStatus("Download error: " + (e?.message ?? "unknown"));
                            }
                          }}
                          disabled={!empPreviewDoc}
                          style={{ padding: "6px 10px" }}
                        >
                          Download
                        </button>

                        <button type="button" className="btn" onClick={closeEmpPreview} style={{ padding: "6px 10px" }}>
                          ✕
                        </button>
                      </div>
                    </div>

                    <div style={{ marginTop: 10, borderRadius: 14, overflow: "hidden", border: "1px solid #e5e7eb", background: "#f6f6f6" }}>
                      {empPreviewLoading ? (
                        <div style={{ padding: 14, fontWeight: 800 }}>Loading preview…</div>
                      ) : !empPreviewSignedUrl ? (
                        <div style={{ padding: 14, fontWeight: 800, color: "#b00020" }}>Missing signed URL.</div>
                      ) : empPreviewMode === "office" ? (
                        <iframe
                          title="Office preview"
                          src={empOfficeEmbedUrl}
                          style={{ width: "100%", height: "100%", border: 0, background: "white" }}
                          allow="clipboard-read; clipboard-write"
                        />
                      ) : empPreviewMode === "pdf" ? (
                        <div style={{ width: "100%", height: "100%" }}>
                          <PdfCanvasPreview url={empPreviewSignedUrl} />
                        </div>
                      ) : empPreviewMode === "image" ? (
                        <div style={{ width: "100%", height: "100%", overflow: "auto", padding: 12 }}>
                          <img
                            src={empPreviewSignedUrl}
                            alt={empPreviewDoc?.name ?? "image"}
                            style={{ maxWidth: "100%", height: "auto", display: "block", borderRadius: 12, background: "white" }}
                          />
                        </div>
                      ) : empPreviewMode === "csv" ? (
                        <div style={{ width: "100%", height: "100%", overflow: "auto", padding: 12 }}>
                          {empPreviewCsvError ? (
                            <div style={{ padding: 12, background: "white", color: "#b00020", fontWeight: 800 }}>
                              CSV preview failed: {empPreviewCsvError}
                            </div>
                          ) : (
                            <div style={{ background: "white", borderRadius: 12, overflow: "hidden", boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.08)" }}>
                              <div style={{ padding: 10, borderBottom: "1px solid #eee", fontWeight: 900 }}>
                                Rows: {empCsvRenderMeta.rowCount.toLocaleString()} • Cols: {empCsvRenderMeta.maxCols.toLocaleString()} (showing up to{" "}
                                {empCsvRenderMeta.colsToShow}×{empCsvRenderMeta.rowsToShow})
                              </div>
                              <div style={{ overflow: "auto" }}>
                                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                                  <tbody>
                                    {(empPreviewCsvRows ?? []).slice(0, empCsvRenderMeta.rowsToShow).map((r, ri) => (
                                      <tr key={ri}>
                                        {Array.from({ length: empCsvRenderMeta.colsToShow }).map((_, ci) => (
                                          <td
                                            key={ci}
                                            style={{
                                              border: "1px solid #eee",
                                              padding: "6px 8px",
                                              fontSize: 12,
                                              whiteSpace: "nowrap",
                                            }}
                                          >
                                            {r?.[ci] ?? ""}
                                          </td>
                                        ))}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </div>
                      ) : empPreviewMode === "video" ? (
                        <video src={empPreviewSignedUrl} controls style={{ width: "100%", height: "100%", background: "black" }} />
                      ) : empPreviewMode === "audio" ? (
                        <div style={{ padding: 14 }}>
                          <audio src={empPreviewSignedUrl} controls style={{ width: "100%" }} />
                        </div>
                      ) : (
                        // text + unknown fallback: iframe works fine for txt/md/json/log in most browsers
                        <iframe title="Document preview" src={empPreviewSignedUrl} style={{ width: "100%", height: "100%", border: 0, background: "white" }} />
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
              {/* =========================
                  MANAGE CAMPUSES MODAL
              ========================= */}
              {showManageCampuses ? (
                <div
                  role="dialog"
                  aria-modal="true"
                  style={{
                    position: "fixed",
                    inset: 0,
                    background: "rgba(0,0,0,0.55)",
                    zIndex: 250,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 14,
                  }}
                  onMouseDown={(e) => {
                    if (e.target === e.currentTarget) setShowManageCampuses(false);
                  }}
                >
                  <div className="card" style={{ width: "min(900px, 100%)", padding: 16, borderRadius: 16 }}>
                    <div className="row-between" style={{ gap: 10, alignItems: "center" }}>
                      <div>
                        <div style={{ fontWeight: 950, fontSize: 16 }}>Manage Campuses</div>
                        <div className="subtle" style={{ marginTop: 2 }}>
                          Add, rename, or remove campuses.
                        </div>
                      </div>
                      <button className="btn" type="button" onClick={() => setShowManageCampuses(false)}>
                        ✕
                      </button>
                    </div>

                    <div style={{ height: 12 }} />

                    <div style={{ border: "1px solid #e5e7eb", borderRadius: 14, overflow: "hidden" }}>
                      <div style={{ maxHeight: 360, overflow: "auto" }}>
                        {campuses.length === 0 ? (
                          <div style={{ padding: 12 }} className="subtle">
                            No campuses yet.
                          </div>
                        ) : (
                          campuses.map((c) => (
                            <div
                              key={c.id}
                              className="row-between"
                              style={{
                                padding: 10,
                                borderTop: "1px solid #f3f4f6",
                                alignItems: "center",
                                gap: 10,
                              }}
                            >
                              <div style={{ flex: 1, minWidth: 220 }}>
                                <TextInput
                                  value={campusEdits[c.id] ?? c.name}
                                  onChange={(e) => setCampusEdits((m) => ({ ...m, [c.id]: e.target.value }))}
                                />
                              </div>
                              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                                <button className="btn" type="button" disabled={campusBusy} onClick={() => void saveCampusName(c.id)}>
                                  Save
                                </button>
                                <button className="btn" type="button" disabled={campusBusy} onClick={() => void deleteCampus(c.id)}>
                                  Delete
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div style={{ height: 12 }} />

                    <div style={{ border: "1px dashed #e5e7eb", borderRadius: 14, padding: 12 }}>
                      <div style={{ fontWeight: 900, marginBottom: 8 }}>Add campus</div>
                      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                        <TextInput
                          value={newCampusName}
                          onChange={(e) => setNewCampusName(e.target.value)}
                          placeholder="Campus name"
                          style={{ flex: 1, minWidth: 240 }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void addCampus();
                            }
                          }}
                        />
                        <button className="btn btn-primary" type="button" disabled={campusBusy} onClick={() => void addCampus()}>
                          Add
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
              {/* =========================
                  MANAGE EVENT TYPES MODAL
              ========================= */}
              {showManageEventTypes ? (
                <div
                  role="dialog"
                  aria-modal="true"
                  style={{
                    position: "fixed",
                    inset: 0,
                    background: "rgba(0,0,0,0.55)",
                    zIndex: 250,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 14,
                  }}
                  onMouseDown={(e) => {
                    if (e.target === e.currentTarget) setShowManageEventTypes(false);
                  }}
                >
                  <div className="card" style={{ width: "min(900px, 100%)", padding: 16, borderRadius: 16 }}>
                    <div className="row-between" style={{ gap: 10, alignItems: "center" }}>
                      <div>
                        <div style={{ fontWeight: 950, fontSize: 16 }}>Manage Event Types</div>
                        <div className="subtle" style={{ marginTop: 2 }}>
                          Add, rename, or remove event types.
                        </div>
                      </div>
                      <button className="btn" type="button" onClick={() => setShowManageEventTypes(false)}>
                        ✕
                      </button>
                    </div>

                    <div style={{ height: 12 }} />

                    <div style={{ border: "1px solid #e5e7eb", borderRadius: 14, overflow: "hidden" }}>
                      <div style={{ maxHeight: 360, overflow: "auto" }}>
                        {eventTypes.length === 0 ? (
                          <div style={{ padding: 12 }} className="subtle">
                            No event types yet.
                          </div>
                        ) : (
                          eventTypes.map((t) => (
                            <div
                              key={t.id}
                              className="row-between"
                              style={{
                                padding: 10,
                                borderTop: "1px solid #f3f4f6",
                                alignItems: "center",
                                gap: 10,
                              }}
                            >
                              <div style={{ flex: 1, minWidth: 220 }}>
                                <TextInput
                                  value={eventTypeEdits[t.id] ?? t.name}
                                  onChange={(e) => setEventTypeEdits((m) => ({ ...m, [t.id]: e.target.value }))}
                                />
                              </div>
                              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                                <button className="btn" type="button" disabled={eventTypeBusy} onClick={() => void saveEventTypeName(t.id)}>
                                  Save
                                </button>
                                <button className="btn" type="button" disabled={eventTypeBusy} onClick={() => void deleteEventType(t.id)}>
                                  Delete
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div style={{ height: 12 }} />

                    <div style={{ border: "1px dashed #e5e7eb", borderRadius: 14, padding: 12 }}>
                      <div style={{ fontWeight: 900, marginBottom: 8 }}>Add event type</div>
                      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                        <TextInput
                          value={newEventTypeName}
                          onChange={(e) => setNewEventTypeName(e.target.value)}
                          placeholder="Event type name"
                          style={{ flex: 1, minWidth: 240 }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void addEventType();
                            }
                          }}
                        />
                        <button className="btn btn-primary" type="button" disabled={eventTypeBusy} onClick={() => void addEventType()}>
                          Add
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
