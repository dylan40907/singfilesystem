"use client";

import { useEffect, useRef } from "react";

interface BlockContextMenuProps {
  x: number;
  y: number;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function BlockContextMenu({
  x,
  y,
  onDuplicate,
  onDelete,
  onClose,
}: BlockContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  const btnStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    padding: "8px 16px",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 13,
    fontWeight: 600,
  };

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 50,
        background: "white",
        border: "1.5px solid #e5e7eb",
        borderRadius: 10,
        boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
        overflow: "hidden",
        minWidth: 140,
      }}
    >
      <button
        style={btnStyle}
        onClick={onDuplicate}
        onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        Duplicate
      </button>
      <button
        style={{ ...btnStyle, color: "#dc2626" }}
        onClick={onDelete}
        onMouseEnter={(e) => (e.currentTarget.style.background = "#fef2f2")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        Delete
      </button>
    </div>
  );
}
