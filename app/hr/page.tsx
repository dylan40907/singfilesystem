"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  mime_type: string | null;
  size_bytes: number | null;
  object_key: string;
  created_at: string;
};

type EmployeeLite = {
  id: string;
  profile_id?: string | null;
  legal_first_name: string;
  legal_middle_name: string | null;
  legal_last_name: string;
  nicknames: string[];
  is_active: boolean;
  attendance_points?: number | null;
  // Pulled from user_profiles for filtering (e.g., supervisors should only see employees)
  role?: string | null;
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
  const isAdmin = profile?.role === "admin";
  const canReviewOthers = isSupervisor || isAdmin;

  type HrTab = "attendance" | "reviews" | "meetings" | "employeeReviews";
  const [activeTab, setActiveTab] = useState<HrTab>("attendance");



  // Attendance
  const [attendanceRows, setAttendanceRows] = useState<EmployeeAttendanceRow[]>([]);
  const [attendanceLoading, setAttendanceLoading] = useState(false);

  // Reviews: keep as simple placeholder (existing system can be swapped in later)
  // If you already have a dedicated reviews tab component, you can drop it in here.
  const [reviewsNote] = useState("Performance reviews are available in this portal.");

  // Meetings (supervisor-only): meetings where current employee is an attendee
  const [meetingTypes, setMeetingTypes] = useState<HrMeetingType[]>([]);
  const activeMeetingTypes = meetingTypes; // keep parity with admin page

  const [allEmployees, setAllEmployees] = useState<EmployeeLite[]>([]);

  // Supervisor "Employee Reviews" picker state (separate from the meeting attendee picker)
  const [reviewEmployeeId, setReviewEmployeeId] = useState<string>("");
  const [reviewEmployeeDropdownOpen, setReviewEmployeeDropdownOpen] = useState<boolean>(false);
  const [reviewEmployeeSearch, setReviewEmployeeSearch] = useState<string>("");

  const reviewEmployee = useMemo(() => {
    if (!reviewEmployeeId) return null;
    return allEmployees.find((e) => e.id === reviewEmployeeId) ?? null;
  }, [allEmployees, reviewEmployeeId]);

  const reviewEmployeeFiltered = useMemo(() => {
		// Supervisors should only be able to review employee-level accounts (not other supervisors/admins).
		// Admins can still see everyone.
		let base = allEmployees;
		if (isSupervisor && !isAdmin) {
			base = base.filter((e) => {
				const r = (e.role ?? "").toLowerCase();
				// keep rows where role is unknown, but hide obvious admin/supervisor accounts
				return r !== "admin" && r !== "supervisor";
			});
		}

		const q = reviewEmployeeSearch.trim().toLowerCase();
		if (!q) return base;
		return base.filter((e) => {
      const name = formatEmployeeName(e).toLowerCase();
      const nick = (e.nicknames || []).join(" ").toLowerCase();
      return name.includes(q) || nick.includes(q);
    });
	}, [allEmployees, reviewEmployeeSearch, isSupervisor, isAdmin]);

  const [meetings, setMeetings] = useState<(HrMeeting & { owner: MeetingOwnerLite | null })[]>([]);
  const [attendeesByMeeting, setAttendeesByMeeting] = useState<Map<string, HrMeetingAttendee[]>>(new Map());
    const [attendeeSearchByMeeting, setAttendeeSearchByMeeting] = useState<Record<string, string>>({});
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
			.select(
				"id,profile_id,legal_first_name,legal_middle_name,legal_last_name,nicknames,is_active,attendance_points"
			)
			.order("legal_last_name", { ascending: true })
			.order("legal_first_name", { ascending: true });
		if (res.error) throw res.error;

		const base = (res.data ?? []) as any as EmployeeLite[];
		const profileIds = Array.from(
			new Set(base.map((e) => (e as any)?.profile_id).filter((x) => typeof x === "string" && x.length > 0))
		) as string[];

		// Fetch roles so supervisors can't accidentally review other supervisors/admins.
		let roleByProfileId = new Map<string, string | null>();
		if (profileIds.length > 0) {
			const profRes = await supabase
				.from("user_profiles")
				.select("id,role")
				.in("id", profileIds);
			if (profRes.error) throw profRes.error;
			for (const p of profRes.data ?? []) {
				roleByProfileId.set(String((p as any).id), (p as any).role ?? null);
			}
		}

		const merged = base.map((e) => ({
			...e,
			role: (e as any)?.profile_id ? roleByProfileId.get(String((e as any).profile_id)) ?? null : null,
		}));
		setAllEmployees(merged as any as EmployeeLite[]);
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
          const owner = asSingle<any>(m.owner) as MeetingOwnerLite | null;
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
            mime_type: file.type || "application/octet-stream",
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
			{canReviewOthers ? (
              <TabButton active={activeTab === "employeeReviews"} onClick={() => setActiveTab("employeeReviews")}>
                Employee Reviews
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
              employee?.id ? (
                <EmployeePerformanceReviewsTab
                  employeeId={employee.id}
                  attendancePoints={(employee as any)?.attendance_points ?? null}
                  includeDrafts={false}
                  readOnly={true}
                />
              ) : (
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
                  <div style={{ fontWeight: 950, fontSize: 18 }}>Performance Reviews</div>
                  <div className="subtle" style={{ marginTop: 6 }}>
                    No employee record is linked to your account.
                  </div>
                </div>
              )
            ) : null}

			{activeTab === "employeeReviews" && canReviewOthers ? (
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
                <div style={{ fontWeight: 950, fontSize: 18 }}>Employee Reviews</div>
                <div className="subtle" style={{ marginTop: 6 }}>
                  Select an employee to view and edit their monthly scorecards and annual evaluations.
                </div>

                <div style={{ marginTop: 14, maxWidth: 520 }}>
                  <div style={{ fontWeight: 850, marginBottom: 6 }}>Employee</div>

                  <div style={{ position: "relative" }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setReviewEmployeeDropdownOpen((v: boolean) => !v)}
                      style={{ width: "100%", justifyContent: "space-between" }}
                    >
                      <span>{reviewEmployee ? formatEmployeeName(reviewEmployee) : "Select…"}</span>
                      <span className="subtle">▾</span>
                    </button>

                    {reviewEmployeeDropdownOpen ? (
                      <div
                        style={{
                          position: "absolute",
                          zIndex: 60,
                          top: "calc(100% + 6px)",
                          left: 0,
                          right: 0,
                          background: "white",
                          border: "1px solid #e5e7eb",
                          borderRadius: 12,
                          boxShadow: "0 12px 32px rgba(0,0,0,0.10)",
                          overflow: "hidden",
                        }}
                      >
                        <div style={{ padding: 10, borderBottom: "1px solid #f1f5f9" }}>
                          <input
                            value={reviewEmployeeSearch}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReviewEmployeeSearch(e.target.value)}
                            placeholder="Search employees…"
                            style={{ width: "100%", padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 10 }}
                          />
                        </div>

                        <div style={{ maxHeight: 260, overflow: "auto" }}>
                          {reviewEmployeeFiltered.length === 0 ? (
                            <div className="subtle" style={{ padding: 12 }}>
                              No results
                            </div>
                          ) : (
                            reviewEmployeeFiltered.map((e: EmployeeLite) => {
                              const isSelected = e.id === reviewEmployeeId;
                              return (
                                <button
                                  key={e.id}
                                  type="button"
                                  onClick={() => {
                                    setReviewEmployeeId(e.id);
                                    setReviewEmployeeDropdownOpen(false);
                                    setReviewEmployeeSearch("");
                                  }}
                                  style={{
                                    width: "100%",
                                    textAlign: "left",
                                    padding: "10px 12px",
                                    background: isSelected ? "#fdf2f8" : "white",
                                    border: "none",
                                    borderBottom: "1px solid #f1f5f9",
                                    cursor: "pointer",
                                  }}
                                >
                                  <div style={{ fontWeight: 850 }}>{formatEmployeeName(e)}</div>
                                  {e.nicknames?.length ? (
                                    <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>
                                      {e.nicknames.join(", ")}
                                    </div>
                                  ) : null}
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div style={{ marginTop: 16 }}>
                  {reviewEmployeeId ? (
                    <EmployeePerformanceReviewsTab
                      employeeId={reviewEmployeeId}
                      attendancePoints={reviewEmployee?.attendance_points ?? null}
                      includeDrafts
                      readOnly={false}
                    />
                  ) : (
                    <div className="subtle" style={{ marginTop: 8 }}>
                      Choose an employee above to load their reviews.
                    </div>
                  )}
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

                              <div className="row" style={{ marginTop: 10, gap: 10, flexWrap: "wrap", alignItems: "end" }}>
                                <div style={{ minWidth: 280, flex: 1 }}>
                                  <FieldLabel>Add employee</FieldLabel>
                                  <div style={{ position: "relative" }}>
                                    <button
                                      type="button"
                                      className="btn-ghost"
                                      onClick={() =>
                                        setAttendeeDropdownOpenByMeeting((cur) => ({
                                          ...cur,
                                          [m.id]: !(cur[m.id] ?? false),
                                        }))
                                      }
                                      style={{
                                        width: "100%",
                                        justifyContent: "space-between",
                                        border: "1px solid #e5e7eb",
                                        borderRadius: 12,
                                        padding: "10px 12px",
                                        background: "white",
                                        textAlign: "left",
                                      }}
                                    >
                                      <span style={{ opacity: selectedAttendeeEmployeeIdByMeeting[m.id] ? 1 : 0.6 }}>
                                        {(() => {
                                          const selectedId = selectedAttendeeEmployeeIdByMeeting[m.id];
                                          const selected = selectedId ? allEmployees.find((e) => e.id === selectedId) : null;
                                          return selected ? formatEmployeeName(selected) : "Select…";
                                        })()}
                                      </span>
                                      <span style={{ opacity: 0.6 }}>▾</span>
                                    </button>

                                    {attendeeDropdownOpenByMeeting[m.id] ? (
                                      <div
                                        style={{
                                          position: "absolute",
                                          zIndex: 40,
                                          top: "calc(100% + 6px)",
                                          left: 0,
                                          right: 0,
                                          border: "1px solid #e5e7eb",
                                          borderRadius: 12,
                                          background: "white",
                                          boxShadow: "0 10px 25px rgba(0,0,0,0.08)",
                                          overflow: "hidden",
                                        }}
                                      >
                                        <div style={{ padding: 10, borderBottom: "1px solid #f1f5f9" }}>
                                          <TextInput
                                            value={attendeeSearchByMeeting[m.id] ?? ""}
                                            onChange={(e) =>
                                              setAttendeeSearchByMeeting((cur: Record<string, string>) => ({
                                                ...cur,
                                                [m.id]: e.target.value,
                                              }))
                                            }
                                            placeholder="Search employee…"
                                            autoFocus
                                          />
                                        </div>

                                        <div style={{ maxHeight: 260, overflowY: "auto" }}>
                                          {(() => {
                                            const q = (attendeeSearchByMeeting[m.id] ?? "").trim().toLowerCase();
                                            const existing = new Set(
                                              (attendeesByMeeting.get(m.id) ?? [])
                                                .map((a) => a.attendee_employee_id)
                                                .filter((x): x is string => typeof x === "string" && x.length > 0)
                                            );
                                            const options = allEmployees
                                              .filter((e) => !existing.has(e.id))
                                              .filter((e) => {
                                                if (!q) return true;
                                                const name = formatEmployeeName(e).toLowerCase();
                                                return name.includes(q);
})
                                              .slice(0, 60);

                                            if (options.length === 0) {
                                              return <div className="subtle" style={{ padding: 10 }}>(No matches.)</div>;
                                            }

                                            return options.map((e) => (
                                              <button
                                                key={e.id}
                                                type="button"
                                                onClick={() => {
                                                  setSelectedAttendeeEmployeeIdByMeeting((cur) => ({ ...cur, [m.id]: e.id }));
                                                  setAttendeeDropdownOpenByMeeting((cur) => ({ ...cur, [m.id]: false }));
                                                  setAttendeeSearchByMeeting((cur: Record<string, string>) => ({ ...cur, [m.id]: "" }));
                                                }}
                                                className="btn-ghost"
                                                style={{
                                                  display: "flex",
                                                  width: "100%",
                                                  justifyContent: "space-between",
                                                  padding: "10px 12px",
                                                  borderRadius: 0,
                                                }}
                                              >
                                                <span style={{ fontWeight: 800 }}>{formatEmployeeName(e)}</span>
</button>
                                            ));
                                          })()}
                                        </div>
                                      </div>
                                    ) : null}
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  className="btn btn-primary"
                                  onClick={() => void addAttendee(m.id)}
                                  disabled={!!addingAttendeeByMeeting[m.id]}
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


// --- Performance Reviews UI (synced from employee [id] page) ---
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
  kind?: ReviewQuestionKind; // 'question' (scored) or 'section' (header)
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


function reviewMostRecentAt(r: HrReview) {
  const t = r.updated_at || r.created_at;
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

function EmployeePerformanceReviewsTab({
  employeeId,
  attendancePoints,
  includeDrafts = false,
  readOnly = false,
  mode = "manage",
}: {
  employeeId: string;
  /** Snapshot source for new annual reviews. We do NOT overwrite existing snapshots. */
  attendancePoints: number | null;
  includeDrafts?: boolean;
  readOnly?: boolean;
  mode?: "manage" | "self";
}) {
  const isSelf = mode === "self";
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
    const q = supabase
      .from("hr_reviews")
      .select("id, employee_id, form_id, form_type, period_year, period_month, notes, published, attendance_points_snapshot, created_at, updated_at")
      .eq("employee_id", employeeId);

    const res = await (includeDrafts ? q : q.eq("published", true));

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

  async function loadReviewForSelection(empId: string, ft: ReviewFormType, y: number, m: number) {
    const formId = selectedFormId || getDefaultActiveFormId(ft);
    const qs = getQuestionsForForm(formId);
    const max = formById.get(formId)?.scale_max ?? (ft === "monthly" ? 3 : 5);

    if (!qs || qs.length === 0) {
      setReviewId("");
      setValues({});
      setReviewNotes("");
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
      return;
    }

    const ansRes = await supabase
      .from("hr_review_answers")
      .select("review_id, question_id, score, created_at, updated_at")
      .eq("review_id", existing.id);

    if (ansRes.error) throw ansRes.error;

    const byQ = new Map<string, number | null>();
    for (const a of (ansRes.data ?? []) as HrReviewAnswer[]) byQ.set(a.question_id, a.score ?? null);

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
      const rows: { review_id: string; question_id: string; score: number | null }[] = activeQuestions
        .filter((q) => (q.kind || "question") !== "section")
        .map((q) => ({
          review_id: rid,
          question_id: q.id,
          score: clampScore(values[q.id], max),
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
          {!readOnly ? (
            <>
              <button className="btn btn-primary" type="button" onClick={() => openCreate("annual")}>
                + Create Annual Evaluation
              </button>
              <button className="btn btn-primary" type="button" onClick={() => openCreate("monthly")}>
                + Create Monthly Scorecard
              </button>
            </>
          ) : null}

          {!readOnly ? (
            <button className="btn" type="button" onClick={() => openManageForms()}>
              Manage Forms
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
                  {canEdit ? (
                    <>
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
                    </>
                  ) : (
                    <button className="btn" type="button" onClick={() => openEdit(r)} style={{ padding: "6px 10px" }}>
                      View
                    </button>
                  )}
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
                    </div>
                  );
                })}
                <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>Notes</div>
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
                  <div className="subtle">
                    Average (auto): <b>{computedAvg === null ? "—" : computedAvg.toFixed(1)}</b>{" "}
                    <span className="subtle">(normal rounding)</span>
                  </div>

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
