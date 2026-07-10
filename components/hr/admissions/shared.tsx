"use client";

import { ReactNode } from "react";
import { SortState } from "@/lib/admissions";

export const modalBackdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  zIndex: 200,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
};

/** Standard admissions modal shell (card + header + scrollable body). */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  width = 560,
  footer,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  footer?: ReactNode;
}) {
  return (
    <div style={modalBackdrop} onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}>
      <div
        className="card"
        style={{ width: `min(${width}px, 96vw)`, borderRadius: 16, maxHeight: "92vh", display: "flex", flexDirection: "column", padding: 0 }}
      >
        <div className="row-between" style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 900, fontSize: 16 }}>{title}</div>
            {subtitle ? <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>{subtitle}</div> : null}
          </div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <div style={{ padding: 20, overflowY: "auto" }}>{children}</div>
        {footer ? (
          <div className="row-between" style={{ padding: "14px 20px", borderTop: "1px solid #e5e7eb", flexWrap: "wrap", gap: 8 }}>
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Labelled form field wrapper. */
export function Field({
  label,
  hint,
  children,
  optional,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  optional?: boolean;
}) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div style={{ fontWeight: 800, fontSize: 13 }}>
        {label}
        {optional ? <span className="subtle" style={{ fontWeight: 400 }}> (optional)</span> : null}
      </div>
      {children}
      {hint ? <div className="subtle" style={{ fontSize: 12 }}>{hint}</div> : null}
    </div>
  );
}

/** Small colored status pill. */
export function Pill({ label, color, bg, border }: { label: string; color: string; bg: string; border: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 800,
        color,
        background: bg,
        border: `1px solid ${border}`,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

export const th: React.CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1.5px solid #e5e7eb",
  fontSize: 12,
  fontWeight: 800,
  textAlign: "left",
  whiteSpace: "nowrap",
  background: "#f9fafb",
  position: "sticky",
  top: 0,
  zIndex: 1,
};

export const td: React.CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid #f0f0f0",
  fontSize: 13,
  whiteSpace: "nowrap",
  verticalAlign: "middle",
};

// Shared style for inline row selects (room / program) so they read as tidy
// controls in a table rather than raw form widgets.
export const inlineSelect: React.CSSProperties = {
  fontSize: 13,
  padding: "6px 10px",
  borderRadius: 8,
  maxWidth: 180,
  background: "#fff",
};

/** A small round color dot for a room (hollow outline when no color/unassigned). */
export function RoomDot({ color }: { color?: string | null }) {
  return (
    <span style={{
      width: 10, height: 10, borderRadius: 999, flexShrink: 0, display: "inline-block",
      background: color ?? "transparent", border: color ? "none" : "1.5px solid #d1d5db",
    }} />
  );
}

/**
 * Clickable table header that sorts by `sortKey`. Click toggles asc/desc. Pass
 * extra header controls (e.g. an Edit button) as children — they stop click
 * propagation so they don't trigger a sort.
 */
export function SortTh({
  label, sortKey, sort, onSort, style, children,
}: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  style?: React.CSSProperties;
  children?: ReactNode;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      style={{ ...th, cursor: "pointer", userSelect: "none", ...style }}
      onClick={() => onSort(sortKey)}
      title="Click to sort"
    >
      <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
        <span>{label}</span>
        {children}
        <span style={{ fontSize: 9, color: active ? "#e6178d" : "#cbd5e1", lineHeight: 1 }}>
          {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </span>
    </th>
  );
}
