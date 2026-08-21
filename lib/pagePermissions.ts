/**
 * Every page a role can be granted or denied, and what each base level gets by
 * default.
 *
 * ⚠ ADDING A PAGE? Add it here too, or it will be invisible to the role editor
 * and silently inherit nothing. See docs/ROLES.md.
 *
 * WHY THIS EXISTS
 * Roles used to be a single enum plus one bolted-on boolean (`can_manage_learning`,
 * which is what "App Supervisor" actually was). Every new variation meant another
 * column and another special case. Instead, a role is now a *base level* — the
 * thing RLS understands — plus per-page overrides on top.
 *
 * IMPORTANT: an override changes what the portal shows. It is not a substitute
 * for row-level security. Anything genuinely sensitive must also be enforced in
 * the database; `access` here decides navigation and whether the UI offers edit
 * controls, and the server still has the final say.
 */

export type BaseRole = "teacher" | "supervisor" | "campus_admin";
export type Access = "none" | "view" | "edit";

export type PageDef = {
  /** Stable identifier stored in the database. Never rename one in place. */
  key: string;
  label: string;
  /** Which portal section it sits in, for grouping in the editor. */
  mode: "curriculum" | "hr" | "students" | "sales" | "app";
  /** The route, so the nav and guards can find it. */
  path: string;
  /**
   * False when the page is inherently read-only, so the editor offers only
   * On/Off instead of a meaningless View/Edit choice.
   */
  editable: boolean;
  /** What each base level gets when a role says nothing about this page. */
  defaults: Record<BaseRole, Access>;
  /** Shown under the toggle in the editor. */
  hint?: string;
};

export const PAGES: PageDef[] = [
  // ── Curriculum / files ────────────────────────────────────────────────────
  {
    key: "curriculum.files", label: "Files", mode: "curriculum", path: "/",
    editable: true,
    defaults: { teacher: "edit", supervisor: "edit", campus_admin: "edit" },
    hint: "Shared folders. Edit allows upload and delete where the folder permits it.",
  },
  {
    key: "curriculum.chat", label: "Chat", mode: "curriculum", path: "/chat",
    editable: true,
    defaults: { teacher: "edit", supervisor: "edit", campus_admin: "edit" },
    hint: "View-only would let someone read messages but not send.",
  },
  {
    key: "curriculum.albums", label: "Albums", mode: "curriculum", path: "/albums",
    editable: true,
    defaults: { teacher: "edit", supervisor: "edit", campus_admin: "edit" },
    hint: "Edit allows uploading. Creating and deleting albums stays with supervisors and up.",
  },

  // ── HR portal ─────────────────────────────────────────────────────────────
  {
    key: "hr.employees", label: "Employees", mode: "hr", path: "/admin/hr/employees",
    editable: true,
    defaults: { teacher: "none", supervisor: "view", campus_admin: "edit" },
    hint: "Supervisors see teacher-level records only; that limit holds regardless of this setting.",
  },
  {
    key: "hr.documents", label: "Documents", mode: "hr", path: "/admin/hr/documents",
    editable: true,
    defaults: { teacher: "none", supervisor: "view", campus_admin: "edit" },
  },
  {
    key: "hr.attendance", label: "Attendance", mode: "hr", path: "/admin/hr/attendance",
    editable: true,
    defaults: { teacher: "none", supervisor: "view", campus_admin: "edit" },
  },
  {
    key: "hr.org_chart", label: "Org Chart", mode: "hr", path: "/admin/hr/org-chart",
    editable: true,
    defaults: { teacher: "none", supervisor: "view", campus_admin: "edit" },
  },
  {
    key: "hr.meetings", label: "Employee Meetings", mode: "hr", path: "/admin/hr/employee-meetings",
    editable: true,
    defaults: { teacher: "none", supervisor: "edit", campus_admin: "edit" },
  },
  {
    key: "hr.schedule", label: "Schedule", mode: "hr", path: "/admin/hr/schedule",
    editable: true,
    defaults: { teacher: "none", supervisor: "view", campus_admin: "edit" },
    hint: "View shows published schedules and plans without the editing grid.",
  },
  {
    key: "hr.timesheets", label: "Timesheets", mode: "hr", path: "/admin/hr/timesheets",
    editable: true,
    defaults: { teacher: "none", supervisor: "view", campus_admin: "edit" },
    hint: "View shows hours without allowing corrections or approvals.",
  },
  {
    key: "hr.leave", label: "Leave", mode: "hr", path: "/admin/hr/leave",
    editable: true,
    defaults: { teacher: "none", supervisor: "view", campus_admin: "edit" },
  },
  {
    key: "hr.courses", label: "Courses", mode: "hr", path: "/admin/courses",
    editable: true,
    defaults: { teacher: "none", supervisor: "view", campus_admin: "edit" },
    hint: "Taking an assigned course never needs this — that lives on the staff HR page.",
  },
  {
    key: "hr.settings", label: "HR Settings", mode: "hr", path: "/admin/hr/settings",
    editable: true,
    defaults: { teacher: "none", supervisor: "none", campus_admin: "edit" },
  },
  {
    key: "hr.roles", label: "Roles", mode: "hr", path: "/admin/hr/roles",
    editable: true,
    // Deliberately unreachable below admin: whoever edits roles can grant
    // themselves anything, so it is never delegated.
    defaults: { teacher: "none", supervisor: "none", campus_admin: "none" },
    hint: "Full admins only. Cannot be granted to a role.",
  },

  // ── Students ──────────────────────────────────────────────────────────────
  {
    key: "students.admissions", label: "Admissions", mode: "students", path: "/admin/students/admissions",
    editable: true,
    defaults: { teacher: "view", supervisor: "view", campus_admin: "edit" },
    hint: "Teachers see the roster for their own campus. Waitlist stays with supervisors and up.",
  },

  // ── Sales ─────────────────────────────────────────────────────────────────
  {
    key: "sales.leads", label: "Leads", mode: "sales", path: "/admin/sales",
    editable: true,
    defaults: { teacher: "none", supervisor: "edit", campus_admin: "edit" },
  },
  {
    key: "sales.tours", label: "Tours", mode: "sales", path: "/admin/sales/tours",
    editable: true,
    defaults: { teacher: "none", supervisor: "edit", campus_admin: "edit" },
  },
  {
    key: "sales.meetings", label: "Meetings", mode: "sales", path: "/admin/sales/meetings",
    editable: true,
    defaults: { teacher: "none", supervisor: "edit", campus_admin: "edit" },
  },
  {
    key: "sales.reports", label: "Reports", mode: "sales", path: "/admin/sales/reports",
    editable: false,
    defaults: { teacher: "none", supervisor: "view", campus_admin: "view" },
  },
  {
    key: "sales.emails", label: "Emails", mode: "sales", path: "/admin/sales/emails",
    editable: true,
    defaults: { teacher: "none", supervisor: "none", campus_admin: "none" },
    hint: "Edits the wording every family receives. Full admins only by default.",
  },
  {
    key: "sales.settings", label: "Sales Settings", mode: "sales", path: "/admin/sales/settings",
    editable: true,
    defaults: { teacher: "none", supervisor: "none", campus_admin: "none" },
  },

  // ── Learning app admin ────────────────────────────────────────────────────
  // This whole section is what "App Supervisor" used to mean: a supervisor with
  // can_manage_learning set. Granting these pages to a role replaces that flag.
  {
    key: "app.content", label: "App Content", mode: "app", path: "/admin/learning/content",
    editable: true,
    defaults: { teacher: "none", supervisor: "none", campus_admin: "edit" },
  },
  {
    key: "app.dictionary", label: "App Dictionary", mode: "app", path: "/admin/learning/dictionary-categories",
    editable: true,
    defaults: { teacher: "none", supervisor: "none", campus_admin: "edit" },
  },
  {
    key: "app.users", label: "App Users", mode: "app", path: "/admin/learning/users",
    editable: true,
    defaults: { teacher: "none", supervisor: "none", campus_admin: "edit" },
  },
];

export const PAGES_BY_KEY = new Map(PAGES.map((p) => [p.key, p]));

export const MODE_LABEL: Record<PageDef["mode"], string> = {
  curriculum: "Curriculum & files",
  hr: "HR portal",
  students: "Students",
  sales: "Sales",
  app: "Learning app admin",
};

/** Pages grouped for the role editor, in the order they're shown. */
export function pagesByMode(): { mode: PageDef["mode"]; label: string; pages: PageDef[] }[] {
  const order: PageDef["mode"][] = ["curriculum", "hr", "students", "sales", "app"];
  return order.map((mode) => ({
    mode,
    label: MODE_LABEL[mode],
    pages: PAGES.filter((p) => p.mode === mode),
  }));
}

/** Ranking so "at least view" style checks read naturally. */
const RANK: Record<Access, number> = { none: 0, view: 1, edit: 2 };
export function atLeast(have: Access, needed: Access): boolean {
  return RANK[have] >= RANK[needed];
}

/**
 * What this role can do on this page.
 *
 * An override wins; otherwise the base level's default applies. Roles is the one
 * page no override can open, because granting it is equivalent to granting
 * everything.
 */
export function resolveAccess(
  pageKey: string,
  base: BaseRole,
  overrides: Record<string, Access> | null | undefined
): Access {
  const page = PAGES_BY_KEY.get(pageKey);
  if (!page) return "none";
  if (pageKey === "hr.roles") return "none";
  const override = overrides?.[pageKey];
  if (override) return override;
  return page.defaults[base];
}
