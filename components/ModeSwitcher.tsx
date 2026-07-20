"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TeacherProfile } from "@/lib/teachers";

/**
 * The portal has several "modes", each with its own navbar and tab set.
 * This pill replaces the old two-way Curriculum ⇆ HR toggle.
 */
export type PortalMode = "curriculum" | "hr" | "students" | "sales";

export const MODE_LABEL: Record<PortalMode, string> = {
  curriculum: "Curriculum",
  hr: "HR Portal",
  students: "Students",
  sales: "Sales",
};

/** Landing route for each mode. */
export function modeHome(mode: PortalMode, profile: TeacherProfile | null): string {
  switch (mode) {
    case "curriculum":
      return "/";
    case "hr":
      // Supervisors don't get the Employees tab — send them to Attendance.
      return profile?.role === "supervisor" ? "/admin/hr/attendance" : "/admin/hr/employees";
    case "students":
      return "/admin/students/admissions";
    case "sales":
      return "/admin/sales";
  }
}

/** Which modes this account may enter. */
export function availableModes(profile: TeacherProfile | null): PortalMode[] {
  if (!profile?.is_active) return [];
  const role = profile.role;
  const isAdmin = role === "admin";
  const isCampusAdmin = role === "campus_admin";
  const isSupervisor = role === "supervisor";

  const modes: PortalMode[] = ["curriculum"];
  // Students mirrors admissions access: admins, campus admins, supervisors.
  if (isAdmin || isCampusAdmin || isSupervisor) modes.push("hr", "students");
  if (isAdmin || isCampusAdmin) modes.push("sales");
  return modes;
}

const pill: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 999,
  border: "1.5px solid rgba(230,23,141,0.45)",
  background: "rgba(230,23,141,0.06)",
  color: "#e6178d",
  fontWeight: 800,
  fontSize: 13.5,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export default function ModeSwitcher({
  profile,
  current,
  onNavigate,
}: {
  profile: TeacherProfile | null;
  current: PortalMode;
  /** Optional hook so mobile menus can close themselves on navigate. */
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const modes = availableModes(profile);

  // Escape closes (house rule for every popup), as does an outside click.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  // Nothing to switch to → don't render the control at all.
  if (modes.length <= 1) return null;

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setOpen((v) => !v)} style={pill} title="Switch mode">
        ⇆ {MODE_LABEL[current]} <span style={{ fontSize: 9, opacity: 0.75 }}>▼</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 200,
            background: "white", border: "1px solid #e5e7eb", borderRadius: 12,
            boxShadow: "0 10px 30px rgba(0,0,0,0.14)", padding: 6, minWidth: 176,
          }}
        >
          {modes.map((m) => {
            const active = m === current;
            return (
              <button
                key={m}
                onClick={() => {
                  setOpen(false);
                  onNavigate?.();
                  router.push(modeHome(m, profile));
                }}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  padding: "9px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                  fontWeight: 800, fontSize: 13.5,
                  background: active ? "rgba(230,23,141,0.08)" : "transparent",
                  color: active ? "#e6178d" : "#374151",
                }}
              >
                {MODE_LABEL[m]}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
