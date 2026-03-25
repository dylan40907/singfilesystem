"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  Schedule,
  ScheduleRoom,
  ScheduleBlock,
  EmployeeLite,
  formatWeekRange,
  formatTime,
  formatTimeRange,
  getMonday,
  formatDateLocal,
  parseDateLocal,
  DAY_LABELS,
  DAY_NUMBERS,
  getDisplayName,
  formatEmployeeName,
} from "@/lib/scheduleUtils";
import WeekPicker from "./WeekPicker";

interface TeacherScheduleViewProps {
  employeeId: string; // hr_employees.id for the current user
}

export default function TeacherScheduleView({ employeeId }: TeacherScheduleViewProps) {
  const [weekStart, setWeekStart] = useState(() =>
    formatDateLocal(getMonday(new Date()))
  );
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [rooms, setRooms] = useState<ScheduleRoom[]>([]);
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [noSchedule, setNoSchedule] = useState(false);

  const fetchSchedule = useCallback(async () => {
    setLoading(true);
    setNoSchedule(false);

    const { data: sched } = await supabase
      .from("schedules")
      .select("*")
      .eq("week_start", weekStart)
      .eq("status", "published")
      .single();

    if (!sched) {
      setSchedule(null);
      setRooms([]);
      setBlocks([]);
      setNoSchedule(true);
      setLoading(false);
      return;
    }

    setSchedule(sched);

    const [roomsRes, blocksRes] = await Promise.all([
      supabase
        .from("schedule_rooms")
        .select("*")
        .eq("schedule_id", sched.id)
        .order("sort_order"),
      supabase
        .from("schedule_blocks")
        .select("*")
        .eq("schedule_id", sched.id)
        .eq("employee_id", employeeId),
    ]);

    setRooms(roomsRes.data ?? []);
    setBlocks(blocksRes.data ?? []);
    setLoading(false);
  }, [weekStart, employeeId]);

  useEffect(() => {
    fetchSchedule();
  }, [fetchSchedule]);

  const roomMap = useMemo(() => {
    const m = new Map<string, ScheduleRoom>();
    for (const r of rooms) m.set(r.id, r);
    return m;
  }, [rooms]);

  // Group blocks by day
  const blocksByDay = useMemo(() => {
    const grouped = new Map<number, ScheduleBlock[]>();
    for (const day of DAY_NUMBERS) grouped.set(day, []);
    for (const b of blocks) {
      const arr = grouped.get(b.day_of_week);
      if (arr) arr.push(b);
    }
    // Sort each day by start_time
    for (const arr of grouped.values()) {
      arr.sort((a, b) => (a.start_time < b.start_time ? -1 : 1));
    }
    return grouped;
  }, [blocks]);

  return (
    <div>
      <div style={{ fontWeight: 950, fontSize: 18 }}>My Schedule</div>
      <div
        style={{
          marginTop: 12,
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 14 }}>Week:</span>
        <WeekPicker value={weekStart} onChange={setWeekStart} weeksBack={24} weeksForward={4} />
      </div>

      {loading ? (
        <div className="subtle" style={{ padding: 20 }}>Loading schedule…</div>
      ) : noSchedule ? (
        <div className="subtle" style={{ padding: 20 }}>
          No published schedule for this week.
        </div>
      ) : blocks.length === 0 ? (
        <div className="subtle" style={{ padding: 20 }}>
          You have no blocks scheduled this week.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {DAY_NUMBERS.map((dayNum, idx) => {
            const dayBlocks = blocksByDay.get(dayNum) ?? [];
            if (dayBlocks.length === 0) return null;
            return (
              <div key={dayNum}>
                <div
                  style={{
                    fontWeight: 800,
                    fontSize: 15,
                    marginBottom: 8,
                    color: "#374151",
                  }}
                >
                  {DAY_LABELS[idx]}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {dayBlocks.map((block) => {
                    const room = roomMap.get(block.room_id);
                    return (
                      <div
                        key={block.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          padding: "10px 14px",
                          background: block.label ? "#e0e7ff" : "#fce7f3",
                          border: block.label
                            ? "1px solid #a5b4fc"
                            : "1px solid #f9a8d4",
                          borderRadius: 10,
                        }}
                      >
                        <div
                          style={{
                            fontWeight: 700,
                            fontSize: 14,
                            minWidth: 150,
                          }}
                        >
                          {formatTimeRange(block.start_time, block.end_time)}
                        </div>
                        <div style={{ fontSize: 13, color: "#6b7280" }}>
                          {room ? room.name : ""}
                          {block.label && (
                            <span style={{ marginLeft: 8, fontWeight: 600, color: "#4f46e5" }}>
                              {block.label}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
