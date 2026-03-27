"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  Schedule,
  ScheduleRoom,
  ScheduleBlock as ScheduleBlockType,
  EmployeeLite,
  formatWeekRange,
  formatEmployeeName,
  timeToMinutes,
  minutesToTime,
  snapMinutes,
  detectConflicts,
  DAY_LABELS,
  DAY_NUMBERS,
  SLOT_MINUTES,
  START_MINUTES,
  END_MINUTES,
} from "@/lib/scheduleUtils";
import ScheduleGrid from "./ScheduleGrid";
import EmployeePickerDropdown from "./EmployeePickerDropdown";
import BlockContextMenu from "./BlockContextMenu";

interface ScheduleGridEditorProps {
  scheduleId: string;
  onBack: () => void;
}

type PickerState = {
  roomId: string;
  columnIndex: number;
  day: number;
  time: string;
} | null;

type ContextMenuState = {
  blockId: string;
  x: number;
  y: number;
} | null;

type DuplicateMode = {
  employeeId: string | null;
  label: string | null;
  durationMinutes: number;
} | null;

type RoomEditState = {
  roomId: string;
  name: string;
  capacity: number;
} | null;

export default function ScheduleGridEditor({ scheduleId, onBack }: ScheduleGridEditorProps) {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [rooms, setRooms] = useState<ScheduleRoom[]>([]);
  const [blocks, setBlocks] = useState<ScheduleBlockType[]>([]);
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [loading, setLoading] = useState(true);

  const [activeDay, setActiveDay] = useState<number>(1);
  const [picker, setPicker] = useState<PickerState>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [duplicateMode, setDuplicateMode] = useState<DuplicateMode>(null);
  const [labelInput, setLabelInput] = useState<{
    roomId: string;
    columnIndex: number;
    day: number;
    time: string;
  } | null>(null);
  const [labelText, setLabelText] = useState("");
  const [labelEmployeeId, setLabelEmployeeId] = useState<string | null>(null);
  const [labelEmployeeSearch, setLabelEmployeeSearch] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [roomEdit, setRoomEdit] = useState<RoomEditState>(null);

  // Paint mode state
  const [paintMode, setPaintMode] = useState(false);
  const [paintColor, setPaintColor] = useState("#fde68a"); // default yellow
  const [paintErase, setPaintErase] = useState(false);
  // cellColors: Map of "roomId:colIdx:timeSlot" -> color hex, per day
  const [cellColors, setCellColors] = useState<Record<number, Record<string, string>>>({});
  const [colorUndoStack, setColorUndoStack] = useState<Record<number, Record<string, string>>[]>([]);
  const colorSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const readOnly = schedule?.status === "published";

  // Fetch all data
  const fetchData = useCallback(async () => {
    setLoading(true);
    const [schedRes, roomsRes, blocksRes, empRes, colorsRes] = await Promise.all([
      supabase.from("schedules").select("*").eq("id", scheduleId).single(),
      supabase
        .from("schedule_rooms")
        .select("*")
        .eq("schedule_id", scheduleId)
        .order("sort_order"),
      supabase
        .from("schedule_blocks")
        .select("*")
        .eq("schedule_id", scheduleId),
      supabase
        .from("hr_employees")
        .select("id, legal_first_name, legal_middle_name, legal_last_name, nicknames, is_active, profile_id")
        .eq("is_active", true)
        .order("legal_first_name"),
      supabase
        .from("schedule_cell_colors")
        .select("day_of_week, colors")
        .eq("schedule_id", scheduleId),
    ]);

    if (schedRes.data) setSchedule(schedRes.data);
    if (roomsRes.data) setRooms(roomsRes.data);
    if (blocksRes.data) setBlocks(blocksRes.data);
    if (empRes.data) setEmployees(empRes.data);
    if (colorsRes.data) {
      const cm: Record<number, Record<string, string>> = {};
      for (const row of colorsRes.data) {
        cm[row.day_of_week] = (row.colors as Record<string, string>) ?? {};
      }
      setCellColors(cm);
    }
    setLoading(false);
  }, [scheduleId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Save cell colors (debounced)
  function saveCellColors(day: number, colors: Record<string, string>) {
    if (colorSaveTimeout.current) clearTimeout(colorSaveTimeout.current);
    colorSaveTimeout.current = setTimeout(async () => {
      await supabase
        .from("schedule_cell_colors")
        .upsert(
          {
            schedule_id: scheduleId,
            day_of_week: day,
            colors,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "schedule_id,day_of_week" }
        );
    }, 300);
  }

  // Handle paint on cells
  function handlePaintCells(cellKeys: string[]) {
    if (!paintMode) return;
    // Push current state to undo stack
    setColorUndoStack((prev) => [...prev.slice(-20), JSON.parse(JSON.stringify(cellColors))]);

    setCellColors((prev) => {
      const dayColors = { ...(prev[activeDay] ?? {}) };
      for (const key of cellKeys) {
        if (paintErase) {
          delete dayColors[key];
        } else {
          dayColors[key] = paintColor;
        }
      }
      const next = { ...prev, [activeDay]: dayColors };
      saveCellColors(activeDay, dayColors);
      return next;
    });
  }

  function handleColorUndo() {
    if (colorUndoStack.length === 0) return;
    const prevState = colorUndoStack[colorUndoStack.length - 1];
    setColorUndoStack((s) => s.slice(0, -1));
    setCellColors(prevState);
    // Save the reverted state for active day
    const dayColors = prevState[activeDay] ?? {};
    saveCellColors(activeDay, dayColors);
  }

  // Clear warning after 4 seconds
  useEffect(() => {
    if (!warning) return;
    const t = setTimeout(() => setWarning(null), 4000);
    return () => clearTimeout(t);
  }, [warning]);

  // --- Room CRUD ---
  async function addRoom() {
    const nextOrder = rooms.length > 0 ? Math.max(...rooms.map((r) => r.sort_order)) + 1 : 0;
    const { data, error } = await supabase
      .from("schedule_rooms")
      .insert({
        schedule_id: scheduleId,
        name: `Room ${rooms.length + 1}`,
        capacity: 2,
        sort_order: nextOrder,
      })
      .select()
      .single();
    if (data) setRooms((prev) => [...prev, data]);
    if (error) setWarning(error.message);
  }

  async function updateRoom(roomId: string, updates: { name?: string; capacity?: number }) {
    const { error } = await supabase
      .from("schedule_rooms")
      .update(updates)
      .eq("id", roomId);
    if (!error) {
      setRooms((prev) =>
        prev.map((r) => (r.id === roomId ? { ...r, ...updates } : r))
      );
      // If capacity decreased, remove blocks in columns beyond new capacity
      if (updates.capacity !== undefined) {
        const room = rooms.find((r) => r.id === roomId);
        if (room && updates.capacity < room.capacity) {
          const toDelete = blocks.filter(
            (b) => b.room_id === roomId && b.column_index >= updates.capacity!
          );
          if (toDelete.length > 0) {
            await supabase
              .from("schedule_blocks")
              .delete()
              .in("id", toDelete.map((b) => b.id));
            setBlocks((prev) =>
              prev.filter((b) => !toDelete.some((d) => d.id === b.id))
            );
          }
        }
      }
    } else {
      setWarning(error.message);
    }
  }

  async function deleteRoom(roomId: string) {
    const roomBlocks = blocks.filter((b) => b.room_id === roomId);
    if (roomBlocks.length > 0 && !confirm(`Delete this room and its ${roomBlocks.length} blocks?`)) {
      return;
    }
    const { error } = await supabase
      .from("schedule_rooms")
      .delete()
      .eq("id", roomId);
    if (!error) {
      setRooms((prev) => prev.filter((r) => r.id !== roomId));
      setBlocks((prev) => prev.filter((b) => b.room_id !== roomId));
    } else {
      setWarning(error.message);
    }
  }

  // Room edit triggered by clicking room name in grid header
  function handleRoomEditTrigger(roomId: string, _updates: { name?: string; capacity?: number }) {
    // If _updates is empty, it's a click-to-edit trigger
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return;
    if (Object.keys(_updates).length === 0) {
      setRoomEdit({ roomId: room.id, name: room.name, capacity: room.capacity });
    } else {
      updateRoom(roomId, _updates);
    }
  }

  async function handleRoomEditSave() {
    if (!roomEdit) return;
    await updateRoom(roomEdit.roomId, {
      name: roomEdit.name.trim() || "Room",
      capacity: roomEdit.capacity,
    });
    setRoomEdit(null);
  }

  // --- Block CRUD ---
  async function createBlock(
    roomId: string,
    columnIndex: number,
    day: number,
    startTime: string,
    endTime: string,
    employeeId: string | null,
    label: string | null
  ) {
    const candidate = {
      employee_id: employeeId,
      day_of_week: day,
      start_time: startTime,
      end_time: endTime,
    };
    const conflicts = detectConflicts(blocks, candidate);
    if (conflicts.length > 0) {
      const empName = employees.find((e) => e.id === employeeId);
      setWarning(
        `Conflict: ${empName ? formatEmployeeName(empName) : "Employee"} already has a block at this time on this day.`
      );
      return;
    }

    setSaving(true);
    const { data, error } = await supabase
      .from("schedule_blocks")
      .insert({
        schedule_id: scheduleId,
        room_id: roomId,
        column_index: columnIndex,
        day_of_week: day,
        start_time: startTime,
        end_time: endTime,
        employee_id: employeeId,
        label: label,
      })
      .select()
      .single();

    if (data) setBlocks((prev) => [...prev, data]);
    if (error) setWarning(error.message);
    setSaving(false);
  }

  async function deleteBlock(blockId: string) {
    const { error } = await supabase
      .from("schedule_blocks")
      .delete()
      .eq("id", blockId);
    if (!error) {
      setBlocks((prev) => prev.filter((b) => b.id !== blockId));
    } else {
      setWarning(error.message);
    }
    setContextMenu(null);
  }

  async function handleBlockResize(blockId: string, newStartTime: string, newEndTime: string) {
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;

    const candidate = {
      id: blockId,
      employee_id: block.employee_id,
      day_of_week: block.day_of_week,
      start_time: newStartTime,
      end_time: newEndTime,
    };
    const conflicts = detectConflicts(blocks, candidate);
    if (conflicts.length > 0) {
      setWarning("Conflict: This resize would overlap with another block for the same employee.");
      return;
    }

    setBlocks((prev) =>
      prev.map((b) =>
        b.id === blockId ? { ...b, start_time: newStartTime, end_time: newEndTime } : b
      )
    );

    const { error } = await supabase
      .from("schedule_blocks")
      .update({ start_time: newStartTime, end_time: newEndTime })
      .eq("id", blockId);

    if (error) {
      setWarning(error.message);
      fetchData();
    }
  }

  // Move block to a new column/room and/or new time
  async function handleBlockMoveToColumn(
    blockId: string,
    newRoomId: string,
    newColumnIndex: number,
    deltaSlots: number
  ) {
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;

    const startMins = timeToMinutes(block.start_time);
    const endMins = timeToMinutes(block.end_time);
    const duration = endMins - startMins;
    const newStartMins = snapMinutes(startMins + deltaSlots * SLOT_MINUTES);
    const newEndMins = newStartMins + duration;

    if (newStartMins < START_MINUTES || newEndMins > END_MINUTES) {
      setWarning("Cannot move block outside the schedule time range.");
      return;
    }

    const newStartTime = minutesToTime(newStartMins);
    const newEndTime = minutesToTime(newEndMins);

    // Check if nothing changed
    if (
      newRoomId === block.room_id &&
      newColumnIndex === block.column_index &&
      newStartTime === block.start_time
    ) {
      return;
    }

    const candidate = {
      id: blockId,
      employee_id: block.employee_id,
      day_of_week: block.day_of_week,
      start_time: newStartTime,
      end_time: newEndTime,
    };
    const conflicts = detectConflicts(blocks, candidate);
    if (conflicts.length > 0) {
      setWarning("Conflict: This move would overlap with another block for the same employee.");
      return;
    }

    // Validate target column exists
    const targetRoom = rooms.find((r) => r.id === newRoomId);
    if (!targetRoom || newColumnIndex >= targetRoom.capacity) {
      setWarning("Invalid target column.");
      return;
    }

    setBlocks((prev) =>
      prev.map((b) =>
        b.id === blockId
          ? {
              ...b,
              room_id: newRoomId,
              column_index: newColumnIndex,
              start_time: newStartTime,
              end_time: newEndTime,
            }
          : b
      )
    );

    const { error } = await supabase
      .from("schedule_blocks")
      .update({
        room_id: newRoomId,
        column_index: newColumnIndex,
        start_time: newStartTime,
        end_time: newEndTime,
      })
      .eq("id", blockId);

    if (error) {
      setWarning(error.message);
      fetchData();
    }
  }

  // --- Cell click handler ---
  function handleCellClick(roomId: string, columnIndex: number, day: number, time: string) {
    if (readOnly) return;

    // If in paint mode, don't open picker (painting handled by ScheduleGrid)
    if (paintMode) return;

    // If in duplicate mode, place block immediately
    if (duplicateMode) {
      const endMins = timeToMinutes(time) + duplicateMode.durationMinutes;
      const endTime = minutesToTime(Math.min(endMins, END_MINUTES));
      createBlock(
        roomId,
        columnIndex,
        day,
        time,
        endTime,
        duplicateMode.employeeId,
        duplicateMode.label
      );
      setDuplicateMode(null);
      return;
    }

    setPicker({ roomId, columnIndex, day, time });
  }

  // --- Employee selection from picker ---
  function handleSelectEmployee(emp: EmployeeLite) {
    if (!picker) return;
    const endMins = timeToMinutes(picker.time) + 30; // default 30 min
    const endTime = minutesToTime(Math.min(endMins, END_MINUTES));
    createBlock(picker.roomId, picker.columnIndex, picker.day, picker.time, endTime, emp.id, null);
    setPicker(null);
  }

  function handleSelectLabel() {
    if (!picker) return;
    setLabelInput({
      roomId: picker.roomId,
      columnIndex: picker.columnIndex,
      day: picker.day,
      time: picker.time,
    });
    setLabelText("");
    setLabelEmployeeId(null);
    setLabelEmployeeSearch("");
    setPicker(null);
  }

  function handleLabelSubmit() {
    if (!labelInput || !labelText.trim()) return;
    const endMins = timeToMinutes(labelInput.time) + 30;
    const endTime = minutesToTime(Math.min(endMins, END_MINUTES));
    createBlock(
      labelInput.roomId,
      labelInput.columnIndex,
      labelInput.day,
      labelInput.time,
      endTime,
      labelEmployeeId,
      labelText.trim()
    );
    setLabelInput(null);
    setLabelText("");
    setLabelEmployeeId(null);
    setLabelEmployeeSearch("");
  }

  // --- Duplicate ---
  function handleDuplicate() {
    if (!contextMenu) return;
    const block = blocks.find((b) => b.id === contextMenu.blockId);
    if (!block) return;
    const duration = timeToMinutes(block.end_time) - timeToMinutes(block.start_time);
    setDuplicateMode({
      employeeId: block.employee_id,
      label: block.label,
      durationMinutes: duration,
    });
    setContextMenu(null);
  }

  // --- Publish / Unpublish ---
  async function togglePublish() {
    if (!schedule) return;
    const newStatus = schedule.status === "published" ? "draft" : "published";
    const { error } = await supabase
      .from("schedules")
      .update({ status: newStatus })
      .eq("id", schedule.id);
    if (!error) {
      setSchedule((prev) => (prev ? { ...prev, status: newStatus } : prev));
    } else {
      setWarning(error.message);
    }
  }

  // --- Copy Previous Week ---
  async function copyPreviousWeek() {
    if (!schedule) return;
    setSaving(true);

    const { data: prevSchedule } = await supabase
      .from("schedules")
      .select("id")
      .lt("week_start", schedule.week_start)
      .order("week_start", { ascending: false })
      .limit(1)
      .single();

    if (!prevSchedule) {
      setWarning("No previous schedule found to copy from.");
      setSaving(false);
      return;
    }

    const [prevRoomsRes, prevBlocksRes] = await Promise.all([
      supabase
        .from("schedule_rooms")
        .select("*")
        .eq("schedule_id", prevSchedule.id)
        .order("sort_order"),
      supabase
        .from("schedule_blocks")
        .select("*")
        .eq("schedule_id", prevSchedule.id),
    ]);

    const prevRooms = prevRoomsRes.data ?? [];
    const prevBlocks = prevBlocksRes.data ?? [];

    if (prevRooms.length === 0) {
      setWarning("Previous schedule has no rooms to copy.");
      setSaving(false);
      return;
    }

    if (rooms.length > 0) {
      if (!confirm("This will replace all current rooms and blocks. Continue?")) {
        setSaving(false);
        return;
      }
      await supabase
        .from("schedule_rooms")
        .delete()
        .eq("schedule_id", scheduleId);
    }

    const { data: newRooms } = await supabase
      .from("schedule_rooms")
      .insert(
        prevRooms.map((r) => ({
          schedule_id: scheduleId,
          name: r.name,
          capacity: r.capacity,
          sort_order: r.sort_order,
        }))
      )
      .select();

    if (newRooms && prevBlocks.length > 0) {
      const roomMap = new Map<string, string>();
      for (const oldRoom of prevRooms) {
        const newRoom = newRooms.find((r) => r.sort_order === oldRoom.sort_order);
        if (newRoom) roomMap.set(oldRoom.id, newRoom.id);
      }

      const newBlocks = prevBlocks
        .filter((b) => roomMap.has(b.room_id))
        .map((b) => ({
          schedule_id: scheduleId,
          room_id: roomMap.get(b.room_id)!,
          employee_id: b.employee_id,
          day_of_week: b.day_of_week,
          start_time: b.start_time,
          end_time: b.end_time,
          column_index: b.column_index,
          label: b.label,
        }));

      if (newBlocks.length > 0) {
        await supabase.from("schedule_blocks").insert(newBlocks);
      }
    }

    await fetchData();
    setSaving(false);
  }

  // --- Delete Schedule ---
  async function handleDeleteSchedule() {
    if (!schedule) return;
    if (!confirm("Delete this schedule and all its rooms and blocks?")) return;
    const { error } = await supabase.from("schedules").delete().eq("id", schedule.id);
    if (!error) {
      onBack();
    } else {
      setWarning(error.message);
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ fontWeight: 800 }}>Loading schedule…</div>
      </div>
    );
  }

  if (!schedule) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ fontWeight: 800, color: "#dc2626" }}>Schedule not found.</div>
        <button className="btn" onClick={onBack} style={{ marginTop: 12 }}>
          Back to list
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 0",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            className="btn"
            onClick={onBack}
            style={{ padding: "6px 14px", fontSize: 13 }}
          >
            &larr; Back
          </button>
          <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>
            {formatWeekRange(schedule.week_start)}
          </h2>
          <span
            style={{
              padding: "4px 12px",
              borderRadius: 20,
              fontSize: 12,
              fontWeight: 700,
              background: schedule.status === "published" ? "#dcfce7" : "#fef3c7",
              color: schedule.status === "published" ? "#16a34a" : "#d97706",
            }}
          >
            {schedule.status === "published" ? "Published" : "Draft"}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!readOnly && (
            <>
              <button className="btn" onClick={copyPreviousWeek} disabled={saving}>
                Copy Previous Week
              </button>
              <button className="btn" onClick={addRoom}>
                + Add Room
              </button>
            </>
          )}
          <button
            className="btn btn-pink"
            onClick={togglePublish}
          >
            {schedule.status === "published" ? "Unpublish" : "Publish"}
          </button>
          <button
            className="btn"
            onClick={handleDeleteSchedule}
            style={{ color: "#dc2626", borderColor: "#fca5a5" }}
          >
            Delete
          </button>
        </div>
      </div>

      {/* Warning banner */}
      {warning && (
        <div
          style={{
            padding: "10px 16px",
            background: "#fef2f2",
            color: "#dc2626",
            borderRadius: 10,
            marginBottom: 12,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {warning}
        </div>
      )}

      {/* Duplicate mode banner */}
      {duplicateMode && (
        <div
          style={{
            padding: "10px 16px",
            background: "#eff6ff",
            color: "#2563eb",
            borderRadius: 10,
            marginBottom: 12,
            fontSize: 13,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>
            Duplicate mode: Click a cell to place a{" "}
            {duplicateMode.durationMinutes}-min block.
          </span>
          <button
            onClick={() => setDuplicateMode(null)}
            style={{
              border: "none",
              background: "#dbeafe",
              padding: "4px 10px",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Label input modal */}
      {labelInput && (
        <div
          style={{
            padding: "10px 16px",
            background: "#f0f9ff",
            borderRadius: 10,
            marginBottom: 12,
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 13 }}>Label:</span>
          <input
            type="text"
            value={labelText}
            onChange={(e) => setLabelText(e.target.value)}
            placeholder="e.g., Lunch, Break, Office"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") handleLabelSubmit();
              if (e.key === "Escape") setLabelInput(null);
            }}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1.5px solid #e5e7eb",
              fontSize: 13,
              width: 200,
            }}
          />
          <div style={{ position: "relative" }}>
            <input
              type="text"
              value={labelEmployeeId ? (employees.find((e) => e.id === labelEmployeeId) ? formatEmployeeName(employees.find((e) => e.id === labelEmployeeId)!) : "Selected") : labelEmployeeSearch}
              onChange={(e) => {
                setLabelEmployeeSearch(e.target.value);
                setLabelEmployeeId(null);
              }}
              placeholder="Attach employee (optional)"
              style={{
                padding: "6px 10px",
                borderRadius: 8,
                border: "1.5px solid #e5e7eb",
                fontSize: 13,
                width: 200,
              }}
            />
            {labelEmployeeSearch && !labelEmployeeId && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  width: 260,
                  maxHeight: 180,
                  overflowY: "auto",
                  background: "white",
                  border: "1.5px solid #e5e7eb",
                  borderRadius: 8,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                  zIndex: 50,
                }}
              >
                {employees
                  .filter((e) => {
                    const name = formatEmployeeName(e).toLowerCase();
                    return name.includes(labelEmployeeSearch.toLowerCase());
                  })
                  .slice(0, 10)
                  .map((emp) => (
                    <button
                      key={emp.id}
                      onClick={() => {
                        setLabelEmployeeId(emp.id);
                        setLabelEmployeeSearch("");
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        padding: "6px 10px",
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "#f3f4f6")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      {formatEmployeeName(emp)}
                    </button>
                  ))}
              </div>
            )}
          </div>
          {labelEmployeeId && (
            <button
              className="btn"
              onClick={() => { setLabelEmployeeId(null); setLabelEmployeeSearch(""); }}
              style={{ padding: "4px 8px", fontSize: 11 }}
            >
              ✕ Clear employee
            </button>
          )}
          <button className="btn btn-pink" onClick={handleLabelSubmit} style={{ padding: "6px 14px", fontSize: 13 }}>
            Add
          </button>
          <button className="btn" onClick={() => setLabelInput(null)} style={{ padding: "6px 14px", fontSize: 13 }}>
            Cancel
          </button>
        </div>
      )}

      {/* Room edit inline */}
      {roomEdit && (
        <div
          style={{
            padding: "10px 16px",
            background: "#fdf2f8",
            borderRadius: 10,
            marginBottom: 12,
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 13 }}>Edit Room:</span>
          <input
            type="text"
            value={roomEdit.name}
            onChange={(e) => setRoomEdit({ ...roomEdit, name: e.target.value })}
            placeholder="Room name"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRoomEditSave();
              if (e.key === "Escape") setRoomEdit(null);
            }}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1.5px solid #e5e7eb",
              fontSize: 13,
              width: 160,
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#6b7280" }}>Capacity:</label>
            <input
              type="number"
              min={1}
              max={10}
              value={roomEdit.capacity}
              onChange={(e) =>
                setRoomEdit({ ...roomEdit, capacity: Math.max(1, parseInt(e.target.value) || 1) })
              }
              style={{
                width: 50,
                padding: "4px 6px",
                borderRadius: 6,
                border: "1px solid #e5e7eb",
                fontSize: 13,
                textAlign: "center",
              }}
            />
          </div>
          <button className="btn btn-pink" onClick={handleRoomEditSave} style={{ padding: "6px 14px", fontSize: 13 }}>
            Save
          </button>
          <button
            className="btn"
            onClick={() => {
              deleteRoom(roomEdit.roomId);
              setRoomEdit(null);
            }}
            style={{ padding: "6px 14px", fontSize: 13, color: "#dc2626", borderColor: "#fca5a5" }}
          >
            Delete Room
          </button>
          <button className="btn" onClick={() => setRoomEdit(null)} style={{ padding: "6px 14px", fontSize: 13 }}>
            Cancel
          </button>
        </div>
      )}

      {/* Paint mode toolbar */}
      {!readOnly && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
            padding: "8px 12px",
            background: paintMode ? "#fffbeb" : "#f9fafb",
            borderRadius: 10,
            border: paintMode ? "1.5px solid #fbbf24" : "1.5px solid #e5e7eb",
            flexWrap: "wrap",
          }}
        >
          <button
            className={paintMode ? "btn btn-pink" : "btn"}
            onClick={() => {
              setPaintMode(!paintMode);
              setPaintErase(false);
            }}
            style={{ padding: "6px 14px", fontSize: 13 }}
          >
            {paintMode ? "🎨 Paint ON" : "🎨 Paint"}
          </button>
          {paintMode && (
            <>
              <input
                type="color"
                value={paintColor}
                onChange={(e) => {
                  setPaintColor(e.target.value);
                  setPaintErase(false);
                }}
                style={{
                  width: 32,
                  height: 28,
                  border: "1.5px solid #d1d5db",
                  borderRadius: 6,
                  cursor: "pointer",
                  padding: 0,
                }}
                title="Pick color"
              />
              <div style={{ display: "flex", gap: 4 }}>
                {["#fde68a", "#bbf7d0", "#bfdbfe", "#fecaca", "#e9d5ff", "#fed7aa"].map((c) => (
                  <button
                    key={c}
                    onClick={() => { setPaintColor(c); setPaintErase(false); }}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      background: c,
                      border: paintColor === c && !paintErase ? "2px solid #111" : "1px solid #d1d5db",
                      cursor: "pointer",
                    }}
                    title={c}
                  />
                ))}
              </div>
              <button
                className="btn"
                onClick={() => setPaintErase(!paintErase)}
                style={{
                  padding: "6px 12px",
                  fontSize: 12,
                  background: paintErase ? "#fef2f2" : undefined,
                  borderColor: paintErase ? "#fca5a5" : undefined,
                }}
              >
                {paintErase ? "🧹 Erasing" : "🧹 Erase"}
              </button>
              <button
                className="btn"
                onClick={handleColorUndo}
                disabled={colorUndoStack.length === 0}
                style={{ padding: "6px 12px", fontSize: 12 }}
              >
                ↩ Undo
              </button>
            </>
          )}
        </div>
      )}

      {/* Day tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        {DAY_NUMBERS.map((dayNum, idx) => (
          <button
            key={dayNum}
            onClick={() => setActiveDay(dayNum)}
            style={{
              padding: "8px 16px",
              borderRadius: 10,
              border:
                activeDay === dayNum
                  ? "1.5px solid rgba(230,23,141,0.35)"
                  : "1.5px solid #e5e7eb",
              background:
                activeDay === dayNum ? "rgba(230,23,141,0.06)" : "white",
              color: activeDay === dayNum ? "#e6178d" : "#111827",
              fontWeight: 700,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {DAY_LABELS[idx]}
          </button>
        ))}
      </div>

      {/* Grid */}
      <div
        data-schedule-grid
        style={{ position: "relative", border: "1.5px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}
      >
        <ScheduleGrid
          rooms={rooms}
          blocks={blocks}
          employees={employees}
          day={activeDay}
          readOnly={readOnly}
          onCellClick={handleCellClick}
          onBlockContextMenu={(blockId, x, y) => {
            if (!readOnly) setContextMenu({ blockId, x, y });
          }}
          onBlockResize={handleBlockResize}
          onBlockMoveToColumn={handleBlockMoveToColumn}
          onRoomUpdate={handleRoomEditTrigger}
          onRoomDelete={deleteRoom}
          paintMode={paintMode}
          cellColors={cellColors[activeDay] ?? {}}
          onPaintCells={handlePaintCells}
        />

        {/* Employee picker overlay */}
        {picker && (
          <EmployeePickerDropdown
            employees={employees}
            onSelect={handleSelectEmployee}
            onSelectLabel={handleSelectLabel}
            onClose={() => setPicker(null)}
            style={{ top: 80, left: 100 }}
          />
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <BlockContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onDuplicate={handleDuplicate}
          onDelete={() => deleteBlock(contextMenu.blockId)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Saving indicator */}
      {saving && (
        <div
          style={{
            position: "fixed",
            bottom: 20,
            right: 20,
            padding: "8px 16px",
            background: "#fdf2f8",
            border: "1px solid #f9a8d4",
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 700,
            color: "#e6178d",
            zIndex: 50,
          }}
        >
          Saving…
        </div>
      )}
    </div>
  );
}
