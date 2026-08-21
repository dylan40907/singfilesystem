"use client";

import { ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { fetchMyProfile } from "@/lib/teachers";
import { canEnterMode, fetchAccess } from "@/lib/access";

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
      /**
       * Resolved permissions, not a role list.
       *
       * This used to hardcode admin/campus_admin/supervisor, so a custom role
       * granting a teacher one HR page put the tab in the nav and then bounced
       * them straight back out of it.
       */
      const access = await fetchAccess(profile);
      if (!canEnterMode(access, "hr")) {
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
