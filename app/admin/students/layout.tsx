"use client";

import { ReactNode } from "react";
import PageAccessGuard from "@/components/PageAccessGuard";

export default function StudentsLayout({ children }: { children: ReactNode }) {
  return <PageAccessGuard mode="students">{children}</PageAccessGuard>;
}
