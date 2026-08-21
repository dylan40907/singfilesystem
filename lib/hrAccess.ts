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

/*
 * Deliberately gone: canUseHrPortal, canEditHr, canViewStudents,
 * canEditStudents.
 *
 * They answered "may you open this / change this" from the account's level
 * alone, which a role grant can no longer be expressed in — a teacher granted
 * Schedule: edit failed canEditHr and got a read-only grid. Ask
 * canView / canEdit from lib/access.ts, or usePageAccess() inside a page.
 *
 * What stays here is the part roles don't govern: which *records* a viewer may
 * see, which is still a question about their level.
 */
