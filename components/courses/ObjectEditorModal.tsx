"use client";

import { useState } from "react";
import { ObjectType, QuizQuestion, uploadCourseMedia } from "@/lib/courses";
import RichTextEditor from "./RichTextEditor";

export type ObjectDraft = {
  type: ObjectType;
  title: string;
  content: Record<string, any>;
  settings: Record<string, any>;
};

const uid = () => Math.random().toString(36).slice(2, 10);

export default function ObjectEditorModal({
  draft,
  onCancel,
  onSave,
}: {
  draft: ObjectDraft;
  onCancel: () => void;
  onSave: (d: ObjectDraft) => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const [content, setContent] = useState<Record<string, any>>(draft.content ?? {});
  const [settings, setSettings] = useState<Record<string, any>>(draft.settings ?? {});
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patchContent(p: Record<string, any>) { setContent((c) => ({ ...c, ...p })); }
  function patchSettings(p: Record<string, any>) { setSettings((s) => ({ ...s, ...p })); }

  async function upload(file: File, contentKey = "url") {
    setUploading(true);
    setError(null);
    try {
      const { url, name } = await uploadCourseMedia(file);
      patchContent({ [contentKey]: url, name });
    } catch (e: any) {
      setError("Upload failed: " + (e?.message ?? "unknown"));
    } finally {
      setUploading(false);
    }
  }

  function validate(): string | null {
    if (["image", "video", "pdf", "file", "audio"].includes(draft.type) && !content.url) return "Upload a file first.";
    if (["youtube", "link"].includes(draft.type) && !content.url) return "Enter a URL.";
    if (draft.type === "quiz") {
      const qs = (content.questions ?? []) as QuizQuestion[];
      if (qs.length === 0) return "Add at least one question.";
      for (const q of qs) {
        if (!q.prompt.trim()) return "Every question needs text.";
        if (q.answers.length < 2) return "Each question needs at least 2 answers.";
        if (!q.answers.some((a) => a.correct)) return "Mark a correct answer for every question.";
      }
    }
    return null;
  }

  function save() {
    const v = validate();
    if (v) { setError(v); return; }
    // Text titles are optional (the section header is often enough); other
    // object types fall back to their type label so the list stays readable.
    const finalTitle = draft.type === "text" ? title.trim() : (title.trim() || defaultTitle(draft.type));
    onSave({ type: draft.type, title: finalTitle, content, settings });
  }

  return (
    <div onMouseDown={(e) => { if (e.currentTarget === e.target) onCancel(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="card" style={{ width: "100%", maxWidth: 640, maxHeight: "88vh", overflowY: "auto" }}>
        <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 4 }}>{typeLabel(draft.type)}</div>

        {draft.type !== "image" && (
          <>
            <label style={lbl}>{draft.type === "quiz" ? "Quiz name" : draft.type === "link" ? "Label" : draft.type === "text" ? "Title (optional)" : "Title"}</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={draft.type === "text" ? "Leave blank to use the section header" : "Type a title"} autoFocus />
          </>
        )}

        {draft.type === "text" && (
          <>
            <label style={lbl}>Content</label>
            <RichTextEditor value={content.html ?? ""} onChange={(html) => patchContent({ html })} />
            <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
              <Check checked={!!settings.requireScroll} onChange={(v) => patchSettings({ requireScroll: v })}
                label="For long text, users must scroll to the bottom to mark as completed" />
              <Check checked={settings.confirmLabel != null} onChange={(v) => patchSettings({ confirmLabel: v ? (settings.confirmLabel || "I understand") : null })}
                label="Add a confirmation button" />
              {settings.confirmLabel != null && (
                <input className="input" value={settings.confirmLabel} onChange={(e) => patchSettings({ confirmLabel: e.target.value })} placeholder="I understand" style={{ maxWidth: 240 }} />
              )}
              <Check checked={settings.allowCopy !== false} onChange={(v) => patchSettings({ allowCopy: v })} label="Users can copy text to clipboard" />
            </div>
          </>
        )}

        {draft.type === "image" && (
          <>
            <label style={lbl}>Image</label>
            <UploadRow accept="image/*" uploading={uploading} onFile={(f) => upload(f)} hasFile={!!content.url} />
            {content.url && <img src={content.url} alt="" style={{ maxWidth: "100%", borderRadius: 8, marginTop: 10 }} />}
            <label style={lbl}>Caption (optional)</label>
            <input className="input" value={content.caption ?? ""} onChange={(e) => patchContent({ caption: e.target.value })} />
          </>
        )}

        {(draft.type === "video" || draft.type === "pdf" || draft.type === "audio" || draft.type === "file") && (
          <>
            <label style={lbl}>Upload {draft.type}</label>
            <UploadRow accept={acceptFor(draft.type)} uploading={uploading} onFile={(f) => upload(f)} hasFile={!!content.url} />
            <div className="subtle" style={{ fontSize: 12, margin: "10px 0 4px" }}>…or paste a direct URL</div>
            <input className="input" value={content.url ?? ""} onChange={(e) => patchContent({ url: e.target.value })} placeholder="https://…" />
          </>
        )}

        {draft.type === "youtube" && (
          <>
            <label style={lbl}>YouTube URL</label>
            <input className="input" value={content.url ?? ""} onChange={(e) => patchContent({ url: e.target.value })} placeholder="https://youtube.com/watch?v=…" />
          </>
        )}

        {draft.type === "link" && (
          <>
            <label style={lbl}>URL</label>
            <input className="input" value={content.url ?? ""} onChange={(e) => patchContent({ url: e.target.value })} placeholder="https://…" />
          </>
        )}

        {draft.type === "quiz" && (
          <QuizEditor
            questions={(content.questions ?? []) as QuizQuestion[]}
            onChange={(questions) => patchContent({ questions })}
            settings={settings}
            onSettings={patchSettings}
          />
        )}

        {error && <div style={{ color: "#991b1b", fontWeight: 600, fontSize: 13, marginTop: 12 }}>{error}</div>}

        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={uploading}>{uploading ? "Uploading…" : "Confirm"}</button>
        </div>
      </div>
    </div>
  );
}

function QuizEditor({
  questions, onChange, settings, onSettings,
}: {
  questions: QuizQuestion[];
  onChange: (q: QuizQuestion[]) => void;
  settings: Record<string, any>;
  onSettings: (p: Record<string, any>) => void;
}) {
  function addQ() {
    onChange([...questions, { id: uid(), prompt: "", answers: [{ id: uid(), text: "", correct: true }, { id: uid(), text: "", correct: false }] }]);
  }
  function patchQ(qi: number, p: Partial<QuizQuestion>) {
    onChange(questions.map((q, i) => (i === qi ? { ...q, ...p } : q)));
  }
  function delQ(qi: number) { onChange(questions.filter((_, i) => i !== qi)); }
  function moveQ(qi: number, dir: -1 | 1) {
    const j = qi + dir;
    if (j < 0 || j >= questions.length) return;
    const next = [...questions];
    [next[qi], next[j]] = [next[j], next[qi]];
    onChange(next);
  }
  function addA(qi: number) {
    patchQ(qi, { answers: [...questions[qi].answers, { id: uid(), text: "", correct: false }] });
  }
  function patchA(qi: number, ai: number, text: string) {
    patchQ(qi, { answers: questions[qi].answers.map((a, i) => (i === ai ? { ...a, text } : a)) });
  }
  function setCorrect(qi: number, ai: number) {
    patchQ(qi, { answers: questions[qi].answers.map((a, i) => ({ ...a, correct: i === ai })) });
  }
  function delA(qi: number, ai: number) {
    if (questions[qi].answers.length <= 2) return;
    patchQ(qi, { answers: questions[qi].answers.filter((_, i) => i !== ai) });
  }

  return (
    <div style={{ marginTop: 8 }}>
      {questions.map((q, qi) => (
        <div key={q.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div className="row-between">
            <div className="row" style={{ gap: 6, alignItems: "center" }}>
              <span style={{ fontWeight: 800, color: "#6b7280" }}>Q{qi + 1}</span>
              <button className="btn" title="Move up" onClick={() => moveQ(qi, -1)} disabled={qi === 0} style={{ padding: "2px 8px", fontSize: 12 }}>↑</button>
              <button className="btn" title="Move down" onClick={() => moveQ(qi, 1)} disabled={qi === questions.length - 1} style={{ padding: "2px 8px", fontSize: 12 }}>↓</button>
            </div>
            <button className="btn" onClick={() => delQ(qi)} style={{ padding: "2px 8px", fontSize: 12, color: "#991b1b" }}>🗑</button>
          </div>
          <textarea className="input" value={q.prompt} onChange={(e) => patchQ(qi, { prompt: e.target.value })} placeholder="Question text" rows={2} style={{ marginTop: 6, resize: "vertical" }} />
          <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
            {q.answers.map((a, ai) => (
              <div key={a.id} className="row" style={{ gap: 8, alignItems: "center" }}>
                <button title="Mark correct" onClick={() => setCorrect(qi, ai)}
                  style={{ width: 22, height: 22, borderRadius: 999, border: "2px solid", borderColor: a.correct ? "#16a34a" : "#d1d5db", background: a.correct ? "#16a34a" : "white", color: "white", cursor: "pointer", flexShrink: 0 }}>
                  {a.correct ? "✓" : ""}
                </button>
                <input className="input" value={a.text} onChange={(e) => patchA(qi, ai, e.target.value)} placeholder={`Answer ${ai + 1}`} />
                <button className="btn" onClick={() => delA(qi, ai)} disabled={q.answers.length <= 2} style={{ padding: "2px 8px", fontSize: 12 }}>✕</button>
              </div>
            ))}
            <button className="btn" onClick={() => addA(qi)} style={{ alignSelf: "flex-start", padding: "4px 10px", fontSize: 12 }}>+ Add answer</button>
          </div>
        </div>
      ))}
      <button className="btn btn-primary" onClick={addQ} style={{ marginBottom: 16 }}>+ Add question</button>

      <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 12 }}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>Quiz settings</div>
        <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 14 }}>Pass score</span>
          <input className="input" type="number" min={0} max={100} value={settings.passScore ?? 100}
            onChange={(e) => onSettings({ passScore: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} style={{ width: 80 }} />
          <span className="subtle" style={{ fontSize: 13 }}>/ 100</span>
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          <Check checked={settings.showScore !== false} onChange={(v) => onSettings({ showScore: v })} label="Show users their final score" />
          <Check checked={settings.feedbackPerQuestion !== false} onChange={(v) => onSettings({ feedbackPerQuestion: v })} label="Tell users right/wrong after each question" />
          <Check checked={settings.showCorrect !== false} onChange={(v) => onSettings({ showCorrect: v })} label="If incorrect, show the correct answer" />
          <Check checked={!!settings.randomize} onChange={(v) => onSettings({ randomize: v })} label="Randomize question order" />
        </div>
      </div>
    </div>
  );
}

function UploadRow({ accept, uploading, onFile, hasFile }: { accept: string; uploading: boolean; onFile: (f: File) => void; hasFile: boolean }) {
  return (
    <label className="btn" style={{ display: "inline-flex", cursor: uploading ? "default" : "pointer" }}>
      {uploading ? "Uploading…" : hasFile ? "Replace file" : "Choose file"}
      <input type="file" accept={accept} style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f); }} />
    </label>
  );
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="row" style={{ gap: 8, alignItems: "flex-start", cursor: "pointer", fontSize: 14 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
      <span>{label}</span>
    </label>
  );
}

const lbl: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "#374151", margin: "14px 0 6px" };

function typeLabel(t: ObjectType) {
  return ({ text: "Text", image: "Image", video: "Video", pdf: "PDF", youtube: "YouTube", file: "File", link: "Link", audio: "Audio", quiz: "Quiz" } as Record<ObjectType, string>)[t];
}
function defaultTitle(t: ObjectType) { return typeLabel(t); }
function acceptFor(t: ObjectType) {
  return t === "video" ? "video/*" : t === "audio" ? "audio/*" : t === "pdf" ? "application/pdf" : "*/*";
}
