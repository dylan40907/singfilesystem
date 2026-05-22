"use client";

import { ReactNode } from "react";
import { usePathname } from "next/navigation";
import Navbar from "@/components/Navbar";
import HrNavbar from "@/components/HrNavbar";
import { CampusProvider } from "@/lib/CampusContext";

export default function LayoutShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // Clock page: no navbar, no page wrapper — full-screen standalone UI
  if (pathname === "/clock" || pathname.startsWith("/clock/")) {
    return <>{children}</>;
  }

  const isHr = pathname === "/admin/hr" || pathname.startsWith("/admin/hr/");

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

  return (
    <>
      <Navbar />
      <div className="page">
        <div className="container">{children}</div>
      </div>
    </>
  );
}
