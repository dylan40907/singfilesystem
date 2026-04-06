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
  onCellClick: (roomId: string, columnIndex: number, day: number, time: string, clientX: number, clientY: number) => void;
  onBlockContextMenu: (blockId: string, x: number, y: number) => void;
  onBlockResize: (blockId: string, newStartTime: string, newEndTime: string) => void;
  onBlockMoveToColumn: (blockId: string, newRoomId: string, newColumnIndex: number, deltaSlots: number) => void;
  onRoomUpdate: (roomId: string, updates: { name?: string; columns?: number }) => void;
  onRoomDelete: (roomId: string) => void;
  paintMode?: boolean;
  cellColors?: Record<string, string>; // "roomId:colIdx:timeSlot" -> color
  onPaintCells?: (cellKeys: string[]) => void;
  blockWarnings?: Map<string, string[]>;
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
  paintMode,
  cellColors = {},
  onPaintCells,
  blockWarnings = new Map(),
}: ScheduleGridProps) {
  const paintingRef = useRef(false);
  const paintedKeysRef = useRef<Set<string>>(new Set());
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
      for (let c = 0; c < room.columns; c++) {
        cols.push({
          roomId: room.id,
          columnIndex: c,
          roomName: room.name,
          capacity: room.columns,
          isFirstInRoom: c === 0,
          isLastInRoom: c === room.columns - 1,
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

  // Time labels every 5 minutes
  const timeLabels = useMemo(() => {
    const labels: string[] = [];
    for (let m = START_MINUTES; m <= END_MINUTES; m += SLOT_MINUTES) {
      labels.push(minutesToTime(m));
    }
    return labels;
  }, []);

  // Grid lines every 30 minutes (thicker visual separators)
  const gridLines = useMemo(() => {
    const lines: string[] = [];
    for (let m = START_MINUTES; m <= END_MINUTES; m += 30) {
      lines.push(minutesToTime(m));
    }
    return lines;
  }, []);

  // Grid lines every 5 minutes (lighter)
  const fineGridLines = useMemo(() => {
    const lines: string[] = [];
    for (let m = START_MINUTES; m < END_MINUTES; m += SLOT_MINUTES) {
      if (m % 30 !== 0) lines.push(minutesToTime(m));
    }
    return lines;
  }, []);

  const COL_WIDTH = 45;
  const TIME_COL_WIDTH = 72;

  return (
    <div style={{ display: "flex", overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 280px)", alignItems: "stretch" }}>
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
        <div style={{ height: 36, borderBottom: "1.5px solid #e5e7eb", position: "sticky", top: 0, zIndex: 21, background: "white" }} />

        {/* Time labels */}
        <div style={{ position: "relative", height: gridHeight }}>
          {timeLabels.map((time) => {
            const mins = timeToMinutes(time);
            const top = ((mins - START_MINUTES) / SLOT_MINUTES) * PX_PER_SLOT;
            const isFirst = mins === START_MINUTES;
            const is30 = mins % 30 === 0;
            return (
              <div
                key={time}
                style={{
                  position: "absolute",
                  top: isFirst ? top : top - 6,
                  right: 6,
                  fontSize: is30 ? 11 : 9,
                  color: is30 ? "#6b7280" : "#c9c9c9",
                  fontWeight: is30 ? 700 : 500,
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
              minHeight: gridHeight + 36,
            }}
          >
            {/* Column header */}
            <div
              style={{
                height: 36,
                borderBottom: "1.5px solid #e5e7eb",
                background: "#f9fafb",
                cursor: !readOnly ? "pointer" : "default",
                position: "sticky",
                top: 0,
                zIndex: col.isFirstInRoom ? 16 : 15,
                overflow: "visible",
              }}
              onClick={() => {
                if (!readOnly) onRoomUpdate(col.roomId, {});
              }}
            >
              {col.isFirstInRoom && (
                <div style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  // span all columns of this room; clip if single column
                  width: col.capacity === 1 ? COL_WIDTH : col.capacity * COL_WIDTH,
                  height: 36,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  fontWeight: 800,
                  color: "#111827",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  pointerEvents: "none",
                }}>
                  {col.roomName}
                </div>
              )}
            </div>

            {/* Grid area */}
            <div
              style={{ position: "relative", height: gridHeight, cursor: paintMode ? "crosshair" : undefined }}
              onClick={(e) => {
                if (readOnly) return;
                if (paintMode) return; // handled by pointer events
                // Suppress click if it was triggered by a drag ending
                if (suppressNextCellClick) {
                  suppressNextCellClick = false;
                  return;
                }
                const rect = e.currentTarget.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const slotIndex = Math.floor(y / PX_PER_SLOT);
                const mins = START_MINUTES + slotIndex * SLOT_MINUTES;
                onCellClick(col.roomId, col.columnIndex, day, minutesToTime(mins), e.clientX, e.clientY);
              }}
              onPointerDown={(e) => {
                if (!paintMode || !onPaintCells) return;
                e.preventDefault();
                paintingRef.current = true;
                paintedKeysRef.current = new Set();
                const rect = e.currentTarget.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const slotIndex = Math.floor(y / PX_PER_SLOT);
                const mins = START_MINUTES + slotIndex * SLOT_MINUTES;
                const key = `${col.roomId}:${col.columnIndex}:${minutesToTime(mins)}`;
                paintedKeysRef.current.add(key);
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!paintMode || !paintingRef.current || !onPaintCells) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const x = e.clientX;
                // Find which column we're over
                const gridContainer = document.querySelector("[data-schedule-grid]");
                if (!gridContainer) return;
                const colElements = gridContainer.querySelectorAll<HTMLElement>("[data-room-id]");
                let targetRoomId = col.roomId;
                let targetColIdx = col.columnIndex;
                for (const colEl of colElements) {
                  const r = colEl.getBoundingClientRect();
                  if (x >= r.left && x < r.right) {
                    targetRoomId = colEl.dataset.roomId!;
                    targetColIdx = parseInt(colEl.dataset.columnIndex!, 10);
                    break;
                  }
                }
                const slotIndex = Math.floor(y / PX_PER_SLOT);
                const mins = START_MINUTES + slotIndex * SLOT_MINUTES;
                if (mins < START_MINUTES || mins >= END_MINUTES) return;
                const key = `${targetRoomId}:${targetColIdx}:${minutesToTime(mins)}`;
                if (!paintedKeysRef.current.has(key)) {
                  paintedKeysRef.current.add(key);
                }
              }}
              onPointerUp={() => {
                if (!paintMode || !paintingRef.current || !onPaintCells) return;
                paintingRef.current = false;
                const keys = Array.from(paintedKeysRef.current);
                paintedKeysRef.current = new Set();
                if (keys.length > 0) onPaintCells(keys);
              }}
            >
              {/* Cell background colors */}
              {timeSlots.map((time) => {
                const key = `${col.roomId}:${col.columnIndex}:${time}`;
                const color = cellColors[key];
                if (!color) return null;
                const mins = timeToMinutes(time);
                const top = ((mins - START_MINUTES) / SLOT_MINUTES) * PX_PER_SLOT;
                return (
                  <div
                    key={`bg-${time}`}
                    style={{
                      position: "absolute",
                      top,
                      left: 0,
                      right: 0,
                      height: PX_PER_SLOT,
                      background: color,
                      pointerEvents: "none",
                      zIndex: 0,
                    }}
                  />
                );
              })}

              {/* 5-min fine grid lines */}
              {fineGridLines.map((time) => {
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
                      background: "#f5f5f5",
                      pointerEvents: "none",
                      zIndex: 1,
                    }}
                  />
                );
              })}
              {/* 30-min grid lines (bolder) */}
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
                      background: "#e5e7eb",
                      pointerEvents: "none",
                      zIndex: 1,
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
                    readOnly={readOnly || paintMode}
                    warnings={blockWarnings.get(block.id)}
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
