// teacher-setup-set-password/index.ts
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
  // IMPORTANT: match how you store usernames (lowercase)
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
    const p = String(body?.password ?? "");

    if (!rawIdent) {
      return json(origin, 400, { error: "Missing identifier" });
    }
    if (p.length < 8) {
      return json(origin, 400, { error: "Password must be at least 8 characters" });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return json(origin, 500, { error: "Missing SUPABASE_URL or SERVICE_ROLE_KEY" });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1) Validate profile (and gate already-set accounts)
    let profile: any = null;

    if (isEmailLike(rawIdent)) {
      const e = normalizeEmail(rawIdent);
      if (!e || !isValidEmail(e)) {
        return json(origin, 400, { error: "Invalid email" });
      }

      const { data, error } = await supabase
        .from("user_profiles")
        .select("id,email,role,is_active,has_set_password,username")
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
        .select("id,email,role,is_active,has_set_password,username")
        .ilike("username", u)
        .maybeSingle();

      if (error) return json(origin, 500, { error: error.message });
      profile = data;
    }

    // Allow teacher + supervisor
    if (!profile || !profile.is_active || !isAllowedRole(profile.role)) {
      // Keep as 404 so the UI shows "not found" behavior
      return json(origin, 404, { error: "Profile not found" });
    }

    if (profile.has_set_password) {
      return json(origin, 409, { error: "Already set up" });
    }

    const userId = String(profile.id ?? "").trim();
    if (!userId) {
      return json(origin, 404, { error: "Profile missing id" });
    }

    // 2) Confirm auth user exists by id (works for username-only users too)
    const { data: authUserData, error: authUserErr } = await supabase.auth.admin.getUserById(userId);
    if (authUserErr || !authUserData?.user?.id) {
      return json(origin, 404, { error: "Auth user not found" });
    }

    // 3) Set password in auth
    const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
      password: p,
    });
    if (updErr) return json(origin, 500, { error: updErr.message });

    // 4) Mark as set up in your profile table
    const { error: flagErr } = await supabase
      .from("user_profiles")
      .update({
        has_set_password: true,
        password_set_at: new Date().toISOString(),
      })
      .eq("id", userId);

    if (flagErr) return json(origin, 500, { error: flagErr.message });

    return json(origin, 200, { ok: true });
  } catch (err) {
    return json(origin, 500, { error: String(err) });
  }
});
