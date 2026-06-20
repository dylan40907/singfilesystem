"use client";

import { ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile } from "@/lib/teachers";

export default function LearningAdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function guard() {
      const { data } = await supabase.auth.getSession();
      if (!data.session) { router.replace("/"); return; }

      const profile = await fetchMyProfile();
      // Admins, campus admins, and "App Supervisors" (the learning flag) may enter.
      if (
        !profile?.is_active ||
        (profile.role !== "admin" && profile.role !== "campus_admin" && !profile.can_manage_learning)
      ) {
        router.replace("/");
        return;
      }

      if (mounted) setOk(true);
    }

    guard();
    return () => { mounted = false; };
  }, [router]);

  if (!ok) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ fontWeight: 800 }}>Loading…</div>
        <div className="subtle" style={{ marginTop: 6 }}>Checking admin permissions.</div>
      </div>
    );
  }

  return <>{children}</>;
}
