"use client";

import { ReactNode } from "react";
import { usePathname } from "next/navigation";
import Navbar from "@/components/Navbar";
import HrNavbar from "@/components/HrNavbar";
import { CampusProvider } from "@/lib/CampusContext";

export default function LayoutShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // Clock page + public legal pages: no navbar, no page wrapper — standalone UI.
  if (
    pathname === "/clock" || pathname.startsWith("/clock/") ||
    pathname === "/privacy" || pathname === "/terms" || pathname === "/delete-account"
  ) {
    return <>{children}</>;
  }

  const isHr = pathname === "/admin/hr" || pathname.startsWith("/admin/hr/");
  const isLearning = pathname === "/admin/learning" || pathname.startsWith("/admin/learning/");
  const isSchedules = pathname === "/schedules" || pathname.startsWith("/schedules/");

  if (isHr) {
    return (
      <CampusProvider>
        <HrNavbar />
        <div className="page">
          <div className="container">{children}</div>
        </div>
      </CampusProvider>
    );
  }

  // Supervisor schedules view: uses the standard Navbar but needs CampusProvider
  // because it mounts ScheduleGridEditor, which calls useCampusFilter().
  if (isSchedules) {
    return (
      <CampusProvider>
        <Navbar />
        <div className="page">
          <div className="container">{children}</div>
        </div>
      </CampusProvider>
    );
  }

  if (isLearning) {
    return (
      <>
        <Navbar />
        <div className="page">
          <div className="container">{children}</div>
        </div>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <div className="page">
        <div className="container">{children}</div>
      </div>
    </>
  );
}
