"use client";

import { useState } from "react";
import ScheduleListView from "@/components/schedule/ScheduleListView";
import ScheduleGridEditor from "@/components/schedule/ScheduleGridEditor";
import { usePageAccess } from "@/components/PageAccessGuard";

export default function SchedulePage() {
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);

  /**
   * Whether the grid opens writable comes from the Schedule grant, not from the
   * account's level. It used to be `admin || campus_admin`, so a role granted
   * "Schedule: edit" got the page and no way to change anything on it.
   *
   * The matching "page grant edit schedules" policies mean the database agrees,
   * rather than the editor offering saves that RLS then refuses.
   */
  const { readOnly, loading } = usePageAccess();

  if (loading) {
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
