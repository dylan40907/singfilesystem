"use client";

import { useEffect, useRef, useState } from "react";
import { uploadCourseMedia } from "@/lib/courses";

/**
 * Lightweight rich-text editor (contentEditable + execCommand) — enough for
 * headers, body text, bold/italic/lists/links and inline images. Emits HTML via
 * onChange.
 *
 * Images go to the course-media bucket unless `upload` says otherwise, and
 * `tokens` adds a menu of locked chips (used by the sales email editor, where a
 * placeholder like the meeting link must survive editing intact).
 */
export default function RichTextEditor({
  value,
  onChange,
  upload,
  tokens,
  minHeight = 160,
  maxHeight = 360,
}: {
  value: string;
  onChange: (html: string) => void;
  /** Where inserted images are stored. Defaults to the course-media bucket. */
  upload?: (file: File) => Promise<{ url: string }>;
  /** Insertable placeholders, rendered as one indivisible chip each. */
  tokens?: { key: string; label: string; hint?: string }[];
  minHeight?: number;
  maxHeight?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const savedRange = useRef<Range | null>(null);
  const [uploading, setUploading] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  // The <a> the caret is currently sitting in, so an existing link can be read
  // and changed instead of only ever being created.
  const [activeLink, setActiveLink] = useState<{ href: string; text: string } | null>(null);
  const activeLinkEl = useRef<HTMLAnchorElement | null>(null);
  // pt size shown in the picker: the current selection's size, "" when the
  // selection spans multiple sizes (or the editor isn't focused).
  const [curSize, setCurSize] = useState("");

  // Seed once; afterwards the DOM is the source of truth (avoids cursor jumps).
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value) ref.current.innerHTML = value || "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect the font size at the caret / selection in the picker (like a normal
  // editor). Reads computed px and converts to pt; blank when sizes are mixed.
  useEffect(() => {
    function onSel() {
      const el = ref.current;
      if (!el || document.activeElement !== el) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) { setCurSize(""); return; }
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return;
      const pxOf = (node: Node): number | null => {
        let n: HTMLElement | null = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
        if (!n || !el.contains(n)) n = el;
        const px = parseFloat(getComputedStyle(n).fontSize);
        return Number.isFinite(px) ? px : null;
      };
      const a = pxOf(range.startContainer);
      const b = pxOf(range.endContainer);
      if (a == null) { setCurSize(""); return; }
      if (b != null && Math.abs(a - b) > 0.5) { setCurSize(""); return; } // mixed
      const pt = Math.round(a * 0.75); // px → pt (72/96)
      const nearest = FONT_PTS.reduce((x, y) => (Math.abs(y - pt) < Math.abs(x - pt) ? y : x), FONT_PTS[0]);
      setCurSize(String(nearest));
    }
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  // Track which link the caret is inside. A link's URL is otherwise invisible
  // in a contentEditable — clicking it does nothing and hovering shows nothing —
  // so the only way to change one was to delete it and retype it blind.
  useEffect(() => {
    function onSel() {
      const el = ref.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const node = sel.getRangeAt(0).startContainer;
      if (!el.contains(node)) return;
      let n: HTMLElement | null = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
      while (n && n !== el && n.tagName !== "A") n = n.parentElement;
      const anchor = n && n.tagName === "A" ? (n as HTMLAnchorElement) : null;
      activeLinkEl.current = anchor;
      setActiveLink(
        anchor
          ? { href: anchor.getAttribute("href") ?? "", text: anchor.textContent ?? "" }
          : null
      );
    }
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  /** Put the selection around an entire anchor, so execCommand acts on all of it. */
  function selectWholeLink(anchor: HTMLAnchorElement) {
    const range = document.createRange();
    range.selectNodeContents(anchor);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    savedRange.current = range.cloneRange();
  }

  function editActiveLink() {
    const anchor = activeLinkEl.current;
    if (!anchor) return;
    ref.current?.focus();
    selectWholeLink(anchor);
    setLinkUrl(anchor.getAttribute("href") ?? "");
    setLinkOpen(true);
  }

  function removeActiveLink() {
    const anchor = activeLinkEl.current;
    if (!anchor) return;
    ref.current?.focus();
    selectWholeLink(anchor);
    document.execCommand("unlink");
    activeLinkEl.current = null;
    setActiveLink(null);
    emit();
  }

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

  // Apply a font size (in pt) to the selection. execCommand("fontSize") only
  // accepts the legacy 1–7 scale, so we tag with size 7 then rewrite those
  // <font> nodes to an exact CSS pt value.
  function applyFontSize(pt: string) {
    if (!pt) return;
    ref.current?.focus();
    restoreSelection();
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand("fontSize", false, "7");
    ref.current?.querySelectorAll('font[size="7"]').forEach((f) => {
      f.removeAttribute("size");
      (f as HTMLElement).style.fontSize = `${pt}pt`;
    });
    setCurSize(pt);
    emit();
  }

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const { url } = await (upload ?? uploadCourseMedia)(file);
      ref.current?.focus();
      document.execCommand("insertHTML", false, `<img src="${url}" style="max-width:100%;border-radius:8px;margin:8px 0;" />`);
      emit();
    } catch (err: any) {
      alert("Image upload failed: " + (err?.message ?? "unknown"));
    } finally {
      setUploading(false);
    }
  }

  /**
   * Drop a placeholder chip at the caret. `contenteditable=false` makes the
   * browser treat it as a single character, so a backspace removes the whole
   * thing rather than leaving a broken `{{meet_lin}}` behind.
   */
  function insertToken(key: string) {
    const t = tokens?.find((x) => x.key === key);
    if (!t) return;
    ref.current?.focus();
    restoreSelection();
    const label = t.label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    document.execCommand(
      "insertHTML", false,
      `<span class="etok" data-tok="${key}" contenteditable="false">${label}</span>&nbsp;`
    );
    emit();
  }

  /** The toolbar button: edits the link you're in, otherwise creates a new one. */
  function openLink() {
    if (activeLinkEl.current) { editActiveLink(); return; }
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
    // createLink over an existing anchor rewrites its href, so this covers both
    // "add a link" and "change this link's URL".
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
          title="Font size (pt)"
          value={curSize}
          onMouseDown={saveSelection}
          onChange={(e) => applyFontSize(e.target.value)}
          style={{ ...btnStyle, cursor: "pointer", minWidth: 78, padding: "0 6px" }}
        >
          <option value="">Size</option>
          {FONT_PTS.map((pt) => <option key={pt} value={String(pt)}>{pt} pt</option>)}
        </select>
        <ToolBtn onClick={() => exec("insertUnorderedList")} title="Bullet list">•≡</ToolBtn>
        <ToolBtn onClick={() => exec("insertOrderedList")} title="Numbered list">1≡</ToolBtn>
        <ToolBtn onClick={openLink} title="Link">🔗</ToolBtn>
        <label style={{ ...btnStyle, cursor: uploading ? "default" : "pointer" }} title="Insert image">
          {uploading ? "…" : "🖼"}
          <input type="file" accept="image/*" style={{ display: "none" }} onChange={onPickImage} />
        </label>
        {tokens && tokens.length > 0 && (
          <select
            title="Insert a placeholder"
            value=""
            onMouseDown={saveSelection}
            onChange={(e) => { insertToken(e.target.value); e.currentTarget.value = ""; }}
            style={{ ...btnStyle, cursor: "pointer", minWidth: 130, padding: "0 6px" }}
          >
            <option value="">+ Insert…</option>
            {tokens.map((t) => (
              <option key={t.key} value={t.key} title={t.hint}>{t.label}</option>
            ))}
          </select>
        )}
      </div>
      {/* Make links look like links inside the editor (matches how they render
          when the course is taken). Scoped to .rte-content so it won't leak. */}
      <style>{`
        .rte-content a { color: #2563eb; text-decoration: underline; cursor: pointer; }
        .rte-content h2 { font-size: 1.4em; font-weight: 800; margin: 0.4em 0; }
        .rte-content img { max-width: 100%; }
        .rte-content .etok {
          display: inline-block; padding: 1px 8px; border-radius: 999px;
          background: #fce7f3; border: 1px solid #f9a8d4; color: #9d174d;
          font-size: 0.85em; font-weight: 800; white-space: nowrap;
          user-select: all; vertical-align: baseline;
        }
      `}</style>
      {/* Caret inside a link → show where it points, with a way to change it. */}
      {activeLink && (
        <div
          className="row"
          style={{
            gap: 8, alignItems: "center", flexWrap: "wrap",
            padding: "6px 10px", background: "#eff6ff",
            borderBottom: "1px solid #bfdbfe", fontSize: 12,
          }}
        >
          <span style={{ fontWeight: 800, color: "#1e40af", flexShrink: 0 }}>🔗 Link</span>
          <a
            href={activeLink.href || undefined}
            target="_blank"
            rel="noopener noreferrer"
            title={activeLink.href}
            style={{ color: "#1d4ed8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320 }}
          >
            {activeLink.href || "(no address)"}
          </a>
          <button type="button" className="btn" onMouseDown={(e) => e.preventDefault()} onClick={editActiveLink}
            style={{ ...btnStyle, height: 24, minWidth: 0, padding: "0 10px", fontSize: 12 }}>
            Edit
          </button>
          <button type="button" className="btn" onMouseDown={(e) => e.preventDefault()} onClick={removeActiveLink}
            style={{ ...btnStyle, height: 24, minWidth: 0, padding: "0 10px", fontSize: 12, color: "#991b1b" }}>
            Remove
          </button>
        </div>
      )}

      <div
        ref={ref}
        className="rte-content"
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        style={{ minHeight, maxHeight, overflowY: "auto", padding: "12px 14px", fontSize: 16, lineHeight: 1.5, outline: "none" }}
      />

      {linkOpen && (
        <div onMouseDown={(e) => { if (e.currentTarget === e.target) setLinkOpen(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div className="card" style={{ width: "100%", maxWidth: 400 }}>
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10 }}>
              {activeLink ? "Edit link" : "Add link"}
            </div>
            {activeLink?.text ? (
              <div className="subtle" style={{ fontSize: 12, marginBottom: 8 }}>
                Linked text: <b>{activeLink.text}</b>
              </div>
            ) : null}
            <input className="input" autoFocus value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") confirmLink(); }} placeholder="https://…" />
            <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button className="btn" onClick={() => setLinkOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmLink}>{activeLink ? "Save link" : "Add link"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Point sizes offered in the picker (fine-grained control).
const FONT_PTS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48];

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
