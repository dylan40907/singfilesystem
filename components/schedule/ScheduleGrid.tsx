"use client";

import { useMemo, useRef } from "react";
import {
  ScheduleRoom,
  ScheduleBlock as ScheduleBlockType,
  EmployeeLite,
  timeToMinutes,
  formatTime,
  minutesToTime,
  generateTimeSlots,
  START_MINUTES,
  END_MINUTES,
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
  onBlockMoveToColumn: (blockId: string, newRoomId: string, newColumnIndex: number, deltaSlots: number) => void;
  onRoomUpdate: (roomId: string, updates: { name?: string; capacity?: number }) => void;
  onRoomDelete: (roomId: string) => void;
}

// Shared flag: when a block drag/resize ends, suppress the next cell click
let suppressNextCellClick = false;

export default function ScheduleGrid({
  rooms,
  blocks,
  employees,
  day,
  readOnly,
  onCellClick,
  onBlockContextMenu,
  onBlockResize,
  onBlockMoveToColumn,
  onRoomUpdate,
  onRoomDelete,
}: ScheduleGridProps) {
  const timeSlots = useMemo(() => generateTimeSlots(), []);
  const gridHeight = TOTAL_SLOTS * PX_PER_SLOT;

  // Build flat columns
  const columns = useMemo(() => {
    const cols: {
      roomId: string;
      columnIndex: number;
      roomName: string;
      capacity: number;
      isFirstInRoom: boolean;
      isLastInRoom: boolean;
      globalIndex: number;
    }[] = [];
    let gi = 0;
    for (const room of rooms) {
      for (let c = 0; c < room.capacity; c++) {
        cols.push({
          roomId: room.id,
          columnIndex: c,
          roomName: room.name,
          capacity: room.capacity,
          isFirstInRoom: c === 0,
          isLastInRoom: c === room.capacity - 1,
          globalIndex: gi++,
        });
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

  // Time labels every 30 minutes, plus the final label at END_MINUTES
  const timeLabels = useMemo(() => {
    const labels: string[] = [];
    for (let m = START_MINUTES; m <= END_MINUTES; m += 30) {
      labels.push(minutesToTime(m));
    }
    return labels;
  }, []);

  // Grid lines every 30 minutes
  const gridLines = timeLabels;

  const COL_WIDTH = 120;
  const TIME_COL_WIDTH = 72;

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
          minWidth: TIME_COL_WIDTH,
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
            // First label: align top edge to grid line; others: center on grid line
            const isFirst = mins === START_MINUTES;
            return (
              <div
                key={time}
                style={{
                  position: "absolute",
                  top: isFirst ? top : top - 6,
                  right: 6,
                  fontSize: 10,
                  color: "#9ca3af",
                  fontWeight: 600,
                  lineHeight: "12px",
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
      {columns.map((col) => {
        const colBlocks = dayBlocks.filter(
          (b) => b.room_id === col.roomId && b.column_index === col.columnIndex
        );

        // Darker border between rooms, lighter between sub-columns
        const borderRight = col.isLastInRoom
          ? "2px solid #d1d5db"
          : "1px solid #e5e7eb";

        return (
          <div
            key={`${col.roomId}-${col.columnIndex}`}
            data-room-id={col.roomId}
            data-column-index={col.columnIndex}
            data-global-index={col.globalIndex}
            style={{
              minWidth: COL_WIDTH,
              flex: `1 0 ${COL_WIDTH}px`,
              borderRight,
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
                fontSize: 13,
                fontWeight: 800,
                color: "#111827",
                background: "#f9fafb",
                cursor: !readOnly && col.isFirstInRoom ? "pointer" : "default",
              }}
              onClick={() => {
                if (!readOnly && col.isFirstInRoom) {
                  onRoomUpdate(col.roomId, {});
                }
              }}
            >
              {col.isFirstInRoom ? col.roomName : ""}
            </div>

            {/* Grid area */}
            <div
              style={{ position: "relative", height: gridHeight }}
              onClick={(e) => {
                if (readOnly) return;
                // Suppress click if it was triggered by a drag ending
                if (suppressNextCellClick) {
                  suppressNextCellClick = false;
                  return;
                }
                const rect = e.currentTarget.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const slotIndex = Math.floor(y / PX_PER_SLOT);
                const mins = START_MINUTES + slotIndex * SLOT_MINUTES;
                onCellClick(col.roomId, col.columnIndex, day, minutesToTime(mins));
              }}
            >
              {/* 30-min grid lines */}
              {gridLines.map((time) => {
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
                    onResizeEnd={(blockId, s, e) => {
                      suppressNextCellClick = true;
                      onBlockResize(blockId, s, e);
                    }}
                    onDragEnd={(blockId, deltaSlots, clientX) => {
                      suppressNextCellClick = true;
                      // Determine which column the block was dropped on
                      const gridContainer = document.querySelector("[data-schedule-grid]");
                      if (!gridContainer) {
                        onBlockMoveToColumn(blockId, block.room_id, block.column_index, deltaSlots);
                        return;
                      }
                      const colElements = gridContainer.querySelectorAll<HTMLElement>("[data-room-id]");
                      let targetRoomId = block.room_id;
                      let targetColIdx = block.column_index;
                      for (const colEl of colElements) {
                        const rect = colEl.getBoundingClientRect();
                        if (clientX >= rect.left && clientX < rect.right) {
                          targetRoomId = colEl.dataset.roomId!;
                          targetColIdx = parseInt(colEl.dataset.columnIndex!, 10);
                          break;
                        }
                      }
                      onBlockMoveToColumn(blockId, targetRoomId, targetColIdx, deltaSlots);
                    }}
                    onDragCancel={() => {
                      // A pointerup without drag — suppress the cell click that follows
                      suppressNextCellClick = true;
                    }}
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
