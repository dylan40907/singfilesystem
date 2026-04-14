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
  formatTime,
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
} from "@/lib/scheduleUtils";
import ScheduleGrid from "./ScheduleGrid";
import BlockContextMenu from "./BlockContextMenu";
import { useDialog } from "@/components/ui/useDialog";

interface ScheduleGridEditorProps {
  scheduleId: string;
  onBack: () => void;
  /** When true, disables all editing regardless of schedule status (for supervisor view) */
  forceReadOnly?: boolean;
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
  columns: number;
  requiredTeachers: number;
  singleTeacherPeriods: Array<{ start: string; end: string }>;
  periodDraft: { start: string; end: string };
} | null;

type UndoEntry =
  | { type: "block_create"; block: ScheduleBlockType }
  | { type: "block_delete"; block: ScheduleBlockType }
  | { type: "block_move"; blockId: string; prevRoomId: string; prevColumnIndex: number; prevStartTime: string; prevEndTime: string; nextRoomId: string; nextColumnIndex: number; nextStartTime: string; nextEndTime: string }
  | { type: "block_resize"; blockId: string; prevStartTime: string; prevEndTime: string; nextStartTime: string; nextEndTime: string }
  | { type: "block_update"; blockId: string; prevEmployeeId: string | null; prevLabel: string | null; nextEmployeeId: string | null; nextLabel: string | null }
  | { type: "paint"; prevColors: Record<number, Record<string, string>>; nextColors: Record<number, Record<string, string>> }
  | { type: "fill_gaps"; blocks: ScheduleBlockType[] }
  | { type: "clear_unassigned"; blocks: ScheduleBlockType[] };

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

export default function ScheduleGridEditor({ scheduleId, onBack, forceReadOnly = false }: ScheduleGridEditorProps) {
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
  const colorSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unified undo/redo stacks
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([]);
  const pushUndo = useCallback((entry: UndoEntry) => {
    setUndoStack((prev) => [...prev.slice(-49), entry]);
    setRedoStack([]); // any new action clears redo history
  }, []);

  // Color legend labels: maps hex color → label text
  const [colorLabels, setColorLabels] = useState<Record<string, string>>({});
  const colorLabelsSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Weekly hours view
  const [showHoursView, setShowHoursView] = useState(false);
  const [hoursSearch, setHoursSearch] = useState("");

  // Unassigned blocks publish confirmation
  type UnassignedItem = { day: string; room: string; start: string; end: string; label: string | null };
  const [unassignedAlert, setUnassignedAlert] = useState<UnassignedItem[] | null>(null);

  // Fill gaps modal
  type FillGapsState = {
    open: boolean;
    selectedRoomIds: Set<string>;
    selectedDays: Set<number>;
    fillStart: string; // "HH:mm"
    fillEnd: string;
  };
  const [fillGaps, setFillGaps] = useState<FillGapsState | null>(null);

  // Clear unassigned modal
  type ClearUnassignedState = {
    selectedRoomIds: Set<string>;
    selectedDays: Set<number>;
    clearStart: string;
    clearEnd: string;
  };
  const [clearUnassigned, setClearUnassigned] = useState<ClearUnassignedState | null>(null);

  // Copy week picker
  const [copyPickerOpen, setCopyPickerOpen] = useState(false);
  const [copyPickerSchedules, setCopyPickerSchedules] = useState<{ id: string; week_start: string; status: string }[]>([]);
  const [copyPickerSelected, setCopyPickerSelected] = useState<string | null>(null);
  const [copyPickerLoading, setCopyPickerLoading] = useState(false);

  const { confirm, modal: dialogModal } = useDialog();
  const readOnly = forceReadOnly;
  const [isFullscreen, setIsFullscreen] = useState(false);

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
    if (blocksRes.data) {
      // Deduplicate: if two blocks share room/column/day/start/end/employee they're ghosts; keep the one with the lowest id
      const seen = new Set<string>();
      const deduped = (blocksRes.data as ScheduleBlockType[]).filter((b) => {
        const key = `${b.room_id}:${b.column_index}:${b.day_of_week}:${b.start_time}:${b.end_time}:${b.employee_id ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setBlocks(deduped);
    }
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
    const prevColors: Record<number, Record<string, string>> = JSON.parse(JSON.stringify(cellColors));
    // Compute next state synchronously so we can store it for redo
    const dayColors = { ...(cellColors[activeDay] ?? {}) };
    for (const key of cellKeys) {
      if (paintErase) delete dayColors[key];
      else dayColors[key] = paintColor;
    }
    const nextColors = { ...cellColors, [activeDay]: dayColors };
    pushUndo({ type: "paint", prevColors, nextColors });
    setCellColors(nextColors);
    saveCellColors(activeDay, dayColors);
  }

  // Shared helper: apply a block row from stored entry
  function blockFields(b: ScheduleBlockType) {
    const { id, schedule_id, room_id, employee_id, day_of_week, start_time, end_time, column_index, label, block_type } = b;
    return { id, schedule_id, room_id, employee_id, day_of_week, start_time, end_time, column_index, label, block_type };
  }

  async function applyColorState(colors: Record<number, Record<string, string>>) {
    setCellColors(colors);
    for (const [dayStr, dayColors] of Object.entries(colors)) {
      await supabase.from("schedule_cell_colors").upsert(
        { schedule_id: scheduleId, day_of_week: parseInt(dayStr), colors: dayColors, updated_at: new Date().toISOString() },
        { onConflict: "schedule_id,day_of_week" }
      );
    }
  }

  const handleUndo = useCallback(async () => {
    if (undoStack.length === 0) return;
    const entry = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((s) => [...s.slice(-49), entry]);

    switch (entry.type) {
      case "block_create":
        await supabase.from("schedule_blocks").delete().eq("id", entry.block.id);
        setBlocks((prev) => prev.filter((b) => b.id !== entry.block.id));
        break;

      case "block_delete": {
        const { data } = await supabase.from("schedule_blocks").insert(blockFields(entry.block)).select().single();
        if (data) setBlocks((prev) => [...prev, data]);
        break;
      }

      case "block_move": {
        const u = { room_id: entry.prevRoomId, column_index: entry.prevColumnIndex, start_time: entry.prevStartTime, end_time: entry.prevEndTime };
        await supabase.from("schedule_blocks").update(u).eq("id", entry.blockId);
        setBlocks((prev) => prev.map((b) => b.id === entry.blockId ? { ...b, ...u } : b));
        break;
      }

      case "block_resize": {
        const u = { start_time: entry.prevStartTime, end_time: entry.prevEndTime };
        await supabase.from("schedule_blocks").update(u).eq("id", entry.blockId);
        setBlocks((prev) => prev.map((b) => b.id === entry.blockId ? { ...b, ...u } : b));
        break;
      }

      case "block_update": {
        const u = { employee_id: entry.prevEmployeeId, label: entry.prevLabel };
        await supabase.from("schedule_blocks").update(u).eq("id", entry.blockId);
        setBlocks((prev) => prev.map((b) => b.id === entry.blockId ? { ...b, ...u } : b));
        break;
      }

      case "paint":
        await applyColorState(entry.prevColors);
        break;

      case "fill_gaps":
        await supabase.from("schedule_blocks").delete().in("id", entry.blocks.map((b) => b.id));
        setBlocks((prev) => prev.filter((b) => !entry.blocks.some((eb) => eb.id === b.id)));
        break;

      case "clear_unassigned": {
        const { data } = await supabase.from("schedule_blocks").insert(entry.blocks.map(blockFields)).select();
        if (data) setBlocks((prev) => [...prev, ...data]);
        break;
      }
    }
  }, [undoStack, scheduleId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRedo = useCallback(async () => {
    if (redoStack.length === 0) return;
    const entry = redoStack[redoStack.length - 1];
    setRedoStack((s) => s.slice(0, -1));
    setUndoStack((s) => [...s.slice(-49), entry]);

    switch (entry.type) {
      case "block_create": {
        const { data } = await supabase.from("schedule_blocks").insert(blockFields(entry.block)).select().single();
        if (data) setBlocks((prev) => [...prev, data]);
        break;
      }

      case "block_delete":
        await supabase.from("schedule_blocks").delete().eq("id", entry.block.id);
        setBlocks((prev) => prev.filter((b) => b.id !== entry.block.id));
        break;

      case "block_move": {
        const u = { room_id: entry.nextRoomId, column_index: entry.nextColumnIndex, start_time: entry.nextStartTime, end_time: entry.nextEndTime };
        await supabase.from("schedule_blocks").update(u).eq("id", entry.blockId);
        setBlocks((prev) => prev.map((b) => b.id === entry.blockId ? { ...b, ...u } : b));
        break;
      }

      case "block_resize": {
        const u = { start_time: entry.nextStartTime, end_time: entry.nextEndTime };
        await supabase.from("schedule_blocks").update(u).eq("id", entry.blockId);
        setBlocks((prev) => prev.map((b) => b.id === entry.blockId ? { ...b, ...u } : b));
        break;
      }

      case "block_update": {
        const u = { employee_id: entry.nextEmployeeId, label: entry.nextLabel };
        await supabase.from("schedule_blocks").update(u).eq("id", entry.blockId);
        setBlocks((prev) => prev.map((b) => b.id === entry.blockId ? { ...b, ...u } : b));
        break;
      }

      case "paint":
        await applyColorState(entry.nextColors);
        break;

      case "fill_gaps": {
        const { data } = await supabase.from("schedule_blocks").insert(entry.blocks.map(blockFields)).select();
        if (data) setBlocks((prev) => [...prev, ...data]);
        break;
      }

      case "clear_unassigned":
        await supabase.from("schedule_blocks").delete().in("id", entry.blocks.map((b) => b.id));
        setBlocks((prev) => prev.filter((b) => !entry.blocks.some((eb) => eb.id === b.id)));
        break;
    }
  }, [redoStack, scheduleId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fullscreen: measure window size directly and use inline px values
  const [windowSize, setWindowSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!isFullscreen) return;
    function measure() {
      setWindowSize({ w: window.innerWidth, h: window.innerHeight });
    }
    measure();
    window.addEventListener("resize", measure);
    // Lock body scroll
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("resize", measure);
      document.body.style.overflow = prev;
    };
  }, [isFullscreen]);

  // Keyboard shortcuts: Ctrl/⌘+Z → undo, Ctrl/⌘+Shift+Z → redo, Escape → exit fullscreen
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") { setIsFullscreen(false); return; }
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      if (e.shiftKey) void handleRedo();
      else void handleUndo();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleUndo, handleRedo]);

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
  // Uses union-of-intervals to avoid double-counting overlapping blocks across columns
  const weeklyHours = useMemo(() => {
    // Group intervals by employee+day, then merge overlapping ones before summing
    const intervalsByEmpDay = new Map<string, { start: number; end: number }[]>();
    for (const b of blocks) {
      if (!b.employee_id || b.block_type === "lunch_break") continue;
      const key = `${b.employee_id}:${b.day_of_week}`;
      if (!intervalsByEmpDay.has(key)) intervalsByEmpDay.set(key, []);
      intervalsByEmpDay.get(key)!.push({ start: timeToMinutes(b.start_time), end: timeToMinutes(b.end_time) });
    }
    const mergeIntervals = (intervals: { start: number; end: number }[]) => {
      if (!intervals.length) return 0;
      const sorted = [...intervals].sort((a, b) => a.start - b.start);
      let total = 0;
      let cur = sorted[0];
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].start < cur.end) {
          cur = { start: cur.start, end: Math.max(cur.end, sorted[i].end) };
        } else {
          total += cur.end - cur.start;
          cur = sorted[i];
        }
      }
      total += cur.end - cur.start;
      return total;
    };
    const paidByEmp = new Map<string, number>();
    for (const [key, intervals] of intervalsByEmpDay) {
      const empId = key.split(":")[0];
      paidByEmp.set(empId, (paidByEmp.get(empId) ?? 0) + mergeIntervals(intervals));
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
      // Use union-of-intervals to avoid double-counting overlapping blocks across columns
      const paidIntervals = empBlocks
        .filter((b) => b.block_type !== "lunch_break")
        .map((b) => ({ start: timeToMinutes(b.start_time), end: timeToMinutes(b.end_time) }))
        .sort((a, b) => a.start - b.start);
      let paidMins = 0;
      if (paidIntervals.length > 0) {
        let cur = paidIntervals[0];
        for (let i = 1; i < paidIntervals.length; i++) {
          if (paidIntervals[i].start < cur.end) {
            cur = { start: cur.start, end: Math.max(cur.end, paidIntervals[i].end) };
          } else {
            paidMins += cur.end - cur.start;
            cur = paidIntervals[i];
          }
        }
        paidMins += cur.end - cur.start;
      }
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

      // 6h+ shift time with < 2 qualifying breaks (union-of-intervals)
      const shiftIntervals = empBlocks
        .filter((b) => b.block_type === "shift")
        .map((b) => ({ start: timeToMinutes(b.start_time), end: timeToMinutes(b.end_time) }))
        .sort((a, b) => a.start - b.start);
      let shiftMins = 0;
      if (shiftIntervals.length > 0) {
        let cur = shiftIntervals[0];
        for (let i = 1; i < shiftIntervals.length; i++) {
          if (shiftIntervals[i].start < cur.end) {
            cur = { start: cur.start, end: Math.max(cur.end, shiftIntervals[i].end) };
          } else {
            shiftMins += cur.end - cur.start;
            cur = shiftIntervals[i];
          }
        }
        shiftMins += cur.end - cur.start;
      }
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
      .insert({ schedule_id: scheduleId, name: `Room ${rooms.length + 1}`, columns: 2, required_teachers: 2, single_teacher_periods: [], sort_order: nextOrder })
      .select()
      .single();
    if (data) setRooms((prev) => [...prev, data]);
    if (error) setWarning(error.message);
  }

  async function updateRoom(roomId: string, updates: { name?: string; columns?: number; required_teachers?: number; single_teacher_periods?: Array<{ start: string; end: string }> }) {
    const { error } = await supabase.from("schedule_rooms").update(updates).eq("id", roomId);
    if (!error) {
      setRooms((prev) => prev.map((r) => (r.id === roomId ? { ...r, ...updates } : r)));
      if (updates.columns !== undefined) {
        const room = rooms.find((r) => r.id === roomId);
        if (room && updates.columns < room.columns) {
          const toDelete = blocks.filter((b) => b.room_id === roomId && b.column_index >= updates.columns!);
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
    if (roomBlocks.length > 0 && !await confirm(`Delete this room and its ${roomBlocks.length} block${roomBlocks.length !== 1 ? "s" : ""}?`, { title: "Delete Room", danger: true, confirmLabel: "Delete" })) return;
    const { error } = await supabase.from("schedule_rooms").delete().eq("id", roomId);
    if (!error) {
      setRooms((prev) => prev.filter((r) => r.id !== roomId));
      setBlocks((prev) => prev.filter((b) => b.room_id !== roomId));
    } else {
      setWarning(error.message);
    }
  }

  function handleRoomEditTrigger(roomId: string, _updates: { name?: string; columns?: number }) {
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return;
    if (Object.keys(_updates).length === 0) {
      setRoomEdit({
        roomId: room.id,
        name: room.name,
        columns: room.columns,
        requiredTeachers: room.required_teachers ?? 2,
        singleTeacherPeriods: room.single_teacher_periods ?? [],
        periodDraft: { start: "07:20", end: "08:00" },
      });
    } else {
      updateRoom(roomId, _updates);
    }
  }

  async function handleRoomEditSave() {
    if (!roomEdit) return;
    await updateRoom(roomEdit.roomId, {
      name: roomEdit.name.trim() || "Room",
      columns: roomEdit.columns,
      required_teachers: roomEdit.requiredTeachers,
      single_teacher_periods: roomEdit.singleTeacherPeriods,
    });
    setRoomEdit(null);
  }

  // Add a single-teacher period: paint #f2f2f2 on unpainted cells in all days for this room
  async function addSingleTeacherPeriod() {
    if (!roomEdit) return;
    const { start, end } = roomEdit.periodDraft;
    const startM = timeToMinutes(start);
    const endM = timeToMinutes(end);
    if (startM >= endM) { setWarning("Period end must be after start."); return; }

    const newPeriods = [...roomEdit.singleTeacherPeriods, { start, end }];
    setRoomEdit({ ...roomEdit, singleTeacherPeriods: newPeriods });

    // Auto-label #f2f2f2 in the legend if not already set
    if (!colorLabels["#f2f2f2"]) {
      handleColorLabelChange("#f2f2f2", "1 Teacher Period");
    }

    // Compute new colors for all days from current state snapshot
    const newCellColors = { ...cellColors };
    for (const day of [1, 2, 3, 4, 5] as const) {
      const dayColors = { ...(newCellColors[day] ?? {}) };
      for (let m = startM; m < endM; m += SLOT_MINUTES) {
        const timeSlot = minutesToTime(m);
        for (let col = 0; col < roomEdit.columns; col++) {
          const key = `${roomEdit.roomId}:${col}:${timeSlot}`;
          if (!dayColors[key]) dayColors[key] = "#f2f2f2";
        }
      }
      newCellColors[day] = dayColors;
    }
    setCellColors(newCellColors);

    // Save all days directly (bypass debounce — this is an explicit user action)
    for (const day of [1, 2, 3, 4, 5] as const) {
      await supabase.from("schedule_cell_colors").upsert(
        { schedule_id: scheduleId, day_of_week: day, colors: newCellColors[day] ?? {}, updated_at: new Date().toISOString() },
        { onConflict: "schedule_id,day_of_week" }
      );
    }
  }

  // Remove a single-teacher period: remove #f2f2f2 cells in its range (but not other colors)
  async function removeSingleTeacherPeriod(idx: number) {
    if (!roomEdit) return;
    const period = roomEdit.singleTeacherPeriods[idx];
    const newPeriods = roomEdit.singleTeacherPeriods.filter((_, i) => i !== idx);
    setRoomEdit({ ...roomEdit, singleTeacherPeriods: newPeriods });

    const startM = timeToMinutes(period.start);
    const endM = timeToMinutes(period.end);

    const newCellColors = { ...cellColors };
    for (const day of [1, 2, 3, 4, 5] as const) {
      const dayColors = { ...(newCellColors[day] ?? {}) };
      for (let m = startM; m < endM; m += SLOT_MINUTES) {
        const timeSlot = minutesToTime(m);
        for (let col = 0; col < roomEdit.columns; col++) {
          const key = `${roomEdit.roomId}:${col}:${timeSlot}`;
          if (dayColors[key] === "#f2f2f2") delete dayColors[key];
        }
      }
      newCellColors[day] = dayColors;
    }
    setCellColors(newCellColors);

    for (const day of [1, 2, 3, 4, 5] as const) {
      await supabase.from("schedule_cell_colors").upsert(
        { schedule_id: scheduleId, day_of_week: day, colors: newCellColors[day] ?? {}, updated_at: new Date().toISOString() },
        { onConflict: "schedule_id,day_of_week" }
      );
    }
  }

  // --- Fill Gaps ---
  async function runFillGaps() {
    if (!fillGaps) return;
    setSaving(true);

    const fillStartM = timeToMinutes(fillGaps.fillStart);
    const fillEndM = timeToMinutes(fillGaps.fillEnd);
    const selectedRooms = rooms.filter((r) => fillGaps.selectedRoomIds.has(r.id));

    const newBlocks: Array<{
      schedule_id: string;
      room_id: string;
      employee_id: null;
      day_of_week: number;
      start_time: string;
      end_time: string;
      column_index: number;
      label: string;
      block_type: "shift";
    }> = [];

    for (const room of selectedRooms) {
      const roomCols = room.columns ?? 2;
      const required = room.required_teachers ?? 2;
      const periods = room.single_teacher_periods ?? [];

      for (const day of ([1, 2, 3, 4, 5] as number[]).filter((d) => fillGaps.selectedDays.has(d))) {
        // All blocks in this room/day
        const allDayBlocks = blocks.filter(
          (b) => b.room_id === room.id && b.day_of_week === day
        );

        // Build set of critical time boundaries within fill range
        const eventSet = new Set<number>([fillStartM, fillEndM]);
        for (const p of periods) {
          const ps = timeToMinutes(p.start);
          const pe = timeToMinutes(p.end);
          if (ps > fillStartM && ps < fillEndM) eventSet.add(ps);
          if (pe > fillStartM && pe < fillEndM) eventSet.add(pe);
        }
        for (const b of allDayBlocks) {
          const bs = timeToMinutes(b.start_time);
          const be = timeToMinutes(b.end_time);
          if (bs > fillStartM && bs < fillEndM) eventSet.add(bs);
          if (be > fillStartM && be < fillEndM) eventSet.add(be);
        }
        const sortedEvents = [...eventSet].sort((a, b) => a - b);

        // Collect gap intervals: { startM, endM, column }
        type GapInterval = { startM: number; endM: number; column: number };
        const gaps: GapInterval[] = [];

        for (let i = 0; i < sortedEvents.length - 1; i++) {
          const iStart = sortedEvents[i];
          const iEnd = sortedEvents[i + 1];
          const mid = (iStart + iEnd) / 2;

          // Required teachers for this interval
          let reqHere = required;
          for (const p of periods) {
            if (mid >= timeToMinutes(p.start) && mid < timeToMinutes(p.end)) {
              reqHere = 1;
              break;
            }
          }

          // coveredByShift: columns with a shift block here → counts toward required
          // occupied: columns with ANY block here → can't place an unassigned block
          const coveredByShift = new Set<number>();
          const occupied = new Set<number>();
          for (const b of allDayBlocks) {
            const bs = timeToMinutes(b.start_time);
            const be = timeToMinutes(b.end_time);
            if (bs < iEnd && be > iStart) {
              occupied.add(b.column_index);
              if (b.block_type === "shift") coveredByShift.add(b.column_index);
            }
          }

          const shortage = Math.max(0, reqHere - coveredByShift.size);
          for (let n = 0; n < shortage; n++) {
            let freeCol = -1;
            for (let col = 0; col < roomCols; col++) {
              if (!occupied.has(col)) { freeCol = col; occupied.add(col); break; }
            }
            if (freeCol >= 0) gaps.push({ startM: iStart, endM: iEnd, column: freeCol });
          }
        }

        // Merge adjacent gaps with the same column
        const merged: GapInterval[] = [];
        const sortedGaps = [...gaps].sort((a, b) => a.column - b.column || a.startM - b.startM);
        for (const g of sortedGaps) {
          const last = merged[merged.length - 1];
          if (last && last.column === g.column && last.endM === g.startM) {
            last.endM = g.endM;
          } else {
            merged.push({ ...g });
          }
        }

        for (const g of merged) {
          newBlocks.push({
            schedule_id: scheduleId,
            room_id: room.id,
            employee_id: null,
            day_of_week: day,
            start_time: minutesToTime(g.startM),
            end_time: minutesToTime(g.endM),
            column_index: g.column,
            label: "Unassigned",
            block_type: "shift",
          });
        }
      }
    }

    if (newBlocks.length > 0) {
      const { data, error } = await supabase.from("schedule_blocks").insert(newBlocks).select();
      if (error) setWarning(error.message);
      else if (data) {
        setBlocks((prev) => [...prev, ...data]);
        pushUndo({ type: "fill_gaps", blocks: data });
      }
    }

    setFillGaps(null);
    setSaving(false);
  }

  async function runClearUnassigned() {
    if (!clearUnassigned) return;
    setSaving(true);
    const startM = timeToMinutes(clearUnassigned.clearStart);
    const endM = timeToMinutes(clearUnassigned.clearEnd);

    const toDelete = blocks.filter((b) =>
      !b.employee_id &&
      clearUnassigned.selectedRoomIds.has(b.room_id) &&
      clearUnassigned.selectedDays.has(b.day_of_week) &&
      timeToMinutes(b.start_time) >= startM &&
      timeToMinutes(b.end_time) <= endM
    );

    if (toDelete.length > 0) {
      pushUndo({ type: "clear_unassigned", blocks: toDelete });
      const { error } = await supabase.from("schedule_blocks").delete().in("id", toDelete.map((b) => b.id));
      if (error) setWarning(error.message);
      else setBlocks((prev) => prev.filter((b) => !toDelete.some((d) => d.id === b.id)));
    }
    setClearUnassigned(null);
    setSaving(false);
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
    if (data) {
      setBlocks((prev) => [...prev, data]);
      pushUndo({ type: "block_create", block: data });
    }
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
    pushUndo({ type: "block_update", blockId, prevEmployeeId: block.employee_id, prevLabel: block.label, nextEmployeeId: employeeId, nextLabel: label });
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
    const block = blocks.find((b) => b.id === blockId);
    const { error } = await supabase.from("schedule_blocks").delete().eq("id", blockId);
    if (!error) {
      if (block) pushUndo({ type: "block_delete", block });
      setBlocks((prev) => prev.filter((b) => b.id !== blockId));
    } else {
      setWarning(error.message);
    }
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

    pushUndo({ type: "block_resize", blockId, prevStartTime: block.start_time, prevEndTime: block.end_time, nextStartTime: newStartTime, nextEndTime: newEndTime });
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
    if (!targetRoom || newColumnIndex >= targetRoom.columns) { setWarning("Invalid target column."); return; }

    // Prevent dropping into a column that already has any overlapping block
    const columnConflict = blocks.some(
      (b) =>
        b.id !== blockId &&
        b.room_id === newRoomId &&
        b.column_index === newColumnIndex &&
        b.day_of_week === block.day_of_week &&
        timeToMinutes(b.start_time) < timeToMinutes(newEndTime) &&
        timeToMinutes(b.end_time) > timeToMinutes(newStartTime)
    );
    if (columnConflict) {
      setWarning("Cannot place block on top of an existing block in that column.");
      return;
    }

    pushUndo({ type: "block_move", blockId, prevRoomId: block.room_id, prevColumnIndex: block.column_index, prevStartTime: block.start_time, prevEndTime: block.end_time, nextRoomId: newRoomId, nextColumnIndex: newColumnIndex, nextStartTime: newStartTime, nextEndTime: newEndTime });
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
      else label = blockFormNotes.trim() || (empId === null ? "Unassigned" : null);
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
  async function proceedPublish() {
    if (!schedule) return;
    const newStatus = schedule.status === "published" ? "draft" : "published";
    const { error } = await supabase.from("schedules").update({ status: newStatus }).eq("id", schedule.id);
    if (!error) setSchedule((prev) => (prev ? { ...prev, status: newStatus } : prev));
    else setWarning(error.message);
  }

  async function togglePublish() {
    if (!schedule) return;

    // When publishing, warn if unassigned blocks exist — but allow proceeding
    if (schedule.status !== "published") {
      const unassigned = blocks.filter((b) => !b.employee_id);
      if (unassigned.length > 0) {
        const items: UnassignedItem[] = unassigned.map((b) => {
          const room = rooms.find((r) => r.id === b.room_id);
          return {
            day: DAY_LABELS[b.day_of_week - 1] ?? `Day ${b.day_of_week}`,
            room: room?.name ?? "Unknown Room",
            start: b.start_time,
            end: b.end_time,
            label: b.label,
          };
        });
        setUnassignedAlert(items);
        return;
      }
    }

    await proceedPublish();
  }

  // --- Copy Week picker ---
  async function openCopyPicker() {
    if (!schedule) return;
    setCopyPickerLoading(true);
    setCopyPickerOpen(true);
    const { data } = await supabase
      .from("schedules")
      .select("id, week_start, status")
      .neq("id", scheduleId)
      .order("week_start", { ascending: false });
    const rows = (data ?? []) as { id: string; week_start: string; status: string }[];
    setCopyPickerSchedules(rows);
    // Default to most recent before current week
    const prev = rows.find((s) => s.week_start < schedule.week_start);
    setCopyPickerSelected(prev?.id ?? (rows[0]?.id ?? null));
    setCopyPickerLoading(false);
  }

  // --- Copy Week (includes rooms, blocks, and cell colors) ---
  async function copyFromWeek(sourceId: string) {
    if (!schedule) return;
    setSaving(true);
    setCopyPickerOpen(false);

    const prevSchedule = { id: sourceId };


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
      setWarning("Selected schedule has no rooms to copy.");
      setSaving(false);
      return;
    }

    if (rooms.length > 0) {
      if (!await confirm("This will remove all current rooms, blocks, and paint colors for this week and replace them with the selected week's data. Continue?", { title: "Copy Week", confirmLabel: "Yes, replace" })) {
        setSaving(false);
        return;
      }
      await supabase.from("schedule_rooms").delete().eq("schedule_id", scheduleId);
    }

    // Always clear existing colors
    await supabase.from("schedule_cell_colors").delete().eq("schedule_id", scheduleId);

    const { data: newRooms } = await supabase
      .from("schedule_rooms")
      .insert(prevRooms.map((r) => ({ schedule_id: scheduleId, name: r.name, columns: r.columns, required_teachers: r.required_teachers ?? 2, single_teacher_periods: r.single_teacher_periods ?? [], sort_order: r.sort_order })))
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
    if (!await confirm("Delete this schedule and all its rooms and blocks? This cannot be undone.", { title: "Delete Schedule", danger: true, confirmLabel: "Delete" })) return;
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
              <button className="btn" onClick={openCopyPicker} disabled={saving}>Copy Week</button>
              <button className="btn" onClick={addRoom}>+ Add Room</button>
            </>
          )}
          <button className="btn" onClick={() => setShowHoursView(true)}>⏱ Hours</button>
          {!readOnly && (
            <>
              <button
                className="btn"
                onClick={() => setFillGaps({ open: true, selectedRoomIds: new Set(), selectedDays: new Set([activeDay]), fillStart: "07:20", fillEnd: "18:00" })}
              >
                ↓ Fill Gaps
              </button>
              <button
                className="btn"
                onClick={() => setClearUnassigned({ selectedRoomIds: new Set(), selectedDays: new Set([activeDay]), clearStart: "07:20", clearEnd: "18:00" })}
              >
                ✕ Clear Unassigned
              </button>
              <button
                className="btn"
                onClick={handleUndo}
                disabled={undoStack.length === 0}
                title="Undo (Ctrl+Z / ⌘Z)"
                style={{ padding: "6px 14px", fontSize: 13 }}
              >
                ↩ Undo
              </button>
              <button
                className="btn"
                onClick={handleRedo}
                disabled={redoStack.length === 0}
                title="Redo (Ctrl+Shift+Z / ⌘⇧Z)"
                style={{ padding: "6px 14px", fontSize: 13 }}
              >
                ↪ Redo
              </button>
            </>
          )}
          {!forceReadOnly && (
            <button className="btn btn-pink" onClick={togglePublish}>
              {schedule.status === "published" ? "Unpublish" : "Publish"}
            </button>
          )}
          {!forceReadOnly && (
            <button className="btn" onClick={handleDeleteSchedule} style={{ color: "#dc2626", borderColor: "#fca5a5" }}>Delete</button>
          )}
          <button
            className="btn"
            onClick={() => setIsFullscreen(true)}
            title="Fullscreen (Esc to exit)"
            style={{ padding: "6px 10px", fontSize: 16, lineHeight: 1 }}
          >
            ⛶
          </button>
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

      {/* Room edit modal */}
      {roomEdit && (
        <>
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 80 }} onMouseDown={() => setRoomEdit(null)} />
          <div
            style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 81, background: "white", borderRadius: 14, boxShadow: "0 8px 40px rgba(0,0,0,0.18)", padding: 24, width: 420, maxHeight: "85vh", display: "flex", flexDirection: "column" }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 16 }}>Edit Room</div>

            {/* Name */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>Room Name</label>
              <input
                type="text" value={roomEdit.name} autoFocus
                onChange={(e) => setRoomEdit({ ...roomEdit, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") handleRoomEditSave(); if (e.key === "Escape") setRoomEdit(null); }}
                style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "1.5px solid #e5e7eb", fontSize: 13, boxSizing: "border-box" }}
              />
            </div>

            {/* Columns + Required teachers */}
            <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>Columns</label>
                <input
                  type="number" min={1} max={10} value={roomEdit.columns}
                  onChange={(e) => setRoomEdit({ ...roomEdit, columns: Math.max(1, parseInt(e.target.value) || 1) })}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "1.5px solid #e5e7eb", fontSize: 13, textAlign: "center", boxSizing: "border-box" }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>Min. Required Teachers</label>
                <input
                  type="number" min={1} max={10} value={roomEdit.requiredTeachers}
                  onChange={(e) => setRoomEdit({ ...roomEdit, requiredTeachers: Math.max(1, parseInt(e.target.value) || 1) })}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "1.5px solid #e5e7eb", fontSize: 13, textAlign: "center", boxSizing: "border-box" }}
                />
              </div>
            </div>

            {/* Single-teacher time periods */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 6 }}>1-Teacher Time Periods</label>
              <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 8 }}>During these windows only 1 teacher is required. Cells are auto-painted gray.</div>
              {roomEdit.singleTeacherPeriods.length === 0 && (
                <div style={{ fontSize: 12, color: "#9ca3af", padding: "6px 0" }}>No periods set.</div>
              )}
              {roomEdit.singleTeacherPeriods.map((p, idx) => (
                <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", background: "#f9fafb", borderRadius: 8, border: "1px solid #e5e7eb", marginBottom: 4 }}>
                  <div style={{ width: 12, height: 12, borderRadius: 3, background: "#f2f2f2", border: "1px solid #d1d5db", flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{formatTime(p.start)} – {formatTime(p.end)}</span>
                  <button
                    onClick={() => removeSingleTeacherPeriod(idx)}
                    style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af", fontSize: 14, padding: "0 2px", lineHeight: 1 }}
                  >✕</button>
                </div>
              ))}
              {/* Add period */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                <input
                  type="time" value={roomEdit.periodDraft.start}
                  onChange={(e) => setRoomEdit({ ...roomEdit, periodDraft: { ...roomEdit.periodDraft, start: e.target.value } })}
                  style={{ padding: "5px 8px", borderRadius: 7, border: "1.5px solid #e5e7eb", fontSize: 12, flex: 1 }}
                />
                <span style={{ fontSize: 12, color: "#6b7280" }}>to</span>
                <input
                  type="time" value={roomEdit.periodDraft.end}
                  onChange={(e) => setRoomEdit({ ...roomEdit, periodDraft: { ...roomEdit.periodDraft, end: e.target.value } })}
                  style={{ padding: "5px 8px", borderRadius: 7, border: "1.5px solid #e5e7eb", fontSize: 12, flex: 1 }}
                />
                <button className="btn" onClick={addSingleTeacherPeriod} style={{ padding: "5px 12px", fontSize: 12 }}>+ Add</button>
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button className="btn btn-pink" onClick={handleRoomEditSave} style={{ flex: 1, padding: "8px 0", fontSize: 13 }}>Save</button>
              <button className="btn" onClick={() => { void deleteRoom(roomEdit.roomId); setRoomEdit(null); }} style={{ padding: "8px 14px", fontSize: 13, color: "#dc2626", borderColor: "#fca5a5" }}>Delete Room</button>
              <button className="btn" onClick={() => setRoomEdit(null)} style={{ padding: "8px 14px", fontSize: 13 }}>Cancel</button>
            </div>
          </div>
        </>
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
            </>
          )}
        </div>
      )}

      {/* Color legend */}
      {usedColors.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, padding: "6px 12px", background: "#f9fafb", borderRadius: 10, border: "1.5px solid #e5e7eb", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", marginRight: 4 }}>Legend:</span>
          {[...usedColors.filter((c) => c !== "#f2f2f2"), ...(usedColors.includes("#f2f2f2") ? ["#f2f2f2"] : [])].map((color) => (
            <div key={color} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 18, height: 18, borderRadius: 4, background: color, border: "1px solid #d1d5db", flexShrink: 0 }} />
              <input
                type="text"
                value={color === "#f2f2f2" ? (colorLabels[color] || "1 Teacher Period") : (colorLabels[color] ?? "")}
                onChange={(e) => handleColorLabelChange(color, e.target.value)}
                placeholder={color === "#f2f2f2" ? "1 Teacher Period" : "Label…"}
                style={{ width: 90, padding: "2px 6px", borderRadius: 6, border: "1px solid #e5e7eb", fontSize: 12, fontWeight: 500, color: "#374151", background: "white" }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Fullscreen overlay — uses window.innerWidth/Height in px to avoid CSS viewport bugs */}
      {isFullscreen && windowSize.h > 0 && (
        <div style={{
          position: "fixed", top: 0, left: 0,
          width: windowSize.w, height: windowSize.h,
          zIndex: 9999, background: "white", overflow: "hidden",
        }}>
          {/* Top bar — 48px */}
          <div style={{
            height: 48,
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "0 16px", borderBottom: "1px solid #e5e7eb", background: "white",
          }}>
            <div style={{ display: "flex", gap: 4 }}>
              {DAY_NUMBERS.map((dayNum, idx) => (
                <button
                  key={dayNum}
                  onClick={() => setActiveDay(dayNum)}
                  style={{
                    padding: "6px 16px", borderRadius: 10,
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
            <button
              onClick={() => setIsFullscreen(false)}
              title="Exit fullscreen (Esc)"
              style={{ background: "none", border: "1px solid #e5e7eb", borderRadius: 8, padding: "5px 12px", fontSize: 13, fontWeight: 700, color: "#6b7280", cursor: "pointer" }}
            >
              ✕ Exit Fullscreen
            </button>
          </div>

          {/* Scrollable grid — explicit px height = window height minus top bar */}
          <div style={{ height: windowSize.h - 48, overflowY: "auto", overflowX: "auto" }}>
            <div data-schedule-grid style={{ position: "relative" }}>
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
          </div>

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
      <div data-schedule-grid style={{ position: "relative", border: "1.5px solid #e5e7eb", borderRadius: 10, maxHeight: "calc(100vh - 280px)", overflow: "auto" }}>
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
      {/* Copy week picker modal */}
      {copyPickerOpen && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.45)" }} onClick={() => setCopyPickerOpen(false)} />
          <div style={{
            position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
            zIndex: 10001, background: "white", borderRadius: 14,
            boxShadow: "0 8px 32px rgba(0,0,0,0.18)", width: "min(480px,95vw)",
            maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden",
            padding: 20,
          }}>
            <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 14 }}>Copy Week</div>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 12 }}>
              Select a week to copy rooms, blocks, and paint colors from:
            </div>
            {copyPickerLoading ? (
              <div style={{ color: "#9ca3af", padding: "20px 0", textAlign: "center" }}>Loading…</div>
            ) : copyPickerSchedules.length === 0 ? (
              <div style={{ color: "#9ca3af" }}>No other schedules found.</div>
            ) : (
              <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
                {copyPickerSchedules.map((s) => {
                  const isSelected = s.id === copyPickerSelected;
                  const isPublished = s.status === "published";
                  return (
                    <button
                      key={s.id}
                      onClick={() => setCopyPickerSelected(s.id)}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        padding: "10px 14px", borderRadius: 10, cursor: "pointer", textAlign: "left",
                        border: isSelected ? "2px solid #e6178d" : "1.5px solid #e5e7eb",
                        background: isSelected ? "rgba(230,23,141,0.05)" : "white",
                      }}
                    >
                      <span style={{ fontWeight: 700, fontSize: 14, color: "#111827" }}>{formatWeekRange(s.week_start)}</span>
                      <span style={{
                        padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700,
                        background: isPublished ? "#dcfce7" : "#fef3c7",
                        color: isPublished ? "#16a34a" : "#d97706",
                      }}>{isPublished ? "Published" : "Draft"}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setCopyPickerOpen(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={() => { if (copyPickerSelected) copyFromWeek(copyPickerSelected); }}
                disabled={!copyPickerSelected || copyPickerLoading}
              >
                Copy
              </button>
            </div>
          </div>
        </>
      )}

      {typePicker && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 10000 }}
            onMouseDown={() => setTypePicker(null)}
          />
          <div
            style={{
              position: "fixed",
              ...popupPos(typePicker.x, typePicker.y, 200, 130),
              zIndex: 10001,
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
            style={{ position: "fixed", inset: 0, zIndex: 10000 }}
            onMouseDown={() => setBlockForm(null)}
          />
          <div
            style={{
              position: "fixed",
              ...popupPos(blockForm.x, blockForm.y, 280, blockForm.blockType === "shift" ? 260 : 200),
              zIndex: 10001,
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

      {/* Unassigned blocks publish confirmation */}
      {unassignedAlert && (
        <>
          <div
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 80 }}
            onMouseDown={() => setUnassignedAlert(null)}
          />
          <div
            style={{
              position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
              zIndex: 81, background: "white", borderRadius: 14,
              boxShadow: "0 8px 40px rgba(0,0,0,0.18)", padding: 24,
              width: 420, maxHeight: "80vh", display: "flex", flexDirection: "column",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <span style={{ fontSize: 22 }}>⚠️</span>
              <div style={{ fontWeight: 800, fontSize: 16, color: "#d97706" }}>Unassigned Blocks</div>
            </div>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 14 }}>
              This schedule has <b>{unassignedAlert.length}</b> unassigned block{unassignedAlert.length !== 1 ? "s" : ""}. Are you sure you want to publish with these unassigned?
            </div>
            <div style={{ overflowY: "auto", flex: 1, borderRadius: 8, border: "1.5px solid #fed7aa", background: "#fff7ed", marginBottom: 16 }}>
              {unassignedAlert.map((item, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: i < unassignedAlert.length - 1 ? "1px solid #fed7aa" : "none" }}>
                  <div style={{ width: 3, flexShrink: 0, alignSelf: "stretch", background: "#f97316", borderRadius: 2 }} />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: "#111827" }}>
                      {item.day} · {item.room}
                    </div>
                    <div style={{ fontSize: 12, color: "#6b7280" }}>
                      {formatTime(item.start)} – {formatTime(item.end)}{item.label && item.label !== "Unassigned" ? ` · ${item.label}` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn btn-pink"
                onClick={() => { setUnassignedAlert(null); void proceedPublish(); }}
                style={{ flex: 1, padding: "9px 0", fontWeight: 700 }}
              >
                Publish Anyway
              </button>
              <button
                className="btn"
                onClick={() => setUnassignedAlert(null)}
                style={{ padding: "9px 16px", fontWeight: 700 }}
              >
                Cancel
              </button>
            </div>
          </div>
        </>
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

      {/* Fill Gaps modal */}
      {fillGaps && (
        <>
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 80 }} onMouseDown={() => setFillGaps(null)} />
          <div
            style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 81, background: "white", borderRadius: 14, boxShadow: "0 8px 40px rgba(0,0,0,0.18)", width: 380, maxHeight: "85vh", display: "flex", flexDirection: "column" }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ padding: "20px 24px 0", flexShrink: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 4 }}>Fill Coverage Gaps</div>
              <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 14 }}>
                Adds unassigned shift blocks wherever a room is below its required teacher count.
              </div>
              <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 6 }}>Rooms</label>
            </div>

            {/* Scrollable room list */}
            <div style={{ overflowY: "auto", flex: 1, padding: "0 24px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingBottom: 4 }}>
                {rooms.map((room) => (
                  <label key={room.id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, padding: "4px 0" }}>
                    <input
                      type="checkbox"
                      checked={fillGaps.selectedRoomIds.has(room.id)}
                      onChange={(e) => {
                        const next = new Set(fillGaps.selectedRoomIds);
                        if (e.target.checked) next.add(room.id); else next.delete(room.id);
                        setFillGaps({ ...fillGaps, selectedRoomIds: next });
                      }}
                    />
                    <span style={{ fontWeight: 600 }}>{room.name}</span>
                    <span style={{ color: "#9ca3af", fontSize: 11 }}>(min {room.required_teachers ?? 2} teacher{(room.required_teachers ?? 2) !== 1 ? "s" : ""})</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Sticky footer */}
            <div style={{ padding: "14px 24px 20px", flexShrink: 0, borderTop: "1px solid #f3f4f6" }}>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 6 }}>Days</label>
                <div style={{ display: "flex", gap: 4 }}>
                  {DAY_LABELS.map((label, i) => {
                    const dayNum = i + 1;
                    const selected = fillGaps.selectedDays.has(dayNum);
                    return (
                      <button
                        key={dayNum}
                        onClick={() => {
                          const next = new Set(fillGaps.selectedDays);
                          if (selected) next.delete(dayNum); else next.add(dayNum);
                          setFillGaps({ ...fillGaps, selectedDays: next });
                        }}
                        style={{ flex: 1, padding: "5px 0", borderRadius: 7, border: selected ? "1.5px solid rgba(230,23,141,0.5)" : "1.5px solid #e5e7eb", background: selected ? "rgba(230,23,141,0.08)" : "white", color: selected ? "#e6178d" : "#374151", fontWeight: 700, fontSize: 12, cursor: "pointer" }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 6 }}>Time Range</label>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="time" value={fillGaps.fillStart} onChange={(e) => setFillGaps({ ...fillGaps, fillStart: e.target.value })} style={{ flex: 1, padding: "6px 8px", borderRadius: 7, border: "1.5px solid #e5e7eb", fontSize: 13 }} />
                  <span style={{ color: "#6b7280", fontSize: 13 }}>to</span>
                  <input type="time" value={fillGaps.fillEnd} onChange={(e) => setFillGaps({ ...fillGaps, fillEnd: e.target.value })} style={{ flex: 1, padding: "6px 8px", borderRadius: 7, border: "1.5px solid #e5e7eb", fontSize: 13 }} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-pink" onClick={runFillGaps} disabled={fillGaps.selectedRoomIds.size === 0 || fillGaps.selectedDays.size === 0} style={{ flex: 1, padding: "9px 0", fontSize: 13, fontWeight: 700 }}>Fill Gaps</button>
                <button className="btn" onClick={() => setFillGaps(null)} style={{ padding: "9px 16px", fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Clear Unassigned modal */}
      {clearUnassigned && (
        <>
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 80 }} onMouseDown={() => setClearUnassigned(null)} />
          <div
            style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 81, background: "white", borderRadius: 14, boxShadow: "0 8px 40px rgba(0,0,0,0.18)", width: 380, maxHeight: "85vh", display: "flex", flexDirection: "column" }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ padding: "20px 24px 0", flexShrink: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 4 }}>Clear Unassigned Blocks</div>
              <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 14 }}>
                Removes all unassigned blocks within the selected rooms and time range.
              </div>
              <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 6 }}>Rooms</label>
            </div>

            {/* Scrollable room list */}
            <div style={{ overflowY: "auto", flex: 1, padding: "0 24px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingBottom: 4 }}>
                {rooms.map((room) => (
                  <label key={room.id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, padding: "4px 0" }}>
                    <input
                      type="checkbox"
                      checked={clearUnassigned.selectedRoomIds.has(room.id)}
                      onChange={(e) => {
                        const next = new Set(clearUnassigned.selectedRoomIds);
                        if (e.target.checked) next.add(room.id); else next.delete(room.id);
                        setClearUnassigned({ ...clearUnassigned, selectedRoomIds: next });
                      }}
                    />
                    <span style={{ fontWeight: 600 }}>{room.name}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Sticky footer */}
            <div style={{ padding: "14px 24px 20px", flexShrink: 0, borderTop: "1px solid #f3f4f6" }}>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 6 }}>Days</label>
                <div style={{ display: "flex", gap: 4 }}>
                  {DAY_LABELS.map((label, i) => {
                    const dayNum = i + 1;
                    const selected = clearUnassigned.selectedDays.has(dayNum);
                    return (
                      <button
                        key={dayNum}
                        onClick={() => {
                          const next = new Set(clearUnassigned.selectedDays);
                          if (selected) next.delete(dayNum); else next.add(dayNum);
                          setClearUnassigned({ ...clearUnassigned, selectedDays: next });
                        }}
                        style={{ flex: 1, padding: "5px 0", borderRadius: 7, border: selected ? "1.5px solid rgba(230,23,141,0.5)" : "1.5px solid #e5e7eb", background: selected ? "rgba(230,23,141,0.08)" : "white", color: selected ? "#e6178d" : "#374151", fontWeight: 700, fontSize: 12, cursor: "pointer" }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 6 }}>Time Range</label>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="time" value={clearUnassigned.clearStart} onChange={(e) => setClearUnassigned({ ...clearUnassigned, clearStart: e.target.value })} style={{ flex: 1, padding: "6px 8px", borderRadius: 7, border: "1.5px solid #e5e7eb", fontSize: 13 }} />
                  <span style={{ color: "#6b7280", fontSize: 13 }}>to</span>
                  <input type="time" value={clearUnassigned.clearEnd} onChange={(e) => setClearUnassigned({ ...clearUnassigned, clearEnd: e.target.value })} style={{ flex: 1, padding: "6px 8px", borderRadius: 7, border: "1.5px solid #e5e7eb", fontSize: 13 }} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" onClick={runClearUnassigned} disabled={clearUnassigned.selectedRoomIds.size === 0 || clearUnassigned.selectedDays.size === 0} style={{ flex: 1, padding: "9px 0", fontSize: 13, fontWeight: 700, color: "#dc2626", borderColor: "#fca5a5" }}>Clear Unassigned</button>
                <button className="btn" onClick={() => setClearUnassigned(null)} style={{ padding: "9px 16px", fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          </div>
        </>
      )}

      {dialogModal}

      {/* Saving indicator */}
      {saving && (
        <div style={{ position: "fixed", bottom: 20, right: 20, padding: "8px 16px", background: "#fdf2f8", border: "1px solid #f9a8d4", borderRadius: 10, fontSize: 13, fontWeight: 700, color: "#e6178d", zIndex: 50 }}>
          Saving…
        </div>
      )}
    </div>
  );
}
