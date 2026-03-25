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
  START_MINUTES,
  END_MINUTES,
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
  onMoveEnd: (blockId: string, deltaSlots: number) => void;
}

export default function ScheduleBlock({
  block,
  employee,
  topPx,
  heightPx,
  readOnly,
  onContextMenu,
  onResizeEnd,
  onMoveEnd,
}: ScheduleBlockProps) {
  const dragRef = useRef<{
    type: "move" | "resize-top" | "resize-bottom";
    startY: number;
    origTop: number;
    origHeight: number;
  } | null>(null);
  const elRef = useRef<HTMLDivElement>(null);

  const isLabel = !block.employee_id;
  const displayName = isLabel
    ? block.label ?? "Label"
    : employee
      ? getDisplayName(employee)
      : "Unknown";

  const timeLabel = `${formatTime(block.start_time)} - ${formatTime(block.end_time)}`;

  const handlePointerDown = useCallback(
    (type: "move" | "resize-top" | "resize-bottom", e: React.PointerEvent) => {
      if (readOnly) return;
      e.stopPropagation();
      e.preventDefault();

      dragRef.current = {
        type,
        startY: e.clientY,
        origTop: topPx,
        origHeight: heightPx,
      };

      const el = elRef.current;
      if (!el) return;

      function onPointerMove(ev: PointerEvent) {
        if (!dragRef.current || !el) return;
        const deltaY = ev.clientY - dragRef.current.startY;
        const { type: dragType, origTop, origHeight } = dragRef.current;

        if (dragType === "resize-bottom") {
          const newHeight = Math.max(PX_PER_SLOT, origHeight + deltaY);
          el.style.height = `${newHeight}px`;
        } else if (dragType === "resize-top") {
          const maxDelta = origHeight - PX_PER_SLOT;
          const clampedDelta = Math.min(deltaY, maxDelta);
          el.style.top = `${origTop + clampedDelta}px`;
          el.style.height = `${origHeight - clampedDelta}px`;
        } else {
          // move
          el.style.top = `${origTop + deltaY}px`;
          el.style.opacity = "0.8";
        }
      }

      function onPointerUp(ev: PointerEvent) {
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);
        if (!dragRef.current || !el) return;

        const deltaY = ev.clientY - dragRef.current.startY;
        const { type: dragType, origTop, origHeight } = dragRef.current;

        // Reset visual
        el.style.top = `${topPx}px`;
        el.style.height = `${heightPx}px`;
        el.style.opacity = "1";
        dragRef.current = null;

        const deltaSlots = Math.round(deltaY / PX_PER_SLOT);
        if (deltaSlots === 0) return;

        const startMins = timeToMinutes(block.start_time);
        const endMins = timeToMinutes(block.end_time);

        if (dragType === "resize-bottom") {
          const newEndMins = snapMinutes(endMins + deltaSlots * SLOT_MINUTES);
          if (newEndMins <= startMins) return;
          onResizeEnd(block.id, block.start_time, minutesToTime(newEndMins));
        } else if (dragType === "resize-top") {
          const newStartMins = snapMinutes(startMins + deltaSlots * SLOT_MINUTES);
          if (newStartMins >= endMins) return;
          onResizeEnd(block.id, minutesToTime(newStartMins), block.end_time);
        } else {
          onMoveEnd(block.id, deltaSlots);
        }
      }

      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    },
    [block, topPx, heightPx, readOnly, onResizeEnd, onMoveEnd]
  );

  return (
    <div
      ref={elRef}
      onClick={(e) => {
        if (!readOnly) {
          e.stopPropagation();
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
        cursor: readOnly ? "default" : "pointer",
        fontSize: 11,
        lineHeight: "14px",
        userSelect: "none",
        zIndex: 10,
      }}
    >
      {/* Resize top handle */}
      {!readOnly && (
        <div
          onPointerDown={(e) => handlePointerDown("resize-top", e)}
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
        onPointerDown={(e) => handlePointerDown("move", e)}
        style={{
          fontWeight: 700,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
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
          }}
        >
          {timeLabel}
        </div>
      )}

      {/* Resize bottom handle */}
      {!readOnly && (
        <div
          onPointerDown={(e) => handlePointerDown("resize-bottom", e)}
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
