"use client";

import { ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile } from "@/lib/teachers";

export default function HrLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function guard() {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        router.replace("/");
        return;
      }

      const profile = await fetchMyProfile();
      const isAdmin = profile?.role === "admin" && !!profile?.is_active;

      if (!isAdmin) {
        router.replace("/");
        return;
      }

      if (mounted) setOk(true);
    }

    guard();
    return () => {
      mounted = false;
    };
  }, [router]);

  if (!ok) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ fontWeight: 800 }}>Loading HR…</div>
        <div className="subtle" style={{ marginTop: 6 }}>
          Checking admin permissions.
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
