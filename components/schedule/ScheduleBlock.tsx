"use client";

import { useRef, useCallback, useState } from "react";
import {
  ScheduleBlock as ScheduleBlockType,
  EmployeeLite,
  formatTime,
  getFirstName,
  timeToMinutes,
  minutesToTime,
  snapMinutes,
  SLOT_MINUTES,
  PX_PER_SLOT,
} from "@/lib/scheduleUtils";

interface ScheduleBlockProps {
  block: ScheduleBlockType;
  employee: EmployeeLite | null;
  topPx: number;
  heightPx: number;
  readOnly?: boolean;
  onContextMenu: (blockId: string, x: number, y: number) => void;
  onResizeEnd: (blockId: string, newStartTime: string, newEndTime: string) => void;
  onDragEnd: (blockId: string, deltaSlots: number, clientX: number) => void;
  onDragCancel: () => void;
  warnings?: string[];
}

export default function ScheduleBlock({
  block,
  employee,
  topPx,
  heightPx,
  readOnly,
  onContextMenu,
  onResizeEnd,
  onDragEnd,
  onDragCancel,
  warnings,
}: ScheduleBlockProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const didInteractRef = useRef(false);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  const isLabelOnly = !block.employee_id && !!block.label;
  const isLabelWithEmployee = !!block.employee_id && !!block.label;

  const leftBorderColor =
    block.block_type === "lunch_break"
      ? "#f97316" // orange
      : block.block_type === "break"
      ? "#22c55e" // green
      : "#6366f1"; // indigo for shift
  const displayName = isLabelOnly
    ? block.label ?? "Label"
    : employee
      ? getFirstName(employee)
      : "Unknown";

  const timeStart = formatTime(block.start_time);
  const timeEnd = formatTime(block.end_time);

  // --- MOVE: pointer down on the block body ---
  const handleMoveDown = useCallback(
    (e: React.PointerEvent) => {
      if (readOnly) return;
      e.stopPropagation();
      e.preventDefault();
      didInteractRef.current = false;

      const el = elRef.current;
      if (!el) return;

      const startY = e.clientY;
      const startX = e.clientX;
      let dragging = false;

      // Capture pointer so we keep getting events even outside the element
      el.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const dy = ev.clientY - startY;
        const dx = ev.clientX - startX;

        if (!dragging && (Math.abs(dy) > 3 || Math.abs(dx) > 3)) {
          dragging = true;
        }

        if (dragging) {
          el.style.top = `${topPx + dy}px`;
          el.style.transform = `translateX(${dx}px)`;
          el.style.opacity = "0.7";
          el.style.zIndex = "100";
          el.style.pointerEvents = "none";
        }
      };

      const onUp = (ev: PointerEvent) => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.releasePointerCapture(ev.pointerId);

        // Reset visual
        el.style.top = `${topPx}px`;
        el.style.transform = "";
        el.style.opacity = "1";
        el.style.zIndex = "10";
        el.style.pointerEvents = "";

        if (dragging) {
          didInteractRef.current = true;
          const dy = ev.clientY - startY;
          const deltaSlots = Math.round(dy / PX_PER_SLOT);
          onDragEnd(block.id, deltaSlots, ev.clientX);
        } else {
          // No drag happened — still suppress the cell click behind us
          onDragCancel();
        }
      };

      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    },
    [block.id, topPx, readOnly, onDragEnd, onDragCancel]
  );

  // --- RESIZE: pointer down on top/bottom handle ---
  const handleResizeDown = useCallback(
    (edge: "top" | "bottom", e: React.PointerEvent) => {
      if (readOnly) return;
      e.stopPropagation();
      e.preventDefault();
      didInteractRef.current = true; // always suppress click after resize

      const el = elRef.current;
      if (!el) return;

      const startY = e.clientY;
      el.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const dy = ev.clientY - startY;
        if (edge === "bottom") {
          el.style.height = `${Math.max(PX_PER_SLOT, heightPx + dy)}px`;
        } else {
          const maxDy = heightPx - PX_PER_SLOT;
          const clamped = Math.min(dy, maxDy);
          el.style.top = `${topPx + clamped}px`;
          el.style.height = `${heightPx - clamped}px`;
        }
      };

      const onUp = (ev: PointerEvent) => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.releasePointerCapture(ev.pointerId);

        // Reset visual
        el.style.top = `${topPx}px`;
        el.style.height = `${heightPx}px`;

        const dy = ev.clientY - startY;
        const deltaSlots = Math.round(dy / PX_PER_SLOT);
        if (deltaSlots === 0) return;

        const startMins = timeToMinutes(block.start_time);
        const endMins = timeToMinutes(block.end_time);

        if (edge === "bottom") {
          const newEnd = snapMinutes(endMins + deltaSlots * SLOT_MINUTES);
          if (newEnd <= startMins) return;
          onResizeEnd(block.id, block.start_time, minutesToTime(newEnd));
        } else {
          const newStart = snapMinutes(startMins + deltaSlots * SLOT_MINUTES);
          if (newStart >= endMins) return;
          onResizeEnd(block.id, minutesToTime(newStart), block.end_time);
        }
      };

      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    },
    [block, topPx, heightPx, readOnly, onResizeEnd]
  );

  return (
    <div
      ref={elRef}
      onPointerDown={handleMoveDown}
      onClick={(e) => {
        e.stopPropagation();
        if (didInteractRef.current) {
          didInteractRef.current = false;
          return;
        }
        if (!readOnly) {
          onContextMenu(block.id, e.clientX, e.clientY);
        }
      }}
      onMouseEnter={(e) => { if (warnings?.length) setTooltipPos({ x: e.clientX, y: e.clientY }); }}
      onMouseMove={(e) => { if (warnings?.length) setTooltipPos({ x: e.clientX, y: e.clientY }); }}
      onMouseLeave={() => setTooltipPos(null)}
      style={{
        position: "absolute",
        top: topPx,
        left: 2,
        right: 2,
        height: heightPx,
        background: warnings && warnings.length > 0 ? "rgba(254,226,226,0.92)" : "rgba(255,255,255,0.85)",
        border: warnings && warnings.length > 0 ? "1px solid #fca5a5" : "1px solid #d1d5db",
        borderLeft: `3px solid ${warnings && warnings.length > 0 ? "#ef4444" : leftBorderColor}`,
        borderRadius: 6,
        padding: "3px 5px",
        overflow: "hidden",
        cursor: readOnly ? "default" : "grab",
        userSelect: "none",
        zIndex: 10,
        touchAction: "none",
      }}
    >
      {/* Resize top handle */}
      {!readOnly && (
        <div
          onPointerDown={(e) => {
            e.stopPropagation();
            handleResizeDown("top", e);
          }}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 6,
            cursor: "ns-resize",
            zIndex: 11,
          }}
        />
      )}

      {/* Block content */}
      <div
        style={{
          fontWeight: 900,
          fontSize: 13,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          pointerEvents: "none",
          color: "#1e293b",
          lineHeight: "16px",
        }}
      >
        {displayName}
      </div>
      {heightPx > 32 && (
        <div style={{ pointerEvents: "none", marginTop: 2, lineHeight: "14px" }}>
          <div style={{ fontSize: 11, color: "#6b7280" }}>{timeStart} –</div>
          <div style={{ fontSize: 11, color: "#6b7280" }}>{timeEnd}</div>
        </div>
      )}
      {isLabelWithEmployee && heightPx > 50 && (
        <div
          style={{
            fontSize: 11,
            color: "#4f46e5",
            fontWeight: 700,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            pointerEvents: "none",
            marginTop: 2,
          }}
        >
          {block.label}
        </div>
      )}


      {/* Warning tooltip */}
      {tooltipPos && warnings && warnings.length > 0 && (
        <div
          style={{
            position: "fixed",
            left: tooltipPos.x + 14,
            top: tooltipPos.y - 12,
            zIndex: 1000,
            background: "#1e293b",
            color: "white",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 12,
            fontWeight: 500,
            maxWidth: 300,
            whiteSpace: "pre-line",
            boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
            pointerEvents: "none",
            lineHeight: 1.5,
          }}
        >
          {warnings.join("\n\n")}
        </div>
      )}

      {/* Resize bottom handle */}
      {!readOnly && (
        <div
          onPointerDown={(e) => {
            e.stopPropagation();
            handleResizeDown("bottom", e);
          }}
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: 6,
            cursor: "ns-resize",
            zIndex: 11,
          }}
        />
      )}
    </div>
  );
}
