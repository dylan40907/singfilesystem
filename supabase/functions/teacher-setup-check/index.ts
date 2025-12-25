// teacher-setup-check/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(origin: string | null, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeUsername(username: string) {
  return username.trim().toLowerCase();
}

function isEmailLike(s: string) {
  return s.includes("@");
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isAllowedRole(role: unknown) {
  return role === "teacher" || role === "supervisor";
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
    const body = await req.json().catch(() => ({} as any));

    // Back-compat: accept { email } as well as { identifier }
    const rawIdent = String(body?.identifier ?? body?.email ?? "").trim();
    if (!rawIdent) {
      return json(origin, 400, { error: "Missing identifier" });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return json(origin, 500, { error: "Missing SUPABASE_URL or SERVICE_ROLE_KEY" });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Source of truth = your app profile table
    let profile: any = null;

    if (isEmailLike(rawIdent)) {
      const e = normalizeEmail(rawIdent);
      if (!e || !isValidEmail(e)) {
        return json(origin, 400, { error: "Invalid email" });
      }

      // email path (legacy / if any exist)
      const { data, error } = await supabase
        .from("user_profiles")
        .select("id,email,full_name,role,is_active,has_set_password,username")
        .ilike("email", e)
        .maybeSingle();

      if (error) return json(origin, 500, { error: error.message });
      profile = data;
    } else {
      const u = normalizeUsername(rawIdent);
      if (!u) {
        return json(origin, 400, { error: "Invalid username" });
      }

      const { data, error } = await supabase
        .from("user_profiles")
        .select("id,email,full_name,role,is_active,has_set_password,username")
        .ilike("username", u) // case-insensitive match
        .maybeSingle();

      if (error) return json(origin, 500, { error: error.message });
      profile = data;
    }

    // Don’t leak existence beyond allowed roles
    if (!profile || !profile.is_active || !isAllowedRole(profile.role)) {
      return json(origin, 200, { status: "not_found" });
    }

    // Already set up
    if (profile.has_set_password) {
      return json(origin, 200, { status: "has_password" });
    }

    // Not set up yet:
    // For BOTH email-based and username-based accounts, your profile.id should be the auth user id.
    const profileUserId = String(profile.id ?? "").trim();
    if (!profileUserId) {
      return json(origin, 200, { status: "not_found" });
    }

    // Confirm auth user exists (doesn't require email)
    const { data: authUserData, error: authUserErr } = await supabase.auth.admin.getUserById(profileUserId);
    if (authUserErr || !authUserData?.user?.id) {
      return json(origin, 200, { status: "not_found" });
    }

    return json(origin, 200, {
      status: "no_password",
      user_id: profileUserId,
      full_name: profile.full_name ?? null,
      role: profile.role ?? null,
      email: profile.email ?? null,
      username: profile.username ?? null,
    });
  } catch (err) {
    return json(origin, 500, { error: String(err) });
  }
});
