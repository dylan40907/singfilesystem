"use client";

import { ReactNode } from "react";
import { usePathname } from "next/navigation";
import Navbar from "@/components/Navbar";
import HrNavbar from "@/components/HrNavbar";
import ModeNavbar from "@/components/ModeNavbar";
import { CampusProvider } from "@/lib/CampusContext";

export default function LayoutShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // Clock page + public legal pages: no navbar, no page wrapper — standalone UI.
  if (
    pathname === "/clock" || pathname.startsWith("/clock/") ||
    pathname === "/privacy" || pathname === "/hr-privacy" || pathname === "/terms" || pathname === "/delete-account"
  ) {
    return <>{children}</>;
  }

  const isHr =
    pathname === "/admin/hr" || pathname.startsWith("/admin/hr/") ||
    pathname === "/admin/courses" || pathname.startsWith("/admin/courses/");
  const isLearning = pathname === "/admin/learning" || pathname.startsWith("/admin/learning/");
  const isSchedules = pathname === "/schedules" || pathname.startsWith("/schedules/");
  const isStudents = pathname === "/admin/students" || pathname.startsWith("/admin/students/");
  const isSales = pathname === "/admin/sales" || pathname.startsWith("/admin/sales/");

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

  // Students mode — Admissions needs CampusProvider (it reads the campus list).
  if (isStudents) {
    return (
      <CampusProvider>
        <ModeNavbar
          mode="students"
          title="Students"
          links={[{ href: "/admin/students/admissions", label: "Admissions", tab: "admissions" }]}
        />
        <div className="page">
          <div className="container">{children}</div>
        </div>
      </CampusProvider>
    );
  }

  if (isSales) {
    return (
      <CampusProvider>
        <ModeNavbar mode="sales" title="Sales" links={[]} />
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
