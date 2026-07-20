/** Shared role labelling for the HR employee views. */

export type AccountRole = "admin" | "campus_admin" | "supervisor" | "teacher" | "hours_manager";

/** Human label. "App Supervisor" is a supervisor carrying the learning flag. */
export function roleLabel(role: string | null | undefined, canManageLearning?: boolean | null): string {
  switch (role) {
    case "admin":
      return "Admin";
    case "campus_admin":
      return "Campus Admin";
    case "supervisor":
      return canManageLearning ? "App Supervisor" : "Supervisor";
    case "teacher":
      return "Teacher";
    case "hours_manager":
      return "Hours Manager";
    default:
      return "No portal account";
  }
}

export function roleBadgeStyle(role: string | null | undefined): { background: string; color: string; border: string } {
  switch (role) {
    case "admin":
      return { background: "rgba(230,23,141,0.10)", color: "#be185d", border: "1.5px solid rgba(230,23,141,0.4)" };
    case "campus_admin":
      return { background: "rgba(124,58,237,0.10)", color: "#6d28d9", border: "1.5px solid rgba(124,58,237,0.35)" };
    case "supervisor":
      return { background: "rgba(2,132,199,0.10)", color: "#0369a1", border: "1.5px solid rgba(2,132,199,0.35)" };
    case "teacher":
      return { background: "rgba(22,163,74,0.10)", color: "#15803d", border: "1.5px solid rgba(22,163,74,0.35)" };
    default:
      return { background: "#f3f4f6", color: "#6b7280", border: "1.5px solid #e5e7eb" };
  }
}
