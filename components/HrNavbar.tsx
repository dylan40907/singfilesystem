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

  const isActive = !!profile?.is_active;
  const isAdmin = isActive && profile?.role === "admin";
  const isSupervisor = isActive && profile?.role === "supervisor";

  // ✅ HR access: admin OR supervisor
  const canUseHr = !!sessionEmail && isActive && (isAdmin || isSupervisor);

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
    if (pathname === "/admin/hr/meetings" || pathname.startsWith("/admin/hr/meetings/")) return "meetings";
    if (pathname === "/admin/hr/employees" || pathname.startsWith("/admin/hr/employees/")) return "employees";
    if (pathname === "/admin/hr/org-chart" || pathname.startsWith("/admin/hr/org-chart/")) return "org-chart";
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

  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "white",
        borderBottom: "1px solid #e5e7eb",
      }}
    >
      <div className="container">
        <div className="row-between" style={{ padding: "12px 0" }}>
          <div className="row" style={{ gap: 14 }}>
            <Link
              href={hrHomeHref}
              aria-label="Go to HR home"
              style={{ display: "block", width: 48, height: 34, position: "relative" }}
            >
              <Image
                src="/logo.png"
                alt="SING Portal logo"
                fill
                priority
                sizes="48px"
                style={{ objectFit: "contain" }}
              />
            </Link>

            <div>
              <div style={{ fontWeight: 800, fontSize: 15 }}>HR Portal</div>
              <div className="subtle">{subtitle}</div>
            </div>

            {/* ✅ Admin sees all tabs; Supervisor sees Attendance + Performance Review */}
            {canUseHr && (
              <div className="row" style={{ marginLeft: 14, gap: 6, flexWrap: "wrap" }}>
                {isAdmin ? (
                  <>
                    <NavLink href="/admin/hr/employees" label="Employees" active={activeTab === "employees"} />
                    <NavLink href="/admin/hr/attendance" label="Attendance" active={activeTab === "attendance"} />
                    <NavLink href="/admin/hr/meetings" label="Meetings" active={activeTab === "meetings"} />
                    <NavLink href="/admin/hr/org-chart" label="Org Chart" active={activeTab === "org-chart"} />
                    <NavLink href="/admin/hr/settings" label="Settings" active={activeTab === "settings"} />
                  </>
                ) : (
                  <>
                    <NavLink href="/admin/hr/attendance" label="Attendance" active={activeTab === "attendance"} />
                  </>
                )}
              </div>
            )}
          </div>

          <div className="row" style={{ gap: 10 }}>
            <button className="btn" onClick={() => router.push("/")}>
              Curriculum
            </button>

            {sessionEmail ? (
              <span className="badge badge-pink">{(profile?.full_name ?? "").trim() || sessionEmail}</span>
            ) : (
              <span className="subtle">Not signed in</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
