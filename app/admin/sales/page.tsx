"use client";

import { useEffect, useState } from "react";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";

export default function SalesPage() {
  const [me, setMe] = useState<TeacherProfile | null>(null);
  const canUse = !!me?.is_active && (me.role === "admin" || me.role === "campus_admin");

  useEffect(() => {
    (async () => setMe(await fetchMyProfile()))();
  }, []);

  if (me && !canUse) {
    return (
      <main className="stack">
        <h1 className="h1">Sales</h1>
        <div className="card">
          <div style={{ fontWeight: 800 }}>Not authorized</div>
          <div className="subtle" style={{ marginTop: 6 }}>Only admins and campus admins can use Sales.</div>
        </div>
      </main>
    );
  }

  return (
    <main className="stack">
      <div className="stack" style={{ gap: 6 }}>
        <h1 className="h1">Sales</h1>
        <div className="subtle">Sales tools live here.</div>
      </div>
      <div className="card">
        <div style={{ fontWeight: 800 }}>Nothing here yet</div>
        <div className="subtle" style={{ marginTop: 6 }}>
          Sales tools are on the way — this mode is set up and ready for its first tab.
        </div>
      </div>
    </main>
  );
}
