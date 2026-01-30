"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { supabase } from "@/lib/supabaseClient";
import "@fortune-sheet/react/dist/index.css";

/**
 * app/hr/page.tsx
 *
 * Self-service HR portal:
 * - All employees: view Attendance + Performance Reviews
 * - Supervisors only: Meetings tab (edit notes, type/time, attendees, documents; cannot delete meeting)
 *
 * This file intentionally mirrors the styling + meeting/document helpers used in the admin HR employee page.
 */

type UserRole = "teacher" | "supervisor" | "admin";

type UserProfileRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  role: UserRole;
  is_active: boolean;
  username: string | null;
};

type EmployeeRow = {
  id: string;
  legal_first_name: string;
  legal_middle_name: string | null;
  legal_last_name: string;
  nicknames: string[];
  is_active: boolean;
  attendance_points: number;
  attendance_score: number | null;
  profile_id: string | null;
};

type AttendanceTypeRow = { id: string; name: string; points_deduct: number };
type EmployeeAttendanceRow = {
  id: string;
  employee_id: string;
  attendance_type_id: string;
  occurred_on: string;
  notes: string | null;
  created_at: string;
  attendance_type?: AttendanceTypeRow | null;
};

type HrMeetingType = { id: string; name: string };
type HrMeeting = {
  id: string;
  employee_id: string;
  meeting_type_id: string | null;
  meeting_at: string;
  notes: string;
  created_at: string;
  updated_at: string | null;
  type?: HrMeetingType | null;
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
  mime: string | null;
  size_bytes: number | null;
  object_key: string;
  created_at: string;
};

type EmployeeLite = {
  id: string;
  legal_first_name: string;
  legal_middle_name: string | null;
  legal_last_name: string;
  nicknames: string[];
  is_active: boolean;
};

type MeetingOwnerLite = Pick<EmployeeLite, "id" | "legal_first_name" | "legal_middle_name" | "legal_last_name" | "nicknames" | "is_active">;

function asSingle<T>(val: any): T | null {
  if (!val) return null;
  if (Array.isArray(val)) return (val[0] ?? null) as T | null;
  return val as T;
}

function formatEmployeeName(e: EmployeeLite | MeetingOwnerLite | null | undefined) {
  if (!e) return "—";
  const first = e.legal_first_name?.trim() ?? "";
  const mid = e.legal_middle_name?.trim() ?? "";
  const last = e.legal_last_name?.trim() ?? "";
  const base = [first, mid, last].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return base || "—";
}

function safeIsoForDatetimeLocal(iso: string) {
  // datetime-local expects "YYYY-MM-DDTHH:mm"
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}

function toIsoFromDatetimeLocal(local: string) {
  // Treat local as local time; new Date(local) parses as local in browsers.
  const d = new Date(local);
  return d.toISOString();
}

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

function extOf(name: string) {
  const idx = name.lastIndexOf(".");
  if (idx === -1) return "";
  return name.slice(idx + 1).toLowerCase();
}

function isOfficeExt(ext: string) {
  return ["doc", "docx", "ppt", "pptx", "xls", "xlsx"].includes(ext);
}
function isPdfExt(ext: string) {
  return ext === "pdf";
}
function isImageExt(ext: string) {
  return ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext);
}
function isTextExt(ext: string) {
  return ["txt", "md", "json", "log"].includes(ext);
}
function isVideoExt(ext: string) {
  return ["mp4", "webm", "mov", "m4v"].includes(ext);
}
function isAudioExt(ext: string) {
  return ["mp3", "wav", "m4a", "ogg"].includes(ext);
}

function parseCsv(text: string) {
  // lightweight CSV parser for preview (handles commas + quotes enough for admin preview use)
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        continue;
      }
      field += ch;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      cur.push(field);
      field = "";
      continue;
    }

    if (ch === "\n") {
      cur.push(field);
      field = "";
      rows.push(cur);
      cur = [];
      continue;
    }

    if (ch === "\r") continue;

    field += ch;
  }

  cur.push(field);
  rows.push(cur);
  return rows;
}

/* ===== UI atoms (match admin page styling) ===== */

function FieldLabel({ children }: { children: any }) {
  return <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 6 }}>{children}</div>;
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={["input", props.className].filter(Boolean).join(" ")}
      style={{
        height: 38,
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        padding: "0 12px",
        outline: "none",
        ...(props.style ?? {}),
      }}
    />
  );
}

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={["input", props.className].filter(Boolean).join(" ")}
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        padding: "10px 12px",
        outline: "none",
        minHeight: 100,
        ...(props.style ?? {}),
      }}
    />
  );
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={["input", props.className].filter(Boolean).join(" ")}
      style={{
        height: 38,
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        padding: "0 12px",
        outline: "none",
        background: "white",
        ...(props.style ?? {}),
      }}
    />
  );
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: any;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="btn"
      style={{
        width: "100%",
        justifyContent: "flex-start",
        borderRadius: 12,
        padding: "10px 12px",
        border: "1px solid #e5e7eb",
        background: active ? "rgba(0,0,0,0.04)" : "white",
        fontWeight: 900,
      }}
    >
      {children}
    </button>
  );
}

// Office preview without extra deps: use Microsoft Office online viewer embed
function OfficeEmbed({ url }: { url: string }) {
  const src = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`;
  return <iframe src={src} style={{ width: "100%", height: "70vh", border: "none" }} />;
}


/* =========================
   Page
========================= */

export default function HrPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [profile, setProfile] = useState<UserProfileRow | null>(null);
  const [employee, setEmployee] = useState<EmployeeRow | null>(null);

  const isSupervisor = profile?.role === "supervisor";

  const [activeTab, setActiveTab] = useState<"attendance" | "reviews" | "meetings">("attendance");

  // Attendance
  const [attendanceRows, setAttendanceRows] = useState<EmployeeAttendanceRow[]>([]);
  const [attendanceLoading, setAttendanceLoading] = useState(false);

  // Reviews: keep as simple placeholder (existing system can be swapped in later)
  // If you already have a dedicated reviews tab component, you can drop it in here.
  const [reviewsNote] = useState("Performance reviews are available in this portal. (UI omitted here.)");

  // Meetings (supervisor-only): meetings where current employee is an attendee
  const [meetingTypes, setMeetingTypes] = useState<HrMeetingType[]>([]);
  const activeMeetingTypes = meetingTypes; // keep parity with admin page

  const [allEmployees, setAllEmployees] = useState<EmployeeLite[]>([]);

  const [meetings, setMeetings] = useState<(HrMeeting & { owner: MeetingOwnerLite | null })[]>([]);
  const [attendeesByMeeting, setAttendeesByMeeting] = useState<Map<string, HrMeetingAttendee[]>>(new Map());
  const [docsByMeeting, setDocsByMeeting] = useState<Map<string, HrMeetingDocument[]>>(new Map());

  const [meetingStatus, setMeetingStatus] = useState<string>("");

  const [attendeeDropdownOpenByMeeting, setAttendeeDropdownOpenByMeeting] = useState<Record<string, boolean>>({});
  const [selectedAttendeeEmployeeIdByMeeting, setSelectedAttendeeEmployeeIdByMeeting] = useState<Record<string, string | null>>({});
  const [addingAttendeeByMeeting, setAddingAttendeeByMeeting] = useState<Record<string, boolean>>({});
  const [uploadingMeetingId, setUploadingMeetingId] = useState<string | null>(null);

  // Preview modal
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<HrMeetingDocument | null>(null);
  const [previewMode, setPreviewMode] = useState<"office" | "pdf" | "image" | "csv" | "text" | "video" | "audio" | "unknown">("unknown");
  const [previewSignedUrl, setPreviewSignedUrl] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewCsvRows, setPreviewCsvRows] = useState<string[][]>([]);
  const [previewCsvError, setPreviewCsvError] = useState<string>("");

  const closePreview = useCallback(() => {
    setPreviewOpen(false);
    setPreviewDoc(null);
    setPreviewSignedUrl("");
    setPreviewLoading(false);
    setPreviewCsvRows([]);
    setPreviewCsvError("");
    setPreviewMode("unknown");
  }, []);

  // init: session -> profile -> employee
  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const userId = sessionData.session?.user?.id;
        if (!userId) {
          setProfile(null);
          setEmployee(null);
          setError("Not signed in.");
          return;
        }

        const profRes = await supabase
          .from("user_profiles")
          .select("id,full_name,email,role,is_active,username")
          .eq("id", userId)
          .single();

        if (profRes.error) throw profRes.error;
        const p = profRes.data as any as UserProfileRow;
        setProfile(p);

        const empRes = await supabase
          .from("hr_employees")
          .select("id,legal_first_name,legal_middle_name,legal_last_name,nicknames,is_active,attendance_points,attendance_score,profile_id")
          .eq("profile_id", userId)
          .single();

        if (empRes.error) throw empRes.error;
        setEmployee(empRes.data as any as EmployeeRow);
      } catch (e: any) {
        setError(e?.message ?? "Failed to load HR portal.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const loadMyAttendance = useCallback(async () => {
    if (!employee?.id) return;
    setAttendanceLoading(true);
    try {
      const res = await supabase
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
        .eq("employee_id", employee.id)
        .order("occurred_on", { ascending: false })
        .order("created_at", { ascending: false });

      if (res.error) throw res.error;

      const rows = (res.data ?? []).map((x: any) => ({
        ...x,
        attendance_type: asSingle<AttendanceTypeRow>(x.attendance_type),
      })) as EmployeeAttendanceRow[];

      setAttendanceRows(rows);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load attendance.");
      setAttendanceRows([]);
    } finally {
      setAttendanceLoading(false);
    }
  }, [employee?.id]);

  const reloadMeetingTypes = useCallback(async () => {
    const res = await supabase.from("hr_meeting_types").select("id,name").order("name", { ascending: true });
    if (res.error) throw res.error;
    setMeetingTypes((res.data ?? []) as any as HrMeetingType[]);
  }, []);

  const reloadAllEmployees = useCallback(async () => {
    const res = await supabase
      .from("hr_employees")
      .select("id,legal_first_name,legal_middle_name,legal_last_name,nicknames,is_active")
      .order("legal_last_name", { ascending: true })
      .order("legal_first_name", { ascending: true });
    if (res.error) throw res.error;
    setAllEmployees((res.data ?? []) as any as EmployeeLite[]);
  }, []);

  const loadAttendeeMeetings = useCallback(async (attendeeEmpId: string) => {
    if (!attendeeEmpId) {
      setMeetings([]);
      setAttendeesByMeeting(new Map());
      setDocsByMeeting(new Map());
      return;
    }

    setMeetingStatus("Loading meetings...");
    try {
      // Load meetings via attendee table so we capture any meeting where supervisor is an attendee.
      const nameHints: string[] = [];
      const profName = (profile?.full_name ?? "").trim();
      if (profName) nameHints.push(profName);
      const uname = (profile as any)?.username ? String((profile as any).username) : "";
      if (uname) nameHints.push(uname);
      const legalName =
        [employee?.legal_first_name, employee?.legal_last_name].filter(Boolean).join(" ").trim();
      if (legalName) nameHints.push(legalName);
      for (const nn of (employee?.nicknames ?? [])) {
        const n = String(nn ?? "").trim();
        if (!n) continue;
        // "Nickname Lastname" and just nickname
        const last = (employee?.legal_last_name ?? "").trim();
        nameHints.push(last ? `${n} ${last}` : n);
        nameHints.push(n);
      }

      // Primary match is attendee_employee_id. We also include a fallback match on attendee_name
      // for older rows where attendee_employee_id was left null.
      const orParts: string[] = [`attendee_employee_id.eq.${attendeeEmpId}`];
      for (const raw of nameHints) {
        const safe = raw.replace(/[,%]/g, " ").replace(/\s+/g, " ").trim();
        if (!safe) continue;
        orParts.push(`attendee_name.ilike.%${safe}%`);
      }

      const ares = await supabase
        .from("hr_meeting_attendees")
        .select("meeting_id, created_at, attendee_name, attendee_employee_id")
        .or(orParts.join(","))
        .order("created_at", { ascending: false });

      if (ares.error) throw ares.error;

      const attendeeRows = (ares.data ?? []) as any[];
      const meetingIds = Array.from(
        new Set(
          attendeeRows
            .map((r) => String(r.meeting_id ?? "").trim())
            .filter(Boolean)
        )
      );

      if (meetingIds.length === 0) {
        setMeetings([]);
        setAttendeesByMeeting(new Map());
        setDocsByMeeting(new Map());
        setMeetingStatus("No meetings found for you yet.");
        return;
      }

      // Now load the meeting objects (this can be RLS-blocked even if attendee rows are visible).
      const mres = await supabase
        .from("hr_meetings")
        .select(
          `
            id,
            employee_id,
            meeting_type_id,
            meeting_at,
            notes,
            created_at,
            updated_at,
            type:hr_meeting_types(id,name),
            owner:hr_employees!hr_meetings_employee_id_fkey(
              id,
              legal_first_name,
              legal_middle_name,
              legal_last_name
            )
          `
        )
        .in("id", meetingIds);

      if (mres.error) throw mres.error;

      const list = ((mres.data ?? []) as any[])
        .map((m) => {
          if (!m?.id) return null;
          const owner = asSingle<MeetingOwnerLite>(m.owner);
          const type = asSingle<any>(m.type) as HrMeetingType | null;
          const mm: HrMeeting & { owner: MeetingOwnerLite | null } = {
            id: m.id,
            employee_id: m.employee_id,
            meeting_type_id: m.meeting_type_id,
            meeting_at: m.meeting_at,
            notes: m.notes ?? "",
            created_at: m.created_at,
            updated_at: m.updated_at,
            type,
            owner,
          };
          return mm;
        })
        .filter(Boolean) as (HrMeeting & { owner: MeetingOwnerLite | null })[];

      if (list.length === 0) {
        setMeetings([]);
        setAttendeesByMeeting(new Map());
        setDocsByMeeting(new Map());
        setMeetingStatus(
          "You have attendee entries, but meetings couldn't be loaded (likely RLS). Ask an admin to allow supervisors to SELECT hr_meetings where they are an attendee."
        );
        return;
      }

      list.sort((a, b) => new Date(b.meeting_at).getTime() - new Date(a.meeting_at).getTime());

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

      const attMap = new Map<string, HrMeetingAttendee[]>();
      const attSeen = new Set<string>();
      for (const a of (attRes.data ?? []) as HrMeetingAttendee[]) {
        if (!a?.id) continue;
        if (attSeen.has(a.id)) continue;
        attSeen.add(a.id);
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
  }, [employee, profile]);

  async function updateMeeting(meetingId: string, patch: Partial<Pick<HrMeeting, "meeting_type_id" | "meeting_at" | "notes">>) {
    setMeetingStatus("Saving...");
    try {
      const { error } = await supabase.from("hr_meetings").update(patch).eq("id", meetingId);
      if (error) throw error;

      setMeetings((cur) => cur.map((m) => (m.id === meetingId ? ({ ...m, ...patch } as any) : m)));

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

    const current = attendeesByMeeting.get(meetingId) ?? [];
    if (current.some((a) => a.attendee_employee_id === selectedEmployeeId)) {
      setMeetingStatus("That employee is already an attendee.");
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

      for (const file of filesArr) {
        const presigned = await presignMeetingUpload(meetingId, file, token);
        const put = await fetch(presigned.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!put.ok) throw new Error(`Upload failed (${put.status})`);

        const { data, error } = await supabase
          .from("hr_meeting_documents")
          .insert({
            meeting_id: meetingId,
            name: file.name,
            mime: file.type || "application/octet-stream",
            size_bytes: file.size,
            object_key: presigned.objectKey,
          })
          .select("*")
          .single();

        if (error) throw error;

        setDocsByMeeting((cur) => {
          const next = new Map(cur);
          const arr = next.get(meetingId) ?? [];
          arr.unshift(data as any as HrMeetingDocument);
          next.set(meetingId, arr);
          return next;
        });
      }

      setMeetingStatus("✅ Uploaded.");
      setTimeout(() => setMeetingStatus(""), 900);
    } catch (e: any) {
      setMeetingStatus("Upload error: " + (e?.message ?? "unknown"));
    } finally {
      setUploadingMeetingId(null);
    }
  }

  async function deleteMeetingDoc(doc: HrMeetingDocument) {
    if (!confirm(`Delete "${doc.name}"?`)) return;
    setMeetingStatus("Deleting document...");
    try {
      const { error } = await supabase.from("hr_meeting_documents").delete().eq("id", doc.id);
      if (error) throw error;

      setDocsByMeeting((cur) => {
        const next = new Map(cur);
        const arr = (next.get(doc.meeting_id) ?? []).filter((d) => d.id !== doc.id);
        next.set(doc.meeting_id, arr);
        return next;
      });

      setMeetingStatus("✅ Deleted.");
      setTimeout(() => setMeetingStatus(""), 900);
    } catch (e: any) {
      setMeetingStatus("Delete document error: " + (e?.message ?? "unknown"));
    }
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

  // ESC closes preview
  useEffect(() => {
    if (!previewOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePreview();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewOpen, closePreview]);

  // Auto-load attendance once employee loads
  useEffect(() => {
    if (!employee?.id) return;
    void loadMyAttendance();
  }, [employee?.id, loadMyAttendance]);

  // When switching to Meetings tab (supervisors only), lazy-load meeting types, employees, and meetings
  useEffect(() => {
    if (!employee?.id) return;
    if (activeTab !== "meetings") return;
    if (!isSupervisor) return;

    (async () => {
      try {
        await reloadMeetingTypes();
        await reloadAllEmployees();
      } catch (e: any) {
        setMeetingStatus("Failed to load meeting data: " + (e?.message ?? "unknown"));
      }
      await loadAttendeeMeetings(employee.id);
    })();
  }, [activeTab, employee?.id, isSupervisor, reloadMeetingTypes, reloadAllEmployees, loadAttendeeMeetings]);

  const headerName = useMemo(() => formatEmployeeName(employee as any), [employee]);

  if (loading) {
    return (
      <main style={{ padding: 24 }}>
        <div className="subtle">Loading…</div>
      </main>
    );
  }

  if (error) {
    return (
      <main style={{ padding: 24 }}>
        <div style={{ fontWeight: 900, fontSize: 18 }}>HR</div>
        <div className="subtle" style={{ marginTop: 8 }}>
          {error}
        </div>
      </main>
    );
  }

  if (!profile || !employee) {
    return (
      <main style={{ padding: 24 }}>
        <div style={{ fontWeight: 900, fontSize: 18 }}>HR</div>
        <div className="subtle" style={{ marginTop: 8 }}>
          No profile/employee record found.
        </div>
      </main>
    );
  }

  if (!profile.is_active || !employee.is_active) {
    return (
      <main style={{ padding: 24 }}>
        <div style={{ fontWeight: 900, fontSize: 18 }}>HR</div>
        <div className="subtle" style={{ marginTop: 8 }}>
          Your account is not active.
        </div>
      </main>
    );
  }

  return (
    <main style={{ padding: 24 }}>
      <div style={{ display: "grid", gap: 14 }}>
        <div className="row-between" style={{ gap: 12, alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 950, fontSize: 22 }}>{headerName}</div>
            <div className="subtle" style={{ marginTop: 2 }}>
              Role: <b>{profile.role}</b>
            </div>
          </div>

          <button className="btn" type="button" onClick={() => void supabase.auth.signOut()}>
            Sign out
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 14, alignItems: "start" }}>
          {/* Left nav */}
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 12, display: "grid", gap: 10 }}>
            <TabButton active={activeTab === "attendance"} onClick={() => setActiveTab("attendance")}>
              Attendance
            </TabButton>
            <TabButton active={activeTab === "reviews"} onClick={() => setActiveTab("reviews")}>
              Performance Reviews
            </TabButton>
            {isSupervisor ? (
              <TabButton active={activeTab === "meetings"} onClick={() => setActiveTab("meetings")}>
                Meetings
              </TabButton>
            ) : null}

            {!isSupervisor ? (
              <div className="subtle" style={{ marginTop: 6, fontSize: 12 }}>
                Meetings are only available to supervisors.
              </div>
            ) : null}
          </div>

          {/* Right content */}
          <div style={{ display: "grid", gap: 14 }}>
            {activeTab === "attendance" ? (
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
                <div style={{ fontWeight: 950, fontSize: 18 }}>Attendance</div>
                <div className="subtle" style={{ marginTop: 6 }}>
                  Points remaining: <b>{employee.attendance_points}</b>
                  {typeof employee.attendance_score === "number" ? (
                    <>
                      {" "}
                      • Attendance score: <b>{employee.attendance_score}</b>
                    </>
                  ) : null}
                </div>

                <div style={{ marginTop: 12 }} className="row-between">
                  <div style={{ fontWeight: 900 }}>History</div>
                  <button className="btn" type="button" onClick={() => void loadMyAttendance()} disabled={attendanceLoading}>
                    {attendanceLoading ? "Loading…" : "Refresh"}
                  </button>
                </div>

                <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                  {attendanceLoading ? (
                    <div className="subtle">Loading…</div>
                  ) : attendanceRows.length === 0 ? (
                    <div className="subtle">(No attendance records yet.)</div>
                  ) : (
                    attendanceRows.map((a) => (
                      <div key={a.id} style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
                        <div style={{ fontWeight: 900 }}>
                          {a.attendance_type?.name ?? "—"}{" "}
                          <span className="subtle" style={{ fontWeight: 800 }}>
                            • −{a.attendance_type?.points_deduct ?? 0}
                          </span>{" "}
                          • {a.occurred_on}
                        </div>
                        <div className="subtle" style={{ marginTop: 4 }}>
                          {a.notes || "—"}
                        </div>
                        <div className="subtle" style={{ marginTop: 6, fontSize: 12 }}>
                          Created: {a.created_at ? new Date(a.created_at).toLocaleString() : "—"}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}

            {activeTab === "reviews" ? (
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
                <div style={{ fontWeight: 950, fontSize: 18 }}>Performance Reviews</div>
                <div className="subtle" style={{ marginTop: 6 }}>
                  {reviewsNote}
                </div>
                <div className="subtle" style={{ marginTop: 10, fontSize: 12 }}>
                  If you want the full review editor UI here (including question editors), we can copy the existing admin page component into this portal, but keep it read-only.
                </div>
              </div>
            ) : null}

            {activeTab === "meetings" && isSupervisor ? (
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
                <div className="row-between" style={{ gap: 12, alignItems: "center" }}>
                  <div style={{ fontWeight: 950, fontSize: 18 }}>Meetings</div>

                  <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                    <button className="btn" type="button" onClick={() => void loadAttendeeMeetings(employee.id)}>
                      Refresh
                    </button>
                  </div>
                </div>

                <div className="subtle" style={{ marginTop: 6 }}>
                  Showing meetings where you are listed as an attendee. You can edit notes, type/time, attendees, and documents. You cannot delete meetings.
                </div>

                {meetingStatus ? (
                  <div className="subtle" style={{ marginTop: 8 }}>
                    {meetingStatus}
                  </div>
                ) : null}

                <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                  {meetings.length === 0 ? (
                    <div className="subtle">(No meetings found.)</div>
                  ) : (
                    meetings.map((m) => {
                      const attendees = attendeesByMeeting.get(m.id) ?? [];
                      const docs = docsByMeeting.get(m.id) ?? [];

                      const ownerName = formatEmployeeName(m.owner);
                      const typeLabel = meetingTypes.find((t) => t.id === m.meeting_type_id)?.name ?? "—";

                      return (
                        <div key={m.id} style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
                          <div className="row-between" style={{ gap: 12, alignItems: "flex-start" }}>
                            <div style={{ minWidth: 260 }}>
                              <div style={{ fontWeight: 950, fontSize: 16 }}>{ownerName}&apos;s meeting</div>
                              <div className="subtle" style={{ marginTop: 4 }}>
                                Type: <b>{typeLabel}</b> • Meeting at:{" "}
                                <b>{m.meeting_at ? new Date(m.meeting_at).toLocaleString() : "—"}</b>
                              </div>
                              <div className="subtle" style={{ marginTop: 4, fontSize: 12 }}>
                                Created: {m.created_at ? new Date(m.created_at).toLocaleString() : "—"}
                                {m.updated_at ? ` · Updated: ${new Date(m.updated_at).toLocaleString()}` : ""}
                              </div>
                            </div>
                          </div>

                          <div style={{ height: 10 }} />

                          <div style={{ display: "grid", gap: 12 }}>
                            {/* Meeting type + time */}
                            <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "end" }}>
                              <div style={{ minWidth: 220 }}>
                                <FieldLabel>Meeting type</FieldLabel>
                                <Select
                                  value={m.meeting_type_id ?? ""}
                                  onChange={(e) => void updateMeeting(m.id, { meeting_type_id: e.target.value || null })}
                                >
                                  <option value="">(None)</option>
                                  {activeMeetingTypes.map((t) => (
                                    <option key={t.id} value={t.id}>
                                      {t.name}
                                    </option>
                                  ))}
                                </Select>
                              </div>

                              <div style={{ minWidth: 240 }}>
                                <FieldLabel>Meeting time</FieldLabel>
                                <TextInput
                                  type="datetime-local"
                                  value={safeIsoForDatetimeLocal(m.meeting_at)}
                                  onChange={(e) => void updateMeeting(m.id, { meeting_at: toIsoFromDatetimeLocal(e.target.value) })}
                                />
                              </div>
                            </div>

                            {/* Notes */}
                            <div>
                              <FieldLabel>Notes</FieldLabel>
                              <TextArea
                                value={m.notes ?? ""}
                                onChange={(e) => void updateMeeting(m.id, { notes: e.target.value })}
                                placeholder="Meeting notes…"
                              />
                            </div>

                            {/* Attendees */}
                            <div style={{ border: "1px solid #eef2f7", borderRadius: 14, padding: 12 }}>
                              <div style={{ fontWeight: 900 }}>Attendees</div>
                              <div className="subtle" style={{ marginTop: 4 }}>
                                Add/remove attendees. (Meeting owner does not have to be an attendee.)
                              </div>

                              <div style={{ marginTop: 10 }} className="row" >
                                <div style={{ minWidth: 280 }}>
                                  <FieldLabel>Add employee</FieldLabel>
                                  <Select
                                    value={selectedAttendeeEmployeeIdByMeeting[m.id] ?? ""}
                                    onChange={(e) =>
                                      setSelectedAttendeeEmployeeIdByMeeting((cur) => ({ ...cur, [m.id]: e.target.value || null }))
                                    }
                                  >
                                    <option value="">Select…</option>
                                    {allEmployees.map((e) => (
                                      <option key={e.id} value={e.id}>
                                        {formatEmployeeName(e)}{e.is_active ? "" : " (inactive)"}
                                      </option>
                                    ))}
                                  </Select>
                                </div>

                                <button
                                  type="button"
                                  className="btn btn-primary"
                                  onClick={() => void addAttendee(m.id)}
                                  disabled={!!addingAttendeeByMeeting[m.id]}
                                  style={{ marginTop: 22 }}
                                >
                                  {addingAttendeeByMeeting[m.id] ? "Adding…" : "Add attendee"}
                                </button>
                              </div>

                              <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                                {attendees.length === 0 ? (
                                  <div className="subtle">(No attendees.)</div>
                                ) : (
                                  attendees.map((a) => (
                                    <div key={a.id} className="row-between" style={{ gap: 12, border: "1px solid #e5e7eb", borderRadius: 12, padding: "8px 10px" }}>
                                      <div style={{ fontWeight: 900 }}>{a.attendee_name}</div>
                                      <button type="button" className="btn-ghost" onClick={() => void removeAttendee(a.id, m.id)}>
                                        Remove
                                      </button>
                                    </div>
                                  ))
                                )}
                              </div>
                            </div>

                            {/* Documents */}
                            <div style={{ border: "1px solid #eef2f7", borderRadius: 14, padding: 12 }}>
                              <div className="row-between" style={{ gap: 12, alignItems: "center" }}>
                                <div>
                                  <div style={{ fontWeight: 900 }}>Documents</div>
                                  <div className="subtle" style={{ marginTop: 4 }}>
                                    Upload files for this meeting. You can preview/download them.
                                  </div>
                                </div>

                                <label className="btn btn-primary" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                                  {uploadingMeetingId === m.id ? "Uploading…" : "Upload"}
                                  <input
                                    type="file"
                                    multiple
                                    style={{ display: "none" }}
                                    onChange={(e) => void handleUploadMeetingDocs(m.id, e.target.files)}
                                    disabled={uploadingMeetingId === m.id}
                                  />
                                </label>
                              </div>

                              <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                                {docs.length === 0 ? (
                                  <div className="subtle">(No documents.)</div>
                                ) : (
                                  docs.map((d) => (
                                    <div key={d.id} className="row-between" style={{ gap: 12, border: "1px solid #e5e7eb", borderRadius: 12, padding: "8px 10px" }}>
                                      <div style={{ minWidth: 0 }}>
                                        <div style={{ fontWeight: 900, wordBreak: "break-word" }}>{d.name}</div>
                                        <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>
                                          {d.created_at ? new Date(d.created_at).toLocaleString() : "—"}
                                          {d.size_bytes ? ` • ${Math.round(d.size_bytes / 1024)} KB` : ""}
                                        </div>
                                      </div>

                                      <div className="row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                                        <button type="button" className="btn" onClick={() => void openPreview(d)} style={{ padding: "6px 10px" }}>
                                          Preview
                                        </button>
                                        <button
                                          type="button"
                                          className="btn"
                                          onClick={async () => {
                                            const url = await getSignedMeetingDownloadUrl(d.id, "attachment");
                                            window.open(url, "_blank", "noopener,noreferrer");
                                          }}
                                          style={{ padding: "6px 10px" }}
                                        >
                                          Download
                                        </button>
                                        <button type="button" className="btn-ghost" onClick={() => void deleteMeetingDoc(d)}>
                                          Delete
                                        </button>
                                      </div>
                                    </div>
                                  ))
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Preview modal */}
                {previewOpen && previewDoc ? (
                  <div
                    style={{
                      position: "fixed",
                      inset: 0,
                      background: "rgba(0,0,0,0.45)",
                      display: "grid",
                      placeItems: "center",
                      padding: 14,
                      zIndex: 50,
                    }}
                    onMouseDown={(e) => {
                      if (e.target === e.currentTarget) closePreview();
                    }}
                  >
                    <div style={{ width: "min(1100px, 100%)", background: "white", borderRadius: 16, border: "1px solid #e5e7eb", overflow: "hidden" }}>
                      <div className="row-between" style={{ padding: 12, borderBottom: "1px solid #e5e7eb", gap: 10 }}>
                        <div style={{ fontWeight: 900, minWidth: 0, wordBreak: "break-word" }}>{previewDoc.name}</div>
                        <div className="row" style={{ gap: 10 }}>
                          <button
                            type="button"
                            className="btn"
                            onClick={async () => {
                              const url = await getSignedMeetingDownloadUrl(previewDoc.id, "attachment");
                              window.open(url, "_blank", "noopener,noreferrer");
                            }}
                          >
                            Download
                          </button>
                          <button type="button" className="btn" onClick={closePreview}>
                            Close
                          </button>
                        </div>
                      </div>

                      <div style={{ padding: 12 }}>
                        {previewLoading ? (
                          <div className="subtle">Loading preview…</div>
                        ) : previewMode === "pdf" ? (
                          <iframe src={previewSignedUrl} style={{ width: "100%", height: "70vh", border: "none" }} />
                        ) : previewMode === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={previewSignedUrl} alt={previewDoc.name} style={{ maxWidth: "100%", maxHeight: "70vh", objectFit: "contain" }} />
                        ) : previewMode === "office" ? (
                          <div style={{ height: "70vh", overflow: "auto" }}>
                            <OfficeEmbed url={previewSignedUrl} />
                          </div>
                        ) : previewMode === "text" ? (
                          <iframe src={previewSignedUrl} style={{ width: "100%", height: "70vh", border: "none" }} />
                        ) : previewMode === "video" ? (
                          <video src={previewSignedUrl} controls style={{ width: "100%", maxHeight: "70vh" }} />
                        ) : previewMode === "audio" ? (
                          <audio src={previewSignedUrl} controls style={{ width: "100%" }} />
                        ) : previewMode === "csv" ? (
                          previewCsvError ? (
                            <div className="subtle">{previewCsvError}</div>
                          ) : (
                            <div style={{ maxHeight: "70vh", overflow: "auto" }}>
                              <table className="table">
                                <tbody>
                                  {previewCsvRows.slice(0, 200).map((row, i) => (
                                    <tr key={i}>
                                      {row.slice(0, 30).map((cell, j) => (
                                        <td key={j} style={{ whiteSpace: "nowrap" }}>
                                          {cell}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )
                        ) : (
                          <div className="subtle">No preview available for this file type.</div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}
