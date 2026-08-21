import { supabase } from "./supabaseClient";
import {
  Access,
  BaseRole,
  PAGES,
  atLeast,
  resolveAccess,
} from "./pagePermissions";

/**
 * One place that answers "what may this person open, and may they change it".
 *
 * Access = base level (user_profiles.role) + optional per-page overrides from
 * the custom role they hold. Full admins bypass the whole thing.
 *
 * This governs navigation and whether edit controls are offered. It is not the
 * security boundary — RLS is. A page that shows data someone shouldn't see is a
 * database problem, not a problem with this file.
 */

export type AccessMap = {
  isAdmin: boolean;
  base: BaseRole | null;
  roleId: string | null;
  roleName: string | null;
  overrides: Record<string, Access>;
};

export const NO_ACCESS: AccessMap = {
  isAdmin: false, base: null, roleId: null, roleName: null, overrides: {},
};

type ProfileShape = {
  id: string;
  role: string | null;
  is_active: boolean | null;
  hr_role_id?: string | null;
};

/** Load the current user's effective permissions. */
export async function fetchAccess(profile: ProfileShape | null): Promise<AccessMap> {
  if (!profile?.is_active) return NO_ACCESS;
  if (profile.role === "admin") {
    return { isAdmin: true, base: null, roleId: null, roleName: null, overrides: {} };
  }

  const base = toBaseRole(profile.role);
  if (!base) return NO_ACCESS;

  if (!profile.hr_role_id) {
    return { isAdmin: false, base, roleId: null, roleName: null, overrides: {} };
  }

  const [{ data: role }, { data: perms }] = await Promise.all([
    supabase.from("hr_roles").select("id, name").eq("id", profile.hr_role_id).maybeSingle(),
    supabase.from("hr_role_permissions").select("page_key, access").eq("role_id", profile.hr_role_id),
  ]);

  const overrides: Record<string, Access> = {};
  for (const p of (perms ?? []) as { page_key: string; access: Access }[]) {
    overrides[p.page_key] = p.access;
  }

  return {
    isAdmin: false,
    base,
    roleId: (role as { id: string } | null)?.id ?? null,
    roleName: (role as { name: string } | null)?.name ?? null,
    overrides,
  };
}

/**
 * Only the three levels are valid bases. 'employee' and 'hours_manager' predate
 * this system and have their own narrow paths (the clock terminal), so they get
 * nothing here rather than being mapped onto a level they were never given.
 */
export function toBaseRole(role: string | null | undefined): BaseRole | null {
  if (role === "teacher" || role === "supervisor" || role === "campus_admin") return role;
  return null;
}

/** What this person can do on a page. */
export function accessTo(map: AccessMap, pageKey: string): Access {
  if (map.isAdmin) return "edit";
  if (!map.base) return "none";
  return resolveAccess(pageKey, map.base, map.overrides);
}

export function canView(map: AccessMap, pageKey: string): boolean {
  return atLeast(accessTo(map, pageKey), "view");
}

export function canEdit(map: AccessMap, pageKey: string): boolean {
  return atLeast(accessTo(map, pageKey), "edit");
}

/** Every page this person may open, for building navigation. */
export function visiblePages(map: AccessMap) {
  return PAGES.filter((p) => canView(map, p.key));
}

/** True when any page in a section is visible — drives the mode switcher. */
export function canEnterMode(map: AccessMap, mode: string): boolean {
  return PAGES.some((p) => p.mode === mode && canView(map, p.key));
}
