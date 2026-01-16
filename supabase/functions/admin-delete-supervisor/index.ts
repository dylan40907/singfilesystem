// supabase/functions/admin-delete-supervisor/index.ts
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const SUPABASE_URL = getEnv("SUPABASE_URL");
    const SUPABASE_ANON_KEY = getEnv("SUPABASE_ANON_KEY");
    const SERVICE_ROLE_KEY = getEnv("SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return json({ error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY in Edge runtime env." }, 500);
    }
    if (!SERVICE_ROLE_KEY) {
      return json(
        {
          error:
            "Missing SERVICE_ROLE_KEY secret. Run: npx supabase secrets set SERVICE_ROLE_KEY=... --project-ref <ref>",
        },
        500
      );
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!jwt) return json({ error: "Missing Authorization bearer token" }, 401);

    const { supervisor_id } = (await req.json().catch(() => ({}))) as { supervisor_id?: string };
    const targetId = (supervisor_id ?? "").trim();
    if (!targetId) return json({ error: "supervisor_id required" }, 400);

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userErr } = await authClient.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);

    const actorId = userData.user.id;

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

    if (targetId === actorId) return json({ error: "You cannot delete yourself." }, 400);

    // Only allow deleting supervisors (refuse deleting admins/teachers)
    const { data: targetProfile, error: targetProfileErr } = await admin
      .from("user_profiles")
      .select("id, role")
      .eq("id", targetId)
      .maybeSingle();

    if (targetProfileErr) return json({ error: targetProfileErr.message }, 500);

    if (targetProfile?.role === "admin") return json({ error: "Refusing to delete an admin." }, 400);
    if (targetProfile?.role !== "supervisor") return json({ error: "Refusing to delete a non-supervisor." }, 400);

    // IMPORTANT: delete DB rows first (cascades, FK constraints), then delete auth user last.

    // Clear supervisor assignments first (avoid FK / business-rule blockers)
    const { error: asnErr } = await admin
      .from("supervisor_teacher_assignments")
      .delete()
      .eq("supervisor_user_id", targetId);
    if (asnErr) return json({ error: "DB error deleting supervisor assignments: " + asnErr.message }, 400);

    // Delete profile (this should cascade any linked HR records via hr_employees.profile_id ON DELETE CASCADE, etc.)
    const { error: profDelErr } = await admin.from("user_profiles").delete().eq("id", targetId);
    if (profDelErr) return json({ error: "DB error deleting profile: " + profDelErr.message }, 400);

    // Delete auth user
    const { error: delErr } = await admin.auth.admin.deleteUser(targetId);
    if (delErr) return json({ error: "Auth delete error: " + delErr.message, details: delErr as any }, 400);

    return json({ ok: true });
  } catch (e) {
    console.error("admin-delete-supervisor error", e);
    return json({ error: (e as Error)?.message ?? "Unknown error" }, 500);
  }
});
