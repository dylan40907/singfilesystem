"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile } from "@/lib/teachers";
import { formatWeekRange, parseDateLocal } from "@/lib/scheduleUtils";
import ScheduleGridEditor from "@/components/schedule/ScheduleGridEditor";

type ScheduleRow = {
  id: string;
  week_start: string;
  status: "draft" | "published";
  created_at: string;
};

export default function SupervisorSchedulePage() {
  const router = useRouter();
  const [authOk, setAuthOk] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Auth: supervisor only
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) { router.replace("/"); return; }
      const profile = await fetchMyProfile();
      if (!profile?.is_active || (profile.role !== "supervisor" && profile.role !== "admin")) {
        router.replace("/");
        return;
      }
      setAuthOk(true);
    })();
  }, [router]);

  useEffect(() => {
    if (!authOk) return;
    supabase
      .from("schedules")
      .select("id, week_start, status, created_at")
      .order("week_start", { ascending: false })
      .then(({ data }) => {
        setSchedules((data as ScheduleRow[]) ?? []);
        setLoading(false);
      });
  }, [authOk]);

  if (!authOk) return null;

  if (selectedId) {
    return (
      <div className="container" style={{ paddingTop: 24, paddingBottom: 40 }}>
        <ScheduleGridEditor
          scheduleId={selectedId}
          onBack={() => setSelectedId(null)}
          forceReadOnly
        />
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingTop: 24, paddingBottom: 40 }}>
      <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 20 }}>Schedules</h2>

      {loading ? (
        <div style={{ color: "#6b7280" }}>Loading schedules…</div>
      ) : schedules.length === 0 ? (
        <div style={{ color: "#6b7280" }}>No schedules found.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 560 }}>
          {schedules.map((s) => {
            const mon = parseDateLocal(s.week_start);
            const isPublished = s.status === "published";
            return (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "14px 18px", borderRadius: 12,
                  border: "1.5px solid #e5e7eb", background: "white",
                  cursor: "pointer", textAlign: "left",
                  transition: "border-color 0.1s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#d1d5db")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#e5e7eb")}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>
                    {formatWeekRange(s.week_start)}
                  </div>
                  <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>
                    Week of {mon.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                  </div>
                </div>
                <span style={{
                  padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 700,
                  background: isPublished ? "#dcfce7" : "#fef3c7",
                  color: isPublished ? "#16a34a" : "#d97706",
                }}>
                  {isPublished ? "Published" : "Draft"}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
