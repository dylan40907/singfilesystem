"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  Schedule,
  formatWeekRange,
  getMonday,
  formatDateLocal,
} from "@/lib/scheduleUtils";
import WeekPicker from "./WeekPicker";

interface ScheduleListViewProps {
  onSelectSchedule: (id: string) => void;
}

export default function ScheduleListView({ onSelectSchedule }: ScheduleListViewProps) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newWeekStart, setNewWeekStart] = useState(() =>
    formatDateLocal(getMonday(new Date()))
  );
  const [showNewForm, setShowNewForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchSchedules() {
    setLoading(true);
    const { data, error: err } = await supabase
      .from("schedules")
      .select("*")
      .order("week_start", { ascending: false });
    if (err) {
      setError(err.message);
    } else {
      setSchedules(data ?? []);
    }
    setLoading(false);
  }

  useEffect(() => {
    fetchSchedules();
  }, []);

  async function handleCreate() {
    setError(null);
    // Check if schedule already exists for this week
    const existing = schedules.find((s) => s.week_start === newWeekStart);
    if (existing) {
      setError("A schedule already exists for this week.");
      return;
    }

    setCreating(true);
    const { data, error: err } = await supabase
      .from("schedules")
      .insert({ week_start: newWeekStart, status: "draft" })
      .select()
      .single();

    if (err) {
      setError(err.message);
      setCreating(false);
      return;
    }

    // Auto-fill rooms from most recent previous schedule
    if (data) {
      const { data: prevSchedule } = await supabase
        .from("schedules")
        .select("id")
        .lt("week_start", newWeekStart)
        .order("week_start", { ascending: false })
        .limit(1)
        .single();

      if (prevSchedule) {
        const { data: prevRooms } = await supabase
          .from("schedule_rooms")
          .select("name, capacity, sort_order")
          .eq("schedule_id", prevSchedule.id)
          .order("sort_order");

        if (prevRooms && prevRooms.length > 0) {
          await supabase.from("schedule_rooms").insert(
            prevRooms.map((r) => ({
              schedule_id: data.id,
              name: r.name,
              capacity: r.capacity,
              sort_order: r.sort_order,
            }))
          );
        }
      }

      setCreating(false);
      setShowNewForm(false);
      onSelectSchedule(data.id);
    }
  }

  return (
    <div style={{ padding: "24px 0" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Schedules</h2>
        <button
          className="btn btn-pink"
          onClick={() => setShowNewForm(!showNewForm)}
        >
          {showNewForm ? "Cancel" : "+ New Schedule"}
        </button>
      </div>

      {showNewForm && (
        <div
          style={{
            padding: 16,
            background: "#fdf2f8",
            borderRadius: 12,
            marginBottom: 20,
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 14 }}>Week:</span>
          <WeekPicker value={newWeekStart} onChange={setNewWeekStart} weeksBack={4} weeksForward={16} />
          <button
            className="btn btn-pink"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? "Creating…" : "Create Draft"}
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "10px 16px",
            background: "#fef2f2",
            color: "#dc2626",
            borderRadius: 10,
            marginBottom: 16,
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="subtle" style={{ padding: 20 }}>
          Loading schedules…
        </div>
      ) : schedules.length === 0 ? (
        <div className="subtle" style={{ padding: 20 }}>
          No schedules yet. Create one to get started.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {schedules.map((s) => (
            <button
              key={s.id}
              onClick={() => onSelectSchedule(s.id)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "14px 18px",
                background: "white",
                border: "1.5px solid #e5e7eb",
                borderRadius: 12,
                cursor: "pointer",
                textAlign: "left",
                transition: "border-color 0.15s",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.borderColor = "#e6178d")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.borderColor = "#e5e7eb")
              }
            >
              <div>
                <div style={{ fontWeight: 800, fontSize: 15 }}>
                  {formatWeekRange(s.week_start)}
                </div>
                <div className="subtle" style={{ fontSize: 13, marginTop: 2 }}>
                  {s.week_start}
                </div>
              </div>
              <span
                style={{
                  padding: "4px 12px",
                  borderRadius: 20,
                  fontSize: 12,
                  fontWeight: 700,
                  background:
                    s.status === "published" ? "#dcfce7" : "#fef3c7",
                  color:
                    s.status === "published" ? "#16a34a" : "#d97706",
                }}
              >
                {s.status === "published" ? "Published" : "Draft"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
