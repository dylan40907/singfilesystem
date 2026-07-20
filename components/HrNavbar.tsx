"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import CampusSelector from "@/components/CampusSelector";
import ChatNavBadge from "@/components/chat/ChatNavBadge";
import NotificationsBell from "@/components/NotificationsBell";
import ModeSwitcher from "@/components/ModeSwitcher";

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
        padding: "8px 12px",
        borderRadius: 10,
        border: active ? "1px solid rgba(230,23,141,0.35)" : "1px solid transparent",
        background: active ? "rgba(230,23,141,0.08)" : "transparent",
        color: active ? "#e6178d" : "#374151",
        fontWeight: 700,
        fontSize: 13.5,
        textDecoration: "none",
        whiteSpace: "nowrap",
        flexShrink: 0,
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
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await supabase.auth.signOut({ scope: "global" });
      router.replace("/");
    } finally {
      setSigningOut(false);
    }
  }

  const isActive = !!profile?.is_active;
  const isAdmin = isActive && profile?.role === "admin";
  const isCampusAdmin = isActive && profile?.role === "campus_admin";
  const isSupervisor = isActive && profile?.role === "supervisor";

  // ✅ HR access: admin OR campus_admin OR supervisor
  const canUseHr = !!sessionEmail && isActive && (isAdmin || isCampusAdmin || isSupervisor);
  // ✅ "Admin-level" access (excludes supervisors) — controls visibility of admin-only tabs/buttons
  const hasAdminAccess = isAdmin || isCampusAdmin;

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
    if (pathname === "/admin/hr/documents" || pathname.startsWith("/admin/hr/documents/")) return "documents";
    if (pathname === "/admin/hr/employee-meetings" || pathname.startsWith("/admin/hr/employee-meetings/"))
      return "employee-meetings";
    if (pathname === "/admin/hr/schedule" || pathname.startsWith("/admin/hr/schedule/")) return "schedule";
    if (pathname === "/admin/hr/org-chart" || pathname.startsWith("/admin/hr/org-chart/")) return "org-chart";
    if (pathname === "/admin/hr/timesheets" || pathname.startsWith("/admin/hr/timesheets/")) return "timesheets";
    if (pathname === "/admin/hr/leave" || pathname.startsWith("/admin/hr/leave/")) return "leave";
    if (pathname === "/admin/hr/roles" || pathname.startsWith("/admin/hr/roles/")) return "roles";
    if (pathname === "/admin/courses" || pathname.startsWith("/admin/courses/")) return "courses";
    return "employees";
  }, [pathname]);

  // ✅ For supervisors, send "home" to Attendance
  const hrHomeHref = hasAdminAccess ? "/admin/hr/employees" : "/admin/hr/attendance";

  const subtitle = useMemo(() => {
    if (!sessionEmail) return "Not signed in";
    if (!isActive) return "Inactive account";
    if (isAdmin) return "Admin";
    if (isCampusAdmin) return "Campus Admin";
    if (isSupervisor) return "Supervisor";
    return "No HR access";
  }, [sessionEmail, isActive, isAdmin, isCampusAdmin, isSupervisor]);

  const displayName = (profile?.full_name ?? "").trim() || sessionEmail || "";

  const adminLinks = canUseHr && hasAdminAccess ? [
    { href: "/admin/hr/employees", label: "Employees", tab: "employees" },
    { href: "/admin/hr/documents", label: "Documents", tab: "documents" },
    { href: "/admin/hr/attendance", label: "Attendance", tab: "attendance" },
    { href: "/admin/hr/org-chart", label: "Org Chart", tab: "org-chart" },
    { href: "/admin/hr/employee-meetings", label: "Meetings", tab: "employee-meetings" },
    { href: "/admin/hr/schedule", label: "Schedule", tab: "schedule" },
    { href: "/admin/hr/timesheets", label: "Timesheets", tab: "timesheets" },
    { href: "/admin/hr/leave", label: "Leave", tab: "leave" },
    ...((isAdmin || isCampusAdmin) ? [{ href: "/admin/courses", label: "Courses", tab: "courses" }] : []),
    ...(isAdmin ? [{ href: "/admin/hr/settings", label: "Settings", tab: "settings" }] : []),
    ...(isAdmin ? [{ href: "/admin/hr/roles", label: "Roles", tab: "roles" }] : []),
  ] : canUseHr && isSupervisor ? [
    { href: "/admin/hr/attendance", label: "Attendance", tab: "attendance" },
  ] : [];

  return (
    <div style={{ position: "sticky", top: 0, zIndex: 50, background: "white", borderBottom: "1px solid #e5e7eb" }}>
      <div className="container">
        {/* Top row: brand + controls */}
        <div className="row-between" style={{ padding: "12px 0", gap: 12 }}>
          {/* Logo + title */}
          <div className="row" style={{ gap: 12, alignItems: "center", minWidth: 0 }}>
            <Link href={hrHomeHref} aria-label="Go to HR home" style={{ display: "block", width: 46, height: 34, position: "relative", flexShrink: 0 }}>
              <Image src="/logo.png" alt="SING Portal logo" fill priority sizes="46px" style={{ objectFit: "contain" }} />
            </Link>
            <div style={{ minWidth: 0, lineHeight: 1.15 }}>
              <div style={{ fontWeight: 800, fontSize: 15 }}>HR Portal</div>
              <div className="subtle" style={{ fontSize: 12 }}>{subtitle}</div>
            </div>
          </div>

          {/* Desktop right controls */}
          <div className="row hide-mobile" style={{ gap: 8, alignItems: "center" }}>
            {canUseHr && hasAdminAccess && <CampusSelector />}
            {sessionEmail && isActive && <NotificationsBell />}
            {sessionEmail && isActive && (
              <button
                className="btn"
                onClick={() => router.push("/chat")}
                style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
              >
                Chat <ChatNavBadge />
              </button>
            )}
            <ModeSwitcher profile={profile} current="hr" />
            {sessionEmail ? (
              <>
                <span className="badge badge-pink">{displayName}</span>
                <button className="btn btn-primary" onClick={signOut} disabled={signingOut}>
                  {signingOut ? "Signing out..." : "Sign out"}
                </button>
              </>
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

        {/* Tabs row (desktop) — single scrollable line so it never wraps */}
        {canUseHr && (
          <div
            className="hide-mobile"
            style={{ display: "flex", gap: 4, overflowX: "auto", paddingTop: 8, paddingBottom: 10, borderTop: "1px solid #f3f4f6" }}
          >
            {adminLinks.map((l) => (
              <NavLink key={l.tab} href={l.href} label={l.label} active={activeTab === l.tab} />
            ))}
          </div>
        )}

        {/* Mobile dropdown */}
        {menuOpen && (
          <div className="nav-mobile-panel hide-desktop">
            {adminLinks.map((l) => (
              <Link key={l.tab} href={l.href} className={`nav-mobile-link${activeTab === l.tab ? " active" : ""}`}>
                {l.label}
              </Link>
            ))}
            {canUseHr && hasAdminAccess && (
              <>
                <div className="nav-mobile-divider" />
                <div style={{ padding: "8px" }}>
                  <CampusSelector />
                </div>
              </>
            )}
            <div className="nav-mobile-divider" />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 8px 0", gap: 10 }}>
              {sessionEmail ? (
                <span style={{ fontSize: 13, fontWeight: 700, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</span>
              ) : (
                <span className="subtle">Not signed in</span>
              )}
              <ModeSwitcher profile={profile} current="hr" onNavigate={() => setMenuOpen(false)} />
            </div>
            {sessionEmail && (
              <div style={{ padding: "10px 8px 0" }}>
                <button className="btn btn-primary" onClick={signOut} disabled={signingOut} style={{ width: "100%" }}>
                  {signingOut ? "Signing out..." : "Sign out"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
