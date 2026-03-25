"use client";

import { useEffect, useRef, useState } from "react";
import { EmployeeLite, formatEmployeeName } from "@/lib/scheduleUtils";

interface EmployeePickerDropdownProps {
  employees: EmployeeLite[];
  onSelect: (employee: EmployeeLite) => void;
  onSelectLabel: () => void;
  onClose: () => void;
  style?: React.CSSProperties;
}

export default function EmployeePickerDropdown({
  employees,
  onSelect,
  onSelectLabel,
  onClose,
  style,
}: EmployeePickerDropdownProps) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  const filtered = employees.filter((e) => {
    if (!search.trim()) return true;
    const name = formatEmployeeName(e).toLowerCase();
    const nick = (e.nicknames ?? "").toLowerCase();
    const q = search.toLowerCase();
    return name.includes(q) || nick.includes(q);
  }).slice(0, 60);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        zIndex: 40,
        background: "white",
        border: "1.5px solid #e5e7eb",
        borderRadius: 12,
        boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
        width: 260,
        maxHeight: 320,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        ...style,
      }}
    >
      <div style={{ padding: "8px 10px", borderBottom: "1px solid #f3f4f6" }}>
        <input
          ref={inputRef}
          type="text"
          placeholder="Search employee…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          style={{
            width: "100%",
            padding: "6px 10px",
            borderRadius: 8,
            border: "1.5px solid #e5e7eb",
            fontSize: 13,
            outline: "none",
          }}
        />
      </div>

      <div style={{ overflowY: "auto", maxHeight: 260 }}>
        {/* Label option */}
        <button
          onClick={onSelectLabel}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "8px 12px",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 700,
            color: "#6b7280",
            borderBottom: "1px solid #f3f4f6",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          🏷️ Add Label (Break / Note)
        </button>

        {filtered.length === 0 ? (
          <div style={{ padding: "12px", color: "#9ca3af", fontSize: 13, textAlign: "center" }}>
            No employees found
          </div>
        ) : (
          filtered.map((emp) => (
            <button
              key={emp.id}
              onClick={() => onSelect(emp)}
              style={{
                display: "block",
                width: "100%",
                padding: "8px 12px",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                textAlign: "left",
                fontSize: 13,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <div style={{ fontWeight: 700 }}>{formatEmployeeName(emp)}</div>
              {emp.nicknames && (
                <div style={{ color: "#9ca3af", fontSize: 12 }}>{emp.nicknames}</div>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
