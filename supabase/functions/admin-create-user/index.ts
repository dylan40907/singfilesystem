// supabase/functions/admin-create-user/index.ts
//
// Unified account creation for the HR → Employees "Add user" flow. Replaces the
// separate admin-create-teacher / -supervisor / -campus-admin calls.
//
// roles:
//   teacher | supervisor | app_supervisor | campus_admin
// "app_supervisor" is a supervisor carrying can_manage_learning = true.
//
// Authorization:
//   - admin        → may create any of the four
//   - campus_admin → may create teacher / supervisor / app_supervisor only, and
//                    the new account is pinned to the campus admin's own campus.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type Json = Record<string, unknown>;

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Json, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
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

const ALLOWED = new Set(["teacher", "supervisor", "app_supervisor", "campus_admin"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const SUPABASE_URL = getEnv("SUPABASE_URL");
    const SUPABASE_ANON_KEY = getEnv("SUPABASE_ANON_KEY");
    const SERVICE_ROLE_KEY = getEnv("SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json({ error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY" }, 500);
    if (!SERVICE_ROLE_KEY) return json({ error: "Missing SERVICE_ROLE_KEY secret" }, 500);

    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!jwt) return json({ error: "Missing Authorization bearer token" }, 401);

    const body = (await req.json().catch(() => ({}))) as {
      username?: string;
      full_name?: string;
      role?: string;
      campus_id?: string | null;
    };

    const username = normalizeUsername(body.username ?? "");
    const fullName = (body.full_name ?? "").trim();
    const requestedRole = (body.role ?? "").trim();
    let campusId = (body.campus_id ?? "")?.toString().trim() || null;

    if (!username || !isValidUsername(username)) {
      return json({ error: "Invalid username (3–30 chars: letters, numbers, . _ -)" }, 400);
    }
    if (!fullName) return json({ error: "full_name required" }, 400);
    if (!ALLOWED.has(requestedRole)) return json({ error: "Invalid role" }, 400);

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await authClient.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ── Authorize the actor ──────────────────────────────────────────────────
    const { data: actor, error: actorErr } = await admin
      .from("user_profiles")
      .select("id, role, is_active, campus_id")
      .eq("id", userData.user.id)
      .maybeSingle();

    if (actorErr) return json({ error: actorErr.message }, 500);
    if (!actor?.is_active) return json({ error: "Inactive account" }, 403);

    const actorRole = actor.role as string | null;
    if (actorRole !== "admin" && actorRole !== "campus_admin") {
      return json({ error: "Admins and campus admins only" }, 403);
    }
    if (requestedRole === "campus_admin" && actorRole !== "admin") {
      return json({ error: "Only true admins can create campus admins" }, 403);
    }
    // A campus admin can only ever add people to their own campus.
    if (actorRole === "campus_admin") {
      if (!actor.campus_id) return json({ error: "Your account has no campus assigned" }, 400);
      campusId = actor.campus_id as string;
    }

    if (requestedRole === "campus_admin" && !campusId) {
      return json({ error: "campus_id required for campus admins" }, 400);
    }

    // Verify campus if one was supplied.
    if (campusId) {
      const { data: campusRow, error: campusErr } = await admin
        .from("hr_campuses").select("id").eq("id", campusId).maybeSingle();
      if (campusErr) return json({ error: campusErr.message }, 500);
      if (!campusRow) return json({ error: "Campus not found" }, 404);
    }

    // ── Unique username ──────────────────────────────────────────────────────
    const { data: existing, error: existingErr } = await admin
      .from("user_profiles").select("id").eq("username", username).maybeSingle();
    if (existingErr) return json({ error: existingErr.message }, 500);
    if (existing?.id) return json({ error: "Username already exists" }, 409);

    // ── Create the auth user ─────────────────────────────────────────────────
    const tempPassword = `${crypto.randomUUID()}Aa1!`;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: syntheticEmailForUsername(username),
      password: tempPassword,
      email_confirm: true,
      user_metadata: { full_name: fullName, username },
    });
    if (createErr) return json({ error: createErr.message }, 400);
    if (!created?.user?.id) return json({ error: "Create user returned no id" }, 500);

    const newUserId = created.user.id;

    // app_supervisor is stored as a supervisor + the learning-manager flag.
    const dbRole = requestedRole === "app_supervisor" ? "supervisor" : requestedRole;
    const canManageLearning = requestedRole === "app_supervisor";

    // Inserting the profile fires hr_ensure_employee_for_profile, which creates
    // the matching hr_employees row for the Employees directory.
    const { error: upsertErr } = await admin.from("user_profiles").upsert(
      {
        id: newUserId,
        email: null,
        username,
        full_name: fullName,
        role: dbRole,
        is_active: true,
        campus_id: campusId,
        can_manage_learning: canManageLearning,
      },
      { onConflict: "id" }
    );

    if (upsertErr) {
      return json(
        { ok: true, user_id: newUserId, warning: "Auth user created but profile upsert failed", detail: upsertErr.message },
        200
      );
    }

    return json({ ok: true, user_id: newUserId, role: dbRole, campus_id: campusId });
  } catch (e) {
    console.error("admin-create-user error", e);
    return json({ error: (e as Error)?.message ?? "Unknown error" }, 500);
  }
});
