import { supabase } from "./supabaseClient";
import { ensureCjkFont } from "./pdfGlyphs";

/**
 * One-click full profile export for an employee.
 *
 * Pulls the same rows every tab of the employee page shows — general details,
 * milestones, attendance, time off, meetings, performance reviews, documents
 * and assigned supervisors — and lays them out as a plain, printable PDF.
 *
 * It re-queries rather than reading the page's state so the export is complete
 * whether or not you've opened each tab (they load lazily). RLS still applies,
 * so an export only ever contains what the person running it may see.
 */

type Doc = {
  addPage: () => void;
  setFont: (family: string, style?: string) => void;
  setFontSize: (n: number) => void;
  setTextColor: (r: number, g?: number, b?: number) => void;
  setDrawColor: (r: number, g?: number, b?: number) => void;
  setFillColor: (r: number, g?: number, b?: number) => void;
  text: (t: string, x: number, y: number) => void;
  line: (x1: number, y1: number, x2: number, y2: number) => void;
  rect: (x: number, y: number, w: number, h: number, style?: string) => void;
  splitTextToSize: (t: string, w: number) => string[];
  save: (name: string) => void;
  addFileToVFS: (n: string, d: string) => void;
  addFont: (f: string, n: string, s: string) => void;
  internal: { pageSize: { getWidth: () => number; getHeight: () => number } };
};

const MARGIN = 44;
const LINE = 14;

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v.length <= 10 ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function fmtMoney(n: number | null | undefined, rateType?: string | null): string {
  if (n == null) return "—";
  const s = `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return rateType === "hourly" ? `${s} / hour` : `${s} / year`;
}

function yesNo(v: boolean | null | undefined): string {
  return v ? "Yes" : "No";
}

type Row = [string, string];
type Section = { title: string; rows?: Row[]; table?: { head: string[]; body: string[][] }; note?: string };

/** Only the columns this export prints — the row type the page uses is far wider. */
type EmpRow = {
  id: string;
  profile_id: string | null;
  legal_first_name: string;
  legal_middle_name: string | null;
  legal_last_name: string;
  nicknames: string[] | null;
  start_date: string | null;
  end_date: string | null;
  rate_type: string | null;
  rate: number | null;
  employment_type: string | null;
  is_active: boolean;
  benefits: string[] | null;
  has_insurance: boolean;
  has_401k: boolean;
  has_pto: boolean;
  attendance_points: number | null;
  job_level_id: string | null;
  campus_id: string | null;
  created_at: string;
  updated_at: string;
};

export async function exportEmployeeProfilePdf(employeeId: string): Promise<void> {
  const { jsPDF } = await import("jspdf");

  // ── Gather ────────────────────────────────────────────────────────────────
  const { data: empData, error } = await supabase
    .from("hr_employees")
    .select(
      "id, profile_id, legal_first_name, legal_middle_name, legal_last_name, nicknames, " +
      "start_date, end_date, rate_type, rate, employment_type, is_active, benefits, " +
      "has_insurance, has_401k, has_pto, attendance_points, job_level_id, campus_id, " +
      "pto_meta, created_at, updated_at"
    )
    .eq("id", employeeId)
    .maybeSingle();
  if (error) throw error;
  if (!empData) throw new Error("That employee record could not be loaded.");
  const emp = empData as unknown as EmpRow;

  const [
    jobLevel, campus, profile, events, attendance, timeOffHours, timeOffDays,
    meetings, reviews, documents, assignees,
  ] = await Promise.all([
    emp.job_level_id
      ? supabase.from("hr_job_levels").select("name").eq("id", emp.job_level_id).maybeSingle()
      : Promise.resolve({ data: null }),
    emp.campus_id
      ? supabase.from("hr_campuses").select("name").eq("id", emp.campus_id).maybeSingle()
      : Promise.resolve({ data: null }),
    emp.profile_id
      ? supabase.from("user_profiles").select("username, full_name, email, role, is_active").eq("id", emp.profile_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("hr_employee_events")
      .select("event_date, notes, event_type:hr_event_types!hr_employee_events_event_type_id_fkey(name)")
      .eq("employee_id", employeeId)
      .order("event_date", { ascending: false }),
    supabase
      .from("hr_employee_attendance")
      .select("occurred_on, notes, attendance_type:hr_attendance_types!hr_employee_attendance_attendance_type_id_fkey(name, points_deduct)")
      .eq("employee_id", employeeId)
      .order("occurred_on", { ascending: false }),
    supabase
      .from("hr_employee_time_off_requests")
      .select("occurred_on, hours_requested, notes")
      .eq("employee_id", employeeId)
      .order("occurred_on", { ascending: false }),
    supabase
      .from("hr_employee_time_off_requests_days")
      .select("occurred_on, notes")
      .eq("employee_id", employeeId)
      .order("occurred_on", { ascending: false }),
    supabase
      .from("hr_meetings")
      .select("meeting_at, notes, meeting_type:hr_meeting_types(name)")
      .eq("employee_id", employeeId)
      .order("meeting_at", { ascending: false }),
    supabase
      .from("hr_reviews")
      .select("form_type, period_year, period_month, published, attendance_points_snapshot, notes, created_at")
      .eq("employee_id", employeeId)
      .order("period_year", { ascending: false })
      .order("period_month", { ascending: false }),
    supabase
      .from("hr_employee_documents")
      .select("name, mime_type, size_bytes, created_at")
      .eq("employee_id", employeeId)
      .order("created_at", { ascending: false }),
    // Only meaningful for supervisors — it's who reports to them, which is what
    // the Assignees tab shows.
    emp.profile_id
      ? supabase.rpc("list_supervisor_assignments", { supervisor_uuid: emp.profile_id })
      : Promise.resolve({ data: null }),
  ]);

  const fullName = [emp.legal_first_name, emp.legal_middle_name, emp.legal_last_name]
    .filter(Boolean).join(" ");
  const prof = (profile.data ?? null) as { username?: string; full_name?: string; email?: string; role?: string; is_active?: boolean } | null;

  // ── Shape ─────────────────────────────────────────────────────────────────
  const sections: Section[] = [];

  sections.push({
    title: "General",
    rows: [
      ["Legal name", fullName || "—"],
      ["Nicknames", (emp.nicknames ?? []).join(", ") || "—"],
      ["Status", emp.is_active ? "Active" : "Inactive"],
      ["Campus", (campus.data as { name?: string } | null)?.name ?? "—"],
      ["Job level", (jobLevel.data as { name?: string } | null)?.name ?? "—"],
      ["Employment type", emp.employment_type === "part_time" ? "Part time" : "Full time"],
      ["Pay", fmtMoney(emp.rate, emp.rate_type)],
      ["Start date", fmtDate(emp.start_date)],
      ["End date", fmtDate(emp.end_date)],
      ["Attendance points", String(emp.attendance_points ?? 0)],
      ["Benefits", (emp.benefits ?? []).join(", ") || "—"],
      ["Insurance", yesNo(emp.has_insurance)],
      ["401(k)", yesNo(emp.has_401k)],
      ["PTO", yesNo(emp.has_pto)],
      ["Record created", fmtDate(emp.created_at)],
      ["Last updated", fmtDate(emp.updated_at)],
    ],
  });

  sections.push({
    title: "Portal account",
    rows: prof
      ? [
          ["Username", prof.username ?? "—"],
          ["Display name", prof.full_name ?? "—"],
          ["Email", prof.email ?? "—"],
          ["Role", prof.role ?? "—"],
          ["Account status", prof.is_active ? "Active" : "Disabled"],
        ]
      : undefined,
    note: prof ? undefined : "No portal account is linked to this record.",
  });

  const assigneeRows = ((assignees.data ?? []) as { full_name: string | null; username: string | null }[])
    .map((a) => (a.full_name ?? "").trim() || (a.username ?? "").trim())
    .filter(Boolean);
  if (assigneeRows.length) {
    sections.push({
      title: "Teachers assigned to this supervisor",
      note: assigneeRows.join(", "),
    });
  }

  const eventRows = ((events.data ?? []) as { event_date: string; notes: string | null; event_type: { name?: string } | { name?: string }[] | null }[])
    .map((e) => {
      const t = Array.isArray(e.event_type) ? e.event_type[0] : e.event_type;
      return [fmtDate(e.event_date), t?.name ?? "—", e.notes ?? ""];
    });
  sections.push({
    title: "Milestones",
    table: eventRows.length ? { head: ["Date", "Type", "Notes"], body: eventRows } : undefined,
    note: eventRows.length ? undefined : "No milestones recorded.",
  });

  const attRows = ((attendance.data ?? []) as { occurred_on: string; notes: string | null; attendance_type: { name?: string; points_deduct?: number } | { name?: string; points_deduct?: number }[] | null }[])
    .map((a) => {
      const t = Array.isArray(a.attendance_type) ? a.attendance_type[0] : a.attendance_type;
      return [fmtDate(a.occurred_on), t?.name ?? "—", t?.points_deduct != null ? String(t.points_deduct) : "—", a.notes ?? ""];
    });
  sections.push({
    title: "Attendance",
    table: attRows.length ? { head: ["Date", "Type", "Points", "Notes"], body: attRows } : undefined,
    note: attRows.length ? undefined : "No attendance records.",
  });

  const hourRows = ((timeOffHours.data ?? []) as { occurred_on: string; hours_requested: number; notes: string | null }[])
    .map((r) => [fmtDate(r.occurred_on), `${Number(r.hours_requested ?? 0)} h`, r.notes ?? ""]);
  const dayRows = ((timeOffDays.data ?? []) as { occurred_on: string; notes: string | null }[])
    .map((r) => [fmtDate(r.occurred_on), "1 day", r.notes ?? ""]);
  const offRows = [...hourRows, ...dayRows];
  sections.push({
    title: "Time off",
    table: offRows.length ? { head: ["Date", "Amount", "Notes"], body: offRows } : undefined,
    note: offRows.length ? undefined : "No time-off records.",
  });

  const meetingRows = ((meetings.data ?? []) as { meeting_at: string; notes: string | null; meeting_type: { name?: string } | { name?: string }[] | null }[])
    .map((m) => {
      const t = Array.isArray(m.meeting_type) ? m.meeting_type[0] : m.meeting_type;
      return [fmtDate(m.meeting_at), t?.name ?? "—", m.notes ?? ""];
    });
  sections.push({
    title: "Meetings",
    table: meetingRows.length ? { head: ["Date", "Type", "Notes"], body: meetingRows } : undefined,
    note: meetingRows.length ? undefined : "No meetings recorded.",
  });

  const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const reviewRows = ((reviews.data ?? []) as { form_type: string; period_year: number | null; period_month: number | null; published: boolean; attendance_points_snapshot: number | null; notes: string | null }[])
    .map((r) => [
      r.period_month ? `${MONTHS[r.period_month] ?? r.period_month} ${r.period_year ?? ""}`.trim() : String(r.period_year ?? "—"),
      r.form_type ?? "—",
      r.published ? "Published" : "Draft",
      r.attendance_points_snapshot != null ? String(r.attendance_points_snapshot) : "—",
      r.notes ?? "",
    ]);
  sections.push({
    title: "Performance reviews",
    table: reviewRows.length ? { head: ["Period", "Form", "Status", "Att. points", "Notes"], body: reviewRows } : undefined,
    note: reviewRows.length
      ? "Scores live in the scorecard exports; this lists which reviews exist."
      : "No performance reviews.",
  });

  const docRows = ((documents.data ?? []) as { name: string; mime_type: string | null; size_bytes: number | null; created_at: string }[])
    .map((d) => [
      fmtDate(d.created_at), d.name,
      d.size_bytes ? `${Math.max(1, Math.round(d.size_bytes / 1024))} KB` : "—",
    ]);
  sections.push({
    title: "Documents on file",
    table: docRows.length ? { head: ["Uploaded", "Name", "Size"], body: docRows } : undefined,
    note: docRows.length
      ? "Filenames only — the files themselves stay in the Documents tab."
      : "No documents uploaded.",
  });

  // ── Draw ──────────────────────────────────────────────────────────────────
  const doc = new jsPDF({ unit: "pt", format: "letter" }) as unknown as Doc;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const contentW = pageW - MARGIN * 2;

  // Nicknames and notes are often Chinese, so subset a font over everything
  // this document will actually print.
  const allText = [
    fullName,
    ...sections.flatMap((s) => [
      s.title, s.note ?? "",
      ...(s.rows ?? []).flat(),
      ...(s.table?.head ?? []),
      ...(s.table?.body ?? []).flat(),
    ]),
  ].join(" ");
  const cjk = await ensureCjkFont(doc, allText, "tc");
  const body = cjk ?? "helvetica";
  const setFont = (bold: boolean) => doc.setFont(body, bold ? "bold" : "normal");

  let y = MARGIN;
  const room = (need: number) => {
    if (y + need <= pageH - MARGIN) return;
    doc.addPage();
    y = MARGIN;
  };

  // Header
  setFont(true);
  doc.setFontSize(20);
  doc.setTextColor(17, 24, 39);
  doc.text(fullName || "Employee", MARGIN, y);
  y += 20;
  setFont(false);
  doc.setFontSize(10);
  doc.setTextColor(107, 114, 128);
  doc.text(
    `Full profile · exported ${new Date().toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })}`,
    MARGIN, y
  );
  y += 10;
  doc.setDrawColor(230, 23, 141);
  doc.line(MARGIN, y, pageW - MARGIN, y);
  y += 22;

  for (const section of sections) {
    room(60);
    setFont(true);
    doc.setFontSize(13);
    doc.setTextColor(230, 23, 141);
    doc.text(section.title, MARGIN, y);
    y += 6;
    doc.setDrawColor(229, 231, 235);
    doc.line(MARGIN, y, pageW - MARGIN, y);
    y += 16;

    doc.setFontSize(10);
    doc.setTextColor(17, 24, 39);

    if (section.rows) {
      const labelW = 130;
      for (const [label, value] of section.rows) {
        const lines = doc.splitTextToSize(value || "—", contentW - labelW - 10);
        room(lines.length * LINE + 4);
        setFont(true);
        doc.setTextColor(107, 114, 128);
        doc.text(label, MARGIN, y);
        setFont(false);
        doc.setTextColor(17, 24, 39);
        lines.forEach((ln, i) => doc.text(ln, MARGIN + labelW, y + i * LINE));
        y += lines.length * LINE + 2;
      }
      y += 6;
    }

    if (section.table) {
      const cols = section.table.head.length;
      // Last column (usually Notes) takes the slack; the rest share evenly.
      const narrow = Math.min(110, (contentW * 0.7) / Math.max(1, cols - 1));
      const widths = section.table.head.map((_, i) => (i === cols - 1 ? contentW - narrow * (cols - 1) : narrow));

      const drawHead = () => {
        room(LINE + 8);
        setFont(true);
        doc.setTextColor(107, 114, 128);
        let x = MARGIN;
        section.table!.head.forEach((h, i) => {
          doc.text(h, x, y);
          x += widths[i];
        });
        y += 6;
        doc.setDrawColor(229, 231, 235);
        doc.line(MARGIN, y, pageW - MARGIN, y);
        y += 12;
        setFont(false);
        doc.setTextColor(17, 24, 39);
      };
      drawHead();

      for (const row of section.table.body) {
        const wrapped = row.map((cell, i) => doc.splitTextToSize(cell || "—", widths[i] - 8));
        const h = Math.max(...wrapped.map((w) => w.length)) * LINE;
        if (y + h > pageH - MARGIN) { doc.addPage(); y = MARGIN; drawHead(); }
        let x = MARGIN;
        wrapped.forEach((lines, i) => {
          lines.forEach((ln, j) => doc.text(ln, x, y + j * LINE));
          x += widths[i];
        });
        y += h + 4;
      }
      y += 8;
    }

    if (section.note) {
      const lines = doc.splitTextToSize(section.note, contentW);
      room(lines.length * LINE + 6);
      setFont(false);
      doc.setTextColor(107, 114, 128);
      lines.forEach((ln, i) => doc.text(ln, MARGIN, y + i * LINE));
      y += lines.length * LINE + 12;
    }
  }

  const safe = (fullName || "employee").replace(/[\\/:*?"<>|]+/g, "_");
  doc.save(`${safe} — full profile.pdf`);
}
