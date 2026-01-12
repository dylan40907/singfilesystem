"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";

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

type HrEmployee = {
  id: string;
  // hr_employees table fields (based on your sample row)
  legal_first_name?: string | null;
  legal_middle_name?: string | null;
  legal_last_name?: string | null;
  nicknames?: string[] | null;

  is_active?: boolean | null;
};

type MeetingType = {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
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

type PreviewMode = "pdf" | "image" | "text" | "csv" | "office" | "video" | "audio" | "unknown";

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
 * Same PDF canvas preview approach you used in app/page.tsx.
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
          stage.style.boxShadow = "inset 0 0 0 1px var(--border)";
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

function employeeLabel(e: HrEmployee) {
  const nick = (Array.isArray(e.nicknames) && e.nicknames.length > 0 ? String(e.nicknames[0] ?? "") : "").trim();

  const fn = (e.legal_first_name ?? "").trim();
  const mn = (e.legal_middle_name ?? "").trim();
  const ln = (e.legal_last_name ?? "").trim();

  const legal = [fn, mn, ln].filter(Boolean).join(" ").trim();

  // Prefer nickname, but show legal in parentheses when both exist
  if (nick && legal) return `${nick} (${legal})`;
  return nick || legal || e.id;
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

export default function HrMeetingsPage() {
  const [status, setStatus] = useState("");
  const [profile, setProfile] = useState<TeacherProfile | null>(null);

  const isAdmin = !!profile?.is_active && profile.role === "admin";

  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [meetingTypes, setMeetingTypes] = useState<MeetingType[]>([]);

  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>("");

  const [meetings, setMeetings] = useState<HrMeeting[]>([]);
  const [attendeesByMeeting, setAttendeesByMeeting] = useState<Map<string, HrMeetingAttendee[]>>(new Map());
  const [docsByMeeting, setDocsByMeeting] = useState<Map<string, HrMeetingDocument[]>>(new Map());

  // Attendee add UI state per meeting
  const [attendeeTextByMeeting, setAttendeeTextByMeeting] = useState<Record<string, string>>({});
  const [attendeeEmployeePickByMeeting, setAttendeeEmployeePickByMeeting] = useState<Record<string, string>>({});
  const [addingAttendeeByMeeting, setAddingAttendeeByMeeting] = useState<Record<string, boolean>>({});

  // Upload UI state
  const [uploadingMeetingId, setUploadingMeetingId] = useState<string>("");

  // Manage meeting types (add/edit/delete)
  const [showManageMeetingTypes, setShowManageMeetingTypes] = useState(false);
  const [meetingTypesError, setMeetingTypesError] = useState<string | null>(null);
  const [newMeetingTypeName, setNewMeetingTypeName] = useState("");
  const [meetingTypeEdits, setMeetingTypeEdits] = useState<Record<string, { name: string; sort_order: string; is_active: boolean }>>({});
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

  const activeMeetingTypes = useMemo(() => {
    return (meetingTypes ?? []).filter((t) => !!t.is_active);
  }, [meetingTypes]);

  async function reloadMeetingTypes() {
    const res = await supabase
      .from("hr_meeting_types")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (res.error) throw res.error;
    setMeetingTypes((res.data ?? []) as MeetingType[]);
  }

  async function loadBoot() {
    setStatus("Loading...");
    try {
      const p = await fetchMyProfile();
      setProfile(p);

      if (!p?.is_active || p.role !== "admin") {
        setStatus("Admin access required.");
        return;
      }

      const [empRes, typeRes] = await Promise.all([
        supabase.from("hr_employees").select("*").order("legal_last_name", { ascending: true }).order("legal_first_name", { ascending: true }).order("legal_middle_name", { ascending: true }),
        // Load ALL meeting types so you can manage them (not just active)
        supabase.from("hr_meeting_types").select("*").order("sort_order", { ascending: true }).order("name", { ascending: true }),
      ]);

      if (empRes.error) throw empRes.error;
      if (typeRes.error) throw typeRes.error;

      setEmployees((empRes.data ?? []) as HrEmployee[]);
      setMeetingTypes((typeRes.data ?? []) as MeetingType[]);

      setStatus("");
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    }
  }

  async function loadEmployeeMeetings(employeeId: string) {
    if (!employeeId) {
      setMeetings([]);
      setAttendeesByMeeting(new Map());
      setDocsByMeeting(new Map());
      return;
    }

    setStatus("Loading meetings...");
    try {
      const { data, error } = await supabase
        .from("hr_meetings")
        .select("*, type:hr_meeting_types(id,name)")
        .eq("employee_id", employeeId)
        .order("meeting_at", { ascending: false });

      if (error) throw error;

      const list = (data ?? []) as HrMeeting[];
      setMeetings(list);

      const ids = list.map((m) => m.id);
      if (ids.length === 0) {
        setAttendeesByMeeting(new Map());
        setDocsByMeeting(new Map());
        setStatus("");
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

      setStatus("");
    } catch (e: any) {
      setStatus("Error loading meetings: " + (e?.message ?? "unknown"));
    }
  }

  async function addMeeting() {
    if (!selectedEmployeeId) return;

    const defaultTypeId = activeMeetingTypes[0]?.id ?? null;

    setStatus("Creating meeting...");
    try {
      const { data, error } = await supabase
        .from("hr_meetings")
        .insert({
          employee_id: selectedEmployeeId,
          meeting_type_id: defaultTypeId,
          meeting_at: new Date().toISOString(),
          notes: "",
        })
        .select("*")
        .single();

      if (error) throw error;

      setStatus("✅ Meeting created.");
      await loadEmployeeMeetings(selectedEmployeeId);

      // focus UI state for attendee inputs
      if (data?.id) {
        setAttendeeTextByMeeting((cur) => ({ ...cur, [data.id]: "" }));
        setAttendeeEmployeePickByMeeting((cur) => ({ ...cur, [data.id]: "" }));
      }
    } catch (e: any) {
      setStatus("Create error: " + (e?.message ?? "unknown"));
    }
  }

  async function deleteMeeting(meetingId: string) {
    if (!meetingId) return;
    if (!confirm("Delete this meeting and all its attendees/documents?")) return;

    setStatus("Deleting meeting...");
    try {
      const { error } = await supabase.from("hr_meetings").delete().eq("id", meetingId);
      if (error) throw error;
      setStatus("✅ Deleted.");
      await loadEmployeeMeetings(selectedEmployeeId);
    } catch (e: any) {
      setStatus("Delete error: " + (e?.message ?? "unknown"));
    }
  }

  async function updateMeeting(meetingId: string, patch: Partial<Pick<HrMeeting, "meeting_type_id" | "meeting_at" | "notes">>) {
    setStatus("Saving...");
    try {
      const { error } = await supabase.from("hr_meetings").update(patch).eq("id", meetingId);
      if (error) throw error;

      // local optimistic update
      setMeetings((cur) => cur.map((m) => (m.id === meetingId ? ({ ...m, ...patch } as HrMeeting) : m)));

      setStatus("✅ Saved.");
      setTimeout(() => setStatus(""), 900);
    } catch (e: any) {
      setStatus("Save error: " + (e?.message ?? "unknown"));
    }
  }

  async function addAttendee(meetingId: string) {
    if (!meetingId) return;

    // Prevent double-submit (double click, rapid taps, etc.)
    if (addingAttendeeByMeeting[meetingId]) return;
    setAddingAttendeeByMeeting((cur) => ({ ...cur, [meetingId]: true }));

    const free = (attendeeTextByMeeting[meetingId] ?? "").trim();
    const pickedEmployeeId = (attendeeEmployeePickByMeeting[meetingId] ?? "").trim();

    let attendeeName = free;

    if (!attendeeName && pickedEmployeeId) {
      const emp = employees.find((x) => x.id === pickedEmployeeId);
      attendeeName = emp ? employeeLabel(emp) : "";
    }

    if (!attendeeName) {
      setStatus("Enter a name or pick an employee.");
      setAddingAttendeeByMeeting((cur) => ({ ...cur, [meetingId]: false }));
      return;
    }

    setStatus("Adding attendee...");
    try {
      const { data, error } = await supabase
        .from("hr_meeting_attendees")
        .insert({ meeting_id: meetingId, attendee_name: attendeeName })
        .select("*")
        .single();

      if (error) throw error;

      // IMPORTANT: dedupe by id before pushing (avoids "same key" crash)
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
      setAttendeeEmployeePickByMeeting((cur) => ({ ...cur, [meetingId]: "" }));

      setStatus("✅ Attendee added.");
      setTimeout(() => setStatus(""), 900);
    } catch (e: any) {
      setStatus("Add attendee error: " + (e?.message ?? "unknown"));
    } finally {
      setAddingAttendeeByMeeting((cur) => ({ ...cur, [meetingId]: false }));
    }
  }

  async function removeAttendee(attendeeId: string, meetingId: string) {
    setStatus("Removing attendee...");
    try {
      const { error } = await supabase.from("hr_meeting_attendees").delete().eq("id", attendeeId);
      if (error) throw error;

      setAttendeesByMeeting((cur) => {
        const next = new Map(cur);
        const arr = (next.get(meetingId) ?? []).filter((a) => a.id !== attendeeId);
        next.set(meetingId, arr);
        return next;
      });

      setStatus("✅ Removed.");
      setTimeout(() => setStatus(""), 900);
    } catch (e: any) {
      setStatus("Remove attendee error: " + (e?.message ?? "unknown"));
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
        setStatus(`Uploading ${i + 1}/${filesArr.length}: ${file.name}`);

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

      setStatus("✅ Upload complete.");
      setTimeout(() => setStatus(""), 900);
    } catch (e: any) {
      setStatus("Upload error: " + (e?.message ?? "unknown"));
    } finally {
      setUploadingMeetingId("");
    }
  }

  async function deleteMeetingDoc(documentId: string, meetingId: string) {
    if (!confirm("Delete this document?")) return;

    setStatus("Deleting document...");
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

      setStatus("✅ Deleted.");
      setTimeout(() => setStatus(""), 900);
    } catch (e: any) {
      setStatus("Delete document error: " + (e?.message ?? "unknown"));
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
      setStatus("Preview error: " + (e?.message ?? "unknown"));
      setPreviewMode("unknown");
      setPreviewLoading(false);
    }
  }

  // Meeting type management helpers
  function openManageMeetingTypes() {
    setMeetingTypesError(null);

    const edits: Record<string, { name: string; sort_order: string; is_active: boolean }> = {};
    for (const t of meetingTypes) {
      edits[t.id] = {
        name: t.name ?? "",
        sort_order: String(t.sort_order ?? 0),
        is_active: !!t.is_active,
      };
    }
    setMeetingTypeEdits(edits);
    setShowManageMeetingTypes(true);
  }

  async function addMeetingType() {
    setMeetingTypesError(null);
    const name = newMeetingTypeName.trim();
    if (!name) return;

    try {
      const maxSort = Math.max(0, ...(meetingTypes ?? []).map((t) => Number(t.sort_order ?? 0) || 0));
      const nextSort = maxSort + 10;

      const { error } = await supabase.from("hr_meeting_types").insert({
        name,
        sort_order: nextSort,
        is_active: true,
      });

      if (error) throw error;

      setNewMeetingTypeName("");
      await reloadMeetingTypes();
    } catch (e: any) {
      setMeetingTypesError(e?.message ?? "Failed to add meeting type.");
    }
  }

  async function saveMeetingType(id: string) {
    setMeetingTypesError(null);
    const draft = meetingTypeEdits[id];
    if (!draft) return;

    const name = (draft.name ?? "").trim();
    const sortOrderNum = Number(draft.sort_order);
    const sort_order = Number.isFinite(sortOrderNum) ? sortOrderNum : 0;

    if (!name) {
      setMeetingTypesError("Meeting type name is required.");
      return;
    }

    setSavingMeetingTypeIds((cur) => ({ ...cur, [id]: true }));
    try {
      const { error } = await supabase
        .from("hr_meeting_types")
        .update({ name, sort_order, is_active: !!draft.is_active })
        .eq("id", id);

      if (error) throw error;

      await reloadMeetingTypes();
    } catch (e: any) {
      setMeetingTypesError(e?.message ?? "Failed to save meeting type.");
    } finally {
      setSavingMeetingTypeIds((cur) => ({ ...cur, [id]: false }));
    }
  }

  async function deleteMeetingType(id: string) {
    const ok = confirm("Delete this meeting type? (If meetings still reference it, deletion may fail.)");
    if (!ok) return;

    setMeetingTypesError(null);
    try {
      const { error } = await supabase.from("hr_meeting_types").delete().eq("id", id);
      if (error) throw error;

      await reloadMeetingTypes();

      // If any currently loaded meeting references this, force it to null locally to avoid weird UI
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

  useEffect(() => {
    void loadBoot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadEmployeeMeetings(selectedEmployeeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmployeeId]);

  const selectedEmployee = useMemo(() => {
    return employees.find((e) => e.id === selectedEmployeeId) ?? null;
  }, [employees, selectedEmployeeId]);

  return (
    <main className="stack">
      <div className="container">
        <div className="row-between" style={{ marginTop: 16 }}>
          <div className="stack" style={{ gap: 6 }}>
            <h1 className="h1">Meetings</h1>
            <div className="subtle">Track meetings per employee (attendees are stored as name text only).</div>
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
              <div style={{ fontWeight: 900, marginBottom: 8 }}>Select employee</div>
              <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                <select
                  className="select"
                  value={selectedEmployeeId}
                  onChange={(e) => setSelectedEmployeeId(e.target.value)}
                  style={{ width: "min(520px, 100%)" }}
                >
                  <option value="">— Choose an employee —</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {employeeLabel(e)}
                    </option>
                  ))}
                </select>

                <button type="button" className="btn btn-primary" onClick={addMeeting} disabled={!selectedEmployeeId}>
                  Add meeting
                </button>
              </div>

              {selectedEmployee ? (
                <div className="subtle" style={{ marginTop: 10 }}>
                  Showing meetings for: <b>{employeeLabel(selectedEmployee)}</b>
                </div>
              ) : (
                <div className="subtle" style={{ marginTop: 10 }}>(Pick an employee to view/add meetings.)</div>
              )}
            </div>

            {selectedEmployeeId ? (
              <div className="stack" style={{ gap: 12, marginTop: 14 }}>
                {meetings.length === 0 ? (
                  <div className="card">
                    <div className="subtle">(No meetings yet for this employee.)</div>
                  </div>
                ) : (
                  meetings.map((m) => {
                    const attendees = attendeesByMeeting.get(m.id) ?? [];
                    const docs = docsByMeeting.get(m.id) ?? [];

                    const currentType = meetingTypes.find((t) => t.id === m.meeting_type_id) ?? null;
                    const currentTypeInactive = !!currentType && !currentType.is_active;

                    return (
                      <div key={m.id} className="card" style={{ padding: 16 }}>
                        <div className="row-between" style={{ gap: 12, alignItems: "flex-start" }}>
                          <div className="stack" style={{ gap: 6, minWidth: 260 }}>
                            <div style={{ fontWeight: 950, fontSize: 16 }}>Meeting</div>
                            <div className="subtle">
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

                        <div className="hr" />

                        <div className="grid-2" style={{ gap: 12 }}>
                          <div className="stack" style={{ gap: 10 }}>
                            <div>
                              <div style={{ fontWeight: 900, marginBottom: 6 }}>Type</div>

                              {/* Manage meeting types (like job levels) */}
                              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "end" }}>
                                <select
                                  className="select"
                                  value={m.meeting_type_id ?? ""}
                                  onChange={(e) => updateMeeting(m.id, { meeting_type_id: e.target.value || null })}
                                  style={{ width: "100%" }}
                                >
                                  <option value="">(No type)</option>

                                  {/* If the currently selected type is inactive, still show it so the select isn't blank */}
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
                                </select>

                                <button type="button" className="btn" title="Manage meeting types" onClick={openManageMeetingTypes}>
                                  +
                                </button>
                              </div>
                            </div>

                            <div>
                              <div style={{ fontWeight: 900, marginBottom: 6 }}>Meeting time</div>
                              <input
                                className="input"
                                type="datetime-local"
                                value={(() => {
                                  // datetime-local expects local time without Z
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
                                  // v is local; convert to ISO
                                  const dt = new Date(v);
                                  updateMeeting(m.id, { meeting_at: dt.toISOString() });
                                }}
                              />
                            </div>

                            <div>
                              <div style={{ fontWeight: 900, marginBottom: 6 }}>Notes</div>
                              <textarea
                                className="input"
                                value={m.notes ?? ""}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setMeetings((cur) => cur.map((x) => (x.id === m.id ? { ...x, notes: v } : x)));
                                }}
                                onBlur={() => updateMeeting(m.id, { notes: (meetings.find((x) => x.id === m.id)?.notes ?? "") as any })}
                                rows={6}
                                style={{ resize: "vertical" }}
                                placeholder="Meeting notes..."
                              />
                              <div className="subtle" style={{ marginTop: 6 }}>
                                Notes save when you click out of the box.
                              </div>
                            </div>
                          </div>

                          <div className="stack" style={{ gap: 12 }}>
                            <div className="card" style={{ borderRadius: 12 }}>
                              <div style={{ fontWeight: 900 }}>Attendees</div>
                              <div className="hr" />

                              {attendees.length === 0 ? (
                                <div className="subtle">(No attendees yet)</div>
                              ) : (
                                <div className="stack" style={{ gap: 8 }}>
                                  {attendees.map((a) => (
                                    <div
                                      key={a.id}
                                      className="row-between"
                                      style={{
                                        padding: "8px 10px",
                                        borderRadius: 12,
                                        border: "1px solid var(--border)",
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

                              <div className="hr" />

                              <div className="stack" style={{ gap: 8 }}>
                                <input
                                  className="input"
                                  placeholder="Add attendee name (free text)"
                                  value={attendeeTextByMeeting[m.id] ?? ""}
                                  onChange={(e) => setAttendeeTextByMeeting((cur) => ({ ...cur, [m.id]: e.target.value }))}
                                />

                                <select
                                  className="select"
                                  value={attendeeEmployeePickByMeeting[m.id] ?? ""}
                                  onChange={(e) => setAttendeeEmployeePickByMeeting((cur) => ({ ...cur, [m.id]: e.target.value }))}
                                >
                                  <option value="">Or pick an employee…</option>
                                  {employees.map((e) => (
                                    <option key={e.id} value={e.id}>
                                      {employeeLabel(e)}
                                    </option>
                                  ))}
                                </select>

                                <button
                                  type="button"
                                  className="btn btn-primary"
                                  onClick={() => addAttendee(m.id)}
                                  disabled={!!addingAttendeeByMeeting[m.id]}
                                >
                                  {addingAttendeeByMeeting[m.id] ? "Adding…" : "Add attendee"}
                                </button>

                                <div className="subtle">
                                  If you pick an employee, we still only store their name text for this meeting (no linkage).
                                </div>
                              </div>
                            </div>

                            <div className="card" style={{ borderRadius: 12 }}>
                              <div className="row-between" style={{ gap: 10 }}>
                                <div style={{ fontWeight: 900 }}>Documents</div>
                                <div className="subtle">
                                  Stored in R2 under <code>meetings/</code> (not visible in file system)
                                </div>
                              </div>
                              <div className="hr" />

                              <input
                                className="input"
                                type="file"
                                multiple
                                disabled={uploadingMeetingId === m.id}
                                onChange={(e) => {
                                  void handleUploadMeetingDocs(m.id, e.target.files);
                                  e.currentTarget.value = "";
                                }}
                              />

                              {docs.length === 0 ? (
                                <div className="subtle" style={{ marginTop: 10 }}>
                                  (No documents)
                                </div>
                              ) : (
                                <div className="stack" style={{ gap: 8, marginTop: 10 }}>
                                  {docs.map((d) => (
                                    <div
                                      key={d.id}
                                      className="row-between"
                                      style={{
                                        padding: "8px 10px",
                                        borderRadius: 12,
                                        border: "1px solid var(--border)",
                                        background: "white",
                                      }}
                                    >
                                      <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                                        <div style={{ fontWeight: 750, overflow: "hidden", textOverflow: "ellipsis" }}>
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
                                              setStatus("Download error: " + (e?.message ?? "unknown"));
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
            ) : null}

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
                  <div className="row-between" style={{ padding: 12, borderBottom: "1px solid var(--border)" }}>
                    <div className="stack" style={{ gap: 2 }}>
                      <div style={{ fontWeight: 950, fontSize: 16 }}>Manage meeting types</div>
                      <div className="subtle">Add, edit, disable, or delete types (Esc to close).</div>
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

                    <div className="card" style={{ padding: 12, borderRadius: 12 }}>
                      <div style={{ fontWeight: 900, marginBottom: 8 }}>Add new type</div>
                      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                        <input
                          className="input"
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

                    <div className="hr" />

                    {meetingTypes.length === 0 ? (
                      <div className="subtle">(No meeting types.)</div>
                    ) : (
                      <div className="stack" style={{ gap: 10 }}>
                        {meetingTypes.map((t) => {
                          const d = meetingTypeEdits[t.id] ?? { name: t.name ?? "", sort_order: String(t.sort_order ?? 0), is_active: !!t.is_active };
                          const saving = !!savingMeetingTypeIds[t.id];

                          return (
                            <div key={t.id} className="card" style={{ padding: 12, borderRadius: 12 }}>
                              <div
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "1fr 140px 120px auto auto",
                                  gap: 10,
                                  alignItems: "end",
                                }}
                              >
                                <div>
                                  <div className="subtle" style={{ fontWeight: 800, marginBottom: 6 }}>
                                    Name
                                  </div>
                                  <input
                                    className="input"
                                    value={d.name}
                                    onChange={(e) =>
                                      setMeetingTypeEdits((cur) => ({
                                        ...cur,
                                        [t.id]: { ...d, name: e.target.value },
                                      }))
                                    }
                                  />
                                </div>

                                <div>
                                  <div className="subtle" style={{ fontWeight: 800, marginBottom: 6 }}>
                                    Sort order
                                  </div>
                                  <input
                                    className="input"
                                    inputMode="numeric"
                                    value={d.sort_order}
                                    onChange={(e) =>
                                      setMeetingTypeEdits((cur) => ({
                                        ...cur,
                                        [t.id]: { ...d, sort_order: e.target.value },
                                      }))
                                    }
                                  />
                                </div>

                                <div>
                                  <div className="subtle" style={{ fontWeight: 800, marginBottom: 6 }}>
                                    Active
                                  </div>
                                  <label className="row" style={{ gap: 8, alignItems: "center" }}>
                                    <input
                                      type="checkbox"
                                      checked={!!d.is_active}
                                      onChange={(e) =>
                                        setMeetingTypeEdits((cur) => ({
                                          ...cur,
                                          [t.id]: { ...d, is_active: e.target.checked },
                                        }))
                                      }
                                    />
                                    <span style={{ fontWeight: 800 }}>{d.is_active ? "Yes" : "No"}</span>
                                  </label>
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
                      borderBottom: "1px solid var(--border)",
                      gap: 10,
                    }}
                  >
                    <div className="stack" style={{ gap: 2 }}>
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
                        <div style={{ padding: 12, borderBottom: "1px solid var(--border)" }}>
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
                                    <th key={idx} style={{ position: "sticky", top: 0, background: "white", zIndex: 1 }}>
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
                                      <td key={cidx}>
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
                                setStatus("Download error: " + (e?.message ?? "unknown"));
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
          </>
        )}
      </div>
    </main>
  );
}
