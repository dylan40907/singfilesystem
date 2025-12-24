"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { supabase } from "@/lib/supabaseClient";
import { fetchActiveTeachers, fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import "@fortune-sheet/react/dist/index.css";

// TipTap (Rich Text)
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { Link } from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extension-placeholder";
import type { CommandProps } from "@tiptap/core";

const FortuneWorkbook = dynamic(() => import("@fortune-sheet/react").then((m) => m.Workbook), { ssr: false });

type UserFolderPermissionRow = {
  permission_id: string;
  folder_id: string;
  folder_name: string;
  access: "view" | "download" | "manage";
  inherit: boolean;
  created_at: string;
};

type TeacherPlanRow = {
  id: string;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
  title: string;
  status: "draft" | "submitted" | "changes_requested" | "approved";
};

type PlanDetailRow = TeacherPlanRow & {
  content: string;
  plan_format: "text" | "sheet";
  sheet_doc: any | null;

  approved_by: string | null;
  approved_at: string | null;
  last_reviewed_at: string | null;
};

type PlanCommentRow = {
  id: string;
  plan_id: string;
  created_at: string;
  author_user_id: string;
  body: string;
};

type UserLabelRow = {
  id: string;
  email: string | null;
  full_name: string | null;
};

function StatusBadge({ status }: { status: TeacherPlanRow["status"] }) {
  return <span className="badge badge-pink">{status.replaceAll("_", " ")}</span>;
}

function labelForUser(u: { full_name?: string | null; email?: string | null; id: string }) {
  const name = (u.full_name ?? "").trim();
  const email = (u.email ?? "").trim();
  if (name && email) return `${name} (${email})`;
  if (name) return name;
  if (email) return email;
  return u.id;
}

// ---------------------------
// FortuneSheet helpers
// ---------------------------
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

// ---------------------------
// Rich text helpers
// ---------------------------
function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeContentToHtml(raw: string | null | undefined) {
  const s = (raw ?? "").trim();
  if (!s) return "<p></p>";

  // If it looks like HTML already, keep it.
  if (s.includes("<p") || s.includes("<div") || s.includes("<h") || s.includes("<ul") || s.includes("<ol")) {
    return s;
  }

  // Otherwise treat as plain text and preserve line breaks.
  const escaped = escapeHtml(s);
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replaceAll("\n", "<br />")}</p>`)
    .join("");
  return paragraphs || "<p></p>";
}

// --- TipTap extension: FontSize using TextStyle ---
const FontSize = TextStyle.extend({
  addAttributes() {
    return {
      ...(this.parent?.() ?? {}),
      fontSize: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).style.fontSize?.replaceAll('"', "") || null,
        renderHTML: (attributes) => {
          if (!attributes.fontSize) return {};
          return { style: `font-size: ${attributes.fontSize}` };
        },
      },
    };
  },
  addCommands() {
    return {
      setFontSize:
        (fontSize: string) =>
        ({ chain }: CommandProps) => {
          return chain().setMark("textStyle", { fontSize }).run();
        },
      unsetFontSize:
        () =>
        ({ chain }: CommandProps) => {
          return chain().setMark("textStyle", { fontSize: null }).run();
        },
    } as any;
  },
});

function ToolbarButton({
  active,
  disabled,
  onClick,
  children,
  title,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="btn"
      disabled={disabled}
      title={title}
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
      style={{
        padding: "6px 10px",
        borderRadius: 10,
        background: active ? "rgba(230,23,141,0.10)" : "white",
        boxShadow: active ? "inset 0 0 0 2px rgba(230,23,141,0.35)" : "inset 0 0 0 1px var(--border)",
        fontWeight: 800,
        fontSize: 12,
      }}
    >
      {children}
    </button>
  );
}

function RichTextEditor({
  valueHtml,
  onChangeHtml,
  disabled,
  minBodyHeight,
}: {
  valueHtml: string;
  onChangeHtml: (html: string) => void;
  disabled: boolean;
  minBodyHeight?: number;
}) {
  const lastHtmlFromEditorRef = useRef<string>("");

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    editorProps: {
      attributes: { spellcheck: "false" },
    },
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Underline,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TextStyle,
      FontSize,
      Color,
      Highlight.configure({ multicolor: true }),
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
      Placeholder.configure({ placeholder: "Write feedback or edits here…" }),
    ],
    content: valueHtml || "<p></p>",
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      lastHtmlFromEditorRef.current = html;
      onChangeHtml(html);
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  useEffect(() => {
    if (!editor) return;
    if (valueHtml === lastHtmlFromEditorRef.current) return;

    const current = editor.getHTML();
    if (current !== valueHtml) {
      editor.commands.setContent(valueHtml || "<p></p>", { emitUpdate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueHtml, editor]);

  const toolbarDisabled = disabled || !editor;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", background: "#fff" }}>
      <div
        style={{
          padding: 10,
          borderBottom: "1px solid var(--border)",
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <select
          className="select"
          disabled={toolbarDisabled}
          defaultValue="default"
          onChange={(e) => {
            const v = e.target.value;
            if (!editor) return;

            if (v === "default") (editor.commands as any).unsetFontSize?.();
            else (editor.commands as any).setFontSize?.(v);

            editor.chain().focus().run();
          }}
          style={{ maxWidth: 140 }}
        >
          <option value="default">Font size</option>
          <option value="12px">12</option>
          <option value="14px">14</option>
          <option value="16px">16</option>
          <option value="18px">18</option>
          <option value="24px">24</option>
          <option value="32px">32</option>
        </select>

        <ToolbarButton disabled={toolbarDisabled} active={!!editor?.isActive("bold")} onClick={() => editor?.chain().focus().toggleBold().run()} title="Bold">
          B
        </ToolbarButton>
        <ToolbarButton disabled={toolbarDisabled} active={!!editor?.isActive("italic")} onClick={() => editor?.chain().focus().toggleItalic().run()} title="Italic">
          I
        </ToolbarButton>
        <ToolbarButton disabled={toolbarDisabled} active={!!editor?.isActive("underline")} onClick={() => editor?.chain().focus().toggleUnderline().run()} title="Underline">
          U
        </ToolbarButton>

        <ToolbarButton disabled={toolbarDisabled} active={!!editor?.isActive("bulletList")} onClick={() => editor?.chain().focus().toggleBulletList().run()} title="Bulleted list">
          • List
        </ToolbarButton>
        <ToolbarButton disabled={toolbarDisabled} active={!!editor?.isActive("orderedList")} onClick={() => editor?.chain().focus().toggleOrderedList().run()} title="Numbered list">
          1. List
        </ToolbarButton>

        <ToolbarButton disabled={toolbarDisabled} active={!!editor?.isActive({ textAlign: "left" })} onClick={() => editor?.chain().focus().setTextAlign("left").run()} title="Align left">
          Left
        </ToolbarButton>
        <ToolbarButton disabled={toolbarDisabled} active={!!editor?.isActive({ textAlign: "center" })} onClick={() => editor?.chain().focus().setTextAlign("center").run()} title="Align center">
          Center
        </ToolbarButton>
        <ToolbarButton disabled={toolbarDisabled} active={!!editor?.isActive({ textAlign: "right" })} onClick={() => editor?.chain().focus().setTextAlign("right").run()} title="Align right">
          Right
        </ToolbarButton>

        <input
          type="color"
          disabled={toolbarDisabled}
          title="Text color"
          onChange={(e) => editor?.chain().focus().setColor(e.target.value).run()}
          style={{
            width: 44,
            height: 34,
            padding: 2,
            borderRadius: 10,
            border: "1px solid var(--border)",
            background: "white",
          }}
        />

        <ToolbarButton disabled={toolbarDisabled} active={!!editor?.isActive("highlight")} onClick={() => editor?.chain().focus().toggleHighlight({ color: "#fff59d" }).run()} title="Highlight">
          Highlight
        </ToolbarButton>

        <ToolbarButton disabled={toolbarDisabled} onClick={() => editor?.chain().focus().undo().run()} title="Undo">
          Undo
        </ToolbarButton>
        <ToolbarButton disabled={toolbarDisabled} onClick={() => editor?.chain().focus().redo().run()} title="Redo">
          Redo
        </ToolbarButton>
      </div>

      <div style={{ padding: 12 }}>
        <div
          style={{
            minHeight: minBodyHeight ?? 260,
            borderRadius: 12,
            padding: 12,
            background: "#fff",
            boxShadow: "inset 0 0 0 1px var(--border)",
          }}
        >
          <EditorContent editor={editor} />
        </div>

        {disabled ? (
          <div className="subtle" style={{ marginTop: 10 }}>
            Read-only.
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------

function isValidEmail(email: string) {
  // good-enough frontend validation
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export default function TeachersPage() {
  const DEFAULT_SHEET_DOC = [{ name: "Sheet 1", row: 30, column: 20, celldata: [], config: {} }];

  const [status, setStatus] = useState("");
  const [me, setMe] = useState<TeacherProfile | null>(null);

  const isAdmin = !!me?.is_active && me.role === "admin";
  const isAdminOrSupervisor = !!me?.is_active && (me.role === "admin" || me.role === "supervisor");

  const [teachers, setTeachers] = useState<TeacherProfile[]>([]);
  const [selectedTeacherId, setSelectedTeacherId] = useState<string>("");

  // Admin-only: Add teacher modal state
  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addName, setAddName] = useState("");
  const [addLoading, setAddLoading] = useState(false);

  // Admin-only: delete state
  const [deleteLoading, setDeleteLoading] = useState(false);

  // permissions
  const [teacherPerms, setTeacherPerms] = useState<UserFolderPermissionRow[]>([]);
  const [teacherPermsLoading, setTeacherPermsLoading] = useState(false);

  // plans list
  const [plans, setPlans] = useState<TeacherPlanRow[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);

  const [selectedPlanId, setSelectedPlanId] = useState<string>("");
  const selectedPlan = useMemo(() => plans.find((p) => p.id === selectedPlanId) || null, [plans, selectedPlanId]);

  // plan detail
  const [planDetail, setPlanDetail] = useState<PlanDetailRow | null>(null);
  const [planLoading, setPlanLoading] = useState(false);

  // Editable fields (supervisor/admin edits)
  const [editTitle, setEditTitle] = useState("");
  const [editContentHtml, setEditContentHtml] = useState("<p></p>");
  const [textDirty, setTextDirty] = useState(false);

  const baselineTitleRef = useRef<string>("");
  const baselineContentHtmlRef = useRef<string>("<p></p>");

  // sheet state
  const [sheetDoc, setSheetDoc] = useState<any[]>(DEFAULT_SHEET_DOC);
  const [sheetLoadedPlanId, setSheetLoadedPlanId] = useState<string>("");
  const [workbookKey, setWorkbookKey] = useState<string>("init");
  const workbookRef = useRef<any>(null);
  const [sheetDirty, setSheetDirty] = useState(false);

  // fullscreen overlays
  const [sheetView, setSheetView] = useState(false);
  const [textView, setTextView] = useState(false);

  const isSheetSelected = planDetail?.plan_format === "sheet";
  const isTextSelected = planDetail?.plan_format === "text";
  const isSheetView = sheetView && isSheetSelected;
  const isTextView = textView && isTextSelected;

  // comments
  const [comments, setComments] = useState<PlanCommentRow[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [newComment, setNewComment] = useState("");

  // map for user labels
  const [userLabelsById, setUserLabelsById] = useState<Record<string, UserLabelRow>>({});

  const teacherById = useMemo(() => {
    const m = new Map<string, TeacherProfile>();
    for (const t of teachers) m.set(t.id, t);
    return m;
  }, [teachers]);

  const selectedTeacher = selectedTeacherId ? teacherById.get(selectedTeacherId) ?? null : null;

  function labelForUserId(id: string) {
    const u = userLabelsById[id];
    if (u) return labelForUser(u);
    return id;
  }

  async function loadMe() {
    const profile = await fetchMyProfile();
    setMe(profile);
    return profile;
  }

  async function ensureUserLabels(userIds: string[]) {
    const unique = Array.from(new Set(userIds.filter(Boolean)));
    const missing = unique.filter((id) => !userLabelsById[id]);
    if (missing.length === 0) return;

    const { data, error } = await supabase.from("user_profiles").select("id, email, full_name").in("id", missing);
    if (error) throw error;

    const next: Record<string, UserLabelRow> = { ...userLabelsById };
    for (const row of (data ?? []) as UserLabelRow[]) next[row.id] = row;
    setUserLabelsById(next);
  }

  async function refreshTeacherList() {
    const list = await fetchActiveTeachers();
    setTeachers(list);

    if (!selectedTeacherId && list.length > 0) setSelectedTeacherId(list[0].id);
    if (selectedTeacherId && list.length > 0 && !list.some((t) => t.id === selectedTeacherId)) {
      // selection was deleted or removed
      setSelectedTeacherId(list[0].id);
      setSelectedPlanId("");
      setPlanDetail(null);
      setComments([]);
    }

    await ensureUserLabels(list.map((t) => t.id));
  }

  // ADMIN: create teacher via Edge Function
  async function createTeacher() {
    const email = addEmail.trim();
    const name = addName.trim();

    if (!email || !isValidEmail(email)) {
      setStatus("Create teacher error: Please enter a valid email.");
      return;
    }
    if (!name) {
      setStatus("Create teacher error: Please enter a name.");
      return;
    }

    setAddLoading(true);
    setStatus("Creating teacher...");
    try {
      // IMPORTANT: match Edge Function expected keys
      const { data, error } = await supabase.functions.invoke("admin-create-teacher", {
        body: {
          teacher_email: email,
          teacher_full_name: name,
        },
      });

      if (error) {
        // Supabase wraps non-2xx as "error"; still show something useful
        setStatus("Create teacher error: " + (error.message ?? "unknown"));
        return;
      }

      setStatus("✅ Teacher created.");
      setAddOpen(false);
      setAddEmail("");
      setAddName("");

      await refreshTeacherList();

      const createdId = (data as any)?.teacher_id ?? (data as any)?.id ?? null;
      if (createdId && typeof createdId === "string") {
        setSelectedTeacherId(createdId);
      }
    } catch (e: any) {
      setStatus("Create teacher error: " + (e?.message ?? "unknown"));
    } finally {
      setAddLoading(false);
    }
  }

  // ADMIN: delete teacher via Edge Function
  async function deleteSelectedTeacher() {
    if (!selectedTeacherId) return;
    if (!isAdmin) return;

    const label = selectedTeacher
      ? labelForUser({ id: selectedTeacher.id, email: selectedTeacher.email, full_name: selectedTeacher.full_name })
      : selectedTeacherId;

    const ok = window.confirm(`Delete this teacher?\n\n${label}\n\nThis cannot be undone.`);
    if (!ok) return;

    setDeleteLoading(true);
    setStatus("Deleting teacher...");
    try {
      // IMPORTANT: match Edge Function expected keys
      const { data, error } = await supabase.functions.invoke("admin-delete-teacher", {
        body: {
          teacher_id: selectedTeacherId,
        },
      });

      if (error) {
        setStatus("Delete teacher error: " + (error.message ?? "unknown"));
        return;
      }

      // optionally use data if your function returns something
      void data;

      setStatus("✅ Teacher deleted.");
      setSelectedTeacherId("");
      setSelectedPlanId("");
      setPlanDetail(null);
      setComments([]);
      await refreshTeacherList();
    } catch (e: any) {
      setStatus("Delete teacher error: " + (e?.message ?? "unknown"));
    } finally {
      setDeleteLoading(false);
    }
  }

  async function refreshTeacherPerms(userId: string) {
    setTeacherPermsLoading(true);
    try {
      const { data, error } = await supabase.rpc("list_user_folder_permissions", { target_user: userId });
      if (error) throw error;
      setTeacherPerms((data ?? []) as UserFolderPermissionRow[]);
    } catch (e: any) {
      setStatus("Error loading permissions: " + (e?.message ?? "unknown"));
      setTeacherPerms([]);
    } finally {
      setTeacherPermsLoading(false);
    }
  }

  async function revokePermission(permissionId: string) {
    setStatus("Revoking permission...");
    try {
      const { error } = await supabase.rpc("revoke_permission", { permission_uuid: permissionId });
      if (error) throw error;
      setStatus("✅ Permission revoked.");
      if (selectedTeacherId) await refreshTeacherPerms(selectedTeacherId);
    } catch (e: any) {
      setStatus("Revoke error: " + (e?.message ?? "unknown"));
    }
  }

  async function refreshTeacherPlans(userId: string) {
    setPlansLoading(true);
    try {
      const { data, error } = await supabase
        .from("lesson_plans")
        .select("id, owner_user_id, created_at, updated_at, title, status")
        .eq("owner_user_id", userId)
        .order("updated_at", { ascending: false });

      if (error) throw error;

      const rows = (data ?? []) as TeacherPlanRow[];
      setPlans(rows);

      await ensureUserLabels(rows.map((r) => r.owner_user_id));

      if (rows.length > 0) {
        const stillExists = rows.some((p) => p.id === selectedPlanId);
        if (!stillExists) setSelectedPlanId(rows[0].id);
      } else {
        setSelectedPlanId("");
        setPlanDetail(null);
        setComments([]);
      }
    } catch (e: any) {
      setStatus("Error loading lesson plans: " + (e?.message ?? "unknown"));
      setPlans([]);
      setSelectedPlanId("");
      setPlanDetail(null);
      setComments([]);
    } finally {
      setPlansLoading(false);
    }
  }

  async function loadPlanDetails(planId: string) {
    setPlanLoading(true);
    try {
      const { data, error } = await supabase
        .from("lesson_plans")
        .select("id, owner_user_id, created_at, updated_at, title, status, content, plan_format, sheet_doc, approved_by, approved_at, last_reviewed_at")
        .eq("id", planId)
        .single();

      if (error) throw error;

      const merged = data as any as PlanDetailRow;
      setPlanDetail(merged);

      // close fullscreen when switching plans
      setSheetView(false);
      setTextView(false);

      // seed editable state
      const seededTitle = merged.title ?? "";
      const seededContent = normalizeContentToHtml(merged.content ?? "");

      setEditTitle(seededTitle);
      setEditContentHtml(seededContent);
      setTextDirty(false);

      baselineTitleRef.current = seededTitle;
      baselineContentHtmlRef.current = seededContent;

      // seed sheet state
      if (merged.plan_format === "sheet") {
        const normalized = normalizeForFortune(merged.sheet_doc, DEFAULT_SHEET_DOC);
        setSheetLoadedPlanId("");
        setSheetDoc(normalized);
        setSheetDirty(false);
        setWorkbookKey(`${planId}:${Date.now()}`);
        setSheetLoadedPlanId(planId);
      } else {
        setSheetLoadedPlanId("");
        setSheetDoc(DEFAULT_SHEET_DOC);
        setSheetDirty(false);
      }
    } catch (e: any) {
      setStatus("Error loading plan: " + (e?.message ?? "unknown"));
      setPlanDetail(null);
    } finally {
      setPlanLoading(false);
    }
  }

  async function refreshComments(planId: string) {
    setCommentsLoading(true);
    try {
      const { data, error } = await supabase
        .from("lesson_plan_comments")
        .select("id, plan_id, created_at, author_user_id, body")
        .eq("plan_id", planId)
        .order("created_at", { ascending: true });

      if (error) throw error;

      const rows = (data ?? []) as PlanCommentRow[];
      setComments(rows);

      await ensureUserLabels(rows.map((r) => r.author_user_id));
    } catch (e: any) {
      setStatus("Error loading comments: " + (e?.message ?? "unknown"));
      setComments([]);
    } finally {
      setCommentsLoading(false);
    }
  }

  async function addComment(planId: string) {
    const text = newComment.trim();
    if (!text) return;

    setStatus("Posting comment...");
    try {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData.user) throw new Error("Not signed in");

      const { error } = await supabase.from("lesson_plan_comments").insert({
        plan_id: planId,
        body: text,
        author_user_id: userData.user.id,
      });

      if (error) throw error;

      setNewComment("");
      setStatus("✅ Comment posted.");
      await refreshComments(planId);
    } catch (e: any) {
      setStatus("Comment error: " + (e?.message ?? "unknown"));
    }
  }

  const exportSheetDoc = useCallback((): any[] => {
    const api = workbookRef.current;
    let latest: any;

    try {
      if (api?.getAllSheets) latest = api.getAllSheets();
    } catch (err) {
      console.warn("exportSheetDoc: ref.getAllSheets() threw", err);
    }

    if (!latest) latest = sheetDoc;
    return deepJsonClone(latest);
  }, [sheetDoc]);

  const handleSheetOp = useCallback((_ops: any[]) => {
    requestAnimationFrame(() => setSheetDirty(true));
  }, []);

  async function autoCommentSupervisorEdit(planId: string, planFormat: "text" | "sheet") {
    try {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData.user) throw new Error("Not signed in");

      const actor =
        me
          ? labelForUser({
              id: userData.user.id,
              full_name: (me as any).full_name ?? null,
              email: (me as any).email ?? null,
            })
          : userData.user.id;

      const ts = new Date().toLocaleString();
      const body = `Supervisor edit — ${actor} edited ${planFormat} at ${ts}`;

      await supabase.from("lesson_plan_comments").insert({
        plan_id: planId,
        body,
        author_user_id: userData.user.id,
      });
    } catch {
      // don't block save
    }
  }

  function hasSupervisorEdits(): boolean {
    if (!planDetail) return false;

    const titleChanged = editTitle !== baselineTitleRef.current;

    if (planDetail.plan_format === "sheet") return titleChanged || sheetDirty;

    const contentChanged = editContentHtml !== baselineContentHtmlRef.current;
    return titleChanged || contentChanged || textDirty;
  }

  async function saveSupervisorEdits() {
    if (!planDetail) return;

    const anyEdits = hasSupervisorEdits();
    if (!anyEdits) {
      setStatus("Nothing to save.");
      return;
    }

    setStatus("Saving edits...");
    try {
      const payload: any = {
        title: editTitle,
        last_reviewed_at: new Date().toISOString(),
      };

      if (planDetail.plan_format === "text") {
        payload.content = editContentHtml;
      } else {
        const exportedRaw = exportSheetDoc();
        const exported = normalizeForFortune(exportedRaw, DEFAULT_SHEET_DOC);
        payload.sheet_doc = deepJsonClone(exported);

        setSheetDoc(exported);
        setSheetDirty(false);
      }

      const { error } = await supabase.from("lesson_plans").update(payload).eq("id", planDetail.id);
      if (error) throw error;

      await autoCommentSupervisorEdit(planDetail.id, planDetail.plan_format);

      baselineTitleRef.current = editTitle;
      if (planDetail.plan_format === "text") baselineContentHtmlRef.current = editContentHtml;

      setTextDirty(false);
      setStatus("✅ Saved edits.");

      if (selectedTeacherId) await refreshTeacherPlans(selectedTeacherId);
      await loadPlanDetails(planDetail.id);
      await refreshComments(planDetail.id);
    } catch (e: any) {
      setStatus("Save edits error: " + (e?.message ?? "unknown"));
    }
  }

  async function approvePlan(planId: string) {
    setStatus("Approving...");
    try {
      const { error } = await supabase.rpc("approve_lesson_plan", { plan_uuid: planId });
      if (error) throw error;
      setStatus("✅ Approved.");
      if (selectedTeacherId) await refreshTeacherPlans(selectedTeacherId);
      await loadPlanDetails(planId);
    } catch (e: any) {
      setStatus("Approve error: " + (e?.message ?? "unknown"));
    }
  }

  async function requestChanges(planId: string) {
    setStatus("Requesting changes...");
    try {
      const { error } = await supabase.rpc("request_changes_lesson_plan", { plan_uuid: planId });
      if (error) throw error;
      setStatus("✅ Changes requested.");
      if (selectedTeacherId) await refreshTeacherPlans(selectedTeacherId);
      await loadPlanDetails(planId);
    } catch (e: any) {
      setStatus("Request changes error: " + (e?.message ?? "unknown"));
    }
  }

  async function bootstrap() {
    setStatus("Loading...");
    try {
      const profile = await loadMe();
      if (!profile?.is_active || !(profile.role === "admin" || profile.role === "supervisor")) {
        setStatus("Not authorized.");
        return;
      }
      await refreshTeacherList();
      setStatus("");
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    }
  }

  useEffect(() => {
    bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isAdminOrSupervisor) return;
    if (!selectedTeacherId) return;

    refreshTeacherPerms(selectedTeacherId);
    refreshTeacherPlans(selectedTeacherId);
    ensureUserLabels([selectedTeacherId]).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeacherId, isAdminOrSupervisor]);

  useEffect(() => {
    if (!selectedPlanId) return;
    loadPlanDetails(selectedPlanId);
    refreshComments(selectedPlanId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlanId]);

  if (!isAdminOrSupervisor) {
    return (
      <main className="stack">
        <div className="row-between">
          <div className="stack" style={{ gap: 6 }}>
            <h1 className="h1">Teachers</h1>
            <div className="subtle">Supervisor-only access.</div>
          </div>
          {status ? <span className="badge badge-pink">{status}</span> : null}
        </div>

        <div className="card">
          <div style={{ fontWeight: 800 }}>Not authorized</div>
          <div className="subtle" style={{ marginTop: 6 }}>
            You must be an active supervisor/admin to view this page.
          </div>
        </div>
      </main>
    );
  }

  const selectedTeacherLabel =
    selectedTeacher
      ? labelForUser({ id: selectedTeacher.id, email: selectedTeacher.email, full_name: selectedTeacher.full_name })
      : selectedTeacherId
      ? labelForUserId(selectedTeacherId)
      : "";

  const showBase = !(isSheetView || isTextView);
  const saveDisabled = planLoading || !planDetail || !hasSupervisorEdits();

  return (
    <main className="stack">
      {/* TipTap polish */}
      <style jsx global>{`
        .ProseMirror {
          outline: none !important;
          border: none !important;
          min-height: 240px;
        }
        .ProseMirror:focus {
          outline: none !important;
        }
        .ProseMirror p {
          margin: 0.35em 0;
        }
      `}</style>

      <div className="row-between">
        <div className="stack" style={{ gap: 6 }}>
          <h1 className="h1">Teachers</h1>
        </div>
        {status ? <span className="badge badge-pink">{status}</span> : null}
      </div>

      <div className="card">
        <div className="row-between">
          <div>
            <div style={{ fontWeight: 900 }}>Select teacher</div>
          </div>

          <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            {isAdmin ? (
              <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
                Add teacher
              </button>
            ) : null}

            <button className="btn" onClick={refreshTeacherList}>
              Refresh teachers
            </button>

            {isAdmin ? (
              <button
                className="btn"
                title="Delete selected teacher"
                onClick={() => void deleteSelectedTeacher()}
                disabled={!selectedTeacherId || deleteLoading}
                style={{ padding: "8px 10px" }}
              >
                🗑
              </button>
            ) : null}
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <select className="select" value={selectedTeacherId} onChange={(e) => setSelectedTeacherId(e.target.value)}>
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.full_name ? `${t.full_name} (${t.email ?? t.id})` : t.email ?? t.id}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Admin-only Add Teacher Modal */}
      {isAdmin && addOpen ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            zIndex: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={() => {
            if (!addLoading) setAddOpen(false);
          }}
        >
          <div
            className="card"
            style={{ width: "min(520px, 100%)", borderRadius: 14 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row-between">
              <div style={{ fontWeight: 950, fontSize: 16 }}>Add teacher</div>
              <button className="btn" onClick={() => !addLoading && setAddOpen(false)} disabled={addLoading}>
                Close
              </button>
            </div>

            <div className="hr" />

            <div className="stack" style={{ gap: 10 }}>
              <div className="subtle">Creates a teacher account without a password (for now).</div>

              <input
                className="input"
                placeholder="Teacher email"
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
                disabled={addLoading}
              />

              <input
                className="input"
                placeholder="Teacher full name"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                disabled={addLoading}
              />

              <div className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
                <button className="btn" onClick={() => setAddOpen(false)} disabled={addLoading}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={() => void createTeacher()} disabled={addLoading}>
                  {addLoading ? "Creating..." : "Create teacher"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showBase ? (
        <>
          <div className="grid-2">
            <div className="card">
              <div className="row-between">
                <div>
                  <div style={{ fontWeight: 900 }}>Folder permissions</div>
                </div>
                <button className="btn" onClick={() => selectedTeacherId && refreshTeacherPerms(selectedTeacherId)} disabled={!selectedTeacherId || teacherPermsLoading}>
                  Refresh
                </button>
              </div>

              <div style={{ marginTop: 12 }}>
                {teacherPermsLoading ? (
                  <div className="subtle">Loading…</div>
                ) : teacherPerms.length === 0 ? (
                  <div className="subtle">(No direct folder shares)</div>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Folder</th>
                        <th>Access</th>
                        <th>Inherit</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {teacherPerms.map((p) => (
                        <tr key={p.permission_id}>
                          <td>{p.folder_name}</td>
                          <td>
                            <span className="badge badge-pink">{p.access}</span>
                          </td>
                          <td>{p.inherit ? "true" : "false"}</td>
                          <td>
                            <button className="btn" onClick={() => revokePermission(p.permission_id)}>
                              Revoke
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className="card">
              <div className="row-between">
                <div>
                  <div style={{ fontWeight: 900 }}>Lesson plans</div>
                  <div className="subtle" style={{ marginTop: 4 }}>
                    Plans created by: <strong>{selectedTeacherLabel || "—"}</strong>
                  </div>
                </div>
                <button className="btn" onClick={() => selectedTeacherId && refreshTeacherPlans(selectedTeacherId)} disabled={!selectedTeacherId || plansLoading}>
                  Refresh
                </button>
              </div>

              <div className="hr" />

              {plansLoading ? (
                <div className="subtle">Loading…</div>
              ) : plans.length === 0 ? (
                <div className="subtle">(No plans)</div>
              ) : (
                <div className="stack">
                  {plans.map((p) => {
                    const active = p.id === selectedPlanId;
                    const ownerLabel = labelForUserId(p.owner_user_id);

                    return (
                      <button
                        key={p.id}
                        className="btn"
                        onClick={() => setSelectedPlanId(p.id)}
                        style={{
                          textAlign: "left",
                          borderColor: active ? "rgba(230,23,141,0.35)" : undefined,
                          background: active ? "rgba(230,23,141,0.06)" : undefined,
                        }}
                      >
                        <div className="row-between" style={{ alignItems: "flex-start" }}>
                          <div style={{ fontWeight: 900 }}>{p.title}</div>
                          <StatusBadge status={p.status} />
                        </div>

                        <div className="subtle" style={{ marginTop: 6 }}>
                          Created by <strong>{ownerLabel}</strong>
                        </div>

                        <div className="subtle" style={{ marginTop: 6 }}>
                          Updated {new Date(p.updated_at).toLocaleString()}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="row-between">
              <div className="stack" style={{ gap: 4 }}>
                <div style={{ fontWeight: 950, fontSize: 16 }}>Plan review</div>
                <div className="subtle">
                  {selectedPlan ? (
                    <>
                      <strong>{selectedPlan.title}</strong> • <span>{selectedPlan.status.replaceAll("_", " ")}</span>
                      {" • "}Created by <strong>{labelForUserId(selectedPlan.owner_user_id)}</strong>
                    </>
                  ) : (
                    "Select a plan above."
                  )}
                </div>
              </div>

              {selectedPlan ? (
                <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
                  <button className="btn" onClick={() => requestChanges(selectedPlan.id)}>
                    Request changes
                  </button>
                  <button className="btn btn-primary" onClick={() => approvePlan(selectedPlan.id)}>
                    Approve
                  </button>
                </div>
              ) : null}
            </div>

            <div className="hr" />

            {!selectedPlan ? (
              <div className="subtle">(No plan selected)</div>
            ) : (
              <div className="grid-2">
                <div className="card" style={{ borderRadius: 12 }}>
                  <div className="row-between" style={{ alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontWeight: 900 }}>Content</div>
                      <div className="subtle" style={{ marginTop: 4 }}>
                        {planDetail ? (
                          <>
                            Status: <strong>{planDetail.status.replaceAll("_", " ")}</strong>
                            {" • "}Format: <strong>{planDetail.plan_format}</strong>
                            {" • "}{hasSupervisorEdits() ? "Unsaved changes" : "All changes saved"}
                          </>
                        ) : null}
                      </div>
                    </div>

                    <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                      <button className="btn" onClick={saveSupervisorEdits} disabled={saveDisabled}>
                        Save edits
                      </button>

                      {planDetail?.plan_format === "sheet" ? (
                        <button className="btn" onClick={() => setSheetView(true)} disabled={planLoading}>
                          Full screen
                        </button>
                      ) : planDetail?.plan_format === "text" ? (
                        <button className="btn" onClick={() => setTextView(true)} disabled={planLoading}>
                          Full screen
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="hr" />

                  {planLoading ? (
                    <div className="subtle" style={{ marginTop: 10 }}>
                      Loading…
                    </div>
                  ) : !planDetail ? (
                    <div className="subtle">(No plan loaded)</div>
                  ) : (
                    <div className="stack" style={{ gap: 10 }}>
                      <input
                        className="input"
                        value={editTitle}
                        onChange={(e) => {
                          setEditTitle(e.target.value);
                          setTextDirty(true);
                        }}
                        placeholder="Lesson plan title"
                      />

                      {planDetail.plan_format === "text" ? (
                        <RichTextEditor
                          valueHtml={editContentHtml}
                          onChangeHtml={(html) => {
                            setEditContentHtml(html);
                            setTextDirty(true);
                          }}
                          disabled={false}
                        />
                      ) : (
                        <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                          <div className="row-between" style={{ padding: 10, borderBottom: "1px solid var(--border)", gap: 10 }}>
                            <div style={{ fontWeight: 800 }}>
                              Sheet plan{" "}
                              <span className="subtle" style={{ marginLeft: 10, fontWeight: 500 }}>
                                (supports multiple tabs){sheetDirty ? " • unsaved" : ""}
                              </span>
                            </div>
                          </div>

                          <div style={{ height: 520, width: "100%" }}>
                            {sheetLoadedPlanId !== planDetail.id ? (
                              <div className="subtle" style={{ padding: 12 }}>
                                Loading sheet…
                              </div>
                            ) : (
                              <FortuneWorkbook key={workbookKey} ref={workbookRef as any} data={sheetDoc} onOp={handleSheetOp} />
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="card" style={{ borderRadius: 12 }}>
                  <div className="row-between">
                    <div>
                      <div style={{ fontWeight: 900 }}>Comments</div>
                    </div>
                    <button className="btn" onClick={() => selectedPlanId && refreshComments(selectedPlanId)} disabled={commentsLoading}>
                      Refresh
                    </button>
                  </div>

                  <div className="hr" />

                  <div className="stack">
                    <textarea className="textarea" value={newComment} onChange={(e) => setNewComment(e.target.value)} placeholder="Write feedback… (optional)" />
                    <button className="btn btn-primary" onClick={() => addComment(selectedPlan.id)}>
                      Post comment
                    </button>

                    <div className="hr" />

                    {commentsLoading ? (
                      <div className="subtle">Loading…</div>
                    ) : comments.length === 0 ? (
                      <div className="subtle">(No comments yet)</div>
                    ) : (
                      <div className="stack">
                        {comments.map((c) => {
                          const author = userLabelsById[c.author_user_id] ?? { id: c.author_user_id, email: null, full_name: null };
                          return (
                            <div key={c.id} className="card" style={{ borderRadius: 12 }}>
                              <div className="row-between" style={{ alignItems: "flex-start" }}>
                                <div className="subtle">{new Date(c.created_at).toLocaleString()}</div>
                                <span className="badge">{labelForUser(author)}</span>
                              </div>
                              <div style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{c.body}</div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      ) : null}

      {/* Fullscreen: SHEET */}
      {isSheetView && planDetail ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "white",
            zIndex: 100,
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            overflow: "hidden",
          }}
        >
          <div className="row-between" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span className="badge badge-pink">{planDetail.status.replaceAll("_", " ")}</span>

              <input
                className="input"
                value={editTitle}
                onChange={(e) => {
                  setEditTitle(e.target.value);
                  setTextDirty(true);
                }}
                placeholder="Lesson plan title"
                style={{ minWidth: 280 }}
              />

              <span className="subtle">{hasSupervisorEdits() ? "Unsaved changes" : "All changes saved"}</span>
            </div>

            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <button className="btn" onClick={() => setSheetView(false)}>
                Exit full screen
              </button>
              <button className="btn btn-primary" onClick={saveSupervisorEdits} disabled={saveDisabled}>
                Save edits
              </button>
              <button className="btn" onClick={() => requestChanges(planDetail.id)}>
                Request changes
              </button>
              <button className="btn btn-primary" onClick={() => approvePlan(planDetail.id)}>
                Approve
              </button>
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, width: "100%", border: "1px solid var(--border)", borderRadius: 12, overflow: "visible" }}>
            {sheetLoadedPlanId !== planDetail.id ? (
              <div className="subtle" style={{ padding: 12 }}>
                Loading sheet…
              </div>
            ) : (
              <div style={{ height: "100%", width: "100%" }}>
                <FortuneWorkbook key={workbookKey + ":fullscreen"} ref={workbookRef as any} data={sheetDoc} onOp={handleSheetOp} />
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* Fullscreen: TEXT */}
      {isTextView && planDetail ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "white",
            zIndex: 100,
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            overflow: "hidden",
          }}
        >
          <div className="row-between" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span className="badge badge-pink">{planDetail.status.replaceAll("_", " ")}</span>

              <input
                className="input"
                value={editTitle}
                onChange={(e) => {
                  setEditTitle(e.target.value);
                  setTextDirty(true);
                }}
                placeholder="Lesson plan title"
                style={{ minWidth: 280 }}
              />

              <span className="subtle">{hasSupervisorEdits() ? "Unsaved changes" : "All changes saved"}</span>
            </div>

            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <button className="btn" onClick={() => setTextView(false)}>
                Exit full screen
              </button>
              <button className="btn btn-primary" onClick={saveSupervisorEdits} disabled={saveDisabled}>
                Save edits
              </button>
              <button className="btn" onClick={() => requestChanges(planDetail.id)}>
                Request changes
              </button>
              <button className="btn btn-primary" onClick={() => approvePlan(planDetail.id)}>
                Approve
              </button>
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            <RichTextEditor
              valueHtml={editContentHtml}
              onChangeHtml={(html) => {
                setEditContentHtml(html);
                setTextDirty(true);
              }}
              disabled={false}
              minBodyHeight={520}
            />
          </div>
        </div>
      ) : null}
    </main>
  );
}
