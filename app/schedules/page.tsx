"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile } from "@/lib/teachers";
import { parseDateLocal, scheduleTitle } from "@/lib/scheduleUtils";
import ScheduleGridEditor from "@/components/schedule/ScheduleGridEditor";

type ScheduleRow = {
  id: string;
  name: string | null;
  /** Null on "plan" schedules. */
  week_start: string | null;
  kind: "week" | "plan";
  status: "draft" | "published";
  created_at: string;
};

export default function SupervisorSchedulesPage() {
  const router = useRouter();
  const [authOk, setAuthOk] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Supervisors can browse the weekly schedules or the general Plans.
  const [mode, setMode] = useState<"week" | "plan">("week");

  // Auth: supervisor only
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) { router.replace("/"); return; }
      const profile = await fetchMyProfile();
      if (!profile?.is_active || profile.role !== "supervisor") {
        router.replace("/");
        return;
      }
      setAuthOk(true);
    })();
  }, [router]);

  useEffect(() => {
    if (!authOk) return;
    setLoading(true);
    let q = supabase.from("schedules").select("id, name, week_start, status, created_at, kind").eq("kind", mode);
    q = mode === "week"
      ? q.not("week_start", "is", null).order("week_start", { ascending: false })
      : q.order("created_at", { ascending: false });
    q.then(({ data }) => {
      setSchedules((data as ScheduleRow[]) ?? []);
      setLoading(false);
    });
  }, [authOk, mode]);

  if (!authOk) return null;

  if (selectedId) {
    return (
      <div className="page">
        <div className="container" style={{ paddingTop: 8 }}>
          <ScheduleGridEditor
            scheduleId={selectedId}
            onBack={() => setSelectedId(null)}
            forceReadOnly
          />
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="container">
        <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 14 }}>
          {mode === "week" ? "Schedules" : "Plans"}
        </h2>

        <div style={{ display: "flex", gap: 4, background: "#f3f4f6", padding: 4, borderRadius: 10, width: "fit-content", marginBottom: 18 }}>
          {(["week", "plan"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: "7px 16px", borderRadius: 8, border: "none", cursor: "pointer",
                fontWeight: 800, fontSize: 13,
                background: mode === m ? "white" : "transparent",
                color: mode === m ? "#e6178d" : "#6b7280",
                boxShadow: mode === m ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
              }}
            >
              {m === "week" ? "Schedules" : "Plans"}
            </button>
          ))}
        </div>

        {loading ? (
          <div style={{ color: "#6b7280" }}>Loading…</div>
        ) : schedules.length === 0 ? (
          <div style={{ color: "#6b7280" }}>{mode === "week" ? "No schedules found." : "No plans found."}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 560 }}>
            {schedules.map((s) => {
              const mon = s.week_start ? parseDateLocal(s.week_start) : null;
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
                      {scheduleTitle({ kind: s.kind, name: s.name, week_start: s.week_start })}
                    </div>
                    <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>
                      {s.kind === "plan"
                        ? "Plan"
                        : mon
                        ? `Week of ${mon.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`
                        : ""}
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
    </div>
  );
}
