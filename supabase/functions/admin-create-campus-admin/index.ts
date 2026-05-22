// supabase/functions/admin-create-campus-admin/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type Json = Record<string, unknown>;

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Json, status = 200, extraHeaders: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function getEnv(name: string) {
  const v = Deno.env.get(name);
  return v && v.trim() ? v : null;
}

function normalizeUsername(input: string) {
  return (input ?? "").trim().toLowerCase();
}

function isValidUsername(input: string) {
  const u = normalizeUsername(input);
  return /^[a-z0-9](?:[a-z0-9._-]{1,28}[a-z0-9])$/.test(u);
}

function syntheticEmailForUsername(username: string) {
  return `${username}@sic.invalid`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const SUPABASE_URL = getEnv("SUPABASE_URL");
    const SUPABASE_ANON_KEY = getEnv("SUPABASE_ANON_KEY");
    const SERVICE_ROLE_KEY = getEnv("SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return json({ error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY" }, 500);
    }
    if (!SERVICE_ROLE_KEY) {
      return json({ error: "Missing SERVICE_ROLE_KEY secret" }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!jwt) return json({ error: "Missing Authorization bearer token" }, 401);

    const { admin_username, admin_full_name, campus_id } = (await req.json().catch(() => ({}))) as {
      admin_username?: string;
      admin_full_name?: string;
      campus_id?: string;
    };

    const username = normalizeUsername(admin_username ?? "");
    const fullName = (admin_full_name ?? "").trim();
    const campusId = (campus_id ?? "").trim();

    if (!username || !isValidUsername(username)) return json({ error: "Invalid admin_username" }, 400);
    if (!fullName) return json({ error: "admin_full_name required" }, 400);
    if (!campusId) return json({ error: "campus_id required" }, 400);

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await authClient.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Verify actor is a true admin
    const { data: actorProfile, error: actorProfileErr } = await admin
      .from("user_profiles")
      .select("id, role, is_active")
      .eq("id", userData.user.id)
      .maybeSingle();

    if (actorProfileErr) return json({ error: actorProfileErr.message }, 500);
    if (!actorProfile?.is_active || actorProfile.role !== "admin") {
      return json({ error: "True admins only" }, 403);
    }

    // Verify campus exists
    const { data: campusRow, error: campusErr } = await admin
      .from("hr_campuses")
      .select("id")
      .eq("id", campusId)
      .maybeSingle();
    if (campusErr) return json({ error: campusErr.message }, 500);
    if (!campusRow) return json({ error: "Campus not found" }, 404);

    // Ensure username is unique
    const { data: existing, error: existingErr } = await admin
      .from("user_profiles")
      .select("id")
      .eq("username", username)
      .maybeSingle();
    if (existingErr) return json({ error: existingErr.message }, 500);
    if (existing?.id) return json({ error: "Username already exists" }, 409);

    const tempPassword = `${crypto.randomUUID()}Aa1!`;
    const authEmail = syntheticEmailForUsername(username);

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: authEmail,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { full_name: fullName, username },
    });
    if (createErr) return json({ error: createErr.message }, 400);
    if (!created?.user?.id) return json({ error: "Create user returned no id" }, 500);

    const newUserId = created.user.id;

    const { error: upsertErr } = await admin.from("user_profiles").upsert(
      {
        id: newUserId,
        email: null,
        username,
        full_name: fullName,
        role: "campus_admin",
        is_active: true,
        campus_id: campusId,
      },
      { onConflict: "id" }
    );

    if (upsertErr) {
      return json(
        { ok: true, user_id: newUserId, warning: "Auth user created but profile upsert failed", detail: upsertErr.message },
        200
      );
    }

    return json({ ok: true, user_id: newUserId });
  } catch (e) {
    console.error("admin-create-campus-admin error", e);
    return json({ error: (e as Error)?.message ?? "Unknown error" }, 500);
  }
});
