// supabase/functions/auth-username-login/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function json(origin: string | null, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

function looksLikeEmail(s: string) {
  const v = s.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function normalizeUsername(s: string) {
  return s.trim().toLowerCase();
}

serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json(origin, 405, { error: "Method not allowed" });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const SUPABASE_SERVICE_ROLE_KEY =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ?? "";

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(origin, 500, {
        error: "Missing env vars (SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY)",
      });
    }

    const body = await req.json().catch(() => ({}));
    const identifierRaw = String((body as any)?.identifier ?? "").trim();
    const password = String((body as any)?.password ?? "");

    if (!identifierRaw || !password) {
      return json(origin, 400, { error: "identifier + password required" });
    }

    // Admin client for safe server-side resolution
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let email = "";

    if (looksLikeEmail(identifierRaw)) {
      // Email login path
      email = identifierRaw.toLowerCase();
    } else {
      // Username login path:
      // 1) Resolve username -> profile.id (auth user id) without relying on profile.email
      const username = normalizeUsername(identifierRaw);

      const { data: prof, error: profErr } = await admin
        .from("user_profiles")
        .select("id, is_active")
        .ilike("username", username)
        .maybeSingle();

      // Don't leak whether username exists
      if (profErr || !prof?.id) {
        return json(origin, 401, { error: "Invalid credentials" });
      }
      if (!prof.is_active) {
        return json(origin, 403, { error: "Not authorized" });
      }

      // 2) Fetch the auth user by id and use its email for password sign-in
      const { data: authUserData, error: authUserErr } = await admin.auth.admin.getUserById(prof.id);
      const authEmail = String(authUserData?.user?.email ?? "").trim().toLowerCase();

      // If the auth user truly has no email, password sign-in isn't possible (GoTrue requires email/phone)
      if (authUserErr || !authEmail) {
        return json(origin, 401, { error: "Invalid credentials" });
      }

      email = authEmail;
    }

    // Password sign-in must be done with anon key
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await anon.auth.signInWithPassword({ email, password });

    if (error || !data?.session?.access_token || !data?.session?.refresh_token) {
      return json(origin, 401, { error: "Invalid credentials" });
    }

    return json(origin, 200, {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      token_type: data.session.token_type,
      user: data.user,
    });
  } catch (e: any) {
    return json(origin, 500, { error: e?.message ?? "unknown" });
  }
});
