"use client";

import { ReactNode } from "react";
import PageAccessGuard from "@/components/PageAccessGuard";

/**
 * The HR section's gate.
 *
 * This used to hardcode admin/campus_admin/supervisor, so a custom role that
 * granted a teacher one HR page put the tab in the nav and then bounced them
 * straight back out. It then checked only "may you enter HR at all", which let
 * anyone with one HR grant walk into every other HR page by typing the URL.
 * PageAccessGuard resolves the specific page instead.
 */
export default function HrLayout({ children }: { children: ReactNode }) {
  return <PageAccessGuard mode="hr">{children}</PageAccessGuard>;
}
