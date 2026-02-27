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


type EmployeeTimeOffRequestRow = {
  id: string;
  employee_id: string;
  occurred_on: string; // YYYY-MM-DD
  hours_requested: number;
  notes: string | null;
  created_at: string;
};

type EmployeeTimeOffDayRequestRow = {
  id: string;
  employee_id: string;
  occurred_on: string; // YYYY-MM-DD
  notes: string | null;
  created_at: string;
};

type EmployeeRow = {
  id: string;
  legal_first_name: string;
  legal_middle_name: string | null;
  legal_last_name: string;

  // Employment dates (DATE)
  start_date?: string;
  end_date?: string | null;

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

  time_off_hours_requested?: number;

  time_off_days_requested?: number;

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
    start_date: raw.start_date ?? undefined,
    end_date: raw.end_date ?? null,
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
    time_off_hours_requested: raw.time_off_hours_requested == null ? 0 : Number(raw.time_off_hours_requested),
    time_off_days_requested: raw.time_off_days_requested == null ? 0 : Number(raw.time_off_days_requested),

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
      start_date,
      end_date,
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
      time_off_hours_requested,
      time_off_days_requested,
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

type ReviewQuestionKind = "question" | "section";

type ReviewQuestion = {
  id: string;
  form_id: string;
  question_text: string;
  sort_order: number;
  is_active: boolean;
  kind?: ReviewQuestionKind;
  created_at: string;
  updated_at: string;
};

type HrReview = {
  id: string;
  employee_id: string;
  form_id: string;
  form_type: ReviewFormType;
  period_year: number;
  period_month: number | null;
  notes: string;
  published: boolean;
  attendance_points_snapshot: number | null;
  created_at: string;
  updated_at: string;
};

type HrReviewAnswer = {
  review_id: string;
  question_id: string;
  score: number | null;
  note?: string | null;
  created_at: string;
  updated_at: string;
};

function clampScore(n: any, scaleMax: number) {
  // Allow a true "unset" score (stored as NULL in hr_review_answers.score)
  if (n === "" || n === null || typeof n === "undefined") return null;
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


function escapeHtml(s: string) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

type PrintRow =
  | { kind: "section"; title: string; avg: number | null }
  | { kind: "question"; text: string; score: number | null };

function buildAnnualPrintRows(questions: ReviewQuestion[], answersByQ: Map<string, HrReviewAnswer>, scaleMax: number) {
  const rows: PrintRow[] = [];
  let bucket: Array<number> = [];

  const flushAvgIntoLastSection = () => {
    // Find the most recent section header row and attach avg
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.kind === "section") {
        const avg = bucket.length ? bucket.reduce((a, b) => a + b, 0) / bucket.length : null;
        (r as any).avg = avg === null ? null : round1dp(avg);
        bucket = [];
        return;
      }
    }
    // No explicit section header yet; ignore
    bucket = [];
  };

  for (const q of questions) {
    const kind = (q.kind ?? "question") as any;
    if (kind === "section") {
      // before starting new section, flush avg for previous section
      flushAvgIntoLastSection();
      rows.push({ kind: "section", title: q.question_text, avg: null });
      continue;
    }
    const ans = answersByQ.get(q.id);
    const score = typeof ans?.score === "number" ? clampScore(ans.score, scaleMax) : null;
    if (typeof score === "number") bucket.push(score);
    rows.push({ kind: "question", text: q.question_text, score });
  }

  // flush avg at end
  flushAvgIntoLastSection();
  return rows;
}

function buildAnnualPrintHtml(opts: {
  year: number;
  employeeName: string;
  jobLevelName: string;
  attendancePoints: number;
  performanceAvg: number | null;
  rows: PrintRow[];
  overallNotes: string;
}) {
  const today = new Date();
  const dateStr = today.toLocaleDateString();

  const perfAvg = opts.performanceAvg === null ? "—" : formatOneDecimal(opts.performanceAvg);
  const total = opts.performanceAvg === null ? null : opts.attendancePoints + round1dp(opts.performanceAvg);
  const inc = total === null ? "—" : `${recommendedIncreasePercent(total)}%`;
  const totalStr = total === null ? "—" : formatOneDecimal(total);

  const rowsHtml = opts.rows
    .map((r) => {
      if (r.kind === "section") {
        const avg = r.avg === null ? "—" : formatOneDecimal(r.avg);
        return `
          <div class="sec">
            <div class="sec-title">${escapeHtml(r.title)}</div>
            <div class="sec-avg">Section Avg: ${escapeHtml(avg)}</div>
          </div>
        `;
      }
      const s = r.score === null ? "—" : String(r.score);
      return `
        <div class="qrow">
          <div class="qtext">${escapeHtml(r.text)}</div>
          <div class="qscore">${escapeHtml(s)}</div>
        </div>
      `;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${opts.year} Performance Evaluation</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 28px; color: #111; }
    h1 { font-size: 22px; margin: 0 0 6px; }
    .sub { margin: 0 0 14px; color: #444; }
    .meta { margin: 0 0 16px; }
    .meta div { margin: 2px 0; }
    .sec { background: #fff4c2; padding: 10px 12px; border-radius: 10px; margin: 14px 0 8px; display:flex; justify-content:space-between; gap: 12px; align-items:flex-end; }
    .sec-title { font-weight: 800; }
    .sec-avg { color:#333; font-weight: 700; font-size: 13px; white-space: nowrap; }
    .qrow { display:flex; justify-content:space-between; gap: 14px; padding: 6px 2px; }
    .qtext { flex: 1; }
    .qscore { width: 70px; text-align: right; font-weight: 800; }
    .hr { height:1px; background:#ddd; margin: 14px 0; }
    .overall { display:flex; justify-content:space-between; font-weight: 900; margin-top: 10px; }
    .box { border:1px solid #ddd; border-radius: 12px; padding: 12px; margin-top: 14px; }
    .box h2 { margin:0 0 8px; font-size: 16px; }
    .mini { font-size: 12px; color:#333; }
    table { border-collapse: collapse; margin-top: 10px; width: 420px; }
    th, td { border: 1px solid #333; padding: 6px 8px; text-align: center; }
    .sig { margin-top: 22px; }
    .sigline { margin: 16px 0 6px; }
  </style>
</head>
<body>
  <h1>${opts.year} Performance Evaluation</h1>
  <p class="sub">${escapeHtml(opts.jobLevelName)}</p>
  <div class="meta">
    <div><b>Employee Name:</b> ${escapeHtml(opts.employeeName)}</div>
    <div><b>Date:</b> ${escapeHtml(dateStr)}</div>
  </div>

  ${rowsHtml}

  <div class="overall">
    <div>Overall Rating (Average):</div>
    <div>${escapeHtml(perfAvg)}</div>
  </div>

  <div class="box">
    <h2>Additional Notes &amp; Plan of Action</h2>
    <div><b>Attendance Score:</b> ${escapeHtml(String(opts.attendancePoints))}</div>
    <div><b>Performance:</b> ${escapeHtml(perfAvg)}</div>
    <div><b>Total:</b> ${escapeHtml(totalStr)} &nbsp;&nbsp; <b>Recommended Increase:</b> ${escapeHtml(inc)}</div>
    <div class="hr"></div>
    <div style="white-space:pre-wrap;">${escapeHtml(opts.overallNotes || "")}</div>

    <div class="hr"></div>
    <div class="mini">
      <div><b>5</b> = Exceeds Expectations</div>
      <div><b>4</b> = Meets Expectations</div>
      <div><b>3</b> = Improving</div>
      <div><b>2</b> = Below Expectations</div>
      <div><b>1</b> = Probation</div>
    </div>

    <table>
      <thead>
        <tr><th>Attendance</th><th>Performance</th><th>Total</th><th>Increase</th></tr>
      </thead>
      <tbody>
        <tr><td>3</td><td>5</td><td>8</td><td>4%</td></tr>
        <tr><td>3</td><td>4</td><td>7</td><td>3%</td></tr>
        <tr><td>3</td><td>3</td><td>6</td><td>2%</td></tr>
        <tr><td>3</td><td>2</td><td>5</td><td>0%</td></tr>
      </tbody>
    </table>
  </div>

  <div class="sig">
    <div class="sigline"><b>Teacher Signature</b></div>
    <div>______________________________</div>

    <div class="sigline"><b>Supervisor Signature</b></div>
    <div>______________________________</div>
  </div>
</body>
</html>`;
}



function reviewMostRecentAt(r: HrReview) {
  const t = r.updated_at || r.created_at;
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

function EmployeePerformanceReviewsTab({
  employeeId,
  attendancePoints,
  viewerRole,
  readOnly = false,
}: {
  employeeId: string;
  /** Snapshot source for new annual reviews. We do NOT overwrite existing snapshots. */
  attendancePoints: number | null;
  viewerRole?: string | null;
  readOnly?: boolean;
}) {
  const now = useMemo(() => new Date(), []);
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const canEdit = !readOnly;

  const [status, setStatus] = useState<string>("");

  // Toggle display type (default monthly)
  const [showAnnual, setShowAnnual] = useState<boolean>(false);

  // Forms + questions (read-only here)
  const [forms, setForms] = useState<HrReviewForm[]>([]);
  const [questions, setQuestions] = useState<ReviewQuestion[]>([]);

  // ---- Question editor modal (edit annual/monthly question bank)
  type EditQuestion = { id: string; question_text: string; sort_order: number; kind: ReviewQuestionKind };

  const [manageOpen, setManageOpen] = useState(false);
  const [manageType, setManageType] = useState<ReviewFormType | "">("");
  const [showArchivedForms, setShowArchivedForms] = useState(false);
  const [newFormTitle, setNewFormTitle] = useState("");
  const [creatingForm, setCreatingForm] = useState(false);

  // ---- Question editor modal (edit questions for a specific form)
  const [editOpen, setEditOpen] = useState(false);
  const [editFormId, setEditFormId] = useState<string>("");
  const [editQuestions, setEditQuestions] = useState<EditQuestion[]>([]);
  const editRef = useRef<HTMLDivElement | null>(null);

  const closeEditQuestions = () => {
    setEditOpen(false);
    setEditFormId("");
    setEditQuestions([]);
  };


  // Existing reviews for this employee
  const [reviews, setReviews] = useState<HrReview[]>([]);
  const [reviewAverages, setReviewAverages] = useState<Record<string, number | null>>({});
  const [reviewTotalPoints, setReviewTotalPoints] = useState<Record<string, number | null>>({});
  const [reviewAnswerCounts, setReviewAnswerCounts] = useState<Record<string, number | null>>({});


  // Modal state
  const [open, setOpen] = useState(false);
  const [formType, setFormType] = useState<ReviewFormType>("monthly");
  const [selectedFormId, setSelectedFormId] = useState<string>("");
  const [year, setYear] = useState<number>(currentYear);
  const [month, setMonth] = useState<number>(currentMonth);

  const [reviewId, setReviewId] = useState<string>("");
  const [values, setValues] = useState<Record<string, number | null>>({});
  const [answerNotes, setAnswerNotes] = useState<Record<string, string>>({}); // per-question notes


  const initialAnsweredIdsRef = useRef<Set<string>>(new Set());
  const [publishingReviewId, setPublishingReviewId] = useState<string>("");
  const [reviewNotes, setReviewNotes] = useState<string>("");
  const modalRef = useRef<HTMLDivElement | null>(null);

  const formById = useMemo(() => {
    const m = new Map<string, HrReviewForm>();
    for (const f of forms) m.set(f.id, f);
    return m;
  }, [forms]);

  const formsByType = useMemo(() => {
    const annual = (forms ?? [])
      .filter((f) => f.form_type === "annual")
      .slice()
      .sort((a, b) => {
        const ai = a.is_active ? 1 : 0;
        const bi = b.is_active ? 1 : 0;
        if (ai !== bi) return bi - ai; // active first
        return String(a.title ?? "").localeCompare(String(b.title ?? ""));
      });

    const monthly = (forms ?? [])
      .filter((f) => f.form_type === "monthly")
      .slice()
      .sort((a, b) => {
        const ai = a.is_active ? 1 : 0;
        const bi = b.is_active ? 1 : 0;
        if (ai !== bi) return bi - ai;
        return String(a.title ?? "").localeCompare(String(b.title ?? ""));
      });

    return { annual, monthly } as Record<ReviewFormType, HrReviewForm[]>;
  }, [forms]);

  const activeFormsByType = useMemo(() => {
    return {
      annual: formsByType.annual.filter((f) => f.is_active !== false),
      monthly: formsByType.monthly.filter((f) => f.is_active !== false),
    } as Record<ReviewFormType, HrReviewForm[]>;
  }, [formsByType]);

  const questionsByFormId = useMemo(() => {
    const map = new Map<string, ReviewQuestion[]>();

    for (const q of questions ?? []) {
      if (q.is_active === false) continue;
      const fid = String(q.form_id ?? "");
      if (!fid) continue;
      const list = map.get(fid) ?? [];
      list.push(q);
      map.set(fid, list);
    }

    const sortFn = (a: ReviewQuestion, b: ReviewQuestion) => {
      const ao = Number.isFinite(Number(a.sort_order)) ? Number(a.sort_order) : 0;
      const bo = Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : 0;
      if (ao !== bo) return ao - bo;
      return (a.question_text ?? "").localeCompare(b.question_text ?? "");
    };

    for (const [fid, list] of map.entries()) {
      map.set(fid, list.slice().sort(sortFn));
    }

    return map;
  }, [questions]);

  const getQuestionsForForm = useCallback(
    (formId: string) => {
      return questionsByFormId.get(formId) ?? [];
    },
    [questionsByFormId],
  );

  const getDefaultActiveFormId = useCallback(
    (ft: ReviewFormType) => {
      const list = activeFormsByType[ft] ?? [];
      return list[0]?.id ?? "";
    },
    [activeFormsByType],
  );


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
  function openManageForms() {
    setManageOpen(true);
    setManageType("");
    setShowArchivedForms(false);
    setNewFormTitle("");
    setStatus("");
  }

  function closeManageForms() {
    setManageOpen(false);
    setManageType("");
    setShowArchivedForms(false);
    setNewFormTitle("");
    setStatus("");
  }

  async function createFormForManage() {
    if (!manageType) return;
    const title = (newFormTitle ?? "").trim();
    if (!title) {
      setStatus("Please enter a form title.");
      return;
    }

    setCreatingForm(true);
    setStatus("Creating form...");
    try {
      const scaleMax = manageType === "monthly" ? 3 : 5;
      const { error } = await supabase.from("hr_review_forms").insert({
        form_type: manageType,
        title,
        scale_max: scaleMax,
        is_active: true,
      });
      if (error) throw error;

      setNewFormTitle("");
      await loadMeta();
      setStatus("Form created.");
    } catch (e: any) {
      setStatus("Create form error: " + (e?.message ?? "unknown"));
    } finally {
      setCreatingForm(false);
    }
  }

  async function deleteForm(formId: string) {
    setStatus("Deleting form...");
    try {
      const { error } = await supabase.from("hr_review_forms").delete().eq("id", formId);
      if (error) throw error;

      await loadMeta();
      // Close editor if it was open for this form
      setEditOpen((wasOpen) => {
        if (wasOpen && editFormId === formId) {
          setEditFormId("");
          setEditQuestions([]);
          return false;
        }
        return wasOpen;
      });
      setStatus("Form deleted.");
    } catch (e: any) {
      setStatus("Delete form error: " + (e?.message ?? "unknown"));
    }
  }

  function openEditForm(formId: string) {
    const form = formById.get(formId);
    if (!form) {
      setStatus("Missing hr_review_forms row for this form.");
      return;
    }

    const list: EditQuestion[] = getQuestionsForForm(formId)
      .slice()
      .map((q, idx) => ({
        id: q.id,
        question_text: q.question_text ?? "",
        sort_order: Number.isFinite(Number(q.sort_order)) ? Number(q.sort_order) : idx,
        kind: (q.kind as ReviewQuestionKind) || "question",
      }));

    if (list.length === 0) {
      if (form.form_type === "annual") {
        list.push({ id: `new:${makeLocalId()}`, question_text: "Quality of work", sort_order: 0, kind: "question" });
        list.push({ id: `new:${makeLocalId()}`, question_text: "Communication", sort_order: 1, kind: "question" });
        list.push({ id: `new:${makeLocalId()}`, question_text: "Reliability", sort_order: 2, kind: "question" });
      } else {
        list.push({ id: `new:${makeLocalId()}`, question_text: "Preparedness", sort_order: 0, kind: "question" });
        list.push({ id: `new:${makeLocalId()}`, question_text: "Classroom management", sort_order: 1, kind: "question" });
        list.push({ id: `new:${makeLocalId()}`, question_text: "Team collaboration", sort_order: 2, kind: "question" });
      }
    }

    list.forEach((q, i) => (q.sort_order = i));
    setEditFormId(formId);
    setEditQuestions(list);
    setEditOpen(true);
  }

  function closeEditForm() {
    setEditOpen(false);
    setEditFormId("");
    setEditQuestions([]);
  }

  function addEditQuestionRow(kind: ReviewQuestionKind) {
    setEditQuestions((cur) => {
      const next = cur.slice();
      next.push({ id: `new:${makeLocalId()}`, question_text: "", sort_order: next.length, kind });
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
      const formId = editFormId;
      const form = formById.get(formId);
      if (!formId || !form) {
        setStatus("Missing form selection for editing questions.");
        return;
      }

      const cleaned = editQuestions
        .map((q, i) => ({ ...q, sort_order: i, kind: (q.kind as any) || "question", question_text: (q.question_text ?? "").trim() }))
        .filter((q) => q.question_text.length > 0);

      if (cleaned.length === 0) {
        setStatus("Add at least 1 question.");
        return;
      }

      const currentIds = new Set(getQuestionsForForm(formId).map((q) => q.id));
      const desiredExistingIds = new Set(cleaned.filter((q) => !q.id.startsWith("new:")).map((q) => q.id));
      const toDelete = Array.from(currentIds).filter((id) => !desiredExistingIds.has(id));

      if (toDelete.length > 0) {
        const ok = confirm(
          `Delete ${toDelete.length} question(s) from "${form.title}"? This will also delete any saved answers for those questions.`
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
          kind: q.kind,
          is_active: true,
        }));
        const { error } = await supabase.from("hr_review_questions").insert(insertRows);
        if (error) throw error;
      }

      const existing = cleaned.filter((q) => !q.id.startsWith("new:"));
      for (const q of existing) {
        const { error } = await supabase
          .from("hr_review_questions")
          .update({ question_text: q.question_text, sort_order: q.sort_order, kind: q.kind, is_active: true })
          .eq("id", q.id);
        if (error) throw error;
      }

      closeEditForm();
      await loadMeta();
      setStatus("✅ Saved.");
      setTimeout(() => setStatus(""), 900);
    } catch (e: any) {
      setStatus("Save error: " + (e?.message ?? "unknown"));
    }
  }

  const effectiveFormId = useMemo(() => {
    return selectedFormId || getDefaultActiveFormId(formType);
  }, [selectedFormId, formType, getDefaultActiveFormId]);

  const activeQuestions = useMemo(() => {
    if (!effectiveFormId) return [];
    return getQuestionsForForm(effectiveFormId);
  }, [effectiveFormId, getQuestionsForForm]);

  const scaleMax = useMemo(() => {
    return formById.get(effectiveFormId)?.scale_max ?? (formType === "monthly" ? 3 : 5);
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
      supabase.from("hr_review_forms").select("id, form_type, title, scale_max, is_active").order("form_type", { ascending: true }).order("title", { ascending: true }),
      supabase
        .from("hr_review_questions")
        .select("id, form_id, question_text, sort_order, is_active, kind, created_at, updated_at")
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
      .select("id, employee_id, form_id, form_type, period_year, period_month, notes, published, attendance_points_snapshot, created_at, updated_at")
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
    // IMPORTANT: exclude SECTION HEADER rows (kind='section') from averages/totals.
    const kindByQuestionId = new Map<string, string>();
    for (const q of questions) kindByQuestionId.set(q.id, (q as any).kind ?? "question");

    const ansRes = await supabase
      .from("hr_review_answers")
      .select("review_id, question_id, score, note")
      .in("review_id", ids);
    if (ansRes.error) throw ansRes.error;

    const sums: Record<string, { sum: number; count: number }> = {};
    for (const row of (ansRes.data ?? []) as Array<{ review_id: string; question_id: string; score: number | null }>) {
      const rid = String(row.review_id);
      const qid = String((row as any).question_id);
      if (kindByQuestionId.get(qid) === "section") continue;

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
    if (!canEdit) return;
    setFormType(which);
    setSelectedFormId(getDefaultActiveFormId(which));
    setYear(currentYear);
    setMonth(currentMonth);
    setReviewId("");
    setValues({});
    setReviewNotes("");
    setOpen(true);
  }

  function openEdit(r: HrReview) {
    setFormType(r.form_type);
    setSelectedFormId(r.form_id ?? "");
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

  
  async function printAnnualEvaluation() {
    if (!employeeId) return;
    const role = viewerRole;
    const canPrint = role === "admin" || role === "supervisor";
    if (!canPrint) return;

    // Open the print window synchronously (before any awaits) to avoid popup blockers.
    const w = window.open("", "_blank", "noopener,noreferrer");
    if (!w) {
      alert("Popup blocked — please allow popups to print.");
      return;
    }

    try {
      console.log("[printAnnual] start", { employeeId });
      w.document.open();
      w.document.write(`<!doctype html><html><head><title>Loading…</title></head><body style="font-family:system-ui;padding:24px;">
        <h2 style="margin:0 0 8px 0;">Preparing print view…</h2>
        <div style="color:#6b7280;">Please wait.</div>
      </body></html>`);
      w.document.close();
      const { data: annuals, error: aerr } = await supabase
        .from("hr_reviews")
        .select("id, form_id, period_year, notes, attendance_points_snapshot, published")
        .eq("employee_id", employeeId)
        .eq("form_type", "annual")
        .eq("published", true)
        .order("period_year", { ascending: false });

      if (aerr) throw aerr;
      const list = (annuals ?? []) as any[];
      if (list.length === 0) {
        alert("No published annual evaluations found for this employee.");
        return;
      }

      const years = Array.from(new Set(list.map((r) => r.period_year))).sort((a, b) => b - a);
      const defaultYear = years[0];
      const input = prompt(
        `Print Annual Evaluation\nAvailable years: ${years.join(", ")}\n\nEnter year:`,
        String(defaultYear),
      );
      if (!input) return;
      const year = Number(input);
      if (!Number.isFinite(year)) {
        alert("Invalid year.");
        return;
      }
      const review = list.find((r) => r.period_year === year);
      if (!review) {
        alert("That year is not available.");
        return;
      }

      const { data: formRow, error: ferr } = await supabase
        .from("hr_review_forms")
        .select("id, scale_max")
        .eq("id", review.form_id)
        .single();
      if (ferr) throw ferr;
      const scaleMax = (formRow as any)?.scale_max ?? 5;

      const { data: qs, error: qerr } = await supabase
        .from("hr_review_questions")
        .select("id, form_id, question_text, sort_order, is_active, kind, created_at, updated_at")
        .eq("form_id", review.form_id)
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (qerr) throw qerr;

      const { data: ans, error: anserr } = await supabase
        .from("hr_review_answers")
        .select("review_id, question_id, score, note, created_at, updated_at")
        .eq("review_id", review.id);
      if (anserr) throw anserr;

      const byQ = new Map<string, HrReviewAnswer>();
      for (const a of (ans ?? []) as any[]) {
        byQ.set(a.question_id, a as HrReviewAnswer);
      }

      const scores: number[] = [];
      for (const q of (qs ?? []) as any[]) {
        if ((q.kind ?? "question") === "section") continue;
        const s = byQ.get(q.id)?.score;
        if (typeof s === "number") scores.push(Math.max(1, Math.min(scaleMax, Math.trunc(s))));
      }
      const performanceAvg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

      // Fetch employee meta (names, job level, attendance points) for printing
      const { data: empMeta, error: emerr } = await supabase
        .from("hr_employees")
        .select(
          "id, legal_first_name, legal_middle_name, legal_last_name, attendance_points, job_level:hr_job_levels(name)",
        )
        .eq("id", employeeId)
        .single();
      if (emerr) throw emerr;

      const att =
        typeof review.attendance_points_snapshot === "number"
          ? review.attendance_points_snapshot
          : (empMeta as any)?.attendance_points ?? 3;

      const jobLevelName = (empMeta as any)?.job_level?.name ?? "";
      const employeeName = formatEmployeeName(empMeta as any);

      const printRows = buildAnnualPrintRows((qs ?? []) as any, byQ, scaleMax);
      const html = buildAnnualPrintHtml({
        year,
        employeeName,
        jobLevelName,
        attendancePoints: att,
        performanceAvg,
        rows: printRows,
        overallNotes: (review.notes ?? "") as string,
      });
      console.log("[printAnnual] writing html", { year });
      w.document.open();
      w.document.write(html);
      w.document.close();
      w.focus();
      setTimeout(() => {
        try {
          w.print();
        } catch {}
      }, 350);
    } catch (e: any) {
      console.error("[printAnnual] error", e);
      try { w.close(); } catch {}
      alert(e?.message ?? "Failed to print annual evaluation.");
    }
  }

async function loadReviewForSelection(empId: string, ft: ReviewFormType, y: number, m: number) {
    const formId = selectedFormId || getDefaultActiveFormId(ft);
    const qs = getQuestionsForForm(formId);
    const max = formById.get(formId)?.scale_max ?? (ft === "monthly" ? 3 : 5);

    if (!qs || qs.length === 0) {
      setReviewId("");
      setValues({});
      setReviewNotes("");
      setAnswerNotes({});
      return;
    }

    const base = supabase
      .from("hr_reviews")
      .select("id, employee_id, form_id, form_type, period_year, period_month, notes, published, attendance_points_snapshot, created_at, updated_at")
      .eq("employee_id", empId)
      .eq("form_type", ft)
      .eq("period_year", y);

    const revRes = ft === "annual"
      ? await base.is("period_month", null).maybeSingle()
      : await base.eq("period_month", m).maybeSingle();

    if (revRes.error) throw revRes.error;

    const existing = (revRes.data ?? null) as HrReview | null;

    if (existing?.form_id) {
      // Existing review locks the form choice for that period
      setSelectedFormId(existing.form_id);
    } else if (!selectedFormId) {
      setSelectedFormId(formId);
    }

    if (!existing?.id) {
      // New review: do NOT pre-fill scores. Missing answers show as blank until someone rates them.
      initialAnsweredIdsRef.current = new Set();
      setReviewId("");
      setValues({});
      setReviewNotes("");
      setAnswerNotes({});
      return;
    }

    const ansRes = await supabase
      .from("hr_review_answers")
      .select("review_id, question_id, score, note, created_at, updated_at")
      .eq("review_id", existing.id);

    if (ansRes.error) throw ansRes.error;

    const byQ = new Map<string, number | null>();
    const byQNote = new Map<string, string>();
    for (const a of (ansRes.data ?? []) as any[]) {
      byQ.set(a.question_id, a.score ?? null);
      if (typeof a.note === "string") byQNote.set(a.question_id, a.note);
    }

    // Existing review: only populate questions that have an answer row.
    const init: Record<string, number> = {};
    for (const q of qs) {
      const v = byQ.get(q.id);
      const clamped = clampScore(typeof v === "number" ? v : null, max);
      if (typeof clamped === "number") init[q.id] = clamped;
    }

    initialAnsweredIdsRef.current = new Set(Object.keys(init));
    setReviewId(existing.id);
    setValues(init);
    setReviewNotes(existing.notes ?? "");
    setAnswerNotes(Object.fromEntries(byQNote.entries()));
  }

  async function ensureReviewRow(
    empId: string,
    ft: ReviewFormType,
    formId: string,
    y: number,
    m: number | null,
    attendancePointsSnapshot: number | null,
  ) {
    // IMPORTANT: don't overwrite a previously-captured snapshot when editing.
    // If the row exists and snapshot is null, then (and only then) we backfill it.
    const base = supabase
      .from("hr_reviews")
      .select("id, attendance_points_snapshot, published")
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
      form_id: formId,
      form_type: ft,
      period_year: y,
      period_month: ft === "annual" ? null : m,
      attendance_points_snapshot: attendancePointsSnapshot,
    };

    const ins = await supabase
      .from("hr_reviews")
      .insert(payload)
      .select("id, published")
      .single();

    if (ins.error) throw ins.error;
    return String((ins.data as any)?.id ?? "");
  }

  async function saveReview() {
    if (!canEdit) return;
    if (!employeeId) return;

    const qs = activeQuestions.filter((q) => (q.kind || "question") !== "section");
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
      const rid = await ensureReviewRow(employeeId, formType, effectiveFormId, year, month, attendancePoints ?? null);
      setReviewId(rid);

      // Persist freeform notes on the review itself.
      {
        const { error: notesErr } = await supabase.from("hr_reviews").update({ notes: reviewNotes }).eq("id", rid);
        if (notesErr) throw notesErr;
      }

      const max = scaleMax;

      // Persist answers for every question. Unset answers are stored as NULL ("Undecided").
      const rows: { review_id: string; question_id: string; score: number | null; note: string | null }[] = activeQuestions
        .filter((q) => (q.kind || "question") !== "section")
        .map((q) => ({
          review_id: rid,
          question_id: q.id,
          score: clampScore(values[q.id], max),
          note: (answerNotes[q.id] ?? null) || null,
        }));

      const upsertRes = await supabase.from("hr_review_answers").upsert(rows, { onConflict: "review_id,question_id" });
      if (upsertRes.error) throw upsertRes.error;

      // Track which questions have been explicitly scored (non-null).
      initialAnsweredIdsRef.current = new Set(rows.filter((r) => r.score !== null).map((r) => r.question_id));

      await loadEmployeeReviews();
      setStatus("✅ Saved.");
      setTimeout(() => setStatus(""), 900);
      closeModal();
    } catch (e: any) {
      setStatus("Save error: " + (e?.message ?? "unknown"));
    }
  }

  async function deleteReview(r: HrReview) {
    if (!canEdit) return;
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

  async function publishReview(reviewIdToPublish: string) {
    if (!canEdit) return;
    if (!reviewIdToPublish) return;
    setPublishingReviewId(reviewIdToPublish);
    setStatus("Publishing review...");
    try {
      const { error } = await supabase.from("hr_reviews").update({ published: true }).eq("id", reviewIdToPublish);
      if (error) throw error;
      await loadEmployeeReviews();
      setStatus("✅ Review published.");
      setTimeout(() => setStatus(""), 2500);
    } catch (e: any) {
      setStatus(`❌ Publish failed: ${e?.message ?? "unknown error"}`);
    } finally {
      setPublishingReviewId("");
    }
  }


  const computedAvg = useMemo(() => {
    const qs = (activeQuestions ?? []).filter((q: any) => (q?.kind ?? "question") !== "section");
    if (!qs || qs.length === 0) return null;

    const max = scaleMax;
    const valsArr = qs
      .map((q) => clampScore(values[q.id], max))
      .filter((v): v is number => typeof v === "number");

    if (valsArr.length === 0) return null;
    return round1dp(valsArr.reduce((s, x) => s + x, 0) / valsArr.length);
  }, [activeQuestions, values, scaleMax]);

  const computedTotal = useMemo(() => {
    const qs = (activeQuestions ?? []).filter((q: any) => (q?.kind ?? "question") !== "section");
    if (!qs || qs.length === 0) return null;
    const max = scaleMax;
    const valsArr = qs
      .map((q) => clampScore(values[q.id], max))
      .filter((v): v is number => typeof v === "number");
    if (valsArr.length === 0) return null;
    return valsArr.reduce((s, x) => s + x, 0);
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
  }, [open, employeeId, formType, year, month, selectedFormId, questionsByFormId, activeFormsByType, formById]);

  // ESC + outside click to close modal
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editOpen) closeEditForm();
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
        if (el2 && !el2.contains(e.target as any)) closeEditForm();
      }
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
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
          {canEdit ? (
            <>
              <button className="btn btn-primary" type="button" onClick={() => openCreate("annual")}>
                + Create Annual Evaluation
              </button>
              <button className="btn btn-primary" type="button" onClick={() => openCreate("monthly")}>
                + Create Monthly Scorecard
              </button>
            </>
          ) : null}

          {canEdit ? (
            <button className="btn" type="button" onClick={() => openManageForms()}>
              Manage Forms
            </button>
          ) : null}

          {(viewerRole === "admin" || viewerRole === "supervisor") ? (
            <button className="btn" type="button" onClick={() => void printAnnualEvaluation()}>
              Print Annual Evaluation
            </button>
          ) : null}

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
                  <div style={{ fontWeight: 900, display: "flex", alignItems: "center", gap: 10 }}>
                      {formatReviewLabel(r)}
                      <span
                        style={{
                          fontSize: 12,
                          padding: "3px 8px",
                          borderRadius: 999,
                          border: "1px solid #ddd",
                          background: r.published ? "#f4fff7" : "#fff7f0",
                          color: r.published ? "#0a7a2f" : "#a04b00",
                          fontWeight: 800,
                        }}
                      >
                        {r.published ? "Published" : "Draft"}
                      </span>
                    </div>

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
                  {!r.published && (
                      <button
                        className="btn"
                        type="button"
                        onClick={() => publishReview(r.id)}
                        disabled={publishingReviewId === r.id}
                        style={{ padding: "6px 10px" }}
                      >
                        {publishingReviewId === r.id ? "Publishing..." : "Publish"}
                      </button>
                    )}
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
                    disabled={readOnly}
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

                <div style={{ minWidth: 260 }}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>Form</div>
                  <select
                    className="select"
                    value={effectiveFormId}
                    onChange={(e) => {
                      const fid = String(e.target.value);
                      setSelectedFormId(fid);
                      if (!reviewId) {
                        initialAnsweredIdsRef.current = new Set();
                        setValues({});
                      }
                    }}
                    disabled={!!reviewId}
                  >
                    {(() => {
                      const optionForms = (reviewId ? formsByType[formType] : activeFormsByType[formType]) ?? [];
                      return optionForms.length ? (
                        optionForms.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.title}
                          </option>
                        ))
                      ) : (
                        <option value="">No active forms</option>
                      );
                    })()}
                  </select>
                  {!!reviewId ? (
                    <div className="subtle" style={{ marginTop: 4 }}>
                      Form is locked for existing reviews.
                    </div>
                  ) : null}
                </div>

                <div style={{ width: 140 }}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>Year</div>
                  <input
                    className="input"
                    type="number"
                    value={year}
                    disabled={readOnly}
                    onChange={(e) => setYear(Number(e.target.value))}
                    min={2000}
                    max={2100}
                  />
                </div>

                {formType === "monthly" ? (
                  <div style={{ width: 200 }}>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>Month</div>
                    <select className="select" value={month} disabled={readOnly} onChange={(e) => setMonth(Number(e.target.value))}>
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
                {activeQuestions.map((q) => {
                  const kind = ((q.kind as any) || "question") as ReviewQuestionKind;

                  if (kind === "section") {
                    return (
                      <div
                        key={q.id}
                        style={{
                          border: "1px solid #bae6fd",
                          borderRadius: 14,
                          padding: "10px 12px",
                          background: "#e0f2fe",
                        }}
                      >
                        <div style={{ fontWeight: 950, fontSize: 16 }}>{q.question_text}</div>
                      </div>
                    );
                  }

                  return (
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
                          value={String(values[q.id] ?? "")}
                          disabled={readOnly}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const s = clampScore(raw, scaleMax);
                            setValues((cur) => {
                              const next = { ...cur } as Record<string, number>;
                              if (s == null) {
                                delete (next as any)[q.id];
                              } else {
                                (next as any)[q.id] = s;
                              }
                              return next;
                            });
                          }}
                          style={{ width: 140 }}
                        >
                          <option value="">Undecided</option>
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

                      <div style={{ marginTop: 10 }}>
                        <div className="subtle" style={{ marginBottom: 6 }}>Question note (optional)</div>
                        <textarea
                          className="input"
                          value={answerNotes[q.id] ?? ""}
                          disabled={readOnly}
                          onChange={(e) =>
                            setAnswerNotes((cur) => ({
                              ...cur,
                              [q.id]: e.target.value,
                            }))
                          }
                          placeholder="Optional note for this question..."
                          style={{ minHeight: 70, resize: "vertical" }}
                        />
                      </div>
                    </div>
                  );
                })}
                <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>Overall Notes</div>
              <textarea
                className="input"
                value={reviewNotes}
                disabled={readOnly}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setReviewNotes(e.target.value)}
                placeholder="Additional notes..."
                style={{ minHeight: 90, resize: "vertical" }}
              />
            </div>

                <div className="row-between" style={{ gap: 10, flexWrap: "wrap", marginTop: 4 }}>
                  {formType === "monthly" ? (
                    <div className="subtle">
                      Total (auto): <b>{computedTotal === null ? "—" : computedTotal}</b>
                    </div>
                  ) : (
                    <div className="subtle">
                      Average (auto): <b>{computedAvg === null ? "—" : computedAvg.toFixed(1)}</b>{" "}
                      <span className="subtle">(normal rounding)</span>
                    </div>
                  )}

                  <div className="row" style={{ gap: 10 }}>
                    <button className="btn" type="button" onClick={closeModal}>
                      {readOnly ? "Close" : "Cancel"}
                    </button>
                    {!readOnly ? (
                      <button className="btn btn-primary" type="button" onClick={() => void saveReview()}>
                        Save evaluation
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            )}
            
          </div>
        </div>
      ) : null}

      {/* ===========================

      {/* ===========================
          MANAGE FORMS MODAL
         =========================== */}
      {manageOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            zIndex: 60,
            display: "grid",
            placeItems: "center",
            padding: 12,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeManageForms();
          }}
        >
          <div
            style={{
              width: "min(860px, 100%)",
              background: "#fff",
              borderRadius: 16,
              border: "1px solid #e5e7eb",
              boxShadow: "0 24px 60px rgba(0,0,0,0.25)",
              padding: 14,
              display: "grid",
              gap: 12,
              maxHeight: "80vh",
              overflow: "auto",
            }}
          >
            <div className="row-between" style={{ gap: 10, alignItems: "center" }}>
              <div style={{ fontWeight: 950, fontSize: 16 }}>Manage Review Forms</div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" type="button" onClick={closeManageForms}>
                  Close
                </button>
              </div>
            </div>

            {!manageType ? (
              <div style={{ display: "grid", gap: 10 }}>
                <div className="subtle">
                  Choose which form category you want to manage. Annual forms use a 1–5 scale and monthly forms use a 1–3
                  scale.
                </div>

                <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                  <button className="btn btn-primary" type="button" onClick={() => setManageType("annual")}>
                    Annual forms
                  </button>
                  <button className="btn btn-primary" type="button" onClick={() => setManageType("monthly")}>
                    Monthly forms
                  </button>
                  <button className="btn" type="button" onClick={closeManageForms}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                <div className="row-between" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <div style={{ display: "grid", gap: 4 }}>
                    <div style={{ fontWeight: 900 }}>
                      {manageType === "annual" ? "Annual" : "Monthly"} forms
                    </div>
                    <div className="subtle">
                      Click a form title to edit its questions. Deleting a form will also delete any reviews/answers that used
                      it.
                    </div>
                  </div>

                  <div className="row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <label className="row" style={{ gap: 8, alignItems: "center" }}>
                      <input
                        type="checkbox"
                        checked={showArchivedForms}
                        onChange={(e) => setShowArchivedForms(e.target.checked)}
                      />
                      <span className="subtle">Show archived</span>
                    </label>

                    <button className="btn" type="button" onClick={() => setManageType("")}>
                      Back
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 10,
                    alignItems: "end",
                    border: "1px solid #e5e7eb",
                    borderRadius: 12,
                    padding: 12,
                    background: "#fafafa",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>New form title</div>
                    <input
                      className="input"
                      value={newFormTitle}
                      onChange={(e) => setNewFormTitle(e.target.value)}
                      placeholder={manageType === "annual" ? "e.g., Annual – Teachers" : "e.g., Monthly – Classroom"}
                    />
                    <div className="subtle" style={{ marginTop: 6 }}>
                      {manageType === "annual" ? "Scale: 1–5" : "Scale: 1–3"}
                    </div>
                  </div>
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={createFormForManage}
                    disabled={creatingForm || !(newFormTitle ?? "").trim()}
                    title={creatingForm ? "Creating..." : "Create form"}
                  >
                    + Create
                  </button>
                </div>

                <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ background: "#f9fafb", padding: 10, fontWeight: 900 }}>Forms</div>

                  <div style={{ display: "grid" }}>
                    {(formsByType[manageType] ?? [])
                      .filter((f) => (showArchivedForms ? true : f.is_active !== false))
                      .map((f) => {
                        const isArchived = f.is_active === false;
                        return (
                          <div
                            key={f.id}
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1fr auto",
                              gap: 10,
                              padding: 10,
                              borderTop: "1px solid #e5e7eb",
                              alignItems: "center",
                            }}
                          >
                            <button
                              type="button"
                              className="btn"
                              style={{
                                justifyContent: "flex-start",
                                background: "transparent",
                                border: "none",
                                padding: 0,
                                fontWeight: 800,
                                textAlign: "left",
                              }}
                              onClick={() => openEditForm(f.id)}
                              title="Edit questions"
                            >
                              {f.title}
                              {isArchived ? (
                                <span className="subtle" style={{ marginLeft: 8, fontWeight: 700 }}>
                                  (archived)
                                </span>
                              ) : null}
                            </button>

                            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
                              {!isArchived ? (
                                <button
                                  className="btn"
                                  type="button"
                                  onClick={async () => {
                                    setStatus("Archiving form...");
                                    try {
                                      const { error } = await supabase
                                        .from("hr_review_forms")
                                        .update({ is_active: false })
                                        .eq("id", f.id);
                                      if (error) throw error;
                                      await loadMeta();
                                      setStatus("Form archived.");
                                    } catch (e: any) {
                                      setStatus("Archive error: " + (e?.message ?? "unknown"));
                                    }
                                  }}
                                >
                                  Archive
                                </button>
                              ) : (
                                <button
                                  className="btn"
                                  type="button"
                                  onClick={async () => {
                                    setStatus("Un-archiving form...");
                                    try {
                                      const { error } = await supabase
                                        .from("hr_review_forms")
                                        .update({ is_active: true })
                                        .eq("id", f.id);
                                      if (error) throw error;
                                      await loadMeta();
                                      setStatus("Form re-activated.");
                                    } catch (e: any) {
                                      setStatus("Un-archive error: " + (e?.message ?? "unknown"));
                                    }
                                  }}
                                >
                                  Restore
                                </button>
                              )}

                              <button
                                className="btn"
                                type="button"
                                title="Delete form"
                                onClick={async () => {
                                  const ok = confirm(
                                    'Are you sure you want to delete this form?\n\nDeleting a form will also delete any employee evaluations (reviews) that used it, along with their saved answers.'
                                  );
                                  if (!ok) return;
                                  await deleteForm(f.id);
                                }}
                              >
                                🗑️
                              </button>
                            </div>
                          </div>
                        );
                      })}

                    {(formsByType[manageType] ?? []).filter((f) => (showArchivedForms ? true : f.is_active !== false))
                      .length === 0 ? (
                      <div style={{ padding: 12 }} className="subtle">
                        No forms found.
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            )}

            {status ? <div className="subtle">{status}</div> : null}
          </div>
        </div>
      ) : null}

      {/* EDIT QUESTIONS MODAL =========================== */}
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
                  Edit Questions — {formById.get(editFormId)?.title ?? "Form"}
                </div>
                <div className="subtle">
                  {formById.get(editFormId)?.form_type === "annual" ? "Annual answers are 1–5." : "Monthly answers are 1–3."}
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
                    border: q.kind === "section" ? "1px solid #bae6fd" : "1px solid #e5e7eb",
                    borderRadius: 14,
                    background: q.kind === "section" ? "#e0f2fe" : "white",
                  }}
                >
                  <div style={{ display: "grid", gap: 8 }}>
                    <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 900 }}>#{idx + 1}</div>
                      <select
                        className="select"
                        value={q.kind}
                        onChange={(e) => {
                          const v = e.target.value as ReviewQuestionKind;
                          setEditQuestions((cur) => cur.map((x) => (x.id === q.id ? { ...x, kind: v } : x)));
                        }}
                        style={{ width: 170 }}
                        title="Item type"
                      >
                        <option value="question">Scored question</option>
                        <option value="section">Section header</option>
                      </select>
                    </div>

                    <input
                      className="input"
                      value={q.question_text}
                      placeholder={q.kind === "section" ? "Section header title" : "Question text"}
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
                <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                  <button className="btn" type="button" onClick={() => addEditQuestionRow("question")}>
                    + Add question
                  </button>
                  <button className="btn" type="button" onClick={() => addEditQuestionRow("section")}>
                    + Add section header
                  </button>
                </div>

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

  const [viewerRole, setViewerRole] = useState<string | null>(null);


  // ✅ Fix: normalize ParamValue -> string
  const employeeId = useMemo(() => {
    const raw = (params as any)?.id as string | string[] | undefined;
    if (!raw) return "";
    return Array.isArray(raw) ? raw[0] ?? "" : raw;
  }, [params]);

  // Load viewer role (admin/supervisor/teacher) for permission-gated UI
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: u } = await supabase.auth.getUser();
        const uid = u.user?.id;
        if (!uid) return;
        const { data: pr } = await supabase.from("user_profiles").select("role").eq("id", uid).maybeSingle();
        if (!cancelled) setViewerRole((pr as any)?.role ?? null);
      } catch {
        if (!cancelled) setViewerRole(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);


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

  // Time off requests (records + running total stored on hr_employees.time_off_hours_requested)
  const [timeOffRecords, setTimeOffRecords] = useState<EmployeeTimeOffRequestRow[]>([]);
  const [timeOffLoading, setTimeOffLoading] = useState(false);

  const [newTimeOffDate, setNewTimeOffDate] = useState<string>("");
  const [newTimeOffHours, setNewTimeOffHours] = useState<string>("");
  const [newTimeOffNotes, setNewTimeOffNotes] = useState<string>("");
  const [timeOffSaving, setTimeOffSaving] = useState(false);


  // Time off requests by DAY (records + running total stored on hr_employees.time_off_days_requested)
  const [timeOffDayRecords, setTimeOffDayRecords] = useState<EmployeeTimeOffDayRequestRow[]>([]);
  const [timeOffDayLoading, setTimeOffDayLoading] = useState(false);

  const [newTimeOffDayDate, setNewTimeOffDayDate] = useState<string>("");
  const [newTimeOffDayNotes, setNewTimeOffDayNotes] = useState<string>("");
  const [timeOffDaySaving, setTimeOffDaySaving] = useState(false);


  // left-nav (sections)
  const [activeTab, setActiveTab] =
  useState<"general" | "milestones" | "attendance" | "meetings" | "reviews" | "documents">("general");
  // form state (mirrors your modal)
  const [legalFirst, setLegalFirst] = useState("");
  const [legalMiddle, setLegalMiddle] = useState("");
  const [legalLast, setLegalLast] = useState("");

  // Employment dates (YYYY-MM-DD). Empty string for endDate means NULL.
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

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
        const today = new Date().toISOString().slice(0, 10);
        setStartDate(emp.start_date ?? today);
        setEndDate(emp.end_date ?? "");
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
  }, [employeeId]);

  
const loadTimeOffRecords = useCallback(async (empId: string) => {
  if (!empId) {
    setTimeOffRecords([]);
    return;
  }
  setTimeOffLoading(true);
  try {
    const res = await supabase
      .from("hr_employee_time_off_requests")
      .select("id, employee_id, occurred_on, hours_requested, notes, created_at")
      .eq("employee_id", empId)
      .order("occurred_on", { ascending: false });

    if (res.error) throw res.error;

    const rows = (res.data ?? []).map((r: any) => ({
      ...r,
      hours_requested: Number(r.hours_requested ?? 0),
    })) as EmployeeTimeOffRequestRow[];

    setTimeOffRecords(rows);
  } catch {
    setTimeOffRecords([]);
  } finally {
    setTimeOffLoading(false);
  }
}, []);

const loadTimeOffDayRecords = useCallback(async (empId: string) => {
  if (!empId) {
    setTimeOffDayRecords([]);
    return;
  }
  setTimeOffDayLoading(true);
  try {
    const res = await supabase
      .from("hr_employee_time_off_requests_days")
      .select("id, employee_id, occurred_on, notes, created_at")
      .eq("employee_id", empId)
      .order("occurred_on", { ascending: false });

    if (res.error) throw res.error;

    const rows = (res.data ?? []) as EmployeeTimeOffDayRequestRow[];
    setTimeOffDayRecords(rows);
  } catch {
    setTimeOffDayRecords([]);
  } finally {
    setTimeOffDayLoading(false);
  }
}, []);

async function addTimeOffRecord() {
  if (!employeeId) return;

  const date = newTimeOffDate.trim();
  if (!date) {
    alert("Please select a date.");
    return;
  }

  const hoursNum = Number(newTimeOffHours);
  if (!Number.isFinite(hoursNum) || hoursNum <= 0) {
    alert("Please enter a valid hours amount (> 0).");
    return;
  }

  setError(null);
  setTimeOffSaving(true);
  try {
    const { error } = await supabase.from("hr_employee_time_off_requests").insert({
      employee_id: employeeId,
      occurred_on: date,
      hours_requested: hoursNum,
      notes: newTimeOffNotes.trim() || null,
    });

    if (error) throw error;

    setNewTimeOffDate("");
    setNewTimeOffHours("");
    setNewTimeOffNotes("");

    await loadTimeOffRecords(employeeId);

    // refresh employee totals
    const fresh = normalizeEmployee(await fetchEmployeeData(employeeId));
    setEmployee(fresh);
  } catch (e: any) {
    setError(e?.message ?? "Failed to add time off request record.");
  } finally {
    setTimeOffSaving(false);
  }
}

async function deleteTimeOffRecord(recId: string) {
  const ok = confirm("Delete this time off request record? (This will subtract the hours automatically.)");
  if (!ok) return;

  setError(null);
  try {
    const { error } = await supabase.from("hr_employee_time_off_requests").delete().eq("id", recId);
    if (error) throw error;

    await loadTimeOffRecords(employeeId);

    const fresh = normalizeEmployee(await fetchEmployeeData(employeeId));
    setEmployee(fresh);
  } catch (e: any) {
    setError(e?.message ?? "Failed to delete time off request record.");
  }
}


async function deleteTimeOffDayRecord(recId: string) {
  const ok = confirm("Delete this time off day request record? (This will subtract 1 day automatically.)");
  if (!ok) return;

  setError(null);
  try {
    const { error } = await supabase.from("hr_employee_time_off_requests_days").delete().eq("id", recId);
    if (error) throw error;

    await loadTimeOffDayRecords(employeeId);

    const fresh = normalizeEmployee(await fetchEmployeeData(employeeId));
    setEmployee(fresh);
  } catch (e: any) {
    setError(e?.message ?? "Failed to delete time off day request record.");
  }
}

async function resetAttendancePointsToDefault() {
  if (!employeeId) return;
  const ok = confirm("Reset attendance points to 3? (This keeps all existing records.)");
  if (!ok) return;

  setError(null);
  try {
    const { error } = await supabase.from("hr_employees").update({ attendance_points: 3 }).eq("id", employeeId);
    if (error) throw error;

    const fresh = normalizeEmployee(await fetchEmployeeData(employeeId));
    setEmployee(fresh);
  } catch (e: any) {
    setError(e?.message ?? "Failed to reset attendance points.");
  }
}


async function addTimeOffDayRecord() {
  if (!employeeId) return;

  const date = (newTimeOffDayDate || "").trim();
  if (!date) {
    alert("Please choose a date.");
    return;
  }

  setTimeOffDaySaving(true);
  try {
    const res = await supabase.from("hr_employee_time_off_requests_days").insert({
      employee_id: employeeId,
      occurred_on: date,
      notes: (newTimeOffDayNotes || "").trim() || null,
    });
    if (res.error) throw res.error;

    setNewTimeOffDayDate("");
    setNewTimeOffDayNotes("");
    const fresh = normalizeEmployee(await fetchEmployeeData(employeeId));
    setEmployee(fresh);
    await loadTimeOffDayRecords(employeeId);
  } catch (e: any) {
    alert(e?.message ?? "Failed to add time off day record.");
  } finally {
    setTimeOffDaySaving(false);
  }
}

async function resetTimeOffDaysToDefault() {
  if (!employeeId) return;
  const ok = confirm("Reset time off DAY count back to 0? (Records will be kept.)");
  if (!ok) return;

  try {
    const res = await supabase.from("hr_employees").update({ time_off_days_requested: 0 }).eq("id", employeeId);
    if (res.error) throw res.error;
    const fresh = normalizeEmployee(await fetchEmployeeData(employeeId));
    setEmployee(fresh);
  } catch (e: any) {
    alert(e?.message ?? "Failed to reset day count.");
  }
}

async function resetTimeOffHoursToDefault() {
  if (!employeeId) return;
  const ok = confirm("Reset time off requested hours to 0? (This keeps all existing records.)");
  if (!ok) return;

  setError(null);
  try {
    const { error } = await supabase.from("hr_employees").update({ time_off_hours_requested: 0 }).eq("id", employeeId);
    if (error) throw error;

    const fresh = normalizeEmployee(await fetchEmployeeData(employeeId));
    setEmployee(fresh);
  } catch (e: any) {
    setError(e?.message ?? "Failed to reset time off requested hours.");
  }
}

// If user clicks Attendance tab later, refresh attendance + types (keeps it current)
  useEffect(() => {
    if (!employeeId) return;
    if (activeTab !== "attendance") return;
        void loadEmployeeAttendance(employeeId);
    void loadAttendanceTypes();
    void loadTimeOffRecords(employeeId);
    void loadTimeOffDayRecords(employeeId);
  }, [activeTab, employeeId, loadEmployeeAttendance, loadAttendanceTypes, loadTimeOffRecords]);

  async function saveChanges() {
    if (!employeeId) return;

    setError(null);
    try {
      const parsedRate = Number(rate);
      const safeRate = Number.isFinite(parsedRate) ? parsedRate : 0;

      const insuranceDoc = hasInsurance ? normalizeForFortune(exportInsuranceSheetDoc(), insuranceFallbackDoc) : null;
      const today = new Date().toISOString().slice(0, 10);
      const safeStartDate = (startDate ?? "").trim() || today;
      const safeEndDate = (endDate ?? "").trim() || null;
      const payload: any = {
        legal_first_name: legalFirst.trim(),
        legal_middle_name: legalMiddle.trim() || null,
        legal_last_name: legalLast.trim(),
        start_date: safeStartDate,
        end_date: safeEndDate,
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

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
                      <div>
                        <FieldLabel>Start date</FieldLabel>
                        <TextInput type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                      </div>
                      <div>
                        <FieldLabel>End date (optional)</FieldLabel>
                        <div className="row" style={{ gap: 8 }}>
                          <TextInput
                            type="date"
                            value={endDate}
                            onChange={(e) => setEndDate(e.target.value)}
                            style={{ flex: 1 }}
                          />
                          {endDate ? (
                            <button
                              className="btn"
                              type="button"
                              onClick={() => setEndDate("")}
                              title="Clear end date"
                            >
                              Clear
                            </button>
                          ) : null}
                        </div>
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
                <div style={{ display: "grid", gap: 14 }}>
                  <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
                  <div className="row-between" style={{ gap: 12, alignItems: "center" }}>
                    <div style={{ fontWeight: 900 }}>
                      Attendance <span style={{ marginLeft: 10, fontWeight: 900, color: scoreColor(attPoints) }}>({attPoints})</span>
                    </div>

                    <div className="row" style={{ gap: 10 }}>
                      <button className="btn" type="button" onClick={() => void loadEmployeeAttendance(employeeId)} disabled={empAttendanceLoading}>
                        {empAttendanceLoading ? "Loading..." : "Refresh records"}
                      </button>
                      <button className="btn" type="button" onClick={() => void resetAttendancePointsToDefault()}>
                        Reset points
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
  <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
    <div className="row-between" style={{ gap: 12, alignItems: "center" }}>
      <div style={{ fontWeight: 900 }}>
        Time off Requests by Hour{" "}
        <span style={{ marginLeft: 10, fontWeight: 900 }}>
          ({Number(employee?.time_off_hours_requested ?? 0).toFixed(2)} hrs)
        </span>
      </div>

      <div className="row" style={{ gap: 10 }}>
        <button className="btn" type="button" onClick={() => void loadTimeOffRecords(employeeId)} disabled={timeOffLoading}>
          {timeOffLoading ? "Loading..." : "Refresh records"}
        </button>
        <button className="btn" type="button" onClick={() => void resetTimeOffHoursToDefault()}>
          Reset hours
        </button>
      </div>
    </div>

    <div className="subtle" style={{ marginTop: 6 }}>
      Records are shown most recent first. Total hours shown above can be reset for a new year without deleting records.
    </div>

    <div style={{ marginTop: 12, padding: 12, borderRadius: 14, border: "1px dashed #e5e7eb" }}>
      <div style={{ fontWeight: 800, marginBottom: 10 }}>Add time off request record</div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "end" }}>
        <div>
          <FieldLabel>Date</FieldLabel>
          <TextInput type="date" value={newTimeOffDate} onChange={(e) => setNewTimeOffDate(e.target.value)} />
        </div>

        <div>
          <FieldLabel>Hours requested</FieldLabel>
          <TextInput
            inputMode="decimal"
            value={newTimeOffHours}
            onChange={(e) => setNewTimeOffHours(e.target.value)}
            placeholder="e.g. 4"
          />
        </div>
      </div>

      <div style={{ height: 10 }} />

      <div>
        <FieldLabel>Notes</FieldLabel>
        <TextInput value={newTimeOffNotes} onChange={(e) => setNewTimeOffNotes(e.target.value)} placeholder="Optional details…" />
      </div>

      <div className="row" style={{ gap: 10, marginTop: 12 }}>
        <button className="btn btn-primary" type="button" onClick={() => void addTimeOffRecord()} disabled={timeOffSaving}>
          {timeOffSaving ? "Adding..." : "Add record"}
        </button>

        <button
          className="btn"
          type="button"
          onClick={() => {
            setNewTimeOffDate("");
            setNewTimeOffHours("");
            setNewTimeOffNotes("");
          }}
          disabled={timeOffSaving}
        >
          Clear
        </button>
      </div>
    </div>

    <div style={{ marginTop: 12 }}>
      <div style={{ fontWeight: 800, marginBottom: 8 }}>
        Existing time off requests ({timeOffRecords.length})
        {timeOffLoading ? <span className="subtle" style={{ marginLeft: 10 }}>Loading…</span> : null}
      </div>

      {timeOffRecords.length === 0 ? (
        <div className="subtle">No time off request records yet.</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {timeOffRecords.map((r) => (
            <div key={r.id} style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
              <div className="row-between" style={{ gap: 12, alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontWeight: 900 }}>
                    {formatYmd(r.occurred_on)} • <span style={{ fontWeight: 900 }}>{Number(r.hours_requested).toFixed(2)} hrs</span>
                  </div>

                  {r.notes ? (
                    <div className="subtle" style={{ marginTop: 4 }}>
                      {r.notes}
                    </div>
                  ) : (
                    <div className="subtle" style={{ marginTop: 4 }}>
                      —
                    </div>
                  )}

                  <div className="subtle" style={{ marginTop: 6, fontSize: 12 }}>
                    Created: {r.created_at ? new Date(r.created_at).toLocaleString() : "—"}
                  </div>
                </div>

                <div className="row" style={{ gap: 8, alignItems: "center" }}>
                  <button className="btn" type="button" onClick={() => void deleteTimeOffRecord(r.id)} style={{ padding: "6px 10px" }}>
                    Delete
                  </button>
                  <div className="subtle" style={{ fontWeight: 800, whiteSpace: "nowrap" }}>
                    ID:{" "}
                    <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                      {r.id.slice(0, 8)}…
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>

  <div style={{ height: 12 }} />

  <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
    <div className="row-between" style={{ gap: 12, alignItems: "center" }}>
      <div style={{ fontWeight: 900 }}>
        Time Off Requests by Day{" "}
        <span style={{ marginLeft: 10, fontWeight: 900 }}>
          ({Number(employee?.time_off_days_requested ?? 0)} days)
        </span>
      </div>

      <div className="row" style={{ gap: 10 }}>
        <button className="btn" type="button" onClick={() => void loadTimeOffDayRecords(employeeId)} disabled={timeOffDayLoading}>
          {timeOffDayLoading ? "Loading..." : "Refresh records"}
        </button>
        <button className="btn" type="button" onClick={() => void resetTimeOffDaysToDefault()}>
          Reset days
        </button>
      </div>
    </div>

    <div className="subtle" style={{ marginTop: 6 }}>
      Records are shown most recent first. Total days shown above can be reset for a new year without deleting records.
    </div>

    <div style={{ marginTop: 12, padding: 12, borderRadius: 14, border: "1px dashed #e5e7eb" }}>
      <div style={{ fontWeight: 800, marginBottom: 10 }}>Add time off day record</div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, alignItems: "end" }}>
        <div>
          <FieldLabel>Date</FieldLabel>
          <TextInput type="date" value={newTimeOffDayDate} onChange={(e) => setNewTimeOffDayDate(e.target.value)} />
        </div>
      </div>

      <div style={{ height: 10 }} />

      <div>
        <FieldLabel>Notes</FieldLabel>
        <TextInput value={newTimeOffDayNotes} onChange={(e) => setNewTimeOffDayNotes(e.target.value)} placeholder="Optional details…" />
      </div>

      <div className="row" style={{ gap: 10, marginTop: 12 }}>
        <button className="btn btn-primary" type="button" onClick={() => void addTimeOffDayRecord()} disabled={timeOffDaySaving}>
          {timeOffDaySaving ? "Adding..." : "Add record"}
        </button>

        <button
          className="btn"
          type="button"
          onClick={() => {
            setNewTimeOffDayDate("");
            setNewTimeOffDayNotes("");
          }}
          disabled={timeOffDaySaving}
        >
          Clear
        </button>
      </div>
    </div>

    <div style={{ marginTop: 12 }}>
      <div style={{ fontWeight: 800, marginBottom: 8 }}>
        Existing time off day records ({timeOffDayRecords.length})
        {timeOffDayLoading ? <span className="subtle" style={{ marginLeft: 10 }}>Loading…</span> : null}
      </div>

      {timeOffDayRecords.length === 0 ? (
        <div className="subtle">No time off day records yet.</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {timeOffDayRecords.map((r) => (
            <div key={r.id} style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
              <div className="row-between" style={{ gap: 12, alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontWeight: 900 }}>{formatYmd(r.occurred_on)}</div>

                  {r.notes ? (
                    <div className="subtle" style={{ marginTop: 4 }}>
                      {r.notes}
                    </div>
                  ) : (
                    <div className="subtle" style={{ marginTop: 4 }}>
                      —
                    </div>
                  )}

                  <div className="subtle" style={{ marginTop: 6, fontSize: 12 }}>
                    Created: {r.created_at ? new Date(r.created_at).toLocaleString() : "—"}
                  </div>
                </div>

                <div className="row" style={{ gap: 8, alignItems: "center" }}>
                  <button className="btn" type="button" onClick={() => void deleteTimeOffDayRecord(r.id)} style={{ padding: "6px 10px" }}>
                    Delete
                  </button>
                  <div className="subtle" style={{ fontWeight: 800, whiteSpace: "nowrap" }}>
                    ID:{" "}
                    <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                      {r.id.slice(0, 8)}…
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  </div>

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