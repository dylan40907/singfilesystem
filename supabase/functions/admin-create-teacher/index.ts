// supabase/functions/admin-create-teacher/index.ts
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
  // 3-30 chars, lowercase letters/numbers, can include . _ -, cannot start/end with punctuation
  return /^[a-z0-9](?:[a-z0-9._-]{1,28}[a-z0-9])$/.test(u);
}

function syntheticEmailForUsername(username: string) {
  // RFC 2606 reserved domain; guaranteed non-real.
  // Make sure it’s stable + unique per username.
  return `${username}@sic.invalid`;
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const SUPABASE_URL = getEnv("SUPABASE_URL");
    const SUPABASE_ANON_KEY = getEnv("SUPABASE_ANON_KEY");
    const SERVICE_ROLE_KEY = getEnv("SERVICE_ROLE_KEY"); // <- you must set this secret

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return json({ error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY in Edge runtime env." }, 500);
    }
    if (!SERVICE_ROLE_KEY) {
      return json(
        { error: "Missing SERVICE_ROLE_KEY secret. Run: npx supabase secrets set SERVICE_ROLE_KEY=... --project-ref <ref>" },
        500
      );
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!jwt) return json({ error: "Missing Authorization bearer token" }, 401);

    const { teacher_username, teacher_full_name } = (await req.json().catch(() => ({}))) as {
      teacher_username?: string;
      teacher_full_name?: string;
    };

    const username = normalizeUsername(teacher_username ?? "");
    const fullName = (teacher_full_name ?? "").trim();

    if (!username || !isValidUsername(username)) return json({ error: "Invalid teacher_username" }, 400);
    if (!fullName) return json({ error: "teacher_full_name required" }, 400);

    // Client to validate JWT -> get caller user id
    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userErr } = await authClient.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);

    const actorId = userData.user.id;

    // Admin client (service role)
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Verify actor is admin
    const { data: actorProfile, error: actorProfileErr } = await admin
      .from("user_profiles")
      .select("id, role, is_active")
      .eq("id", actorId)
      .maybeSingle();

    if (actorProfileErr) return json({ error: actorProfileErr.message }, 500);
    if (!actorProfile?.is_active || actorProfile.role !== "admin") return json({ error: "Admin-only" }, 403);

    // Ensure username is unique in your app layer
    const { data: existing, error: existingErr } = await admin
      .from("user_profiles")
      .select("id")
      .eq("username", username)
      .maybeSingle();

    if (existingErr) return json({ error: existingErr.message }, 500);
    if (existing?.id) return json({ error: "Username already exists" }, 409);

    // Create auth user with a random temp password (unknown to everyone).
    const tempPassword = `${crypto.randomUUID()}Aa1!`;

    // Supabase Auth REQUIRES email or phone.
    // We generate a synthetic email from username so the app can remain "username-only".
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

    // Upsert profile row (keep email NULL in your profile table if you truly don't use it)
    const { error: upsertErr } = await admin.from("user_profiles").upsert(
      {
        id: newUserId,
        email: null,
        username,
        full_name: fullName,
        role: "teacher",
        is_active: true,
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
    console.error("admin-create-teacher error", e);
    return json({ error: (e as Error)?.message ?? "Unknown error" }, 500);
  }
});
