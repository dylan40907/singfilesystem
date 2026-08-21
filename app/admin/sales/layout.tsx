"use client";

import { ReactNode } from "react";
import PageAccessGuard from "@/components/PageAccessGuard";

/**
 * Sales had no guard of its own — the section relied on nobody linking to it.
 * A role that denies Leads or Emails now actually keeps people out of them.
 */
export default function SalesLayout({ children }: { children: ReactNode }) {
  return <PageAccessGuard mode="sales">{children}</PageAccessGuard>;
}
