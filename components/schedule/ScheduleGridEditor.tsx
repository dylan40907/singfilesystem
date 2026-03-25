"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import RoomHeader from "./RoomHeader";
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
  const [warning, setWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const readOnly = schedule?.status === "published";

  // Fetch all data
  const fetchData = useCallback(async () => {
    setLoading(true);
    const [schedRes, roomsRes, blocksRes, empRes] = await Promise.all([
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
    ]);

    if (schedRes.data) setSchedule(schedRes.data);
    if (roomsRes.data) setRooms(roomsRes.data);
    if (blocksRes.data) setBlocks(blocksRes.data);
    if (empRes.data) setEmployees(empRes.data);
    setLoading(false);
  }, [scheduleId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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

    // Optimistic update
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
      fetchData(); // revert
    }
  }

  async function handleBlockMove(blockId: string, deltaSlots: number) {
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

  // --- Cell click handler ---
  function handleCellClick(roomId: string, columnIndex: number, day: number, time: string) {
    if (readOnly) return;

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
      null,
      labelText.trim()
    );
    setLabelInput(null);
    setLabelText("");
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

    // Fetch previous rooms and blocks
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

    // Delete existing rooms (cascade deletes blocks)
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

    // Insert new rooms
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
      // Map old room IDs to new room IDs (by sort_order)
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
              flex: 1,
              maxWidth: 300,
            }}
          />
          <button className="btn btn-pink" onClick={handleLabelSubmit} style={{ padding: "6px 14px", fontSize: 13 }}>
            Add
          </button>
          <button className="btn" onClick={() => setLabelInput(null)} style={{ padding: "6px 14px", fontSize: 13 }}>
            Cancel
          </button>
        </div>
      )}

      {/* Room headers */}
      {rooms.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 4,
            marginBottom: 8,
            overflowX: "auto",
            paddingLeft: 64, // align with grid (time column width)
          }}
        >
          {rooms.map((room) => (
            <div key={room.id} style={{ minWidth: 120 * room.capacity, flex: `0 0 ${120 * room.capacity}px` }}>
              <RoomHeader
                room={room}
                onUpdate={updateRoom}
                onDelete={deleteRoom}
                readOnly={readOnly}
              />
            </div>
          ))}
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
      <div style={{ position: "relative", border: "1.5px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
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
          onBlockMove={handleBlockMove}
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
