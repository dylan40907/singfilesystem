// teacher-setup-check/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function json(origin: string | null, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin),
  });
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isAllowedRole(role: unknown) {
  return role === "teacher" || role === "supervisor";
}

async function findAuthUserIdByEmail(
  supabase: ReturnType<typeof createClient>,
  email: string,
) {
  // listUsers is paginated; we scan pages until we find the email.
  // For your app this is fine (small user count).
  const perPage = 200;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (hit?.id) return hit.id;

    if (users.length < perPage) break; // no more pages
  }
  return null;
}

serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json(origin, 405, { error: "Method not allowed" });
  }

  try {
    const { email } = await req.json();
    const e = normalizeEmail(email ?? "");

    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return json(origin, 400, { error: "Invalid email" });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      Deno.env.get("SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return json(origin, 500, { error: "Missing SUPABASE_URL or SERVICE_ROLE_KEY" });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Source of truth = your app profile table (what you already validated)
    const { data: profile, error: profErr } = await supabase
      .from("user_profiles")
      .select("id,email,full_name,role,is_active,has_set_password")
      .ilike("email", e)
      .maybeSingle();

    if (profErr) return json(origin, 500, { error: profErr.message });

    // Don’t leak existence beyond allowed roles
    if (!profile || !profile.is_active || !isAllowedRole(profile.role)) {
      return json(origin, 200, { status: "not_found" });
    }

    // Already set up
    if (profile.has_set_password) {
      return json(origin, 200, { status: "has_password" });
    }

    // Not set up yet: ensure auth user exists so set-password can work
    const userId = await findAuthUserIdByEmail(supabase, e);
    if (!userId) {
      return json(origin, 200, { status: "not_found" });
    }

    return json(origin, 200, {
      status: "no_password",
      user_id: userId,
      full_name: profile.full_name ?? null,
      role: profile.role ?? null,
    });
  } catch (err) {
    return json(origin, 500, { error: String(err) });
  }
});
