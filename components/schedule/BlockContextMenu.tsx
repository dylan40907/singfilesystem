"use client";

interface BlockContextMenuProps {
  x: number;
  y: number;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function BlockContextMenu({
  x,
  y,
  onEdit,
  onDuplicate,
  onDelete,
  onClose,
}: BlockContextMenuProps) {
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
    <>
      {/* Transparent backdrop — catches outside clicks */}
      <div
        style={{ position: "fixed", inset: 0, zIndex: 10001 }}
        onMouseDown={onClose}
      />
      {/* Menu popup */}
      <div
        style={{
          position: "fixed",
          left: x,
          top: y,
          zIndex: 10002,
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
          onMouseDown={(e) => { e.stopPropagation(); onEdit(); }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#f0f9ff")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          ✏️ Edit
        </button>
        <button
          style={btnStyle}
          onMouseDown={(e) => { e.stopPropagation(); onDuplicate(); }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          Duplicate
        </button>
        <button
          style={{ ...btnStyle, color: "#dc2626" }}
          onMouseDown={(e) => { e.stopPropagation(); onDelete(); }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#fef2f2")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          Delete
        </button>
      </div>
    </>
  );
}
