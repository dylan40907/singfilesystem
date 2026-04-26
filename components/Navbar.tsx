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
      }}
    >
      {label}
    </Link>
  );
}

function hardClearSupabaseAuthStorage() {
  try {
    const killKeys = (storage: Storage) => {
      const toRemove: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k) continue;

        const lk = k.toLowerCase();
        if (lk.startsWith("sb-") && lk.includes("auth-token")) toRemove.push(k);
        if (lk.includes("supabase") && lk.includes("auth") && lk.includes("token")) toRemove.push(k);
      }
      toRemove.forEach((k) => storage.removeItem(k));
    };

    killKeys(window.localStorage);
    killKeys(window.sessionStorage);
  } catch {
    // ignore
  }
}

export default function Navbar() {
  const pathname = usePathname();
  const router = useRouter();

  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<TeacherProfile | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = !!profile?.is_active;

  const isAdminOrSupervisor =
    !!profile?.is_active && (profile.role === "admin" || profile.role === "supervisor");

  const showMyPlans = !!sessionEmail && isActive;
  const showTeachers = !!sessionEmail && isAdminOrSupervisor;
  const showReviewQueue = !!sessionEmail && isAdminOrSupervisor;

  const isSupervisor = !!profile?.is_active && profile.role === "supervisor";
  const isAdmin = !!profile?.is_active && profile.role === "admin";
  const showSupervisors = !!sessionEmail && isAdmin;
  const showSchedules = !!sessionEmail && isSupervisor;

  // ✅ HR visible to ALL active users (admin goes to /admin/hr, everyone else to /hr)
  const showHr = !!sessionEmail && isActive;
  const hrHref = isAdmin ? "/admin/hr" : "/hr";

  // Keep latest pathname without re-subscribing
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  // Guard against auth listener reacting during explicit signOut
  const signingOutRef = useRef(false);

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
      // Redirect hours_manager to the clock page immediately
      if (p?.role === "hours_manager" && pathnameRef.current !== "/clock") {
        router.replace("/clock");
      }
    } catch {
      setProfile(null);
    }
  }

  async function signOut() {
    if (signingOutRef.current) return;

    signingOutRef.current = true;
    setSigningOut(true);

    try {
      await supabase.auth.signOut({ scope: "global" });
      hardClearSupabaseAuthStorage();

      // Update navbar UI immediately
      await applySession(null);

      // ✅ Key behavior:
      // If you're already on "/", force a *single* full reload so the Home page re-mounts
      // and shows the login UI (since Home may not be subscribed to auth changes).
      if (pathnameRef.current === "/") {
        window.location.reload();
        return;
      }

      // Otherwise, go back to home/login normally.
      router.replace("/");
    } finally {
      setSigningOut(false);
      signingOutRef.current = false;
    }
  }

  // Close menu on route change
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  useEffect(() => {
    // Initial session load once
    supabase.auth
      .getSession()
      .then(({ data }) => applySession(data.session))
      .catch(() => applySession(null));

    // Listen once
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      // Ignore while our explicit signOut is in progress
      if (signingOutRef.current) return;

      void applySession(session);

      // If we became signed out while on another route, kick back to home/login.
      // 🚫 Do NOT reload on "/" here (that caused the infinite refresh loop).
      if (!session && pathnameRef.current !== "/") {
        router.replace("/");
      }
    });

    return () => {
      data.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeTab = useMemo(() => {
    if (pathname.startsWith("/admin/supervisors")) return "supervisors";
    if (pathname.startsWith("/schedules")) return "schedules";
    if (pathname.startsWith("/admin/hr") || pathname.startsWith("/hr")) return "hr";
    if (pathname === "/teachers") return "teachers";
    if (pathname === "/review-queue") return "review-queue";
    if (pathname === "/my-plans") return "my-plans";
    return "home";
  }, [pathname]);

  const displayName = (profile?.full_name ?? "").trim() || sessionEmail || "";

  return (
    <div style={{ position: "sticky", top: 0, zIndex: 50, background: "white", borderBottom: "1px solid #e5e7eb" }}>
      <div className="container">
        <div className="row-between" style={{ padding: "12px 0" }}>
          {/* Logo + title */}
          <div className="row" style={{ gap: 14 }}>
            <Link href="/" aria-label="Go to home" style={{ display: "block", width: 48, height: 34, position: "relative" }}>
              <Image src="/logo.png" alt="SING Portal logo" fill priority sizes="48px" style={{ objectFit: "contain" }} />
            </Link>
            <div>
              <div style={{ fontWeight: 800, fontSize: 15 }}>SING Portal</div>
              <div className="subtle">Files + Lesson Plans</div>
            </div>

            {/* Desktop nav links */}
            <div className="row hide-mobile" style={{ marginLeft: 14, gap: 6, flexWrap: "wrap" }}>
              <NavLink href="/" label="Home" active={activeTab === "home"} />
              {showMyPlans && <NavLink href="/my-plans" label="My Plans" active={activeTab === "my-plans"} />}
              {showTeachers && <NavLink href="/teachers" label="Teachers" active={activeTab === "teachers"} />}
              {showReviewQueue && <NavLink href="/review-queue" label="Review Queue" active={activeTab === "review-queue"} />}
              {showSupervisors && <NavLink href="/admin/supervisors" label="Supervisors" active={activeTab === "supervisors"} />}
              {showSchedules && <NavLink href="/schedules" label="Schedules" active={activeTab === "schedules"} />}
              {showHr && <NavLink href={hrHref} label="HR" active={activeTab === "hr"} />}
            </div>
          </div>

          {/* Desktop right controls */}
          <div className="row hide-mobile" style={{ gap: 10 }}>
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

        {/* Mobile dropdown */}
        {menuOpen && (
          <div className="nav-mobile-panel hide-desktop">
            <Link href="/" className={`nav-mobile-link${activeTab === "home" ? " active" : ""}`}>Home</Link>
            {showMyPlans && <Link href="/my-plans" className={`nav-mobile-link${activeTab === "my-plans" ? " active" : ""}`}>My Plans</Link>}
            {showTeachers && <Link href="/teachers" className={`nav-mobile-link${activeTab === "teachers" ? " active" : ""}`}>Teachers</Link>}
            {showReviewQueue && <Link href="/review-queue" className={`nav-mobile-link${activeTab === "review-queue" ? " active" : ""}`}>Review Queue</Link>}
            {showSupervisors && <Link href="/admin/supervisors" className={`nav-mobile-link${activeTab === "supervisors" ? " active" : ""}`}>Supervisors</Link>}
            {showSchedules && <Link href="/schedules" className={`nav-mobile-link${activeTab === "schedules" ? " active" : ""}`}>Schedules</Link>}
            {showHr && <Link href={hrHref} className={`nav-mobile-link${activeTab === "hr" ? " active" : ""}`}>HR</Link>}
            <div className="nav-mobile-divider" />
            {sessionEmail ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 8px 0" }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</span>
                <button className="btn btn-primary" onClick={signOut} disabled={signingOut} style={{ flexShrink: 0, marginLeft: 12 }}>
                  {signingOut ? "Signing out..." : "Sign out"}
                </button>
              </div>
            ) : (
              <span className="subtle" style={{ padding: "8px 8px 0" }}>Not signed in</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
