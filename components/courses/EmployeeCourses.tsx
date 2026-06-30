"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  FullCourse, MyCourse, fetchCourseFull, fetchMyCourses,
} from "@/lib/courses";
import CourseTaker from "./CourseTaker";

export default function EmployeeCourses() {
  const [myId, setMyId] = useState<string | null>(null);
  const [courses, setCourses] = useState<MyCourse[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<{ mc: MyCourse; full: FullCourse } | null>(null);

  const reload = useCallback(async (uid: string) => {
    setLoading(true);
    try {
      setCourses(await fetchMyCourses(uid));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      const uid = data.user?.id ?? null;
      setMyId(uid);
      if (uid) reload(uid);
      else setLoading(false);
    })();
  }, [reload]);

  async function openCourse(mc: MyCourse) {
    const full = await fetchCourseFull(mc.course.id);
    if (full) setOpen({ mc, full });
  }

  if (loading) return <div className="subtle">Loading your courses…</div>;
  if (courses.length === 0) return <div className="card"><div className="subtle" style={{ padding: 12 }}>No courses assigned to you yet.</div></div>;

  return (
    <div className="card">
      <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 12 }}>My Courses</div>
      <div style={{ display: "grid", gap: 10 }}>
        {courses.map((mc) => {
          const a = mc.assignment;
          const label = a.status === "completed" ? "Review" : a.status === "in_progress" ? "Continue" : "Start";
          return (
            <div key={mc.course.id} className="row-between" style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 14px", flexWrap: "wrap", gap: 10 }}>
              <div className="row" style={{ gap: 10, minWidth: 0 }}>
                {mc.segment && <span style={{ width: 10, height: 10, borderRadius: 999, background: mc.segment.color }} />}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{mc.course.title}</div>
                  <div className="subtle" style={{ fontSize: 12 }}>{mc.segment?.name ?? "Course"}</div>
                </div>
              </div>
              <div className="row" style={{ gap: 10, alignItems: "center" }}>
                <StatusPill status={a.status} />
                <button className="btn btn-primary" onClick={() => openCourse(mc)}>{label}</button>
              </div>
            </div>
          );
        })}
      </div>

      {open && (
        <CourseTaker
          assignmentId={open.mc.assignment.id}
          full={open.full}
          initialProgress={open.mc.assignment.progress ?? {}}
          onClose={() => { setOpen(null); if (myId) reload(myId); }}
          onCompletedChange={() => { if (myId) reload(myId); }}
        />
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    completed: { bg: "#dcfce7", fg: "#166534", label: "Completed" },
    in_progress: { bg: "#fef9c3", fg: "#854d0e", label: "In progress" },
    not_started: { bg: "#fee2e2", fg: "#991b1b", label: "Not started" },
  };
  const s = map[status] ?? map.not_started;
  return <span style={{ background: s.bg, color: s.fg, fontWeight: 700, fontSize: 12, padding: "3px 10px", borderRadius: 999 }}>{s.label}</span>;
}
