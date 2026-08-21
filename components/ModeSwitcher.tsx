"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TeacherProfile } from "@/lib/teachers";
import { AccessMap, NO_ACCESS, canEnterMode, canView, fetchAccess } from "@/lib/access";
import { PAGES } from "@/lib/pagePermissions";

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

/**
 * Landing route for each mode — the first page in it this person can open.
 *
 * It used to be a fixed route per mode, which broke as soon as roles stopped
 * being uniform: a teacher granted only Timesheets was sent to Employees, had
 * no access, and was bounced straight back.
 */
export function modeHome(mode: PortalMode, access: AccessMap): string {
  if (mode === "curriculum") return "/";
  const first = PAGES.find((p) => p.mode === mode && canView(access, p.key));
  if (first) return first.path;
  // No page visible — shouldn't be reachable, since the mode wouldn't be offered.
  return "/";
}

/**
 * Which modes this account may enter.
 *
 * Derived from the resolved page permissions rather than hardcoded role checks:
 * a mode is offered when at least one page inside it is visible. That way a
 * custom role granting, say, Timesheets to a teacher opens the HR section
 * without anyone having to remember to update this function too.
 */
export function availableModes(access: AccessMap): PortalMode[] {
  const modes: PortalMode[] = [];
  for (const mode of ["curriculum", "hr", "students", "sales"] as PortalMode[]) {
    if (canEnterMode(access, mode)) modes.push(mode);
  }
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
  const [access, setAccess] = useState<AccessMap>(NO_ACCESS);
  useEffect(() => { fetchAccess(profile).then(setAccess).catch(() => setAccess(NO_ACCESS)); }, [profile]);
  const modes = availableModes(access);

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
                  router.push(modeHome(m, access));
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
