"use client";

import { ReactNode } from "react";
import { usePathname } from "next/navigation";
import Navbar from "@/components/Navbar";
import HrNavbar from "@/components/HrNavbar";
import ModeNavbar from "@/components/ModeNavbar";
import { CampusProvider } from "@/lib/CampusContext";

export default function LayoutShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // Clock page, public legal pages and the public tour booking pages: no navbar,
  // no page wrapper — standalone UI. /book/* is also embedded in Squarespace via
  // an iframe, so it must render nothing but itself.
  if (
    pathname === "/clock" || pathname.startsWith("/clock/") ||
    pathname === "/book" || pathname.startsWith("/book/") ||
    pathname === "/privacy" || pathname === "/hr-privacy" || pathname === "/terms" || pathname === "/delete-account"
  ) {
    return <>{children}</>;
  }

  const isHr =
    pathname === "/admin/hr" || pathname.startsWith("/admin/hr/") ||
    pathname === "/admin/courses" || pathname.startsWith("/admin/courses/");
  const isLearning = pathname === "/admin/learning" || pathname.startsWith("/admin/learning/");
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
        <ModeNavbar
          mode="sales"
          title="Sales"
          links={[
            { href: "/admin/sales", label: "Leads", tab: "leads" },
            { href: "/admin/sales/tours", label: "Tours", tab: "tours" },
            { href: "/admin/sales/meetings", label: "Meetings", tab: "meetings" },
            { href: "/admin/sales/reports", label: "Reports", tab: "reports" },
            { href: "/admin/sales/settings", label: "Settings", tab: "settings" },
          ]}
        />
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
