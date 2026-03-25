"use client";

import { useState } from "react";
import ScheduleListView from "@/components/schedule/ScheduleListView";
import ScheduleGridEditor from "@/components/schedule/ScheduleGridEditor";

export default function SchedulePage() {
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);

  if (selectedScheduleId) {
    return (
      <div className="container" style={{ paddingTop: 8, paddingBottom: 40 }}>
        <ScheduleGridEditor
          scheduleId={selectedScheduleId}
          onBack={() => setSelectedScheduleId(null)}
        />
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingBottom: 40 }}>
      <ScheduleListView onSelectSchedule={setSelectedScheduleId} />
    </div>
  );
}
