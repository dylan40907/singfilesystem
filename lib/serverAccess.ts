import type { SupabaseClient } from "@supabase/supabase-js";
import { Access, atLeast } from "./pagePermissions";

/**
 * Page-grant checks for API routes.
 *
 * Routes can't use lib/access.ts — that reads the browser session. They also
 * can't just look at `user_profiles.role`, which is what left the R2 routes
 * refusing uploads for a role that had been granted the page in the editor.
 *
 * Mirrors the SQL `has_page_access(page_key, min)`: overrides only, because the
 * base-level defaults live in TypeScript and the existing role checks in each
 * route already cover them.
 *
 * Takes a service-role client so it can read the role tables regardless of the
 * caller's own RLS. Never pass a user id you haven't verified from a JWT.
 */
export async function serverHasPageAccess(
  adminClient: SupabaseClient,
  userId: string,
  pageKeys: string[],
  min: Access = "view"
): Promise<boolean> {
  const { data: prof } = await adminClient
    .from("user_profiles")
    .select("is_active, hr_role_id")
    .eq("id", userId)
    .maybeSingle();

  if (!prof?.is_active || !prof.hr_role_id) return false;

  const { data: perms } = await adminClient
    .from("hr_role_permissions")
    .select("page_key, access")
    .eq("role_id", prof.hr_role_id)
    .in("page_key", pageKeys);

  return (perms ?? []).some((p: { access: Access }) => atLeast(p.access, min));
}

/** The three learning-app admin pages, for the R2 routes that serve them. */
export const LEARNING_PAGES = ["app.content", "app.dictionary", "app.users"];
