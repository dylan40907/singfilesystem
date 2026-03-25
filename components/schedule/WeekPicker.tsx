"use client";

import { useMemo } from "react";
import {
  getMonday,
  formatDateLocal,
  formatWeekRange,
  parseDateLocal,
} from "@/lib/scheduleUtils";

interface WeekPickerProps {
  value: string; // YYYY-MM-DD (Monday)
  onChange: (weekStart: string) => void;
  /** Number of weeks forward from current week to show */
  weeksForward?: number;
  /** Number of weeks backward from current week to show */
  weeksBack?: number;
}

export default function WeekPicker({
  value,
  onChange,
  weeksForward = 12,
  weeksBack = 12,
}: WeekPickerProps) {
  const options = useMemo(() => {
    const today = new Date();
    const currentMonday = getMonday(today);
    const weeks: string[] = [];

    for (let i = -weeksBack; i <= weeksForward; i++) {
      const d = new Date(currentMonday);
      d.setDate(d.getDate() + i * 7);
      weeks.push(formatDateLocal(d));
    }
    return weeks;
  }, [weeksForward, weeksBack]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: "8px 12px",
        borderRadius: 10,
        border: "1.5px solid #e5e7eb",
        fontSize: 14,
        fontWeight: 600,
        background: "white",
        cursor: "pointer",
        minWidth: 240,
      }}
    >
      {options.map((weekStart) => {
        const mon = parseDateLocal(weekStart);
        const isCurrentWeek =
          formatDateLocal(getMonday(new Date())) === weekStart;
        return (
          <option key={weekStart} value={weekStart}>
            {formatWeekRange(weekStart)}
            {isCurrentWeek ? " (This Week)" : ""}
          </option>
        );
      })}
    </select>
  );
}
