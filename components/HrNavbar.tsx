"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";

function NavLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      style={{
        padding: "10px 12px",
        borderRadius: 12,
        border: active ? "1px solid rgba(230,23,141,0.35)" : "1px solid transparent",
        background: active ? "rgba(230,23,141,0.06)" : "transparent",
        color: active ? "#e6178d" : "#111827",
        fontWeight: 700,
        fontSize: 14,
        textDecoration: "none",
      }}
    >
      {label}
    </Link>
  );
}

export default function HrNavbar() {
  const pathname = usePathname();
  const router = useRouter();

  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<TeacherProfile | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = !!profile?.is_active;
  const isAdmin = isActive && profile?.role === "admin";
  const isSupervisor = isActive && profile?.role === "supervisor";

  // ✅ HR access: admin OR supervisor
  const canUseHr = !!sessionEmail && isActive && (isAdmin || isSupervisor);

  useEffect(() => { setMenuOpen(false); }, [pathname]);

  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  async function applySession(session: any) {
    const email = session?.user?.email ?? null;
    setSessionEmail(email);

    if (!email) {
      setProfile(null);
      return;
    }

    try {
      const p = await fetchMyProfile();
      setProfile(p);
    } catch {
      setProfile(null);
    }
  }

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => applySession(data.session))
      .catch(() => applySession(null));

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      void applySession(session);

      if (!session && pathnameRef.current.startsWith("/admin/hr")) {
        router.replace("/");
      }
    });

    return () => {
      data.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeTab = useMemo(() => {
    if (pathname === "/admin/hr/settings" || pathname.startsWith("/admin/hr/settings/")) return "settings";
    if (pathname === "/admin/hr/attendance" || pathname.startsWith("/admin/hr/attendance/")) return "attendance";
    if (pathname === "/admin/hr/employees" || pathname.startsWith("/admin/hr/employees/")) return "employees";
    if (pathname === "/admin/hr/employee-meetings" || pathname.startsWith("/admin/hr/employee-meetings/"))
      return "employee-meetings";
    if (pathname === "/admin/hr/schedule" || pathname.startsWith("/admin/hr/schedule/")) return "schedule";
    if (pathname === "/admin/hr/org-chart" || pathname.startsWith("/admin/hr/org-chart/")) return "org-chart";
    if (pathname === "/admin/hr/timesheets" || pathname.startsWith("/admin/hr/timesheets/")) return "timesheets";
    if (pathname === "/admin/hr/leave" || pathname.startsWith("/admin/hr/leave/")) return "leave";
    return "employees";
  }, [pathname]);

  // ✅ For supervisors, send "home" to Attendance
  const hrHomeHref = isAdmin ? "/admin/hr/employees" : "/admin/hr/attendance";

  const subtitle = useMemo(() => {
    if (!sessionEmail) return "Not signed in";
    if (!isActive) return "Inactive account";
    if (isAdmin) return "Admin";
    if (isSupervisor) return "Supervisor";
    return "No HR access";
  }, [sessionEmail, isActive, isAdmin, isSupervisor]);

  const displayName = (profile?.full_name ?? "").trim() || sessionEmail || "";

  const adminLinks = canUseHr && isAdmin ? [
    { href: "/admin/hr/employees", label: "Employees", tab: "employees" },
    { href: "/admin/hr/attendance", label: "Attendance", tab: "attendance" },
    { href: "/admin/hr/org-chart", label: "Org Chart", tab: "org-chart" },
    { href: "/admin/hr/employee-meetings", label: "Meetings", tab: "employee-meetings" },
    { href: "/admin/hr/schedule", label: "Schedule", tab: "schedule" },
    { href: "/admin/hr/timesheets", label: "Timesheets", tab: "timesheets" },
    { href: "/admin/hr/leave", label: "Leave", tab: "leave" },
    { href: "/admin/hr/settings", label: "Settings", tab: "settings" },
  ] : canUseHr && isSupervisor ? [
    { href: "/admin/hr/attendance", label: "Attendance", tab: "attendance" },
  ] : [];

  return (
    <div style={{ position: "sticky", top: 0, zIndex: 50, background: "white", borderBottom: "1px solid #e5e7eb" }}>
      <div className="container">
        <div className="row-between" style={{ padding: "12px 0" }}>
          {/* Logo + title */}
          <div className="row" style={{ gap: 14 }}>
            <Link href={hrHomeHref} aria-label="Go to HR home" style={{ display: "block", width: 48, height: 34, position: "relative" }}>
              <Image src="/logo.png" alt="SING Portal logo" fill priority sizes="48px" style={{ objectFit: "contain" }} />
            </Link>
            <div>
              <div style={{ fontWeight: 800, fontSize: 15 }}>HR Portal</div>
              <div className="subtle">{subtitle}</div>
            </div>

            {/* Desktop tabs */}
            {canUseHr && (
              <div className="row hide-mobile" style={{ marginLeft: 14, gap: 6, flexWrap: "wrap" }}>
                {adminLinks.map((l) => (
                  <NavLink key={l.tab} href={l.href} label={l.label} active={activeTab === l.tab} />
                ))}
              </div>
            )}
          </div>

          {/* Desktop right controls */}
          <div className="row hide-mobile" style={{ gap: 10 }}>
            <button className="btn" onClick={() => router.push("/")}>Curriculum</button>
            {sessionEmail ? (
              <span className="badge badge-pink">{displayName}</span>
            ) : (
              <span className="subtle">Not signed in</span>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            className="nav-hamburger-btn hide-desktop"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
          >
            <span style={{ opacity: menuOpen ? 0.4 : 1 }} />
            <span />
            <span style={{ opacity: menuOpen ? 0.4 : 1 }} />
          </button>
        </div>

        {/* Mobile dropdown */}
        {menuOpen && (
          <div className="nav-mobile-panel hide-desktop">
            {adminLinks.map((l) => (
              <Link key={l.tab} href={l.href} className={`nav-mobile-link${activeTab === l.tab ? " active" : ""}`}>
                {l.label}
              </Link>
            ))}
            <div className="nav-mobile-divider" />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 8px 0", gap: 10 }}>
              {sessionEmail ? (
                <span style={{ fontSize: 13, fontWeight: 700, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</span>
              ) : (
                <span className="subtle">Not signed in</span>
              )}
              <button className="btn" onClick={() => { setMenuOpen(false); router.push("/"); }} style={{ flexShrink: 0 }}>
                Curriculum
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
