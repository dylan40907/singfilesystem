"use client";

import { ReactNode, createContext, useContext, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AccessMap, NO_ACCESS, accessTo, canView, visiblePages } from "@/lib/access";
import { pageKeyForPath, useAccess } from "@/lib/useAccess";
import { Access, PageDef } from "@/lib/pagePermissions";

/**
 * One guard for every admin section.
 *
 * It answers three questions the sections used to answer separately, and
 * inconsistently: may this account open the section at all, may it open *this
 * page*, and may it change anything here. Doing it once is what stops a role
 * grant from appearing in the nav and then bouncing the person straight back
 * out — which is what happened when the HR layout still checked a role list.
 *
 * It is not the security boundary. RLS is: every page's tables carry
 * "page grant view/edit" policies driven by the same page keys.
 */

type PageAccess = {
  access: AccessMap;
  pageKey: string | null;
  /** Resolved level for the current page. */
  level: Access;
  /** True when the page is visible but nothing on it may be changed. */
  readOnly: boolean;
  loading: boolean;
};

const Ctx = createContext<PageAccess>({
  access: NO_ACCESS,
  pageKey: null,
  level: "none",
  readOnly: false,
  loading: true,
});

/**
 * Permissions for the page being rendered. Use `readOnly` to hide edit
 * controls; the database refuses the write either way, but a button that always
 * fails is worse than no button.
 */
export function usePageAccess(): PageAccess {
  return useContext(Ctx);
}

export default function PageAccessGuard({
  mode,
  children,
}: {
  mode: PageDef["mode"];
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { access, loading } = useAccess();

  const pageKey = pageKeyForPath(pathname);
  // An unmapped route stays open — see pageKeyForPath. Guarding it would lock
  // people out of pages purely because nobody added them to PAGES yet.
  const allowed = loading || !pageKey || canView(access, pageKey);
  const level = pageKey ? accessTo(access, pageKey) : "edit";

  useEffect(() => {
    if (loading || allowed) return;
    // Send them somewhere they can actually be, rather than to the mode's
    // fixed landing page — that page is often the one they lack.
    const fallback = visiblePages(access).find((p) => p.mode === mode);
    router.replace(fallback ? fallback.path : "/");
  }, [loading, allowed, access, mode, router]);

  if (loading || !allowed) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ fontWeight: 800 }}>Loading…</div>
        <div className="subtle" style={{ marginTop: 6 }}>Checking your permissions.</div>
      </div>
    );
  }

  return (
    <Ctx.Provider value={{ access, pageKey, level, readOnly: level === "view", loading: false }}>
      {level === "view" && <ReadOnlyBanner />}
      {children}
    </Ctx.Provider>
  );
}

/**
 * Says up front that this page is read-only, so a view-only grant doesn't feel
 * like the page is broken when a save is refused.
 */
function ReadOnlyBanner() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "10px auto 0",
        maxWidth: 1200,
        padding: "8px 14px",
        borderRadius: 10,
        border: "1px solid #fcd34d",
        background: "#fffbeb",
        color: "#92400e",
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      <span aria-hidden>👁</span>
      <span>View only — your role can see this page but not change anything on it.</span>
    </div>
  );
}
