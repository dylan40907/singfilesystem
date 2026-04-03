"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  Schedule,
  ScheduleRoom,
  ScheduleBlock as ScheduleBlockType,
  EmployeeLite,
  BlockType,
  formatWeekRange,
  formatEmployeeName,
  getDisplayName,
  timeToMinutes,
  minutesToTime,
  snapMinutes,
  detectConflicts,
  DAY_LABELS,
  DAY_NUMBERS,
  SLOT_MINUTES,
  START_MINUTES,
  END_MINUTES,
  calculatePaidMinutes,
} from "@/lib/scheduleUtils";
import ScheduleGrid from "./ScheduleGrid";
import BlockContextMenu from "./BlockContextMenu";

interface ScheduleGridEditorProps {
  scheduleId: string;
  onBack: () => void;
}

type ContextMenuState = {
  blockId: string;
  x: number;
  y: number;
} | null;

type DuplicateMode = {
  employeeId: string | null;
  label: string | null;
  durationMinutes: number;
  blockType: BlockType;
} | null;

type RoomEditState = {
  roomId: string;
  name: string;
  capacity: number;
} | null;

// State for the 3-option type picker popup
type TypePickerState = {
  x: number;
  y: number;
  roomId: string;
  columnIndex: number;
  day: number;
  time: string;
} | null;

// State for the block creation/edit form popup
type BlockFormState = {
  x: number;
  y: number;
  roomId: string;
  columnIndex: number;
  day: number;
  time: string;
  blockType: BlockType;
  editBlockId?: string; // set when editing existing block
} | null;

export default function ScheduleGridEditor({ scheduleId, onBack }: ScheduleGridEditorProps) {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [rooms, setRooms] = useState<ScheduleRoom[]>([]);
  const [blocks, setBlocks] = useState<ScheduleBlockType[]>([]);
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [loading, setLoading] = useState(true);

  const [activeDay, setActiveDay] = useState<number>(1);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [duplicateMode, setDuplicateMode] = useState<DuplicateMode>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [roomEdit, setRoomEdit] = useState<RoomEditState>(null);

  // Type picker + block form
  const [typePicker, setTypePicker] = useState<TypePickerState>(null);
  const [blockForm, setBlockForm] = useState<BlockFormState>(null);
  const [blockFormEmployeeId, setBlockFormEmployeeId] = useState<string | null>(null);
  const [blockFormEmployeeSearch, setBlockFormEmployeeSearch] = useState("");
  const [blockFormNotes, setBlockFormNotes] = useState("");
  const [blockFormEmpOpen, setBlockFormEmpOpen] = useState(false);


  // Paint mode state
  const [paintMode, setPaintMode] = useState(false);
  const [paintColor, setPaintColor] = useState("#fde68a");
  const [paintErase, setPaintErase] = useState(false);
  const [cellColors, setCellColors] = useState<Record<number, Record<string, string>>>({});
  const [colorUndoStack, setColorUndoStack] = useState<Record<number, Record<string, string>>[]>([]);
  const colorSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Color legend labels: maps hex color → label text
  const [colorLabels, setColorLabels] = useState<Record<string, string>>({});
  const colorLabelsSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Weekly hours view
  const [showHoursView, setShowHoursView] = useState(false);
  const [hoursSearch, setHoursSearch] = useState("");

  const readOnly = schedule?.status === "published";

  // No document listener needed — outside clicks handled by backdrop divs

  // Fetch all data
  const fetchData = useCallback(async () => {
    setLoading(true);
    const [schedRes, roomsRes, blocksRes, empRes, colorsRes] = await Promise.all([
      supabase.from("schedules").select("*").eq("id", scheduleId).single(),
      supabase.from("schedule_rooms").select("*").eq("schedule_id", scheduleId).order("sort_order"),
      supabase.from("schedule_blocks").select("*").eq("schedule_id", scheduleId),
      supabase
        .from("hr_employees")
        .select("id, legal_first_name, legal_middle_name, legal_last_name, nicknames, is_active, profile_id")
        .eq("is_active", true)
        .order("legal_first_name"),
      supabase.from("schedule_cell_colors").select("day_of_week, colors").eq("schedule_id", scheduleId),
    ]);

    if (schedRes.data) {
      setSchedule(schedRes.data);
      setColorLabels((schedRes.data.color_labels as Record<string, string>) ?? {});
    }
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
      await supabase.from("schedule_cell_colors").upsert(
        { schedule_id: scheduleId, day_of_week: day, colors, updated_at: new Date().toISOString() },
        { onConflict: "schedule_id,day_of_week" }
      );
    }, 300);
  }

  function handlePaintCells(cellKeys: string[]) {
    if (!paintMode) return;
    setColorUndoStack((prev) => [...prev.slice(-20), JSON.parse(JSON.stringify(cellColors))]);
    setCellColors((prev) => {
      const dayColors = { ...(prev[activeDay] ?? {}) };
      for (const key of cellKeys) {
        if (paintErase) delete dayColors[key];
        else dayColors[key] = paintColor;
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
    saveCellColors(activeDay, prevState[activeDay] ?? {});
  }

  // Save color labels (debounced)
  function saveColorLabels(labels: Record<string, string>) {
    if (colorLabelsSaveTimeout.current) clearTimeout(colorLabelsSaveTimeout.current);
    colorLabelsSaveTimeout.current = setTimeout(async () => {
      await supabase.from("schedules").update({ color_labels: labels }).eq("id", scheduleId);
    }, 400);
  }

  function handleColorLabelChange(color: string, label: string) {
    const next = { ...colorLabels, [color]: label };
    setColorLabels(next);
    saveColorLabels(next);
  }

  // Colors actually used across all days in this schedule
  const usedColors = useMemo(() => {
    const colorSet = new Set<string>();
    for (const dayColors of Object.values(cellColors)) {
      for (const c of Object.values(dayColors)) {
        colorSet.add(c);
      }
    }
    return [...colorSet].sort();
  }, [cellColors]);

  // Weekly hours: all employees with blocks, total paid minutes per employee
  const weeklyHours = useMemo(() => {
    const paidByEmp = new Map<string, number>();
    for (const b of blocks) {
      if (!b.employee_id || b.block_type === "lunch_break") continue;
      const dur = timeToMinutes(b.end_time) - timeToMinutes(b.start_time);
      paidByEmp.set(b.employee_id, (paidByEmp.get(b.employee_id) ?? 0) + dur);
    }
    return [...paidByEmp.entries()]
      .map(([empId, mins]) => {
        const emp = employees.find((e) => e.id === empId);
        return { empId, name: emp ? getDisplayName(emp) : empId, mins };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [blocks, employees]);

  // Compute per-block warnings. Overtime takes priority: if overtime exists for an
  // employee on a given day, only the overtime warning is shown (5h / break warnings suppressed).
  const blockWarnings = useMemo((): Map<string, string[]> => {
    const warnings = new Map<string, string[]>();
    const fmt = (m: number) => {
      const h = Math.floor(m / 60);
      const min = m % 60;
      return min === 0 ? `${h}h` : `${h}h ${min}m`;
    };

    // Group by employee+day for multi-block checks
    const grouped = new Map<string, ScheduleBlockType[]>();
    for (const b of blocks) {
      if (!b.employee_id) continue;
      const key = `${b.employee_id}:${b.day_of_week}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(b);
    }

    // Track which block IDs have overtime so we can suppress lower-priority warnings
    const overtimeBlockIds = new Set<string>();

    for (const empBlocks of grouped.values()) {
      const day = empBlocks[0].day_of_week;
      const emp = employees.find((e) => e.id === empBlocks[0].employee_id);
      const name = emp ? getDisplayName(emp) : "Employee";
      const dayLabel = DAY_LABELS[day - 1];

      // Overtime: total paid (shift + break, not lunch) > 8h
      const paidMins = empBlocks
        .filter((b) => b.block_type !== "lunch_break")
        .reduce((s, b) => s + timeToMinutes(b.end_time) - timeToMinutes(b.start_time), 0);
      if (paidMins > 480) {
        const msg = `Overtime: ${name} has ${fmt(paidMins)} paid time on ${dayLabel} (over 8h).`;
        for (const b of empBlocks.filter((b) => b.block_type !== "lunch_break")) {
          const arr = warnings.get(b.id) ?? [];
          arr.push(msg);
          warnings.set(b.id, arr);
          overtimeBlockIds.add(b.id);
        }
        continue; // skip lower-priority checks for this employee+day
      }

      // 5h+ straight shift (single block >= 5h)
      for (const b of empBlocks.filter((b) => b.block_type === "shift")) {
        const dur = timeToMinutes(b.end_time) - timeToMinutes(b.start_time);
        if (dur >= 300) {
          const arr = warnings.get(b.id) ?? [];
          arr.push(`Shift is ${fmt(dur)} long — a lunch break should be inserted.`);
          warnings.set(b.id, arr);
        }
      }

      // 6h+ shift time with < 2 qualifying breaks
      const shiftMins = empBlocks
        .filter((b) => b.block_type === "shift")
        .reduce((s, b) => s + timeToMinutes(b.end_time) - timeToMinutes(b.start_time), 0);
      if (shiftMins >= 360) {
        const qualBreaks = empBlocks.filter(
          (b) =>
            b.block_type === "break" &&
            timeToMinutes(b.end_time) - timeToMinutes(b.start_time) >= 10
        );
        if (qualBreaks.length < 2) {
          const cnt = qualBreaks.length;
          const msg = `${name} has ${fmt(shiftMins)} of shifts on ${dayLabel} but only ${cnt} qualifying break${cnt !== 1 ? "s" : ""} — needs 2 × 10 min breaks.`;
          for (const b of empBlocks.filter((b) => b.block_type === "shift")) {
            const arr = warnings.get(b.id) ?? [];
            arr.push(msg);
            warnings.set(b.id, arr);
          }
        }
      }
    }

    return warnings;
  }, [blocks, employees]);

  // Clear warning after 4s
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
      .insert({ schedule_id: scheduleId, name: `Room ${rooms.length + 1}`, capacity: 2, sort_order: nextOrder })
      .select()
      .single();
    if (data) setRooms((prev) => [...prev, data]);
    if (error) setWarning(error.message);
  }

  async function updateRoom(roomId: string, updates: { name?: string; capacity?: number }) {
    const { error } = await supabase.from("schedule_rooms").update(updates).eq("id", roomId);
    if (!error) {
      setRooms((prev) => prev.map((r) => (r.id === roomId ? { ...r, ...updates } : r)));
      if (updates.capacity !== undefined) {
        const room = rooms.find((r) => r.id === roomId);
        if (room && updates.capacity < room.capacity) {
          const toDelete = blocks.filter((b) => b.room_id === roomId && b.column_index >= updates.capacity!);
          if (toDelete.length > 0) {
            await supabase.from("schedule_blocks").delete().in("id", toDelete.map((b) => b.id));
            setBlocks((prev) => prev.filter((b) => !toDelete.some((d) => d.id === b.id)));
          }
        }
      }
    } else {
      setWarning(error.message);
    }
  }

  async function deleteRoom(roomId: string) {
    const roomBlocks = blocks.filter((b) => b.room_id === roomId);
    if (roomBlocks.length > 0 && !confirm(`Delete this room and its ${roomBlocks.length} blocks?`)) return;
    const { error } = await supabase.from("schedule_rooms").delete().eq("id", roomId);
    if (!error) {
      setRooms((prev) => prev.filter((r) => r.id !== roomId));
      setBlocks((prev) => prev.filter((b) => b.room_id !== roomId));
    } else {
      setWarning(error.message);
    }
  }

  function handleRoomEditTrigger(roomId: string, _updates: { name?: string; capacity?: number }) {
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
    await updateRoom(roomEdit.roomId, { name: roomEdit.name.trim() || "Room", capacity: roomEdit.capacity });
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
    label: string | null,
    blockType: BlockType
  ) {
    const candidate = { employee_id: employeeId, day_of_week: day, start_time: startTime, end_time: endTime };
    const conflicts = detectConflicts(blocks, candidate);
    if (conflicts.length > 0) {
      const emp = employees.find((e) => e.id === employeeId);
      setWarning(`Conflict: ${emp ? getDisplayName(emp) : "Employee"} already has a block at this time on this day.`);
      return;
    }

    setSaving(true);
    const { data, error } = await supabase
      .from("schedule_blocks")
      .insert({ schedule_id: scheduleId, room_id: roomId, column_index: columnIndex, day_of_week: day, start_time: startTime, end_time: endTime, employee_id: employeeId, label, block_type: blockType })
      .select()
      .single();
    if (data) setBlocks((prev) => [...prev, data]);
    if (error) setWarning(error.message);
    setSaving(false);
  }

  async function updateBlock(blockId: string, employeeId: string | null, label: string | null) {
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;

    const candidate = { id: blockId, employee_id: employeeId, day_of_week: block.day_of_week, start_time: block.start_time, end_time: block.end_time };
    const conflicts = detectConflicts(blocks, candidate);
    if (conflicts.length > 0) {
      setWarning("Conflict: Employee already has a block at this time on this day.");
      return;
    }

    setSaving(true);
    const { error } = await supabase
      .from("schedule_blocks")
      .update({ employee_id: employeeId, label })
      .eq("id", blockId);
    if (!error) {
      setBlocks((prev) => prev.map((b) => (b.id === blockId ? { ...b, employee_id: employeeId, label } : b)));
    } else {
      setWarning(error.message);
    }
    setSaving(false);
  }

  async function deleteBlock(blockId: string) {
    const { error } = await supabase.from("schedule_blocks").delete().eq("id", blockId);
    if (!error) setBlocks((prev) => prev.filter((b) => b.id !== blockId));
    else setWarning(error.message);
    setContextMenu(null);
  }

  async function handleBlockResize(blockId: string, newStartTime: string, newEndTime: string) {
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;

    const candidate = { id: blockId, employee_id: block.employee_id, day_of_week: block.day_of_week, start_time: newStartTime, end_time: newEndTime };
    const conflicts = detectConflicts(blocks, candidate);
    if (conflicts.length > 0) {
      setWarning("Conflict: This resize would overlap with another block for the same employee.");
      return;
    }

    setBlocks((prev) => prev.map((b) => (b.id === blockId ? { ...b, start_time: newStartTime, end_time: newEndTime } : b)));
    const { error } = await supabase.from("schedule_blocks").update({ start_time: newStartTime, end_time: newEndTime }).eq("id", blockId);
    if (error) { setWarning(error.message); fetchData(); }
  }

  async function handleBlockMoveToColumn(blockId: string, newRoomId: string, newColumnIndex: number, deltaSlots: number) {
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

    if (newRoomId === block.room_id && newColumnIndex === block.column_index && newStartTime === block.start_time) return;

    const candidate = { id: blockId, employee_id: block.employee_id, day_of_week: block.day_of_week, start_time: newStartTime, end_time: newEndTime };
    const conflicts = detectConflicts(blocks, candidate);
    if (conflicts.length > 0) {
      setWarning("Conflict: This move would overlap with another block for the same employee.");
      return;
    }

    const targetRoom = rooms.find((r) => r.id === newRoomId);
    if (!targetRoom || newColumnIndex >= targetRoom.capacity) { setWarning("Invalid target column."); return; }

    setBlocks((prev) =>
      prev.map((b) =>
        b.id === blockId ? { ...b, room_id: newRoomId, column_index: newColumnIndex, start_time: newStartTime, end_time: newEndTime } : b
      )
    );

    const { error } = await supabase.from("schedule_blocks").update({ room_id: newRoomId, column_index: newColumnIndex, start_time: newStartTime, end_time: newEndTime }).eq("id", blockId);
    if (error) { setWarning(error.message); fetchData(); }
  }

  // --- Cell click → type picker ---
  function handleCellClick(roomId: string, columnIndex: number, day: number, time: string, clientX: number, clientY: number) {
    if (readOnly || paintMode) return;

    if (duplicateMode) {
      const endMins = timeToMinutes(time) + duplicateMode.durationMinutes;
      const endTime = minutesToTime(Math.min(endMins, END_MINUTES));
      createBlock(roomId, columnIndex, day, time, endTime, duplicateMode.employeeId, duplicateMode.label, duplicateMode.blockType);
      setDuplicateMode(null);
      return;
    }

    setTypePicker({ x: clientX, y: clientY, roomId, columnIndex, day, time });
  }

  // Open block form from type picker
  function openBlockForm(blockType: BlockType) {
    if (!typePicker) return;
    setBlockForm({ ...typePicker, blockType });
    setBlockFormEmployeeId(null);
    setBlockFormEmployeeSearch("");
    setBlockFormNotes("");
    setBlockFormEmpOpen(false);
    setTypePicker(null);
  }

  // Open block form for editing an existing block
  function handleEditBlock() {
    if (!contextMenu) return;
    const block = blocks.find((b) => b.id === contextMenu.blockId);
    if (!block) return;
    setBlockForm({
      x: contextMenu.x,
      y: contextMenu.y,
      roomId: block.room_id,
      columnIndex: block.column_index,
      day: block.day_of_week,
      time: block.start_time,
      blockType: block.block_type,
      editBlockId: block.id,
    });
    setBlockFormEmployeeId(block.employee_id);
    setBlockFormEmployeeSearch(block.employee_id ? "" : "");
    setBlockFormNotes(block.block_type === "shift" && block.label !== "Unassigned" ? (block.label ?? "") : "");
    setBlockFormEmpOpen(false);
    setContextMenu(null);
  }

  async function handleBlockFormSubmit() {
    if (!blockForm) return;

    // "__unassigned__" sentinel → null in DB
    const empId = blockFormEmployeeId === "__unassigned__" ? null : blockFormEmployeeId;

    if (blockForm.editBlockId) {
      let label: string | null = null;
      if (blockForm.blockType === "lunch_break") label = "Lunch Break";
      else if (blockForm.blockType === "break") label = "Break";
      else label = blockFormNotes.trim() || null;
      await updateBlock(blockForm.editBlockId, empId, label);
    } else {
      const endMins = timeToMinutes(blockForm.time) + 10; // 10-minute default
      const endTime = minutesToTime(Math.min(endMins, END_MINUTES));
      let label: string | null = null;
      if (blockForm.blockType === "lunch_break") label = "Lunch Break";
      else if (blockForm.blockType === "break") label = "Break";
      else label = blockFormNotes.trim() || (empId === null ? "Unassigned" : null);
      await createBlock(blockForm.roomId, blockForm.columnIndex, blockForm.day, blockForm.time, endTime, empId, label, blockForm.blockType);
    }

    setBlockForm(null);
    setBlockFormEmployeeId(null);
    setBlockFormEmployeeSearch("");
    setBlockFormNotes("");
  }

  // --- Duplicate ---
  function handleDuplicate() {
    if (!contextMenu) return;
    const block = blocks.find((b) => b.id === contextMenu.blockId);
    if (!block) return;
    const duration = timeToMinutes(block.end_time) - timeToMinutes(block.start_time);
    setDuplicateMode({ employeeId: block.employee_id, label: block.label, durationMinutes: duration, blockType: block.block_type });
    setContextMenu(null);
  }

  // --- Publish / Unpublish ---
  async function togglePublish() {
    if (!schedule) return;
    const newStatus = schedule.status === "published" ? "draft" : "published";
    const { error } = await supabase.from("schedules").update({ status: newStatus }).eq("id", schedule.id);
    if (!error) setSchedule((prev) => (prev ? { ...prev, status: newStatus } : prev));
    else setWarning(error.message);
  }

  // --- Copy Previous Week (includes rooms, blocks, and cell colors) ---
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

    const [prevRoomsRes, prevBlocksRes, prevColorsRes, prevSchedRes] = await Promise.all([
      supabase.from("schedule_rooms").select("*").eq("schedule_id", prevSchedule.id).order("sort_order"),
      supabase.from("schedule_blocks").select("*").eq("schedule_id", prevSchedule.id),
      supabase.from("schedule_cell_colors").select("*").eq("schedule_id", prevSchedule.id),
      supabase.from("schedules").select("color_labels").eq("id", prevSchedule.id).single(),
    ]);

    const prevRooms = prevRoomsRes.data ?? [];
    const prevBlocks = prevBlocksRes.data ?? [];
    const prevColors = prevColorsRes.data ?? [];

    if (prevRooms.length === 0) {
      setWarning("Previous schedule has no rooms to copy.");
      setSaving(false);
      return;
    }

    if (rooms.length > 0) {
      if (!confirm("This will replace all current rooms, blocks, and colors. Continue?")) {
        setSaving(false);
        return;
      }
      await supabase.from("schedule_rooms").delete().eq("schedule_id", scheduleId);
    }

    // Always clear existing colors
    await supabase.from("schedule_cell_colors").delete().eq("schedule_id", scheduleId);

    const { data: newRooms } = await supabase
      .from("schedule_rooms")
      .insert(prevRooms.map((r) => ({ schedule_id: scheduleId, name: r.name, capacity: r.capacity, sort_order: r.sort_order })))
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
          block_type: b.block_type ?? "shift",
        }));

      if (newBlocks.length > 0) {
        await supabase.from("schedule_blocks").insert(newBlocks);
      }
    }

    // Copy cell colors — remap old room IDs in color keys to new room IDs
    if (newRooms && prevColors.length > 0) {
      const roomMap2 = new Map<string, string>();
      for (const oldRoom of prevRooms) {
        const newRoom = newRooms.find((r) => r.sort_order === oldRoom.sort_order);
        if (newRoom) roomMap2.set(oldRoom.id, newRoom.id);
      }

      await supabase.from("schedule_cell_colors").insert(
        prevColors.map((c) => {
          const oldColors = c.colors as Record<string, string>;
          const remapped: Record<string, string> = {};
          for (const [key, color] of Object.entries(oldColors)) {
            // key format: "roomId:colIdx:timeSlot"
            const firstColon = key.indexOf(":");
            const oldRoomId = key.slice(0, firstColon);
            const rest = key.slice(firstColon); // ":colIdx:timeSlot"
            const newRoomId = roomMap2.get(oldRoomId);
            if (newRoomId) remapped[newRoomId + rest] = color;
          }
          return {
            schedule_id: scheduleId,
            day_of_week: c.day_of_week,
            colors: remapped,
            updated_at: new Date().toISOString(),
          };
        })
      );
    }

    // Copy color labels from previous schedule
    if (prevSchedRes.data?.color_labels) {
      const labels = prevSchedRes.data.color_labels as Record<string, string>;
      await supabase.from("schedules").update({ color_labels: labels }).eq("id", scheduleId);
    }

    await fetchData();
    setSaving(false);
  }

  // --- Delete Schedule ---
  async function handleDeleteSchedule() {
    if (!schedule) return;
    if (!confirm("Delete this schedule and all its rooms and blocks?")) return;
    const { error } = await supabase.from("schedules").delete().eq("id", schedule.id);
    if (!error) onBack();
    else setWarning(error.message);
  }

  // Employee search helpers for block form
  const blockFormEmpResults = employees.filter((e) => {
    if (!blockFormEmployeeSearch.trim()) return true;
    const name = formatEmployeeName(e).toLowerCase();
    const nick = Array.isArray(e.nicknames) ? e.nicknames.join(" ").toLowerCase() : (e.nicknames ?? "").toLowerCase();
    const q = blockFormEmployeeSearch.toLowerCase();
    return name.includes(q) || nick.includes(q);
  }).slice(0, 12);

  const selectedEmpName = blockFormEmployeeId === "__unassigned__"
    ? "Unassigned"
    : blockFormEmployeeId
      ? (() => { const e = employees.find((emp) => emp.id === blockFormEmployeeId); return e ? getDisplayName(e) : ""; })()
      : "";

  if (loading) {
    return <div style={{ padding: 24 }}><div style={{ fontWeight: 800 }}>Loading schedule…</div></div>;
  }

  if (!schedule) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ fontWeight: 800, color: "#dc2626" }}>Schedule not found.</div>
        <button className="btn" onClick={onBack} style={{ marginTop: 12 }}>Back to list</button>
      </div>
    );
  }

  const blockTypeLabel = (t: BlockType) =>
    t === "lunch_break" ? "Lunch Break" : t === "break" ? "Break" : "Shift";

  // Smart popup position: offset from cursor, clamped
  function popupPos(x: number, y: number, w = 260, h = 200) {
    const maxX = typeof window !== "undefined" ? window.innerWidth - w - 8 : x;
    const maxY = typeof window !== "undefined" ? window.innerHeight - h - 8 : y;
    return { left: Math.min(x + 8, maxX), top: Math.min(y + 8, maxY) };
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 0", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button className="btn" onClick={onBack} style={{ padding: "6px 14px", fontSize: 13 }}>&larr; Back</button>
          <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>{formatWeekRange(schedule.week_start)}</h2>
          <span style={{ padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 700, background: schedule.status === "published" ? "#dcfce7" : "#fef3c7", color: schedule.status === "published" ? "#16a34a" : "#d97706" }}>
            {schedule.status === "published" ? "Published" : "Draft"}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!readOnly && (
            <>
              <button className="btn" onClick={copyPreviousWeek} disabled={saving}>Copy Previous Week</button>
              <button className="btn" onClick={addRoom}>+ Add Room</button>
            </>
          )}
          <button className="btn" onClick={() => setShowHoursView(true)}>⏱ Hours</button>
          <button className="btn btn-pink" onClick={togglePublish}>
            {schedule.status === "published" ? "Unpublish" : "Publish"}
          </button>
          <button className="btn" onClick={handleDeleteSchedule} style={{ color: "#dc2626", borderColor: "#fca5a5" }}>Delete</button>
        </div>
      </div>

      {/* Warning banner */}
      {warning && (
        <div style={{ padding: "10px 16px", background: "#fef2f2", color: "#dc2626", borderRadius: 10, marginBottom: 12, fontSize: 13, fontWeight: 600 }}>
          {warning}
        </div>
      )}

      {/* Duplicate mode banner */}
      {duplicateMode && (
        <div style={{ padding: "10px 16px", background: "#eff6ff", color: "#2563eb", borderRadius: 10, marginBottom: 12, fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Duplicate mode: Click a cell to place a {duplicateMode.durationMinutes}-min {blockTypeLabel(duplicateMode.blockType)} block.</span>
          <button onClick={() => setDuplicateMode(null)} style={{ border: "none", background: "#dbeafe", padding: "4px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>Cancel</button>
        </div>
      )}

      {/* Room edit panel */}
      {roomEdit && (
        <div style={{ padding: "10px 16px", background: "#fdf2f8", borderRadius: 10, marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>Edit Room:</span>
          <input
            type="text"
            value={roomEdit.name}
            onChange={(e) => setRoomEdit({ ...roomEdit, name: e.target.value })}
            placeholder="Room name"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") handleRoomEditSave(); if (e.key === "Escape") setRoomEdit(null); }}
            style={{ padding: "6px 10px", borderRadius: 8, border: "1.5px solid #e5e7eb", fontSize: 13, width: 160 }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#6b7280" }}>Capacity:</label>
            <input
              type="number" min={1} max={10} value={roomEdit.capacity}
              onChange={(e) => setRoomEdit({ ...roomEdit, capacity: Math.max(1, parseInt(e.target.value) || 1) })}
              style={{ width: 50, padding: "4px 6px", borderRadius: 6, border: "1px solid #e5e7eb", fontSize: 13, textAlign: "center" }}
            />
          </div>
          <button className="btn btn-pink" onClick={handleRoomEditSave} style={{ padding: "6px 14px", fontSize: 13 }}>Save</button>
          <button className="btn" onClick={() => { deleteRoom(roomEdit.roomId); setRoomEdit(null); }} style={{ padding: "6px 14px", fontSize: 13, color: "#dc2626", borderColor: "#fca5a5" }}>Delete Room</button>
          <button className="btn" onClick={() => setRoomEdit(null)} style={{ padding: "6px 14px", fontSize: 13 }}>Cancel</button>
        </div>
      )}

      {/* Paint mode toolbar */}
      {!readOnly && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, padding: "8px 12px", background: paintMode ? "#fffbeb" : "#f9fafb", borderRadius: 10, border: paintMode ? "1.5px solid #fbbf24" : "1.5px solid #e5e7eb", flexWrap: "wrap" }}>
          <button
            className={paintMode ? "btn btn-pink" : "btn"}
            onClick={() => { setPaintMode(!paintMode); setPaintErase(false); }}
            style={{ padding: "6px 14px", fontSize: 13 }}
          >
            {paintMode ? "🎨 Paint ON" : "🎨 Paint"}
          </button>
          {paintMode && (
            <>
              <input
                type="color" value={paintColor}
                onChange={(e) => { setPaintColor(e.target.value); setPaintErase(false); }}
                style={{ width: 32, height: 28, border: "1.5px solid #d1d5db", borderRadius: 6, cursor: "pointer", padding: 0 }}
                title="Pick color"
              />
              <div style={{ display: "flex", gap: 4 }}>
                {["#fde68a", "#bbf7d0", "#bfdbfe", "#fecaca", "#e9d5ff", "#fed7aa", "#f2f2f2", "#dce3eb", "#a5f8e8", "#fff0ee"].map((c) => (
                  <button
                    key={c}
                    onClick={() => { setPaintColor(c); setPaintErase(false); }}
                    style={{ width: 24, height: 24, borderRadius: 6, background: c, border: paintColor === c && !paintErase ? "2px solid #111" : "1px solid #d1d5db", cursor: "pointer" }}
                    title={c}
                  />
                ))}
              </div>
              <button
                className="btn"
                onClick={() => setPaintErase(!paintErase)}
                style={{ padding: "6px 12px", fontSize: 12, background: paintErase ? "#fef2f2" : undefined, borderColor: paintErase ? "#fca5a5" : undefined }}
              >
                {paintErase ? "🧹 Erasing" : "🧹 Erase"}
              </button>
              <button className="btn" onClick={handleColorUndo} disabled={colorUndoStack.length === 0} style={{ padding: "6px 12px", fontSize: 12 }}>
                ↩ Undo
              </button>
            </>
          )}
        </div>
      )}

      {/* Color legend */}
      {usedColors.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, padding: "6px 12px", background: "#f9fafb", borderRadius: 10, border: "1.5px solid #e5e7eb", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", marginRight: 4 }}>Legend:</span>
          {usedColors.map((color) => (
            <div key={color} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 18, height: 18, borderRadius: 4, background: color, border: "1px solid #d1d5db", flexShrink: 0 }} />
              <input
                type="text"
                value={colorLabels[color] ?? ""}
                onChange={(e) => handleColorLabelChange(color, e.target.value)}
                placeholder="Label…"
                style={{ width: 90, padding: "2px 6px", borderRadius: 6, border: "1px solid #e5e7eb", fontSize: 12, fontWeight: 500, color: "#374151", background: "white" }}
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
              padding: "8px 16px", borderRadius: 10,
              border: activeDay === dayNum ? "1.5px solid rgba(230,23,141,0.35)" : "1.5px solid #e5e7eb",
              background: activeDay === dayNum ? "rgba(230,23,141,0.06)" : "white",
              color: activeDay === dayNum ? "#e6178d" : "#111827",
              fontWeight: 700, fontSize: 13, cursor: "pointer",
            }}
          >
            {DAY_LABELS[idx]}
          </button>
        ))}
      </div>

      {/* Grid */}
      <div data-schedule-grid style={{ position: "relative", border: "1.5px solid #e5e7eb", borderRadius: 10 }}>
        <ScheduleGrid
          rooms={rooms}
          blocks={blocks}
          employees={employees}
          day={activeDay}
          readOnly={readOnly}
          onCellClick={handleCellClick}
          onBlockContextMenu={(blockId, x, y) => { if (!readOnly) setContextMenu({ blockId, x, y }); }}
          onBlockResize={handleBlockResize}
          onBlockMoveToColumn={handleBlockMoveToColumn}
          onRoomUpdate={handleRoomEditTrigger}
          onRoomDelete={deleteRoom}
          paintMode={paintMode}
          cellColors={cellColors[activeDay] ?? {}}
          onPaintCells={handlePaintCells}
          blockWarnings={blockWarnings}
        />
      </div>

      {/* Type picker popup */}
      {typePicker && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 59 }}
            onMouseDown={() => setTypePicker(null)}
          />
          <div
            style={{
              position: "fixed",
              ...popupPos(typePicker.x, typePicker.y, 200, 130),
              zIndex: 60,
              background: "white",
              border: "1.5px solid #e5e7eb",
              borderRadius: 10,
              boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
              overflow: "hidden",
              minWidth: 190,
            }}
          >
            {(
              [
                { type: "shift" as BlockType, icon: "👤", label: "Add Shift", color: "#6366f1" },
                { type: "lunch_break" as BlockType, icon: "🥗", label: "Add Lunch Break", color: "#f97316" },
                { type: "break" as BlockType, icon: "☕", label: "Add Break", color: "#22c55e" },
              ] as const
            ).map(({ type, icon, label, color }) => (
              <button
                key={type}
                onClick={() => openBlockForm(type)}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 14px", border: "none", background: "transparent", cursor: "pointer", textAlign: "left", fontSize: 13, fontWeight: 700, color }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                {icon} {label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Block form popup */}
      {blockForm && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 59 }}
            onMouseDown={() => setBlockForm(null)}
          />
          <div
            style={{
              position: "fixed",
              ...popupPos(blockForm.x, blockForm.y, 280, blockForm.blockType === "shift" ? 260 : 200),
              zIndex: 60,
              background: "white",
              border: "1.5px solid #e5e7eb",
              borderRadius: 12,
              boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
              padding: 16,
              width: 280,
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 12, color: blockForm.blockType === "lunch_break" ? "#f97316" : blockForm.blockType === "break" ? "#22c55e" : "#6366f1" }}>
              {blockForm.editBlockId ? "Edit" : "Add"} {blockTypeLabel(blockForm.blockType)}
            </div>

            {/* Employee search */}
            <div style={{ marginBottom: 10, position: "relative" }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>Employee</label>
              <input
                type="text"
                placeholder="Search employee…"
                value={blockFormEmployeeId ? selectedEmpName : blockFormEmployeeSearch}
                onChange={(e) => {
                  setBlockFormEmployeeSearch(e.target.value);
                  setBlockFormEmployeeId(null);
                  setBlockFormEmpOpen(true);
                }}
                onFocus={() => setBlockFormEmpOpen(true)}
                autoFocus
                style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "1.5px solid #e5e7eb", fontSize: 13, boxSizing: "border-box" }}
              />
              {blockFormEmployeeId && (
                <button
                  onClick={() => { setBlockFormEmployeeId(null); setBlockFormEmployeeSearch(""); setBlockFormEmpOpen(true); }}
                  style={{ position: "absolute", right: 8, top: 26, border: "none", background: "none", cursor: "pointer", color: "#9ca3af", fontSize: 14 }}
                >✕</button>
              )}
              {blockFormEmpOpen && !blockFormEmployeeId && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "white", border: "1.5px solid #e5e7eb", borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.1)", zIndex: 70, maxHeight: 180, overflowY: "auto" }}>
                  {/* Unassigned option always at top */}
                  <button
                    onMouseDown={(e) => { e.preventDefault(); setBlockFormEmployeeId("__unassigned__"); setBlockFormEmployeeSearch(""); setBlockFormEmpOpen(false); }}
                    style={{ display: "block", width: "100%", padding: "7px 12px", border: "none", borderBottom: "1px solid #f3f4f6", background: "transparent", cursor: "pointer", textAlign: "left", fontSize: 13, fontWeight: 700, color: "#f97316" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#fff7ed")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    — Unassigned
                  </button>
                  {blockFormEmpResults.length === 0 ? (
                    <div style={{ padding: "10px 12px", color: "#9ca3af", fontSize: 12 }}>No employees found</div>
                  ) : (
                    blockFormEmpResults.map((emp) => (
                      <button
                        key={emp.id}
                        onMouseDown={(e) => { e.preventDefault(); setBlockFormEmployeeId(emp.id); setBlockFormEmployeeSearch(""); setBlockFormEmpOpen(false); }}
                        style={{ display: "block", width: "100%", padding: "7px 12px", border: "none", background: "transparent", cursor: "pointer", textAlign: "left", fontSize: 13, fontWeight: 600 }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        {getDisplayName(emp)}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Notes field (shift only) */}
            {blockForm.blockType === "shift" && (
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>Notes / Label (optional)</label>
                <input
                  type="text"
                  placeholder="e.g., Front desk, Tutoring…"
                  value={blockFormNotes}
                  onChange={(e) => setBlockFormNotes(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleBlockFormSubmit(); if (e.key === "Escape") setBlockForm(null); }}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "1.5px solid #e5e7eb", fontSize: 13, boxSizing: "border-box" }}
                />
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn btn-pink"
                onClick={handleBlockFormSubmit}
                style={{ flex: 1, padding: "7px 0", fontSize: 13 }}
              >
                {blockForm.editBlockId ? "Save" : "Add"}
              </button>
              <button className="btn" onClick={() => setBlockForm(null)} style={{ padding: "7px 14px", fontSize: 13 }}>Cancel</button>
            </div>
          </div>
        </>
      )}

      {/* Context menu */}
      {contextMenu && (
        <BlockContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onEdit={handleEditBlock}
          onDuplicate={handleDuplicate}
          onDelete={() => deleteBlock(contextMenu.blockId)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Weekly hours modal */}
      {showHoursView && (
        <>
          <div
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 80 }}
            onMouseDown={() => setShowHoursView(false)}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 81,
              background: "white",
              borderRadius: 14,
              boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
              padding: 24,
              width: 380,
              maxHeight: "80vh",
              display: "flex",
              flexDirection: "column",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>Weekly Paid Hours</div>
              <button onClick={() => setShowHoursView(false)} style={{ border: "none", background: "none", cursor: "pointer", fontSize: 18, color: "#9ca3af", lineHeight: 1 }}>✕</button>
            </div>
            <input
              type="text"
              placeholder="Search employee…"
              value={hoursSearch}
              onChange={(e) => setHoursSearch(e.target.value)}
              autoFocus
              style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1.5px solid #e5e7eb", fontSize: 13, marginBottom: 12, boxSizing: "border-box" }}
            />
            <div style={{ overflowY: "auto", flex: 1 }}>
              {(() => {
                const q = hoursSearch.toLowerCase().trim();
                const filtered = weeklyHours.filter((r) => !q || r.name.toLowerCase().includes(q));
                if (filtered.length === 0) {
                  return <div style={{ color: "#9ca3af", fontSize: 13, padding: "10px 0" }}>No employees found.</div>;
                }
                return filtered.map(({ empId, name, mins }) => {
                  const h = Math.floor(mins / 60);
                  const m = mins % 60;
                  const label = m === 0 ? `${h}h` : `${h}h ${m}m`;
                  return (
                    <div
                      key={empId}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "9px 4px",
                        borderBottom: "1px solid #f3f4f6",
                      }}
                    >
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#1e293b" }}>{name}</span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: "#374151" }}>{label}</span>
                    </div>
                  );
                });
              })()}
            </div>
            <div style={{ marginTop: 10, fontSize: 11, color: "#9ca3af" }}>
              Paid time = shifts + breaks, excluding lunch breaks.
            </div>
          </div>
        </>
      )}

      {/* Saving indicator */}
      {saving && (
        <div style={{ position: "fixed", bottom: 20, right: 20, padding: "8px 16px", background: "#fdf2f8", border: "1px solid #f9a8d4", borderRadius: 10, fontSize: 13, fontWeight: 700, color: "#e6178d", zIndex: 50 }}>
          Saving…
        </div>
      )}
    </div>
  );
}
