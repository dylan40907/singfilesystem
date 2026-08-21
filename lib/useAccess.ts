"use client";

import { useEffect, useState } from "react";
import { AccessMap, NO_ACCESS, fetchAccess } from "./access";
import { fetchMyProfile, TeacherProfile } from "./teachers";
import { PAGES } from "./pagePermissions";

/**
 * The resolved permissions for the signed-in account, loaded once per mount.
 *
 * Pages used to each re-derive this from `profile.role`, which is exactly how a
 * grant could show up in the nav and then be refused by the page behind it.
 */
export function useAccess(): {
  access: AccessMap;
  profile: TeacherProfile | null;
  loading: boolean;
} {
  const [access, setAccess] = useState<AccessMap>(NO_ACCESS);
  const [profile, setProfile] = useState<TeacherProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const p = await fetchMyProfile();
        const a = await fetchAccess(p);
        if (!mounted) return;
        setProfile(p);
        setAccess(a);
      } catch {
        if (mounted) setAccess(NO_ACCESS);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  return { access, profile, loading };
}

/**
 * Extra routes that belong to a page but don't sit under its path.
 *
 * The learning admin section is the awkward one: its lesson list lives at
 * /admin/learning while the page entry points at /admin/learning/content.
 */
const PATH_ALIASES: Record<string, string[]> = {
  "app.content": ["/admin/learning"],
};

type PathEntry = { path: string; key: string };

/** Longest path first, so /admin/sales/tours beats /admin/sales. */
const PATH_TABLE: PathEntry[] = PAGES.flatMap((p) => [
  { path: p.path, key: p.key },
  ...(PATH_ALIASES[p.key] ?? []).map((path) => ({ path, key: p.key })),
]).sort((a, b) => b.path.length - a.path.length);

/**
 * Which page in lib/pagePermissions.ts a route belongs to, or null when the
 * route isn't one the permission system knows about.
 *
 * Null means "don't guard this" rather than "deny": an unlisted route is a gap
 * in the map, and silently locking people out of it would be worse than letting
 * RLS handle it. Adding a page to PAGES is what closes the gap.
 */
export function pageKeyForPath(pathname: string): string | null {
  // "/" is the file browser; as a prefix it would match every route there is.
  if (pathname === "/") return "curriculum.files";
  for (const e of PATH_TABLE) {
    if (e.path === "/") continue;
    if (pathname === e.path || pathname.startsWith(e.path + "/")) return e.key;
  }
  return null;
}
