"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile, fetchActiveTeachers } from "@/lib/teachers";
import "@fortune-sheet/react/dist/index.css";
import SheetPlanEditor from "@/components/SheetPlanEditor";
import { useDebouncedAutosave } from "@/lib/useDebouncedAutosave";

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

type UserLabelRow = {
  id: string;
  email: string | null;
  full_name: string | null;
};

type QueuePlanRow = {
  id: string;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
  title: string;
  status: "draft" | "submitted" | "changes_requested" | "approved";
  owner_profile?: UserLabelRow | null;
};

type PlanDetailRow = QueuePlanRow & {
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

function StatusBadge({ status }: { status: QueuePlanRow["status"] }) {
  return <span className="badge badge-pink">{status.replaceAll("_", " ")}</span>;
}

function labelForUser(u: { full_name?: string | null; username?: string | null; id: string }) {
  const name = (u.full_name ?? "").trim();
  const username = (u.username ?? "").trim();
  if (name && username) return `${name} (${username})`;
  if (name) return name;
  if (username) return username;
  return u.id;
}

function statusRank(s: QueuePlanRow["status"]) {
  if (s === "submitted") return 0;
  if (s === "changes_requested") return 1;
  if (s === "approved") return 2;
  return 3;
}

async function attachOwnerProfiles(rows: QueuePlanRow[]): Promise<QueuePlanRow[]> {
  const uniqueIds = Array.from(new Set(rows.map((r) => r.owner_user_id).filter(Boolean)));
  if (uniqueIds.length === 0) return rows;

  const { data, error } = await supabase.from("user_profiles").select("id, email, full_name").in("id", uniqueIds);
  if (error) throw error;

  const map = new Map<string, UserLabelRow>();
  for (const r of (data ?? []) as UserLabelRow[]) map.set(r.id, r);

  return rows.map((p) => ({ ...p, owner_profile: map.get(p.owner_user_id) ?? null }));
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
  title: editTitle,
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
      title={editTitle}
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
        placeholder: "Write feedback or edits here…",
      }),
    ],
    content: valueHtml || "<p></p>",
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      lastHtmlFromEditorRef.current = html;
      onChangeHtml(html);
    },
  });

  // ensure editable toggles live
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  // keep in sync without fighting typing
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
        background: "#fff",
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

export default function ReviewQueuePage() {
  const AUTOSAVE_ENABLED = false; // TEMP: disable autosave (manual save only)

  const DEFAULT_SHEET_DOC = [{ name: "Sheet 1", row: 30, column: 20, celldata: [], config: {} }];

  const [status, setStatus] = useState("");
  const [me, setMe] = useState<TeacherProfile | null>(null);

  const [allowedTeacherIds, setAllowedTeacherIds] = useState<string[] | null>(null);

  const isTeacherAllowed = useCallback(
    (ownerUserId?: string | null) => {
      if (!ownerUserId) return false;
      if (me?.role === "admin") return true;
      if (me?.role === "supervisor") return !!allowedTeacherIds?.includes(ownerUserId);
      return false;
    },
    [me, allowedTeacherIds]
  );


  const [showAll, setShowAll] = useState(false);

  const [plans, setPlans] = useState<QueuePlanRow[]>([]);
  const [loadingPlans, setLoadingPlans] = useState(false);

  const [selectedPlanId, setSelectedPlanId] = useState("");
  const selectedPlan = useMemo(() => plans.find((p) => p.id === selectedPlanId) || null, [plans, selectedPlanId]);

  const [planDetail, setPlanDetail] = useState<PlanDetailRow | null>(null);
  const [planLoading, setPlanLoading] = useState(false);

  // Editable fields for supervisors/admins
  const [editTitle, setEditTitle] = useState("");
  const [editContentHtml, setEditContentHtml] = useState("<p></p>");
  const textDirtyRef = useRef(false);

  const [textDirty, setTextDirty] = useState(false);

  // Baselines to detect real edits
  const baselineTitleRef = useRef<string>("");
  const baselineContentHtmlRef = useRef<string>("<p></p>");

  // Sheet viewer state
  const [sheetDoc, setSheetDoc] = useState<any[]>(DEFAULT_SHEET_DOC);
  const latestSheetRef = useRef<any[]>(sheetDoc);
  const sheetApiRef = useRef<any>(null);
  const [sheetLoadedPlanId, setSheetLoadedPlanId] = useState<string>("");
  const [workbookKey, setWorkbookKey] = useState<string>("init");
  const [sheetDirty, setSheetDirty] = useState(false);
  const sheetDirtyRef = useRef(false);

  const canAutosave = !!selectedPlan && isTeacherAllowed(selectedPlan.owner_user_id);

  const sheetAutosave = useDebouncedAutosave({
    enabled: AUTOSAVE_ENABLED && (canAutosave && planDetail?.plan_format === "sheet"),
    delayMs: 2000,
    saveFn: async () => {
      if (!planDetail || planDetail.plan_format !== "sheet") return;
      if (!isTeacherAllowed(planDetail.owner_user_id)) return;
      if (!sheetDirtyRef.current) return;

      console.log("[autosave:review-queue] sheet save start", { planId: planDetail.id, dirty: true });

      const exportedRaw = (await exportSheetDocNow()) ?? exportSheetDoc();
      const exported = normalizeForFortune(exportedRaw, DEFAULT_SHEET_DOC);

      const payload: any = {
        title: editTitle,
        sheet_doc: deepJsonClone(exported),
        last_reviewed_at: new Date().toISOString(),
      };

      const { error } = await supabase.from("lesson_plans").update(payload).eq("id", planDetail.id);
      if (error) {
        console.error("[autosave:review-queue] sheet save error", error);
        throw error;
      }
      console.log("[autosave:review-queue] sheet save success", { planId: planDetail.id, sheets: Array.isArray(payload.sheet_doc) ? payload.sheet_doc.length : null });
      sheetDirtyRef.current = false;
      setSheetDirty(false);

      setSheetDoc(exported);
      setSheetDirty(false);
      baselineTitleRef.current = editTitle;
    },
  });

  const textAutosave = useDebouncedAutosave({
    enabled: AUTOSAVE_ENABLED && (canAutosave && planDetail?.plan_format === "text"),
    delayMs: 2000,
    saveFn: async () => {
      if (!planDetail || planDetail.plan_format !== "text") return;
      if (!isTeacherAllowed(planDetail.owner_user_id)) return;
      if (!textDirtyRef.current) return;

      const payload: any = {
        title: editTitle,
        content: editContentHtml,
        last_reviewed_at: new Date().toISOString(),
      };

      const { data: savedRow, error } = await supabase
        .from("lesson_plans")
        .update(payload)
        .eq("id", planDetail.id)
        .eq("updated_at", planDetail.updated_at)
        .select("updated_at, sheet_doc, content, title")
        .maybeSingle();

      if (error) throw error;
      if (!savedRow) {
        // Conflict: reload latest version so UI doesn't “revert”
        const { data: latest, error: rErr } = await supabase
          .from("lesson_plans")
          .select(
            "id, owner_user_id, created_at, updated_at, title, status, content, plan_format, sheet_doc, approved_by, approved_at, last_reviewed_at"
          )
          .eq("id", planDetail.id)
          .maybeSingle();
        if (rErr) throw rErr;

        if (latest) {
          setPlanDetail(latest as any);
          setEditTitle((latest as any).title ?? "");
          if ((latest as any).plan_format === "text") {
            setEditContentHtml(normalizeContentToHtml((latest as any).content ?? ""));
          } else {
            const normalized = normalizeForFortune((latest as any).sheet_doc, DEFAULT_SHEET_DOC);
            setSheetDoc(normalized);
            setSheetDirty(false);
            setWorkbookKey(`${planDetail.id}:${Date.now()}`);
            setSheetLoadedPlanId(planDetail.id);
          }
        }

        setStatus("⚠️ Save conflict detected. Reloaded latest version — please re-apply your last change and save again.");
        return;
      }

      textDirtyRef.current = false;
      baselineTitleRef.current = editTitle;
      baselineContentHtmlRef.current = editContentHtml;
    },
  });


  // Fullscreen overlays
  const [sheetView, setSheetView] = useState(false);
  const [textView, setTextView] = useState(false);

  const isSheetSelected = planDetail?.plan_format === "sheet";
  const isTextSelected = planDetail?.plan_format === "text";
  const isSheetView = sheetView && isSheetSelected;
  const isTextView = textView && isTextSelected;

  // ✅ Escape closes fullscreen
  useEffect(() => {
    if (!isSheetView && !isTextView) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (isSheetView) setSheetView(false);
      if (isTextView) setTextView(false);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSheetView, isTextView]);

  // comments
  const [comments, setComments] = useState<PlanCommentRow[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [newComment, setNewComment] = useState("");

  const [userLabelsById, setUserLabelsById] = useState<Record<string, UserLabelRow>>({});

  const isAdminOrSupervisor = !!me?.is_active && (me.role === "admin" || me.role === "supervisor");

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

  async function loadMe() {
    const p = await fetchMyProfile();
    setMe(p);
    return p;
  }

  async function refreshQueue(profileArg?: TeacherProfile | null, allowedIds?: string[] | null) {
    setLoadingPlans(true);
    try {
      const p = profileArg ?? me;
      const ids = allowedIds ?? allowedTeacherIds;

      let q = supabase
        .from("lesson_plans")
        .select("id, owner_user_id, created_at, updated_at, title, status")
        .order("updated_at", { ascending: false });

      // supervisors: filter to assigned teachers only
      if (p?.role === "supervisor") {
        if (!ids || ids.length === 0) {
          setPlans([]);
          setSelectedPlanId("");
          setPlanDetail(null);
          setComments([]);
          setStatus("");
          return;
        }
        q = q.in("owner_user_id", ids);
      }

      const { data, error } = await q;
      if (error) throw error;

      let rows = (data ?? []) as QueuePlanRow[];
      rows = await attachOwnerProfiles(rows);

      rows.sort((a, b) => {
        const ra = statusRank(a.status);
        const rb = statusRank(b.status);
        if (ra !== rb) return ra - rb;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });

      if (!showAll) {
        rows = rows.filter((p) => p.status === "submitted" || p.status === "changes_requested");
      }

      setPlans(rows);

      if (rows.length > 0) {
        const stillExists = rows.some((p) => p.id === selectedPlanId);
        if (!stillExists) setSelectedPlanId(rows[0].id);
      } else {
        setSelectedPlanId("");
        setPlanDetail(null);
        setComments([]);
      }

      setStatus("");
    } catch (e: any) {
      setStatus("Error loading review queue: " + (e?.message ?? "unknown"));
      setPlans([]);
    } finally {
      setLoadingPlans(false);
    }
  }

  async function loadPlan(planId: string, opts?: { preserveView?: boolean }) {
    sheetAutosave.cancel();
    textAutosave.cancel();

    setPlanLoading(true);
    try {
      const { data, error } = await supabase
        .from("lesson_plans")
        .select(
          "id, owner_user_id, created_at, updated_at, title, status, content, plan_format, sheet_doc, approved_by, approved_at, last_reviewed_at"
        )
        .eq("id", planId)
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        setStatus("Plan not found (or you don't have access).");
        setPlanDetail(null);
        return;
      }

      const base = (data as any) as PlanDetailRow;
      const ownerProfile = plans.find((p) => p.id === planId)?.owner_profile ?? null;

      const merged: PlanDetailRow = { ...base, owner_profile: ownerProfile };
      setPlanDetail(merged);

      // close any fullscreen when switching plans (unless preserving view)
      if (!opts?.preserveView) {
        setSheetView(false);
        setTextView(false);
      }

      // Seed editable UI state
      const seededTitle = merged.title ?? "";
      const seededContent = normalizeContentToHtml(merged.content ?? "");

      setEditTitle(seededTitle);
      setEditContentHtml(seededContent);
      setTextDirty(false);

      baselineTitleRef.current = seededTitle;
      baselineContentHtmlRef.current = seededContent;

      // Seed sheet UI state
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

  // ----- Supervisor edit support -----

  const exportSheetDoc = useCallback((): any[] => {
    // Prefer reading directly from the SheetPlanEditor api (more reliable in production builds)
    try {
      const api: any = sheetApiRef.current as any;
      const snap = api?.getSnapshot?.();
      if (Array.isArray(snap) && snap.length > 0) return deepJsonClone(snap);
    } catch {
      // ignore
    }
    return deepJsonClone(latestSheetRef.current ?? sheetDoc);
  }, [sheetDoc]);

  const exportSheetDocNow = async (): Promise<any[] | null> => {
    try {
      const api: any = sheetApiRef.current as any;
      await api?.commitPendingEdits?.();
      const snap = api?.getSnapshot?.();
      if (Array.isArray(snap) && snap.length > 0) return deepJsonClone(snap);
    } catch {
      // ignore
    }
    try {
      const fallback = exportSheetDoc();
      return Array.isArray(fallback) && fallback.length > 0 ? fallback : null;
    } catch {
      return null;
    }
  };


  async function autoCommentSupervisorEdit(planId: string, planFormat: "text" | "sheet") {
    try {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData.user) throw new Error("Not signed in");

      const actor =
        me
          ? labelForUser({
              id: userData.user.id,
              full_name: (me as any).full_name ?? null,
              username: (me as any).email ?? null,
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

    if (planDetail.plan_format === "sheet") {
      return titleChanged || sheetDirty;
    }

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
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

        let exportedRaw = (await exportSheetDocNow()) ?? exportSheetDoc();
        const api = sheetApiRef.current;
        if (api?.getAllSheets) {
          try {
            exportedRaw = deepJsonClone(api.getAllSheets());
          } catch (err) {
            console.warn("[save:review-queue] getAllSheets failed; using latest snapshot ref", err);
          }
        }

        const exported = normalizeForFortune(exportedRaw, DEFAULT_SHEET_DOC);
        payload.sheet_doc = deepJsonClone(exported);

        setSheetDoc(exported);
        setSheetDirty(false);

        console.log("REVIEW SAVE sheet_doc sheets:", exported.length);
        console.log("REVIEW SAVE approx filled cells:", countFilledCellsInDoc(exported));
      }

      const { data: savedRow, error } = await supabase
        .from("lesson_plans")
        .update(payload)
        .eq("id", planDetail.id)
        .eq("updated_at", planDetail.updated_at)
        .select("updated_at, sheet_doc, content, title")
        .maybeSingle();

      if (error) throw error;
      if (!savedRow) {
        // Conflict: reload latest version so UI doesn't “revert”
        const { data: latest, error: rErr } = await supabase
          .from("lesson_plans")
          .select(
            "id, owner_user_id, created_at, updated_at, title, status, content, plan_format, sheet_doc, approved_by, approved_at, last_reviewed_at"
          )
          .eq("id", planDetail.id)
          .maybeSingle();
        if (rErr) throw rErr;

        if (latest) {
          setPlanDetail(latest as any);
          setEditTitle((latest as any).title ?? "");
          if ((latest as any).plan_format === "text") {
            setEditContentHtml(normalizeContentToHtml((latest as any).content ?? ""));
          } else {
            const normalized = normalizeForFortune((latest as any).sheet_doc, DEFAULT_SHEET_DOC);
            setSheetDoc(normalized);
            setSheetDirty(false);
            setWorkbookKey(`${planDetail.id}:${Date.now()}`);
            setSheetLoadedPlanId(planDetail.id);
          }
        }

        setStatus("⚠️ Save conflict detected. Reloaded latest version — please re-apply your last change and save again.");
        return;
      }

      await autoCommentSupervisorEdit(planDetail.id, planDetail.plan_format);

      baselineTitleRef.current = editTitle;
      if (planDetail.plan_format === "text") {
        baselineContentHtmlRef.current = editContentHtml;
      }

      setTextDirty(false);
      setStatus("✅ Saved edits.");
      await refreshQueue();
      await loadPlan(planDetail.id, { preserveView: true });
      await refreshComments(planDetail.id);
    } catch (e: any) {
      setStatus("Save edits error: " + (e?.message ?? "unknown"));
    }
  }

  // ----- Status actions -----

  async function approvePlan(planId: string) {
    setStatus("Approving...");
    try {
      const { error } = await supabase.rpc("approve_lesson_plan", { plan_uuid: planId });
      if (error) throw error;

      setStatus("✅ Approved.");
      await refreshQueue();
      await loadPlan(planId);
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
      await refreshQueue();
      await loadPlan(planId);
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

      if (profile.role === "admin") {
        setAllowedTeacherIds(null); // null = no filter
        await refreshQueue(profile, null);
      } else {
        const list = await fetchActiveTeachers(); // for supervisors this is already filtered correctly
        const ids = list.map((t) => t.id);
        setAllowedTeacherIds(ids);
        await refreshQueue(profile, ids);
      }

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
    refreshQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll, isAdminOrSupervisor, allowedTeacherIds, me?.role]);

  useEffect(() => {
    if (!selectedPlanId) return;
    // switching selection closes fullscreen already in loadPlan, but close immediately too
    setSheetView(false);
    setTextView(false);

    loadPlan(selectedPlanId);
    refreshComments(selectedPlanId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlanId]);

  useEffect(() => {
    if (!isAdminOrSupervisor) return;

    const ch = supabase
      .channel("review-queue-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "lesson_plans" }, () => {
        refreshQueue();
        if (selectedPlanId) loadPlan(selectedPlanId);
      })
      .subscribe();

    const ch2 = supabase
      .channel("review-queue-comments-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "lesson_plan_comments" }, (payload) => {
        const planId = (payload as any)?.new?.plan_id || (payload as any)?.old?.plan_id;
        if (planId && planId === selectedPlanId) refreshComments(selectedPlanId);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
      supabase.removeChannel(ch2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdminOrSupervisor, selectedPlanId]);

  if (!isAdminOrSupervisor) {
    return (
      <main className="stack">
        <div className="row-between">
          <div className="stack" style={{ gap: 6 }}>
            <h1 className="h1">Review Queue</h1>
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

  const selectedOwnerLabel = planDetail?.owner_profile ? labelForUser(planDetail.owner_profile) : planDetail?.owner_user_id ?? "";

  const showBaseGrid = !(isSheetView || isTextView);
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
          <h1 className="h1">Review Queue</h1>
        </div>
        {status ? <span className="badge badge-pink">{status}</span> : null}
      </div>

      <div className="card">
        <div className="row-between">
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => refreshQueue()} disabled={loadingPlans}>
              Refresh
            </button>

            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              <span className="subtle">Show all statuses (otherwise only needs-review)</span>
            </label>
          </div>

          <span className="badge">{plans.length} plans</span>
        </div>
      </div>

      {showBaseGrid ? (
        <div className="grid-sidebar">
          {/* Left list */}
          <div className="card">
            <div style={{ fontWeight: 900 }}>Queue</div>

            <div className="hr" />

            {loadingPlans ? (
              <div className="subtle">Loading…</div>
            ) : plans.length === 0 ? (
              <div className="subtle">(No plans in queue)</div>
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                {plans.map((p) => {
                  const active = p.id === selectedPlanId;
                  const ownerLabel = p.owner_profile ? labelForUser(p.owner_profile) : p.owner_user_id;

                  return (
                    <button
                      key={p.id}
                      className="btn"
                      onClick={() => setSelectedPlanId(p.id)}
                      style={{
                        textAlign: "left",
                        background: active ? "rgba(230,23,141,0.06)" : undefined,
                        boxShadow: active ? "inset 0 0 0 2px rgba(230,23,141,0.35)" : undefined,
                      }}
                    >
                      <div className="row-between" style={{ alignItems: "flex-start" }}>
                        <div style={{ fontWeight: 900 }}>{p.title}</div>
                        <StatusBadge status={p.status} />
                      </div>

                      <div className="subtle" style={{ marginTop: 6 }}>
                        Teacher: <strong>{ownerLabel}</strong>
                      </div>

                      <div className="subtle" style={{ marginTop: 4 }}>
                        Updated {new Date(p.updated_at).toLocaleString()}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right panel */}
          <div className="card">
            {!selectedPlanId ? (
              <div className="subtle">(Select a plan from the queue)</div>
            ) : (
              <>
                <div className="row-between">
                  <div className="stack" style={{ gap: 4 }}>
                    <div style={{ fontWeight: 950, fontSize: 16 }}>{planDetail?.title ?? "Plan"}</div>
                    <div className="subtle">
                      Teacher: <strong>{selectedOwnerLabel}</strong>
                      {planDetail ? (
                        <>
                          {" • "}Status: <strong>{planDetail.status.replaceAll("_", " ")}</strong>
                          {" • "}Format: <strong>{planDetail.plan_format}</strong>
                        </>
                      ) : null}
                    </div>
                  </div>

                  <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
                    <button className="btn" onClick={() => requestChanges(selectedPlanId)}>
                      Request changes
                    </button>
                    <button className="btn btn-primary" onClick={() => approvePlan(selectedPlanId)}>
                      Approve
                    </button>
                  </div>
                </div>

                <div className="hr" />

                <div className="grid-2">
                  {/* CONTENT / EDITOR */}
                  <div className="card" style={{ borderRadius: 12 }}>
                    <div className="row-between" style={{ alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 900 }}>Content</div>
                      </div>

                      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                        <button className="btn" onClick={saveSupervisorEdits} disabled={saveDisabled}>
                          Save edits
                        </button>

                        {planDetail?.plan_format === "sheet" ? (
                          <button className="btn" onClick={() => setSheetView(true)} disabled={planLoading || sheetAutosave.isSaving || textAutosave.isSaving}>
                            Full screen
                          </button>
                        ) : planDetail?.plan_format === "text" ? (
                          <button className="btn" onClick={() => setTextView(true)} disabled={planLoading || sheetAutosave.isSaving || textAutosave.isSaving}>
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
                      <div className="subtle">(No plan selected)</div>
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
                          <>
                            <div className="subtle">{hasSupervisorEdits() ? "Unsaved changes" : "All changes saved"}</div>

                            <RichTextEditor
                              valueHtml={editContentHtml}
                              onChangeHtml={(html) => {
                                setEditContentHtml(html);
                                setTextDirty(true);
                              }}
                              disabled={false}
                            />
                          </>
                        ) : (
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
                                <SheetPlanEditor
                                key={workbookKey}
                                workbookKey={workbookKey}
                                apiRef={sheetApiRef}
                                value={sheetDoc}
                                height={520}
                                onChange={(next) => {
                                  // IMPORTANT: do NOT setSheetDoc(next) here.
                                  latestSheetRef.current = next;
                                  sheetDirtyRef.current = true;
                                  setSheetDirty(true);
                                  if (AUTOSAVE_ENABLED) sheetAutosave.schedule();
                                }}
                              />
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* COMMENTS */}
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
                      <button className="btn btn-primary" onClick={() => addComment(selectedPlanId)}>
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
                            const author =
                              userLabelsById[c.author_user_id] ?? ({ id: c.author_user_id, email: null, full_name: null } as UserLabelRow);

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
              </>
            )}
          </div>
        </div>
      ) : null}

      {/* Fullscreen: SHEET (no navbar offset) */}
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

              <span className="subtle" style={{ alignSelf: "center" }}>
                {hasSupervisorEdits() ? "Unsaved changes" : "All changes saved"}
              </span>
            </div>

            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <button className="btn" onClick={() => setSheetView(false)} disabled={planLoading || sheetAutosave.isSaving || textAutosave.isSaving}>
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
            {sheetLoadedPlanId !== planDetail.id ? (
              <div className="subtle" style={{ padding: 12 }}>
                Loading sheet…
              </div>
            ) : (
              <div style={{ height: "100%", width: "100%" }}>
                <SheetPlanEditor
                key={workbookKey + ":fullscreen"}
                workbookKey={workbookKey + ":fullscreen"}
                apiRef={sheetApiRef}
                value={sheetDoc}
                height={"100%"}
                onChange={(next) => {
                  // IMPORTANT: do NOT setSheetDoc(next) here.
                  latestSheetRef.current = next;
                  sheetDirtyRef.current = true;
                  setSheetDirty(true);
                  if (AUTOSAVE_ENABLED) sheetAutosave.schedule();
                }}
              />
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* Fullscreen: TEXT (no navbar offset) */}
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

              <span className="subtle" style={{ alignSelf: "center" }}>
                {hasSupervisorEdits() ? "Unsaved changes" : "All changes saved"}
              </span>
            </div>

            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <button className="btn" onClick={() => setTextView(false)} disabled={planLoading || sheetAutosave.isSaving || textAutosave.isSaving}>
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