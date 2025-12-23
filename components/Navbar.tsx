"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
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
      }}
    >
      {label}
    </Link>
  );
}

export default function Navbar() {
  const pathname = usePathname();

  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<TeacherProfile | null>(null);

  const isActive = !!profile?.is_active;
  const isAdminOrSupervisor =
    !!profile?.is_active && (profile.role === "admin" || profile.role === "supervisor");

  const showMyPlans = !!sessionEmail && isActive;
  const showTeachers = !!sessionEmail && isAdminOrSupervisor;
  const showReviewQueue = !!sessionEmail && isAdminOrSupervisor;
  const isAdmin = !!profile?.is_active && profile.role === "admin";
  const showSupervisors = !!sessionEmail && isAdmin;

  async function refresh() {
    const { data: sessionData } = await supabase.auth.getSession();
    const email = sessionData.session?.user?.email ?? null;
    setSessionEmail(email);

    if (!email) {
      setProfile(null);
      return;
    }

    try {
      const p = await fetchMyProfile();
      setProfile(p);
    } catch {
      // If profile fetch fails, still keep sessionEmail for sign-out visibility
      setProfile(null);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    await refresh();
  }

  useEffect(() => {
    refresh();

    const { data } = supabase.auth.onAuthStateChange(() => {
      refresh();
    });

    return () => {
      data.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeTab = useMemo(() => {
    if (pathname.startsWith("/admin/supervisors")) return "supervisors";
    if (pathname === "/teachers") return "teachers";
    if (pathname === "/review-queue") return "review-queue";
    if (pathname === "/my-plans") return "my-plans";
    return "home";
  }, [pathname]);

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
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 12,
                background: "#e6178d",
              }}
            />
            <div>
              <div style={{ fontWeight: 800, fontSize: 15 }}>Sing Portal</div>
              <div className="subtle">Files + Lesson Plans</div>
            </div>

            <div className="row" style={{ marginLeft: 14, gap: 6, flexWrap: "wrap" }}>
              <NavLink href="/" label="Home" active={activeTab === "home"} />
              {showMyPlans && (
                <NavLink href="/my-plans" label="My Plans" active={activeTab === "my-plans"} />
              )}
              {showTeachers && (
                <NavLink href="/teachers" label="Teachers" active={activeTab === "teachers"} />
              )}
              {showReviewQueue && (
                <NavLink
                  href="/review-queue"
                  label="Review Queue"
                  active={activeTab === "review-queue"}
                />
              )}

              {showSupervisors && (
                <NavLink
                  href="/admin/supervisors"
                  label="Supervisors"
                  active={activeTab === "supervisors"}
                />
              )}

            </div>
          </div>

          <div className="row" style={{ gap: 10 }}>
            {sessionEmail ? (
              <>
                <span className="badge badge-pink">
                  {(profile?.full_name ?? "").trim() || sessionEmail}
                </span>

                <button className="btn btn-primary" onClick={signOut}>
                  Sign out
                </button>
              </>
            ) : (
              <span className="subtle">Not signed in</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
