"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function HrHomePage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/admin/hr/employees");
  }, [router]);

  return null;
}
