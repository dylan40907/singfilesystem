// teacher-setup-set-password/index.ts
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
  const perPage = 200;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (hit?.id) return hit.id;

    if (users.length < perPage) break;
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
    const { email, password } = await req.json();
    const e = normalizeEmail(email ?? "");
    const p = String(password ?? "");

    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return json(origin, 400, { error: "Invalid email" });
    }
    if (p.length < 8) {
      return json(origin, 400, { error: "Password must be at least 8 characters" });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      Deno.env.get("SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return json(origin, 500, { error: "Missing SUPABASE_URL or SERVICE_ROLE_KEY" });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1) Validate profile (and gate already-set accounts)
    const { data: profile, error: profErr } = await supabase
      .from("user_profiles")
      .select("id,email,role,is_active,has_set_password")
      .ilike("email", e)
      .maybeSingle();

    if (profErr) return json(origin, 500, { error: profErr.message });

    // Allow teacher + supervisor
    if (!profile || !profile.is_active || !isAllowedRole(profile.role)) {
      // Keep as 404 so the UI shows "not found" behavior
      return json(origin, 404, { error: "Profile not found" });
    }

    if (profile.has_set_password) {
      // This is how you get the nice “already set up” behavior
      return json(origin, 409, { error: "Already set up" });
    }

    // 2) Find auth user id by email
    const userId = await findAuthUserIdByEmail(supabase, e);
    if (!userId) {
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
      .eq("id", profile.id);

    if (flagErr) return json(origin, 500, { error: flagErr.message });

    return json(origin, 200, { ok: true });
  } catch (err) {
    return json(origin, 500, { error: String(err) });
  }
});
