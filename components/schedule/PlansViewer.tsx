"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useCampusFilter } from "@/lib/CampusContext";
import PlansSection from "./PlansSection";
import ScheduleGridEditor from "./ScheduleGridEditor";

/**
 * Read-only Plans for the staff-facing /hr page.
 *
 * Teachers and supervisors get the same list and the same grid the HR Portal
 * shows, minus every way to change them: no "+ New Plan", and the grid is
 * forced read-only. Scoped to the viewer's own campus when we know it.
 *
 * Which plans actually come back is decided by RLS, not here — teachers see
 * published plans only, supervisors see drafts too.
 */
export default function PlansViewer() {
  const { campuses } = useCampusFilter();
  // undefined = still resolving, null = no campus on their HR record.
  const [campusId, setCampusId] = useState<string | null | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc("current_employee_campus");
      setCampusId((data as string | null) ?? null);
    })();
  }, []);

  if (selectedId) {
    return <ScheduleGridEditor scheduleId={selectedId} onBack={() => setSelectedId(null)} forceReadOnly />;
  }

  if (campusId === undefined) {
    return <div className="subtle" style={{ padding: 12 }}>Loading plans…</div>;
  }

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, padding: 14 }}>
      <PlansSection
        onSelectSchedule={setSelectedId}
        campuses={campuses}
        // No campus on the record: fall back to everything they're allowed to read.
        campusFilter={campusId ?? "all"}
        defaultCampusId=""
        isCampusAdmin={false}
        readOnly
      />
    </div>
  );
}
