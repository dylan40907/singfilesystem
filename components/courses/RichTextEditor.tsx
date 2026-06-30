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
  const [uploading, setUploading] = useState(false);

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

  function addLink() {
    const url = prompt("Link URL");
    if (url) exec("createLink", url);
  }

  return (
    <div style={{ border: "1.5px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: 6, borderBottom: "1px solid #e5e7eb", background: "#f9fafb" }}>
        <ToolBtn onClick={() => exec("formatBlock", "<h2>")} title="Heading">H</ToolBtn>
        <ToolBtn onClick={() => exec("formatBlock", "<p>")} title="Body">¶</ToolBtn>
        <ToolBtn onClick={() => exec("bold")} title="Bold"><b>B</b></ToolBtn>
        <ToolBtn onClick={() => exec("italic")} title="Italic"><i>I</i></ToolBtn>
        <ToolBtn onClick={() => exec("underline")} title="Underline"><u>U</u></ToolBtn>
        <ToolBtn onClick={() => exec("insertUnorderedList")} title="Bullet list">•≡</ToolBtn>
        <ToolBtn onClick={() => exec("insertOrderedList")} title="Numbered list">1≡</ToolBtn>
        <ToolBtn onClick={addLink} title="Link">🔗</ToolBtn>
        <label style={{ ...btnStyle, cursor: uploading ? "default" : "pointer" }} title="Insert image">
          {uploading ? "…" : "🖼"}
          <input type="file" accept="image/*" style={{ display: "none" }} onChange={onPickImage} />
        </label>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        style={{ minHeight: 160, maxHeight: 360, overflowY: "auto", padding: "12px 14px", fontSize: 14, lineHeight: 1.5, outline: "none" }}
      />
    </div>
  );
}

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
