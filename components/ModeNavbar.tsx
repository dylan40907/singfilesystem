"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import ChatNavBadge from "@/components/chat/ChatNavBadge";
import NotificationsBell from "@/components/NotificationsBell";
import ModeSwitcher, { PortalMode, modeHome } from "@/components/ModeSwitcher";

export type ModeLink = { href: string; label: string; tab: string };

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
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

/**
 * Generic navbar shell for the simpler portal modes (Students, Sales).
 * Curriculum and HR keep their own bespoke navbars.
 */
export default function ModeNavbar({
  mode,
  title,
  links,
}: {
  mode: PortalMode;
  title: string;
  links: ModeLink[];
}) {
  const pathname = usePathname();
  const router = useRouter();

  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<TeacherProfile | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const isActive = !!profile?.is_active;

  useEffect(() => { setMenuOpen(false); }, [pathname]);

  async function applySession(session: any) {
    const email = session?.user?.email ?? null;
    setSessionEmail(email);
    if (!email) { setProfile(null); return; }
    try { setProfile(await fetchMyProfile()); } catch { setProfile(null); }
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => applySession(data.session)).catch(() => applySession(null));
    const { data } = supabase.auth.onAuthStateChange((_e, session) => {
      void applySession(session);
      if (!session) router.replace("/");
    });
    return () => { data.subscription.unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const activeTab = useMemo(() => {
    const hit = links.find((l) => pathname === l.href || pathname.startsWith(l.href + "/"));
    return hit?.tab ?? "";
  }, [pathname, links]);

  const subtitle = useMemo(() => {
    if (!sessionEmail) return "Not signed in";
    if (!isActive) return "Inactive account";
    if (profile?.role === "admin") return "Admin";
    if (profile?.role === "campus_admin") return "Campus Admin";
    if (profile?.role === "supervisor") return "Supervisor";
    return "";
  }, [sessionEmail, isActive, profile?.role]);

  const displayName = (profile?.full_name ?? "").trim() || sessionEmail || "";

  return (
    <div style={{ position: "sticky", top: 0, zIndex: 50, background: "white", borderBottom: "1px solid #e5e7eb" }}>
      <div className="container">
        <div className="row-between" style={{ padding: "12px 0", gap: 12 }}>
          <div className="row" style={{ gap: 12, alignItems: "center", minWidth: 0 }}>
            <Link href={modeHome(mode, profile)} aria-label={`Go to ${title} home`} style={{ display: "block", width: 46, height: 34, position: "relative", flexShrink: 0 }}>
              <Image src="/logo.png" alt="SING Portal logo" fill priority sizes="46px" style={{ objectFit: "contain" }} />
            </Link>
            <div style={{ minWidth: 0, lineHeight: 1.15 }}>
              <div style={{ fontWeight: 800, fontSize: 15 }}>{title}</div>
              <div className="subtle" style={{ fontSize: 12 }}>{subtitle}</div>
            </div>
          </div>

          <div className="row hide-mobile" style={{ gap: 8, alignItems: "center" }}>
            {sessionEmail && isActive && <NotificationsBell />}
            {sessionEmail && isActive && (
              <button className="btn" onClick={() => router.push("/chat")} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                Chat <ChatNavBadge />
              </button>
            )}
            <ModeSwitcher profile={profile} current={mode} />
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

        {links.length > 0 && (
          <div
            className="hide-mobile"
            style={{ display: "flex", gap: 4, overflowX: "auto", paddingTop: 8, paddingBottom: 10, borderTop: "1px solid #f3f4f6" }}
          >
            {links.map((l) => (
              <NavLink key={l.tab} href={l.href} label={l.label} active={activeTab === l.tab} />
            ))}
          </div>
        )}

        {menuOpen && (
          <div className="nav-mobile-panel hide-desktop">
            {links.map((l) => (
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
              <ModeSwitcher profile={profile} current={mode} onNavigate={() => setMenuOpen(false)} />
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
