"use client";

import { ReactNode } from "react";
import PageAccessGuard from "@/components/PageAccessGuard";

/**
 * The learning-app admin gate.
 *
 * Was `role in (admin, campus_admin) or can_manage_learning` — that flag *was*
 * the "App Supervisor" role, and it is now three grantable pages instead.
 */
export default function LearningAdminLayout({ children }: { children: ReactNode }) {
  return <PageAccessGuard mode="app">{children}</PageAccessGuard>;
}
