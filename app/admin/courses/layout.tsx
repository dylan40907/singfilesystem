"use client";

import { ReactNode } from "react";
import PageAccessGuard from "@/components/PageAccessGuard";

/**
 * Courses lives under /admin/courses but is an HR-section page (hr.courses),
 * so it needs its own guard rather than inheriting the HR layout's.
 */
export default function CoursesLayout({ children }: { children: ReactNode }) {
  return <PageAccessGuard mode="hr">{children}</PageAccessGuard>;
}
