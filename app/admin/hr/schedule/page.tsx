"use client";

import { useEffect, useState } from "react";
import ScheduleListView from "@/components/schedule/ScheduleListView";
import ScheduleGridEditor from "@/components/schedule/ScheduleGridEditor";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import { canEditHr } from "@/lib/hrAccess";

export default function SchedulePage() {
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [me, setMe] = useState<TeacherProfile | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      setMe(await fetchMyProfile());
      setLoaded(true);
    })();
  }, []);

  // Supervisors may read every schedule but change none — the database has only
  // ever given them SELECT here, so opening the editor in write mode would just
  // produce failures. Wait for the profile before deciding, so the editor never
  // renders as writable and then flips.
  const readOnly = !canEditHr(me);

  if (!loaded) {
    return <div className="container" style={{ padding: 20 }}><div className="subtle">Loading…</div></div>;
  }

  if (selectedScheduleId) {
    return (
      <div className="container" style={{ paddingTop: 8, paddingBottom: 40 }}>
        <ScheduleGridEditor
          scheduleId={selectedScheduleId}
          onBack={() => setSelectedScheduleId(null)}
          forceReadOnly={readOnly}
        />
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingBottom: 40 }}>
      <ScheduleListView onSelectSchedule={setSelectedScheduleId} readOnly={readOnly} />
    </div>
  );
}
