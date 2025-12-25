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

  const isActive = !!profile?.is_active;
  const isAdminOrSupervisor =
    !!profile?.is_active && (profile.role === "admin" || profile.role === "supervisor");

  const showMyPlans = !!sessionEmail && isActive;
  const showTeachers = !!sessionEmail && isAdminOrSupervisor;
  const showReviewQueue = !!sessionEmail && isAdminOrSupervisor;
  const isAdmin = !!profile?.is_active && profile.role === "admin";
  const showSupervisors = !!sessionEmail && isAdmin;

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
      // If we reload, this code won't matter, but keep correct for other routes.
      setSigningOut(false);
      signingOutRef.current = false;
    }
  }

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
            <Link
              href="/"
              aria-label="Go to home"
              style={{
                display: "block",
                width: 48,
                height: 34,
                position: "relative",
              }}
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
              <div style={{ fontWeight: 800, fontSize: 15 }}>SING Portal</div>
              <div className="subtle">Files + Lesson Plans</div>
            </div>

            <div className="row" style={{ marginLeft: 14, gap: 6, flexWrap: "wrap" }}>
              <NavLink href="/" label="Home" active={activeTab === "home"} />
              {showMyPlans && <NavLink href="/my-plans" label="My Plans" active={activeTab === "my-plans"} />}
              {showTeachers && <NavLink href="/teachers" label="Teachers" active={activeTab === "teachers"} />}
              {showReviewQueue && (
                <NavLink href="/review-queue" label="Review Queue" active={activeTab === "review-queue"} />
              )}
              {showSupervisors && (
                <NavLink href="/admin/supervisors" label="Supervisors" active={activeTab === "supervisors"} />
              )}
            </div>
          </div>

          <div className="row" style={{ gap: 10 }}>
            {sessionEmail ? (
              <>
                <span className="badge badge-pink">
                  {(profile?.full_name ?? "").trim() || sessionEmail}
                </span>

                <button className="btn btn-primary" onClick={signOut} disabled={signingOut}>
                  {signingOut ? "Signing out..." : "Sign out"}
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
