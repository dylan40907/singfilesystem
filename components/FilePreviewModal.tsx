"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PreviewMode } from "@/lib/fileUtils";

// =============================================================================
// PDF Canvas Viewer
// Goals:
//   1) Fit each page fully within the available viewport (no cropping).
//   2) Render at devicePixelRatio for sharp text (avoids CSS-scaling blur).
//   3) Clickable annotation overlay for external + internal PDF links.
// =============================================================================
function PdfCanvasPreview({ url, maxPages = 50 }: { url: string; maxPages?: number }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [err, setErr] = useState<string>("");
  const [pdfjs, setPdfjs] = useState<any>(null);
  const [vp, setVp] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Track available viewport size.
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

  // Load pdfjs on the client only (avoids DOMMatrix SSR crashes).
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

        if (!mod) throw new Error("PDF.js failed to load. Check pdfjs-dist installation.");

        try {
          mod.GlobalWorkerOptions.workerSrc = new URL(
            "pdfjs-dist/build/pdf.worker.min.mjs",
            import.meta.url
          ).toString();
        } catch {
          try {
            mod.GlobalWorkerOptions.workerSrc = new URL(
              "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
              import.meta.url
            ).toString();
          } catch {
            // Worker may still fall back to main-thread rendering.
          }
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

  // Render whenever url/maxPages/pdfjs/viewport changes.
  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!pdfjs) return;
      if (!vp.w || !vp.h) return;

      setErr("");

      const container = containerRef.current;
      if (!container) return;

      // Render into a staging node so the old content stays visible until all
      // pages are ready — prevents the white-flash flicker on re-render.
      const staging = document.createElement("div");

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

        async function resolveDestToPageNum(dest: any): Promise<number | null> {
          try {
            let destArray: any = dest;
            if (typeof destArray === "string") destArray = await pdf.getDestination(destArray);
            if (!Array.isArray(destArray) || destArray.length === 0) return null;

            const pageRef = destArray[0];
            if (typeof pageRef === "number") {
              return Math.max(0, Math.min(pdf.numPages - 1, pageRef)) + 1;
            }

            const pageIndex = await pdf.getPageIndex(pageRef);
            return pageIndex + 1;
          } catch {
            return null;
          }
        }

        function scrollToPage(pageNum: number) {
          const c = containerRef.current;
          if (!c) return;
          const el = c.querySelector(`[data-pdf-page="${pageNum}"]`) as HTMLElement | null;
          if (!el) return;
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }

        for (let pageNum = 1; pageNum <= pagesToRender; pageNum++) {
          if (cancelled) return;

          const page = await pdf.getPage(pageNum);
          const base = page.getViewport({ scale: 1 });
          const fitScale = Math.min(availW / base.width, availH / base.height);
          const cssViewport = page.getViewport({ scale: fitScale });
          const renderViewport = page.getViewport({ scale: fitScale * dpr * QUALITY_BOOST });

          const pageCard = document.createElement("div");
          pageCard.dataset.pdfPage = String(pageNum);
          pageCard.setAttribute("data-pdf-page", String(pageNum));
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

          const overlay = document.createElement("div");
          overlay.style.position = "absolute";
          overlay.style.left = "0";
          overlay.style.top = "0";
          overlay.style.width = `${Math.floor(cssViewport.width)}px`;
          overlay.style.height = `${Math.floor(cssViewport.height)}px`;
          overlay.style.pointerEvents = "none";

          stage.appendChild(canvas);
          stage.appendChild(overlay);
          pageCard.appendChild(stage);
          staging.appendChild(pageCard);

          await page.render({ canvas, canvasContext: ctx, viewport: renderViewport } as any).promise;

          // Annotation layer (clickable links)
          try {
            const annots = await page.getAnnotations({ intent: "display" });

            for (const a of annots ?? []) {
              if (cancelled) return;
              if (!a || a.subtype !== "Link") continue;
              if (!Array.isArray(a.rect) || a.rect.length !== 4) continue;

              const rect = cssViewport.convertToViewportRectangle(a.rect);
              const left = Math.min(rect[0], rect[2]);
              const top = Math.min(rect[1], rect[3]);
              const width = Math.abs(rect[0] - rect[2]);
              const height = Math.abs(rect[1] - rect[3]);

              if (!isFinite(left) || !isFinite(top) || !isFinite(width) || !isFinite(height)) continue;
              if (width < 1 || height < 1) continue;

              const linkEl = document.createElement("a");
              linkEl.style.position = "absolute";
              linkEl.style.left = `${left}px`;
              linkEl.style.top = `${top}px`;
              linkEl.style.width = `${width}px`;
              linkEl.style.height = `${height}px`;
              linkEl.style.pointerEvents = "auto";
              linkEl.style.background = "transparent";
              linkEl.style.cursor = "pointer";
              linkEl.style.textDecoration = "none";

              const href = (a.url ?? a.unsafeUrl ?? "").toString().trim();
              if (href) {
                linkEl.href = href;
                linkEl.target = "_blank";
                linkEl.rel = "noopener noreferrer";
                linkEl.title = href;
              } else if (a.dest) {
                linkEl.href = "#";
                linkEl.title = "Go to destination";
                linkEl.addEventListener("click", async (ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  const targetPage = await resolveDestToPageNum(a.dest);
                  if (targetPage) scrollToPage(targetPage);
                });
              } else {
                continue;
              }

              overlay.appendChild(linkEl);
            }
          } catch {
            // Annotation failure is non-fatal; pages still render.
          }
        }

        if (pdf.numPages > pagesToRender) {
          const note = document.createElement("div");
          note.style.padding = "12px 16px 18px";
          note.style.color = "#666";
          note.style.fontWeight = "700";
          note.textContent = `Preview truncated: showing ${pagesToRender} of ${pdf.numPages} pages.`;
          staging.appendChild(note);
        }

        // Atomic swap: replace old content only after all pages are rendered.
        if (!cancelled) {
          container.innerHTML = "";
          while (staging.firstChild) container.appendChild(staging.firstChild);
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
      style={{ height: "100%", overflow: "auto", background: "#f6f6f6", padding: 16, boxSizing: "border-box" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {err ? (
        <div style={{ padding: 14, background: "white", color: "#b00020", fontWeight: 800 }}>
          PDF preview failed: {err}
        </div>
      ) : (
        <div ref={containerRef} />
      )}
    </div>
  );
}

// =============================================================================
// FilePreviewModal
// =============================================================================

export interface FilePreviewModalProps {
  open: boolean;
  onClose: () => void;
  /** Display name shown in the header. For "link" mode pass the link's display label. */
  fileName: string;
  mode: PreviewMode;
  /** Presigned URL for the file. For "link" mode, this is the destination URL. */
  signedUrl: string;
  loading: boolean;
  csvRows?: string[][];
  csvError?: string;
  /**
   * "fullscreen" (default): covers the entire viewport, ideal for the main file browser.
   * "dialog": centered card with max dimensions, ideal for embedded HR pages.
   */
  variant?: "fullscreen" | "dialog";
  /** Shown as a Download button in the header (dialog) or unknown-mode fallback (fullscreen). */
  onDownload?: () => void | Promise<void>;
  /** For "unknown" mode in fullscreen variant: shows a download button in the body. */
  canDownload?: boolean;
  /** Called after the link URL is successfully copied to clipboard. */
  onLinkCopied?: () => void;
  /** Called when the clipboard write fails. */
  onLinkCopyFailed?: () => void;
  /** Override the default z-index (120 for fullscreen, 100 for dialog). */
  zIndex?: number;
}

export function FilePreviewModal({
  open,
  onClose,
  fileName,
  mode,
  signedUrl,
  loading,
  csvRows = [],
  csvError = "",
  variant = "fullscreen",
  onDownload,
  canDownload,
  onLinkCopied,
  onLinkCopyFailed,
  zIndex,
}: FilePreviewModalProps) {
  // ESC key closes the modal.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const officeEmbedUrl = useMemo(() => {
    if (!signedUrl) return "";
    return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(signedUrl)}`;
  }, [signedUrl]);

  const csvMeta = useMemo(() => {
    const rows = csvRows ?? [];
    const rowCount = rows.length;
    let maxCols = 0;
    for (const r of rows) maxCols = Math.max(maxCols, r.length);
    return {
      rowCount,
      maxCols,
      colsToShow: Math.min(maxCols, 40),
      rowsToShow: Math.min(rowCount, 200),
    };
  }, [csvRows]);

  const modeLabel =
    mode === "office" ? "Office preview" :
    mode === "pdf" ? "PDF preview" :
    mode === "image" ? "Image preview" :
    mode === "csv" ? "CSV preview" :
    mode === "text" ? "Text preview" :
    mode === "video" ? "Video preview" :
    mode === "audio" ? "Audio preview" :
    mode === "link" ? "Link" :
    "Preview";

  if (!open) return null;

  const defaultZIndex = variant === "fullscreen" ? 120 : 100;
  const z = zIndex ?? defaultZIndex;

  // -------------------------------------------------------------------------
  // Shared body content (what's inside the viewer area)
  // -------------------------------------------------------------------------
  function renderBody() {
    if (loading) {
      return (
        <div style={{ padding: 14, color: variant === "fullscreen" ? "white" : "#374151" }}>
          Loading preview…
        </div>
      );
    }

    if (mode === "link") {
      return (
        <div style={{ height: "100%", background: "white", padding: 16 }}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>🔗 Link</div>
          <div className="subtle" style={{ marginBottom: 12, wordBreak: "break-word" }}>
            {signedUrl || "(missing URL)"}
          </div>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button
              className="btn btn-primary"
              onClick={() => signedUrl && window.open(signedUrl, "_blank", "noopener,noreferrer")}
              disabled={!signedUrl}
            >
              Open link ↗️
            </button>
            <button
              className="btn"
              onClick={() => {
                if (!signedUrl) return;
                navigator.clipboard?.writeText(signedUrl).then(
                  () => onLinkCopied?.(),
                  () => onLinkCopyFailed?.()
                );
              }}
              disabled={!signedUrl}
            >
              Copy
            </button>
          </div>
        </div>
      );
    }

    if (mode === "office") {
      return signedUrl ? (
        <iframe
          src={officeEmbedUrl}
          style={{ width: "100%", height: "100%", border: 0, background: "white" }}
          allowFullScreen
          allow="clipboard-read; clipboard-write"
        />
      ) : (
        <div style={{ padding: 14, color: variant === "fullscreen" ? "white" : "#374151" }}>
          No preview URL.
        </div>
      );
    }

    if (mode === "pdf") {
      return signedUrl ? (
        <div style={{ width: "100%", height: "100%", background: "white" }}>
          <PdfCanvasPreview url={signedUrl} />
        </div>
      ) : (
        <div style={{ padding: 14, color: variant === "fullscreen" ? "white" : "#374151" }}>
          PDF preview unavailable.
        </div>
      );
    }

    if (mode === "image") {
      return signedUrl ? (
        <div
          style={{ height: "100%", width: "100%", display: "flex", justifyContent: "center", alignItems: "center", padding: 12, boxSizing: "border-box" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={signedUrl}
            alt={fileName}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", background: "white", borderRadius: 8 }}
          />
        </div>
      ) : (
        <div style={{ padding: 14, color: variant === "fullscreen" ? "white" : "#374151" }}>
          Image preview unavailable.
        </div>
      );
    }

    if (mode === "csv") {
      return (
        <div style={{ height: "100%", background: "white", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: 12, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            {csvError ? (
              <div className="subtle" style={{ color: "#b00020", fontWeight: 700 }}>
                CSV preview failed: {csvError}
              </div>
            ) : csvRows.length === 0 ? (
              <div className="subtle">(No CSV data)</div>
            ) : (
              <div className="subtle">
                Showing up to {csvMeta.rowsToShow} rows and {csvMeta.colsToShow} columns
                {csvMeta.rowCount > csvMeta.rowsToShow || csvMeta.maxCols > csvMeta.colsToShow
                  ? " (truncated)"
                  : ""}
                .
              </div>
            )}
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            {!csvError && csvRows.length > 0 ? (
              <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {csvRows[0].slice(0, csvMeta.colsToShow).map((h, idx) => (
                      <th
                        key={idx}
                        style={{ position: "sticky", top: 0, background: "white", zIndex: 1, textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}
                      >
                        <div style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {h || <span className="subtle">(empty)</span>}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {csvRows.slice(1, csvMeta.rowsToShow).map((r, ridx) => (
                    <tr key={ridx}>
                      {r.slice(0, csvMeta.colsToShow).map((cell, cidx) => (
                        <td key={cidx} style={{ padding: 8, borderBottom: "1px solid #f3f4f6" }}>
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
      );
    }

    if (mode === "text") {
      return signedUrl ? (
        <iframe src={signedUrl} style={{ width: "100%", height: "100%", border: 0, background: "white" }} />
      ) : (
        <div style={{ padding: 14, color: variant === "fullscreen" ? "white" : "#374151" }}>
          Text preview unavailable.
        </div>
      );
    }

    if (mode === "video") {
      return signedUrl ? (
        <div style={{ height: "100%", width: "100%", display: "flex", justifyContent: "center", alignItems: "center" }}>
          <video
            controls
            controlsList="nodownload noplaybackrate noremoteplayback"
            disablePictureInPicture
            disableRemotePlayback
            onContextMenu={(e) => e.preventDefault()}
            src={signedUrl}
            style={{ width: "min(1100px, 100%)", height: "min(700px, 100%)", background: "black" }}
          />
        </div>
      ) : (
        <div style={{ padding: 14, color: variant === "fullscreen" ? "white" : "#374151" }}>
          Video preview unavailable.
        </div>
      );
    }

    if (mode === "audio") {
      return signedUrl ? (
        <div style={{ padding: 18, background: "white", height: "100%", boxSizing: "border-box" }}>
          <audio controls src={signedUrl} style={{ width: "100%" }} />
        </div>
      ) : (
        <div style={{ padding: 14, color: variant === "fullscreen" ? "white" : "#374151" }}>
          Audio preview unavailable.
        </div>
      );
    }

    // unknown fallback
    return (
      <div style={{ padding: 14, color: variant === "fullscreen" ? "white" : "#374151" }}>
        No in-app preview for this file type.
        {canDownload && onDownload ? (
          <>
            <div className="subtle" style={{ marginTop: 10, color: variant === "fullscreen" ? "rgba(255,255,255,0.8)" : "#6b7280" }}>
              You can download it to view locally.
            </div>
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-primary" onClick={() => void onDownload()}>
                Download
              </button>
            </div>
          </>
        ) : (
          <div className="subtle" style={{ marginTop: 10, color: variant === "fullscreen" ? "rgba(255,255,255,0.8)" : "#6b7280" }}>
            Use the Download button to view it locally.
          </div>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Fullscreen layout
  // -------------------------------------------------------------------------
  if (variant === "fullscreen") {
    return (
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.55)",
          zIndex: z,
          display: "flex",
          flexDirection: "column",
        }}
        onMouseDown={(e) => {
          if (e.currentTarget === e.target) onClose();
        }}
      >
        <div style={{ background: "white", height: "100%", width: "100%", display: "flex", flexDirection: "column" }}>
          {/* Header */}
          <div
            className="row-between"
            style={{ padding: 12, borderBottom: "1px solid var(--border)", gap: 10, flexShrink: 0 }}
          >
            <div className="stack" style={{ gap: 2, minWidth: 0 }}>
              <div style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {fileName}
              </div>
              <div className="subtle">{modeLabel}</div>
            </div>
            <button className="btn" onClick={onClose} title="Close (Esc)">
              ✕
            </button>
          </div>

          {/* Body */}
          <div style={{ flex: 1, minHeight: 0, background: "#111" }}>
            {renderBody()}
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Dialog layout (centered card)
  // -------------------------------------------------------------------------
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: z,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 14,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="card"
        style={{
          width: "min(1180px, 100%)",
          height: "min(860px, 90vh)",
          display: "grid",
          gridTemplateRows: "auto 1fr",
          overflow: "hidden",
          borderRadius: 16,
          border: "1px solid #e5e7eb",
          background: "white",
        }}
      >
        {/* Header */}
        <div
          className="row-between"
          style={{ padding: 12, borderBottom: "1px solid #e5e7eb", gap: 10, flexShrink: 0 }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {fileName}
            </div>
            <div className="subtle" style={{ marginTop: 2 }}>{modeLabel}</div>
          </div>

          <div className="row" style={{ gap: 8 }}>
            {onDownload ? (
              <button type="button" className="btn" onClick={() => void onDownload()}>
                Download
              </button>
            ) : null}
            <button type="button" className="btn" onClick={onClose} title="Close (Esc)">
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ overflow: "hidden", background: "#f6f6f6" }}>
          {renderBody()}
        </div>
      </div>
    </div>
  );
}
