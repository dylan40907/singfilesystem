"use client";

import { useMemo } from "react";
import {
  ScheduleRoom,
  ScheduleBlock as ScheduleBlockType,
  EmployeeLite,
  timeToMinutes,
  formatTime,
  minutesToTime,
  generateTimeSlots,
  START_MINUTES,
  PX_PER_SLOT,
  TOTAL_SLOTS,
  SLOT_MINUTES,
} from "@/lib/scheduleUtils";
import ScheduleBlock from "./ScheduleBlock";

interface ScheduleGridProps {
  rooms: ScheduleRoom[];
  blocks: ScheduleBlockType[];
  employees: EmployeeLite[];
  day: number; // 1-5
  readOnly?: boolean;
  onCellClick: (roomId: string, columnIndex: number, day: number, time: string) => void;
  onBlockContextMenu: (blockId: string, x: number, y: number) => void;
  onBlockResize: (blockId: string, newStartTime: string, newEndTime: string) => void;
  onBlockMove: (blockId: string, deltaSlots: number) => void;
}

export default function ScheduleGrid({
  rooms,
  blocks,
  employees,
  day,
  readOnly,
  onCellClick,
  onBlockContextMenu,
  onBlockResize,
  onBlockMove,
}: ScheduleGridProps) {
  const timeSlots = useMemo(() => generateTimeSlots(), []);
  const gridHeight = TOTAL_SLOTS * PX_PER_SLOT;

  // Build flat columns: [{roomId, columnIndex, roomName}]
  const columns = useMemo(() => {
    const cols: { roomId: string; columnIndex: number; roomName: string }[] = [];
    for (const room of rooms) {
      for (let c = 0; c < room.capacity; c++) {
        cols.push({ roomId: room.id, columnIndex: c, roomName: room.name });
      }
    }
    return cols;
  }, [rooms]);

  // Filter blocks for this day
  const dayBlocks = useMemo(
    () => blocks.filter((b) => b.day_of_week === day),
    [blocks, day]
  );

  // Employee lookup
  const empMap = useMemo(() => {
    const m = new Map<string, EmployeeLite>();
    for (const e of employees) m.set(e.id, e);
    return m;
  }, [employees]);

  // Time labels to show (every 30 minutes)
  const timeLabels = useMemo(
    () => timeSlots.filter((_, i) => i % 6 === 0),
    [timeSlots]
  );

  return (
    <div style={{ display: "flex", overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 220px)" }}>
      {/* Time column */}
      <div
        style={{
          position: "sticky",
          left: 0,
          zIndex: 20,
          background: "white",
          borderRight: "1.5px solid #e5e7eb",
          minWidth: 64,
          flexShrink: 0,
        }}
      >
        {/* Header spacer */}
        <div style={{ height: 36, borderBottom: "1.5px solid #e5e7eb" }} />

        {/* Time labels */}
        <div style={{ position: "relative", height: gridHeight }}>
          {timeLabels.map((time) => {
            const mins = timeToMinutes(time);
            const top = ((mins - START_MINUTES) / SLOT_MINUTES) * PX_PER_SLOT;
            return (
              <div
                key={time}
                style={{
                  position: "absolute",
                  top,
                  right: 6,
                  fontSize: 10,
                  color: "#9ca3af",
                  fontWeight: 600,
                  lineHeight: "12px",
                  transform: "translateY(-6px)",
                  whiteSpace: "nowrap",
                }}
              >
                {formatTime(time)}
              </div>
            );
          })}
        </div>
      </div>

      {/* Room columns */}
      {columns.map((col, colIdx) => {
        const colBlocks = dayBlocks.filter(
          (b) => b.room_id === col.roomId && b.column_index === col.columnIndex
        );

        return (
          <div
            key={`${col.roomId}-${col.columnIndex}`}
            style={{
              minWidth: 120,
              flex: "1 0 120px",
              borderRight: "1px solid #f3f4f6",
              position: "relative",
            }}
          >
            {/* Column header */}
            <div
              style={{
                height: 36,
                borderBottom: "1.5px solid #e5e7eb",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 700,
                color: "#6b7280",
                background: "#f9fafb",
              }}
            >
              {col.columnIndex === 0 ? col.roomName : ""}
              {rooms.find((r) => r.id === col.roomId)!.capacity > 1 && (
                <span style={{ marginLeft: 4, fontSize: 10, color: "#d1d5db" }}>
                  #{col.columnIndex + 1}
                </span>
              )}
            </div>

            {/* Grid area */}
            <div
              style={{ position: "relative", height: gridHeight }}
              onClick={(e) => {
                if (readOnly) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const slotIndex = Math.floor(y / PX_PER_SLOT);
                const mins = START_MINUTES + slotIndex * SLOT_MINUTES;
                onCellClick(col.roomId, col.columnIndex, day, minutesToTime(mins));
              }}
            >
              {/* Hour lines */}
              {timeLabels.map((time) => {
                const mins = timeToMinutes(time);
                const top = ((mins - START_MINUTES) / SLOT_MINUTES) * PX_PER_SLOT;
                return (
                  <div
                    key={time}
                    style={{
                      position: "absolute",
                      top,
                      left: 0,
                      right: 0,
                      height: 1,
                      background: "#f3f4f6",
                      pointerEvents: "none",
                    }}
                  />
                );
              })}

              {/* Blocks */}
              {colBlocks.map((block) => {
                const startMins = timeToMinutes(block.start_time);
                const endMins = timeToMinutes(block.end_time);
                const topPx = ((startMins - START_MINUTES) / SLOT_MINUTES) * PX_PER_SLOT;
                const heightPx = ((endMins - startMins) / SLOT_MINUTES) * PX_PER_SLOT;

                return (
                  <ScheduleBlock
                    key={block.id}
                    block={block}
                    employee={block.employee_id ? empMap.get(block.employee_id) ?? null : null}
                    topPx={topPx}
                    heightPx={heightPx}
                    readOnly={readOnly}
                    onContextMenu={onBlockContextMenu}
                    onResizeEnd={onBlockResize}
                    onMoveEnd={onBlockMove}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Empty state if no rooms */}
      {columns.length === 0 && (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 40,
            color: "#9ca3af",
            fontSize: 14,
          }}
        >
          No rooms yet. Add a room to start scheduling.
        </div>
      )}
    </div>
  );
}
