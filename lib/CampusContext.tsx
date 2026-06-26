"use client";

/**
 * Campus selection context for the HR admin section.
 *
 * - True admins (`role === "admin"`) can switch between any campus, "All", or "Unassigned".
 * - Campus admins (`role === "campus_admin"`) are locked to their `campus_id`.
 * - Selection is persisted to localStorage so it survives reloads.
 *
 * Pages use `useCampusFilter()` to get the active filter and apply it to their queries.
 */

import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile, TeacherProfile } from "@/lib/teachers";

export type Campus = {
  id: string;
  name: string;
};

/** "all" = every campus + unassigned. "unassigned" = NULL campus_id only. UUID string = single campus. */
export type CampusFilter = "all" | "unassigned" | string;

const STORAGE_KEY = "sing-portal:hr-selected-campus";

type CampusContextValue = {
  loading: boolean;
  profile: TeacherProfile | null;
  campuses: Campus[];
  refreshCampuses: () => Promise<void>;

  /** The current filter (UUID, "all", or "unassigned"). For campus_admin always equals their campus_id. */
  filter: CampusFilter;
  setFilter: (next: CampusFilter) => void;

  /** Convenience: true if caller is a campus_admin (locked to one campus). */
  isCampusAdmin: boolean;
  /** Convenience: true if caller is a true admin (can switch campuses). */
  isTrueAdmin: boolean;
  /** For campus_admin: the campus_id they are locked to. Null for true admins. */
  lockedCampusId: string | null;
};

const CampusContext = createContext<CampusContextValue | null>(null);

export function CampusProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<TeacherProfile | null>(null);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [filter, setFilterState] = useState<CampusFilter>("all");

  const refreshCampuses = useCallback(async () => {
    const { data } = await supabase
      .from("hr_campuses")
      .select("id, name")
      .order("name", { ascending: true });
    setCampuses((data as Campus[]) ?? []);
  }, []);

  // Initial load: profile, campuses, restore persisted filter
  useEffect(() => {
    (async () => {
      const [prof] = await Promise.all([fetchMyProfile(), refreshCampuses()]);
      setProfile(prof);

      if (prof?.role === "campus_admin" && prof.campus_id) {
        // Campus admin: always locked to their campus, ignore localStorage
        setFilterState(prof.campus_id);
      } else if (prof?.role === "admin") {
        // True admin: restore persisted filter, default "all"
        const stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
        setFilterState(stored && stored.length > 0 ? (stored as CampusFilter) : "all");
      } else {
        setFilterState("all");
      }
      setLoading(false);
    })();
  }, [refreshCampuses]);

  const setFilter = useCallback(
    (next: CampusFilter) => {
      if (profile?.role === "campus_admin") return; // locked
      setFilterState(next);
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // ignore quota errors
        }
      }
    },
    [profile?.role]
  );

  const isCampusAdmin = profile?.role === "campus_admin";
  const isTrueAdmin = profile?.role === "admin";
  const lockedCampusId = isCampusAdmin ? profile?.campus_id ?? null : null;

  const value = useMemo<CampusContextValue>(
    () => ({
      loading,
      profile,
      campuses,
      refreshCampuses,
      filter,
      setFilter,
      isCampusAdmin,
      isTrueAdmin,
      lockedCampusId,
    }),
    [loading, profile, campuses, refreshCampuses, filter, setFilter, isCampusAdmin, isTrueAdmin, lockedCampusId]
  );

  return <CampusContext.Provider value={value}>{children}</CampusContext.Provider>;
}

export function useCampusFilter(): CampusContextValue {
  const ctx = useContext(CampusContext);
  if (!ctx) {
    throw new Error("useCampusFilter must be used inside <CampusProvider>");
  }
  return ctx;
}

// ─── Query helpers ───────────────────────────────────────────────────────────

/**
 * Apply a campus filter directly to a `hr_employees` (or any table with `campus_id`) query.
 * - "all": no constraint
 * - "unassigned": campus_id IS NULL
 * - <uuid>: campus_id = uuid
 *
 * Usage:
 *   let q = supabase.from("hr_employees").select(...);
 *   q = applyCampusFilterToQuery(q, filter, "campus_id");
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyCampusFilterToQuery<Q extends { eq: (col: string, val: any) => any; is: (col: string, val: any) => any }>(
  query: Q,
  filter: CampusFilter,
  column: string = "campus_id"
): Q {
  if (filter === "all") return query;
  if (filter === "unassigned") return query.is(column, null) as Q;
  return query.eq(column, filter) as Q;
}

/**
 * Returns true if a campus_id value (possibly null) matches the active filter.
 * Used for client-side filtering after we have employee rows in hand.
 */
export function matchesCampusFilter(employeeCampusId: string | null, filter: CampusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "unassigned") return employeeCampusId === null;
  return employeeCampusId === filter;
}

/**
 * Campus admins are a level below regular admins, so they must never see
 * admin-role accounts in any HR list. Given employee rows that carry a
 * `profile_id`, this drops anyone whose linked profile has role 'admin' when the
 * viewer is a campus admin (no-op for everyone else).
 */
export async function hideRegularAdminsForCampusAdmin<T extends { profile_id?: string | null }>(
  rows: T[],
  viewerRole: string | null | undefined
): Promise<T[]> {
  if (viewerRole !== "campus_admin") return rows;
  const profIds = rows.map((r) => r.profile_id).filter(Boolean) as string[];
  if (profIds.length === 0) return rows;
  const { data } = await supabase.from("user_profiles").select("id, role").in("id", profIds);
  const adminIds = new Set((data ?? []).filter((p: any) => p.role === "admin").map((p: any) => p.id));
  return rows.filter((r) => !r.profile_id || !adminIds.has(r.profile_id));
}
