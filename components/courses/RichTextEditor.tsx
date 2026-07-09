"use client";

import { useEffect, useRef, useState } from "react";
import { uploadCourseMedia } from "@/lib/courses";

/**
 * Lightweight rich-text editor (contentEditable + execCommand) — enough for
 * headers, body text, bold/italic/lists/links and inline images (uploaded to the
 * course-media bucket). Emits HTML via onChange.
 */
export default function RichTextEditor({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const savedRange = useRef<Range | null>(null);
  const [uploading, setUploading] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  // Seed once; afterwards the DOM is the source of truth (avoids cursor jumps).
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value) ref.current.innerHTML = value || "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function exec(cmd: string, arg?: string) {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    emit();
  }

  function emit() {
    if (ref.current) onChange(ref.current.innerHTML);
  }

  function saveSelection() {
    const sel = window.getSelection();
    savedRange.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  }
  function restoreSelection() {
    if (!savedRange.current) return;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(savedRange.current);
  }

  // Apply a font size to the selection. execCommand("fontSize") only accepts the
  // legacy 1–7 scale, so we tag with size 7 then rewrite those <font> nodes to an
  // exact CSS px value.
  function applyFontSize(px: string) {
    if (!px) return;
    ref.current?.focus();
    restoreSelection();
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand("fontSize", false, "7");
    ref.current?.querySelectorAll('font[size="7"]').forEach((f) => {
      f.removeAttribute("size");
      (f as HTMLElement).style.fontSize = px;
    });
    emit();
  }

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const { url } = await uploadCourseMedia(file);
      ref.current?.focus();
      document.execCommand("insertHTML", false, `<img src="${url}" style="max-width:100%;border-radius:8px;margin:8px 0;" />`);
      emit();
    } catch (err: any) {
      alert("Image upload failed: " + (err?.message ?? "unknown"));
    } finally {
      setUploading(false);
    }
  }

  function openLink() {
    saveSelection();
    setLinkUrl("");
    setLinkOpen(true);
  }
  function confirmLink() {
    const url = linkUrl.trim();
    setLinkOpen(false);
    if (!url) return;
    ref.current?.focus();
    restoreSelection();
    document.execCommand("createLink", false, url);
    emit();
  }

  return (
    <div style={{ border: "1.5px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: 6, borderBottom: "1px solid #e5e7eb", background: "#f9fafb" }}>
        <ToolBtn onClick={() => exec("formatBlock", "<h2>")} title="Heading">H</ToolBtn>
        <ToolBtn onClick={() => exec("formatBlock", "<p>")} title="Body">¶</ToolBtn>
        <ToolBtn onClick={() => exec("bold")} title="Bold"><b>B</b></ToolBtn>
        <ToolBtn onClick={() => exec("italic")} title="Italic"><i>I</i></ToolBtn>
        <ToolBtn onClick={() => exec("underline")} title="Underline"><u>U</u></ToolBtn>
        <select
          title="Font size"
          value=""
          onMouseDown={saveSelection}
          onChange={(e) => { applyFontSize(e.target.value); e.currentTarget.selectedIndex = 0; }}
          style={{ ...btnStyle, cursor: "pointer", minWidth: 74, padding: "0 6px" }}
        >
          <option value="">Size</option>
          {FONT_SIZES.map((s) => <option key={s.px} value={s.px}>{s.label}</option>)}
        </select>
        <ToolBtn onClick={() => exec("insertUnorderedList")} title="Bullet list">•≡</ToolBtn>
        <ToolBtn onClick={() => exec("insertOrderedList")} title="Numbered list">1≡</ToolBtn>
        <ToolBtn onClick={openLink} title="Link">🔗</ToolBtn>
        <label style={{ ...btnStyle, cursor: uploading ? "default" : "pointer" }} title="Insert image">
          {uploading ? "…" : "🖼"}
          <input type="file" accept="image/*" style={{ display: "none" }} onChange={onPickImage} />
        </label>
      </div>
      {/* Make links look like links inside the editor (matches how they render
          when the course is taken). Scoped to .rte-content so it won't leak. */}
      <style>{`
        .rte-content a { color: #2563eb; text-decoration: underline; cursor: pointer; }
        .rte-content h2 { font-size: 1.4em; font-weight: 800; margin: 0.4em 0; }
        .rte-content img { max-width: 100%; }
      `}</style>
      <div
        ref={ref}
        className="rte-content"
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        style={{ minHeight: 160, maxHeight: 360, overflowY: "auto", padding: "12px 14px", fontSize: 14, lineHeight: 1.5, outline: "none" }}
      />

      {linkOpen && (
        <div onMouseDown={(e) => { if (e.currentTarget === e.target) setLinkOpen(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div className="card" style={{ width: "100%", maxWidth: 400 }}>
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10 }}>Add link</div>
            <input className="input" autoFocus value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") confirmLink(); }} placeholder="https://…" />
            <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button className="btn" onClick={() => setLinkOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmLink}>Add link</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const FONT_SIZES: { label: string; px: string }[] = [
  { label: "Small", px: "12px" },
  { label: "Normal", px: "16px" },
  { label: "Large", px: "20px" },
  { label: "X-Large", px: "26px" },
  { label: "Huge", px: "34px" },
];

const btnStyle: React.CSSProperties = {
  minWidth: 32, height: 30, display: "inline-flex", alignItems: "center", justifyContent: "center",
  border: "1px solid #e5e7eb", borderRadius: 7, background: "white", fontSize: 13, padding: "0 8px",
};

function ToolBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick} style={{ ...btnStyle, cursor: "pointer" }}>
      {children}
    </button>
  );
}
