"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import { submitLessonPlan } from "@/lib/lessonPlans";
import { fetchLessonPlanComments, LessonPlanComment } from "@/lib/lessonPlanComments";
import "@fortune-sheet/react/dist/index.css";

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

type UserLabelRow = {
  id: string;
  email: string | null;
  full_name: string | null;
};

type MyPlanRow = {
  id: string;
  created_at: string;
  updated_at: string;
  title: string;
  status: "draft" | "submitted" | "changes_requested" | "approved";
  content: string;
  plan_format: "text" | "sheet";
  sheet_doc: any | null;

  owner_user_id: string;
  owner_profile?: UserLabelRow | null;

  last_edited_by?: string | null;
  last_edited_at?: string | null;
  last_submitted_by?: string | null;
  last_submitted_at?: string | null;
};

function StatusBadge({ status }: { status: MyPlanRow["status"] }) {
  const label = status.replaceAll("_", " ");
  return <span className="badge badge-pink">{label}</span>;
}

function labelForUser(u: { full_name?: string | null; username?: string | null; id: string }) {
  const name = (u.full_name ?? "").trim();
  const username = (u.username ?? "").trim();
  if (name && username) return `${name} (${username})`;
  if (name) return name;
  if (username) return username;
  return u.id;
}

async function attachOwnerProfiles(rows: MyPlanRow[]): Promise<MyPlanRow[]> {
  const uniqueIds = Array.from(new Set(rows.map((r) => r.owner_user_id).filter(Boolean)));
  if (uniqueIds.length === 0) return rows;

  const { data, error } = await supabase.from("user_profiles").select("id, email, full_name").in("id", uniqueIds);
  if (error) throw error;

  const map = new Map<string, UserLabelRow>();
  for (const r of (data ?? []) as UserLabelRow[]) map.set(r.id, r);

  return rows.map((p) => ({
    ...p,
    owner_profile: map.get(p.owner_user_id) ?? null,
  }));
}

// --- Sheet helpers ---
function deepJsonClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

function countFilledCells(sheet: any): number {
  if (Array.isArray(sheet?.celldata) && sheet.celldata.length > 0) return sheet.celldata.length;

  const grid = sheet?.data;
  if (!Array.isArray(grid)) return 0;

  let n = 0;
  for (const row of grid) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      if (cell == null) continue;
      if (typeof cell === "object" && cell !== null) {
        const v = (cell as any).v;
        if (v !== null && v !== undefined && String(v) !== "") n++;
      } else {
        if (String(cell) !== "") n++;
      }
    }
  }
  return n;
}

function countFilledCellsInDoc(doc: any[]): number {
  if (!Array.isArray(doc)) return 0;
  return doc.reduce((sum, sh) => sum + countFilledCells(sh), 0);
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

// --- Rich text helpers ---
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

  if (s.includes("<p") || s.includes("<div") || s.includes("<h") || s.includes("<ul") || s.includes("<ol")) {
    return s;
  }

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
  highlightMode,
  minBodyHeight,
}: {
  valueHtml: string;
  onChangeHtml: (html: string) => void;
  disabled: boolean;
  highlightMode?: boolean;
  minBodyHeight?: number;
}) {
  const lastHtmlFromEditorRef = useRef<string>("");

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    editorProps: {
      attributes: {
        spellcheck: "false",
      },
    },
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Underline,
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
      TextStyle,
      FontSize,
      Color,
      Highlight.configure({ multicolor: true }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
      }),
      Placeholder.configure({
        placeholder: "Write your lesson plan here…",
      }),
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
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        overflow: "hidden",
        background: highlightMode ? "rgba(255, 235, 59, 0.10)" : "#fff",
      }}
    >
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

            editor.chain().focus();

            if (v === "default") {
              (editor.commands as any).unsetFontSize?.();
            } else {
              (editor.commands as any).setFontSize?.(v);
            }

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

        <ToolbarButton
          disabled={toolbarDisabled}
          active={!!editor?.isActive("bold")}
          onClick={() => editor?.chain().focus().toggleBold().run()}
          title="Bold"
        >
          B
        </ToolbarButton>

        <ToolbarButton
          disabled={toolbarDisabled}
          active={!!editor?.isActive("italic")}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          title="Italic"
        >
          I
        </ToolbarButton>

        <ToolbarButton
          disabled={toolbarDisabled}
          active={!!editor?.isActive("underline")}
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
          title="Underline"
        >
          U
        </ToolbarButton>

        <ToolbarButton
          disabled={toolbarDisabled}
          active={!!editor?.isActive("bulletList")}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          title="Bulleted list"
        >
          • List
        </ToolbarButton>

        <ToolbarButton
          disabled={toolbarDisabled}
          active={!!editor?.isActive("orderedList")}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          title="Numbered list"
        >
          1. List
        </ToolbarButton>

        <ToolbarButton
          disabled={toolbarDisabled}
          active={!!editor?.isActive({ textAlign: "left" })}
          onClick={() => editor?.chain().focus().setTextAlign("left").run()}
          title="Align left"
        >
          Left
        </ToolbarButton>

        <ToolbarButton
          disabled={toolbarDisabled}
          active={!!editor?.isActive({ textAlign: "center" })}
          onClick={() => editor?.chain().focus().setTextAlign("center").run()}
          title="Align center"
        >
          Center
        </ToolbarButton>

        <ToolbarButton
          disabled={toolbarDisabled}
          active={!!editor?.isActive({ textAlign: "right" })}
          onClick={() => editor?.chain().focus().setTextAlign("right").run()}
          title="Align right"
        >
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

        <ToolbarButton
          disabled={toolbarDisabled}
          active={!!editor?.isActive("highlight")}
          onClick={() => editor?.chain().focus().toggleHighlight({ color: "#fff59d" }).run()}
          title="Highlight"
        >
          Highlight
        </ToolbarButton>

        <ToolbarButton
          disabled={toolbarDisabled}
          active={false}
          onClick={() => editor?.chain().focus().undo().run()}
          title="Undo"
        >
          Undo
        </ToolbarButton>

        <ToolbarButton
          disabled={toolbarDisabled}
          active={false}
          onClick={() => editor?.chain().focus().redo().run()}
          title="Redo"
        >
          Redo
        </ToolbarButton>
      </div>

      <div style={{ padding: 12 }}>
        <div
          style={{
            minHeight: minBodyHeight ?? 280,
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

function ConfirmDeleteModal({
  open,
  name,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        zIndex: 110,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.currentTarget === e.target) onCancel();
      }}
    >
      <div className="card" style={{ width: "min(560px, 96vw)", borderRadius: 16, padding: 16 }}>
        <div style={{ fontWeight: 950, fontSize: 16 }}>Confirm delete</div>
        <div className="subtle" style={{ marginTop: 8 }}>
          Are you sure you want to delete <strong>"{name}"</strong>?
        </div>

        <div className="hr" />

        <div className="row" style={{ justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function TrashIconButton({
  title,
  disabled,
  onClick,
}: {
  title: string;
  disabled?: boolean;
  onClick: (e?: any) => void;
}) {
  return (
    <button
      type="button"
      className="btn"
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        onClick(e);
      }}
      style={{
        padding: "6px 10px",
        borderRadius: 10,
        background: "white",
        boxShadow: "inset 0 0 0 1px var(--border)",
        fontWeight: 800,
        fontSize: 12,
        lineHeight: 1,
      }}
    >
      🗑️
    </button>
  );
}

export default function MyPlansPage() {
  const DEFAULT_SHEET_DOC = [
    {
      name: "Sheet 1",
      row: 30,
      column: 20,
      celldata: [],
      config: {},
    },
  ];

  const [status, setStatus] = useState("");
  const [myProfile, setMyProfile] = useState<TeacherProfile | null>(null);
  const [myUserId, setMyUserId] = useState<string>("");

  const [plans, setPlans] = useState<MyPlanRow[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string>("");

  const [title, setTitle] = useState("");
  const [contentHtml, setContentHtml] = useState("<p></p>");
  const [sheetDoc, setSheetDoc] = useState<any[]>(DEFAULT_SHEET_DOC);

  const [sheetView, setSheetView] = useState(false);
  const [textView, setTextView] = useState(false);

  const [busy, setBusy] = useState(false);

  const [comments, setComments] = useState<LessonPlanComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);

  const [sheetLoadedPlanId, setSheetLoadedPlanId] = useState<string>("");
  const [workbookKey, setWorkbookKey] = useState<string>("init");

  const [userLabelsById, setUserLabelsById] = useState<Record<string, UserLabelRow>>({});

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  const selectedPlan = useMemo(() => plans.find((p) => p.id === selectedPlanId) || null, [plans, selectedPlanId]);

  const isSheetSelected = selectedPlan?.plan_format === "sheet";
  const isTextSelected = selectedPlan?.plan_format === "text";

  const isSheetView = sheetView && isSheetSelected;
  const isTextView = textView && isTextSelected;

  const isAnyFullscreen = isSheetView || isTextView;

  // "My Plans" should be *my* plans only (even for admin/supervisor),
  // so edit/delete is owner-only.
  const canEdit = !!selectedPlan && selectedPlan.owner_user_id === myUserId;
  const canDelete = !!selectedPlan && selectedPlan.owner_user_id === myUserId;

  const showCreator = useMemo(() => {
    if (!myUserId) return false;
    return plans.some((p) => p.owner_user_id && p.owner_user_id !== myUserId);
  }, [plans, myUserId]);

  function createdByLabelForPlan(p: MyPlanRow) {
    if (p.owner_user_id === myUserId) return "You";
    if (p.owner_profile) return labelForUser(p.owner_profile);
    return p.owner_user_id ?? "Unknown";
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

  async function loadMeAndPlans() {
    setStatus("Loading...");
    try {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData.user) throw new Error("Not signed in");
      const userId = userData.user.id;
      setMyUserId(userId);

      const profile = await fetchMyProfile();
      setMyProfile(profile);

      if (!profile?.is_active) {
        setPlans([]);
        setSelectedPlanId("");
        setComments([]);
        setStatus("Not authorized.");
        return;
      }

      // ✅ My Plans = only plans I own (regardless of role)
      const { data, error } = await supabase
        .from("lesson_plans")
        .select(
          "id, created_at, updated_at, title, status, content, plan_format, sheet_doc, owner_user_id, last_edited_by, last_edited_at, last_submitted_by, last_submitted_at"
        )
        .eq("owner_user_id", userId)
        .order("updated_at", { ascending: false });

      if (error) throw error;

      const rows = (data ?? []) as MyPlanRow[];
      const withProfiles = await attachOwnerProfiles(rows);

      setPlans(withProfiles);
      setStatus("");

      await ensureUserLabels(
        withProfiles.flatMap((p) => [p.last_edited_by, p.last_submitted_by]).filter(Boolean) as string[]
      );
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    }
  }

  async function loadComments(planId: string) {
    setCommentsLoading(true);
    try {
      const rows = await fetchLessonPlanComments(planId);
      setComments(rows);
    } catch (e: any) {
      setStatus("Error loading comments: " + (e?.message ?? "unknown"));
      setComments([]);
    } finally {
      setCommentsLoading(false);
    }
  }

  const workbookRef = useRef<any>(null);
  const [sheetDirty, setSheetDirty] = useState(false);

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

  async function createNewPlan() {
    setBusy(true);
    setStatus("Creating...");
    try {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData.user) throw new Error("Not signed in");

      // ✅ Always create a SHEET plan (dropdown removed; text plan stays dormant)
      const { data, error } = await supabase.rpc("create_lesson_plan", {
        plan_title: "New Lesson Plan",
        plan_format: "sheet",
        plan_content: "",
        sheet_doc: DEFAULT_SHEET_DOC,
      });
      if (error) throw error;

      await loadMeAndPlans();

      const newId = (data as any).id as string;
      setSelectedPlanId(newId);

      setSheetView(false);
      setTextView(false);

      setTitle((data as any).title);
      setContentHtml(normalizeContentToHtml((data as any).content ?? ""));
      setSheetDoc(((data as any).sheet_doc as any[]) ?? DEFAULT_SHEET_DOC);
      setSheetDirty(false);

      await loadComments(newId);

      setStatus("✅ Created.");
    } catch (e: any) {
      setStatus("Create error: " + (e?.message ?? "unknown"));
    } finally {
      setBusy(false);
    }
  }

  async function savePlan() {
    if (!selectedPlan) return;
    if (!canEdit) {
      setStatus("This plan is not editable.");
      return;
    }

    setBusy(true);
    setStatus("Saving...");
    try {
      const payload: any = {
        title,
        last_edited_by: myUserId,
        last_edited_at: new Date().toISOString(),
      };

      if (selectedPlan.plan_format === "text") {
        payload.content = contentHtml;
      } else {
        const exportedRaw = exportSheetDoc();
        const exported = normalizeForFortune(exportedRaw, DEFAULT_SHEET_DOC);
        payload.sheet_doc = deepJsonClone(exported);
        setSheetDoc(exported);
        setSheetDirty(false);
      }

      const { error } = await supabase.from("lesson_plans").update(payload).eq("id", selectedPlan.id);
      if (error) throw error;

      setStatus("✅ Saved.");
      await loadMeAndPlans();
    } catch (e: any) {
      setStatus("Save error: " + (e?.message ?? "unknown"));
    } finally {
      setBusy(false);
    }
  }

  async function submitSelectedPlan() {
    if (!selectedPlan) return;
    if (!canEdit) {
      setStatus("This plan is not editable.");
      return;
    }

    setBusy(true);
    setStatus("Saving + submitting...");
    try {
      const payload: any = {
        title,
        last_edited_by: myUserId,
        last_edited_at: new Date().toISOString(),
        last_submitted_by: myUserId,
        last_submitted_at: new Date().toISOString(),
      };

      if (selectedPlan.plan_format === "text") {
        payload.content = contentHtml;
      } else {
        const exportedRaw = exportSheetDoc();
        const exported = normalizeForFortune(exportedRaw, DEFAULT_SHEET_DOC);
        payload.sheet_doc = deepJsonClone(exported);
        setSheetDoc(exported);
        setSheetDirty(false);
      }

      const { error: saveErr } = await supabase.from("lesson_plans").update(payload).eq("id", selectedPlan.id);
      if (saveErr) throw saveErr;

      await submitLessonPlan(selectedPlan.id);

      setStatus("✅ Submitted.");
      await loadMeAndPlans();
      await loadComments(selectedPlan.id);
    } catch (e: any) {
      setStatus("Submit error: " + (e?.message ?? "unknown"));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedPlanConfirmed(planId: string) {
    const plan = plans.find((p) => p.id === planId) ?? selectedPlan;
    if (!plan) return;

    const canDeleteThis = plan.owner_user_id === myUserId;
    if (!canDeleteThis) {
      setStatus("You cannot delete this plan.");
      return;
    }

    setBusy(true);
    setStatus("Deleting...");
    try {
      const { error: cErr } = await supabase.from("lesson_plan_comments").delete().eq("plan_id", planId).select("id");
      if (cErr) throw cErr;

      const { data: deletedRows, error: pErr } = await supabase.from("lesson_plans").delete().eq("id", planId).select("id");
      if (pErr) throw pErr;

      if (!deletedRows || deletedRows.length === 0) {
        setStatus("Delete failed (0 rows affected). This is usually an RLS policy issue.");
        return;
      }

      setDeleteOpen(false);
      setDeleteTarget(null);

      setPlans((prev) => prev.filter((p) => p.id !== planId));
      setComments([]);
      setSelectedPlanId((prev) => (prev === planId ? "" : prev));

      setSheetView(false);
      setTextView(false);

      setStatus("✅ Deleted.");
      await loadMeAndPlans();
    } catch (e: any) {
      setStatus("Delete error: " + (e?.message ?? "unknown"));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    loadMeAndPlans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedPlanId && plans.length > 0) {
      setSelectedPlanId(plans[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans]);

  useEffect(() => {
    if (!selectedPlanId) return;
    const p = plans.find((x) => x.id === selectedPlanId);
    if (!p) return;

    setTitle(p.title);
    setSheetView(false);
    setTextView(false);
    setSheetDirty(false);

    ensureUserLabels([p.last_edited_by ?? "", p.last_submitted_by ?? ""]);

    if (p.plan_format === "sheet") {
      const normalized = normalizeForFortune(p.sheet_doc, DEFAULT_SHEET_DOC);

      setSheetLoadedPlanId("");
      setSheetDoc(normalized);

      setWorkbookKey(`${selectedPlanId}:${Date.now()}`);
      setSheetLoadedPlanId(selectedPlanId);

      setContentHtml("<p></p>");
    } else {
      setSheetLoadedPlanId("");
      setContentHtml(normalizeContentToHtml(p.content ?? ""));
    }

    loadComments(selectedPlanId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlanId, plans]);

  const activeTab = useMemo(() => {
    return selectedPlan ? selectedPlan.status.replaceAll("_", " ") : "";
  }, [selectedPlan]);

  const textWasEditedBySomeoneElse =
    !!selectedPlan &&
    selectedPlan.plan_format === "text" &&
    !!selectedPlan.last_edited_by &&
    selectedPlan.last_edited_by !== myUserId;

  const lastEditorLabel = useMemo(() => {
    if (!selectedPlan?.last_edited_by) return null;
    const u =
      userLabelsById[selectedPlan.last_edited_by] ??
      ({ id: selectedPlan.last_edited_by, email: null, full_name: null } as UserLabelRow);
    return labelForUser(u);
  }, [selectedPlan?.last_edited_by, userLabelsById]);

  return (
    <main className="stack">
      <style jsx global>{`
        .ProseMirror {
          outline: none !important;
          border: none !important;
          min-height: 256px;
        }
        .ProseMirror:focus {
          outline: none !important;
        }
        .ProseMirror p {
          margin: 0.35em 0;
        }
      `}</style>

      <ConfirmDeleteModal
        open={deleteOpen}
        name={deleteTarget?.title ?? selectedPlan?.title ?? "this plan"}
        onCancel={() => {
          setDeleteOpen(false);
          setDeleteTarget(null);
        }}
        onConfirm={() => {
          if (!deleteTarget) return;
          deleteSelectedPlanConfirmed(deleteTarget.id);
        }}
      />

      {!isAnyFullscreen ? (
        <>
          <div className="row-between">
            <div className="stack" style={{ gap: 6 }}>
              <h1 className="h1">My Plans</h1>
            </div>
            {status ? <span className="badge badge-pink">{status}</span> : null}
          </div>

          {!myProfile?.is_active ? (
            <div className="card">
              <div style={{ fontWeight: 800 }}>Not authorized</div>
              <div className="subtle" style={{ marginTop: 6 }}>
                You must have an active account to use this page.
              </div>
            </div>
          ) : (
            <>
              <div className="row" style={{ gap: 10 }}>
                <button className="btn btn-primary" onClick={createNewPlan} disabled={busy}>
                  + New Plan
                </button>
              </div>

              <div className="grid-sidebar">
                {/* Left list */}
                <div className="card">
                  <div className="row-between">
                    <div>
                      <div style={{ fontWeight: 800 }}>Your plans</div>
                    </div>
                    <span className="badge">{plans.length} total</span>
                  </div>

                  <div className="hr" />

                  <div className="stack" style={{ gap: 10 }}>
                    {plans.length === 0 ? (
                      <div className="subtle">(No plans yet)</div>
                    ) : (
                      plans.map((p) => {
                        const active = p.id === selectedPlanId;
                        const createdBy = createdByLabelForPlan(p);
                        const canDeleteThis = p.owner_user_id === myUserId;

                        return (
                          <div
                            key={p.id}
                            className="btn"
                            role="button"
                            tabIndex={0}
                            onClick={() => setSelectedPlanId(p.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setSelectedPlanId(p.id);
                              }
                            }}
                            style={{
                              textAlign: "left",
                              background: active ? "rgba(230,23,141,0.06)" : undefined,
                              boxShadow: active ? "inset 0 0 0 2px rgba(230,23,141,0.35)" : undefined,
                            }}
                          >
                            <div className="row-between" style={{ alignItems: "flex-start" }}>
                              <div style={{ fontWeight: 800, marginRight: 10 }}>{p.title}</div>

                              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                                {canDeleteThis ? (
                                  <TrashIconButton
                                    title="Delete plan"
                                    disabled={busy}
                                    onClick={() => {
                                      setDeleteTarget({ id: p.id, title: p.title });
                                      setDeleteOpen(true);
                                    }}
                                  />
                                ) : null}
                                <StatusBadge status={p.status} />
                              </div>
                            </div>

                            {showCreator ? (
                              <div className="subtle" style={{ marginTop: 6 }}>
                                Created by <strong>{createdBy}</strong>
                              </div>
                            ) : null}

                            <div className="subtle" style={{ marginTop: showCreator ? 4 : 6 }}>
                              Updated {new Date(p.updated_at).toLocaleString()}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Right editor */}
                <div className="card">
                  <div className="row-between" style={{ alignItems: "flex-start" }}>
                    <div className="stack" style={{ gap: 4 }}>
                      <div style={{ fontWeight: 900, fontSize: 16 }}>Editor</div>
                      <div className="subtle">
                        {selectedPlan ? (
                          <>
                            Status: <strong>{activeTab}</strong> {!canEdit ? "• Read-only" : ""}
                          </>
                        ) : (
                          "Select a plan to start editing."
                        )}
                      </div>
                    </div>

                    {selectedPlan ? (
                      <div className="row" style={{ gap: 8, alignItems: "center" }}>
                        {canDelete ? (
                          <TrashIconButton
                            title="Delete plan"
                            disabled={busy}
                            onClick={() => {
                              setDeleteTarget({ id: selectedPlan.id, title: selectedPlan.title });
                              setDeleteOpen(true);
                            }}
                          />
                        ) : null}
                        <StatusBadge status={selectedPlan.status} />
                      </div>
                    ) : null}
                  </div>

                  <div className="hr" />

                  {!selectedPlan ? (
                    <div className="subtle">(No plan selected)</div>
                  ) : (
                    <div className="stack">
                      {showCreator ? (
                        <div className="subtle">
                          Created by <strong>{createdByLabelForPlan(selectedPlan)}</strong>
                        </div>
                      ) : null}

                      <input
                        className="input"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        disabled={!canEdit || busy}
                        placeholder="Lesson plan title"
                      />

                      {selectedPlan.plan_format === "sheet" ? (
                        <div
                          style={{
                            border: "1px solid var(--border)",
                            borderRadius: 12,
                            overflow: "hidden",
                          }}
                        >
                          <div
                            className="row-between"
                            style={{
                              padding: 10,
                              borderBottom: "1px solid var(--border)",
                              gap: 10,
                            }}
                          >
                            <div style={{ fontWeight: 800 }}>
                              Sheet plan
                              <span className="subtle" style={{ marginLeft: 10, fontWeight: 500 }}>
                                (supports multiple tabs){sheetDirty ? " • unsaved" : ""}
                              </span>
                            </div>

                            <button className="btn" onClick={() => setSheetView(true)} disabled={busy}>
                              Full screen
                            </button>
                          </div>

                          <div style={{ height: 520, width: "100%" }}>
                            {sheetLoadedPlanId !== selectedPlanId ? (
                              <div className="subtle" style={{ padding: 12 }}>
                                Loading sheet…
                              </div>
                            ) : (
                              <FortuneWorkbook
                                key={workbookKey}
                                ref={workbookRef as any}
                                data={sheetDoc}
                                onOp={handleSheetOp}
                              />
                            )}
                          </div>
                        </div>
                      ) : (
                        <>
                          {textWasEditedBySomeoneElse ? (
                            <div
                              className="card"
                              style={{
                                borderRadius: 12,
                                padding: 12,
                                border: "1px solid rgba(255, 193, 7, 0.55)",
                                background: "rgba(255, 235, 59, 0.14)",
                              }}
                            >
                              <div style={{ fontWeight: 900 }}>Other-user edit detected</div>
                              <div className="subtle" style={{ marginTop: 6 }}>
                                Last edited by <strong>{lastEditorLabel ?? selectedPlan.last_edited_by}</strong>
                                {selectedPlan.last_edited_at ? (
                                  <>
                                    {" "}
                                    at <strong>{new Date(selectedPlan.last_edited_at).toLocaleString()}</strong>
                                  </>
                                ) : null}
                                .
                              </div>
                            </div>
                          ) : null}

                          <div className="stack" style={{ gap: 10 }}>
                            <div className="row-between" style={{ alignItems: "center", gap: 10 }}>
                              <div style={{ fontWeight: 900 }}>Text plan</div>
                              <button className="btn" onClick={() => setTextView(true)} disabled={busy}>
                                Full screen
                              </button>
                            </div>

                            <RichTextEditor
                              valueHtml={contentHtml}
                              onChangeHtml={setContentHtml}
                              disabled={!canEdit || busy}
                              highlightMode={textWasEditedBySomeoneElse}
                            />
                          </div>
                        </>
                      )}

                      <div className="row" style={{ flexWrap: "wrap" }}>
                        <button className="btn" onClick={savePlan} disabled={!canEdit || busy}>
                          Save
                        </button>
                        <button className="btn btn-primary" onClick={submitSelectedPlan} disabled={busy || !canEdit}>
                          Submit
                        </button>

                        {!canEdit ? <span className="subtle">You can only edit plans you created.</span> : null}
                      </div>

                      <div className="hr" />

                      <div>
                        <div className="row-between">
                          <div>
                            <div style={{ fontWeight: 900 }}>Supervisor comments</div>
                          </div>
                          <button className="btn" onClick={() => loadComments(selectedPlan.id)} disabled={commentsLoading}>
                            Refresh
                          </button>
                        </div>

                        {commentsLoading ? (
                          <div className="subtle" style={{ marginTop: 10 }}>
                            Loading comments…
                          </div>
                        ) : comments.length === 0 ? (
                          <div className="subtle" style={{ marginTop: 10 }}>
                            (No comments yet)
                          </div>
                        ) : (
                          <div className="stack" style={{ marginTop: 12 }}>
                            {comments.map((c) => (
                              <div key={c.id} className="card" style={{ borderRadius: 12 }}>
                                <div className="subtle">{new Date(c.created_at).toLocaleString()}</div>
                                <div style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{c.body}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </>
      ) : null}

      {/* Fullscreen: SHEET (no navbar offset) */}
      {isSheetView && selectedPlan ? (
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
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                {canDelete ? (
                  <TrashIconButton
                    title="Delete plan"
                    disabled={busy}
                    onClick={() => {
                      setDeleteTarget({ id: selectedPlan.id, title: selectedPlan.title });
                      setDeleteOpen(true);
                    }}
                  />
                ) : null}
                <span className="badge badge-pink">{selectedPlan.status.replaceAll("_", " ")}</span>
              </div>

              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={!canEdit || busy}
                placeholder="Lesson plan title"
                style={{ minWidth: 280 }}
              />

              <span className="subtle" style={{ alignSelf: "center" }}>
                {sheetDirty ? "Unsaved changes" : "All changes saved"}
              </span>
            </div>

            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <button className="btn" onClick={() => setSheetView(false)} disabled={busy}>
                Exit full screen
              </button>
              <button className="btn" onClick={savePlan} disabled={!canEdit || busy}>
                Save
              </button>
              <button className="btn btn-primary" onClick={submitSelectedPlan} disabled={!canEdit || busy}>
                Submit
              </button>
            </div>
          </div>

          <div
            style={{
              flex: 1,
              minHeight: 0,
              width: "100%",
              border: "1px solid var(--border)",
              borderRadius: 12,
              overflow: "visible",
            }}
          >
            {sheetLoadedPlanId !== selectedPlanId ? (
              <div className="subtle" style={{ padding: 12 }}>
                Loading sheet…
              </div>
            ) : (
              <div style={{ height: "100%", width: "100%" }}>
                <FortuneWorkbook
                  key={workbookKey + ":fullscreen"}
                  ref={workbookRef as any}
                  data={sheetDoc}
                  onOp={handleSheetOp}
                />
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* Fullscreen: TEXT (no navbar offset) */}
      {isTextView && selectedPlan ? (
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
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                {canDelete ? (
                  <TrashIconButton
                    title="Delete plan"
                    disabled={busy}
                    onClick={() => {
                      setDeleteTarget({ id: selectedPlan.id, title: selectedPlan.title });
                      setDeleteOpen(true);
                    }}
                  />
                ) : null}
                <span className="badge badge-pink">{selectedPlan.status.replaceAll("_", " ")}</span>
              </div>

              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={!canEdit || busy}
                placeholder="Lesson plan title"
                style={{ minWidth: 280 }}
              />
            </div>

            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <button className="btn" onClick={() => setTextView(false)} disabled={busy}>
                Exit full screen
              </button>
              <button className="btn" onClick={savePlan} disabled={!canEdit || busy}>
                Save
              </button>
              <button className="btn btn-primary" onClick={submitSelectedPlan} disabled={!canEdit || busy}>
                Submit
              </button>
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            {textWasEditedBySomeoneElse ? (
              <div
                className="card"
                style={{
                  borderRadius: 12,
                  padding: 12,
                  border: "1px solid rgba(255, 193, 7, 0.55)",
                  background: "rgba(255, 235, 59, 0.14)",
                  marginBottom: 10,
                }}
              >
                <div style={{ fontWeight: 900 }}>Other-user edit detected</div>
                <div className="subtle" style={{ marginTop: 6 }}>
                  Last edited by <strong>{lastEditorLabel ?? selectedPlan.last_edited_by}</strong>
                  {selectedPlan.last_edited_at ? (
                    <>
                      {" "}
                      at <strong>{new Date(selectedPlan.last_edited_at).toLocaleString()}</strong>
                    </>
                  ) : null}
                  .
                </div>
              </div>
            ) : null}

            <RichTextEditor
              valueHtml={contentHtml}
              onChangeHtml={setContentHtml}
              disabled={!canEdit || busy}
              highlightMode={textWasEditedBySomeoneElse}
              minBodyHeight={520}
            />
          </div>
        </div>
      ) : null}
    </main>
  );
}
