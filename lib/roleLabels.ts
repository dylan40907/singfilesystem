import type { BaseRole } from "./pagePermissions";

/**
 * Names for the three base levels, in one place so the roles page, the employee
 * record and the editor can't disagree about what to call them.
 */
export const BASE_ROLE_LABEL: Record<BaseRole, string> = {
  teacher: "Teacher",
  supervisor: "Supervisor",
  campus_admin: "Campus Admin",
};
