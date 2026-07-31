import { TeacherProfile } from "./teachers";

/**
 * Who may see what in the HR Portal and Students views.
 *
 * These rules used to be re-derived on every page, which is how supervisors
 * ended up with a pile of bolted-on subtabs in /hr instead of the real pages.
 * One module now answers the question everywhere, and the database enforces the
 * same boundary through RLS — the UI here is convenience, not the gate.
 */

export type Role = "admin" | "campus_admin" | "supervisor" | "teacher" | "employee" | "hours_manager";

/** Roles a supervisor must never see or act on — their peers and superiors. */
export const PRIVILEGED_ROLES: ReadonlySet<string> = new Set(["admin", "campus_admin", "supervisor"]);

export function isActive(p: TeacherProfile | null): boolean {
  return !!p?.is_active;
}

export function isAdmin(p: TeacherProfile | null): boolean {
  return isActive(p) && p!.role === "admin";
}

export function isCampusAdmin(p: TeacherProfile | null): boolean {
  return isActive(p) && p!.role === "campus_admin";
}

export function isSupervisor(p: TeacherProfile | null): boolean {
  return isActive(p) && p!.role === "supervisor";
}

/** Full HR management. Supervisors are deliberately excluded. */
export function hasAdminAccess(p: TeacherProfile | null): boolean {
  return isAdmin(p) || isCampusAdmin(p);
}

/** May open the HR Portal at all. */
export function canUseHrPortal(p: TeacherProfile | null): boolean {
  return hasAdminAccess(p) || isSupervisor(p);
}

/**
 * Supervisors read HR data; they never write it. Their one long-standing
 * exception is administering monthly scorecards for non-privileged staff, which
 * lives with the review UI rather than here.
 */
export function canEditHr(p: TeacherProfile | null): boolean {
  return hasAdminAccess(p);
}

/**
 * Can this viewer see an employee whose linked portal account has `role`?
 * Supervisors are limited to non-privileged staff; an employee with no linked
 * account counts as visible, matching how the directory has always treated
 * records with no portal login.
 */
export function canSeeEmployeeWithRole(p: TeacherProfile | null, role: string | null | undefined): boolean {
  if (isAdmin(p)) return true;
  if (isCampusAdmin(p)) return !(role === "admin" || role === "campus_admin");
  if (isSupervisor(p)) return !PRIVILEGED_ROLES.has(role ?? "");
  return false;
}

/**
 * Students view: teachers and supervisors may read it, nobody below admin may
 * change it. Supervisors keep whatever edit rights they already had elsewhere;
 * this only governs the Students section.
 */
export function canViewStudents(p: TeacherProfile | null): boolean {
  return isActive(p);
}

export function canEditStudents(p: TeacherProfile | null): boolean {
  return hasAdminAccess(p);
}
