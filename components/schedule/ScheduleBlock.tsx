"use client";

import { useRef, useCallback } from "react";
import {
  ScheduleBlock as ScheduleBlockType,
  EmployeeLite,
  formatTime,
  getDisplayName,
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
}: ScheduleBlockProps) {
  const elRef = useRef<HTMLDivElement>(null);
  // Track whether a drag happened so we can suppress click
  const didInteractRef = useRef(false);

  const isLabel = !block.employee_id;
  const displayName = isLabel
    ? block.label ?? "Label"
    : employee
      ? getDisplayName(employee)
      : "Unknown";

  const timeLabel = `${formatTime(block.start_time)} - ${formatTime(block.end_time)}`;

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
      style={{
        position: "absolute",
        top: topPx,
        left: 2,
        right: 2,
        height: heightPx,
        background: isLabel ? "#e0e7ff" : "#fce7f3",
        border: isLabel ? "1px solid #a5b4fc" : "1px solid #f9a8d4",
        borderRadius: 6,
        padding: "2px 4px",
        overflow: "hidden",
        cursor: readOnly ? "default" : "grab",
        fontSize: 11,
        lineHeight: "14px",
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
          fontWeight: 700,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          pointerEvents: "none",
        }}
      >
        {displayName}
      </div>
      {heightPx > 20 && (
        <div
          style={{
            fontSize: 10,
            color: "#6b7280",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            pointerEvents: "none",
          }}
        >
          {timeLabel}
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
