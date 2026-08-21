/// <reference lib="deno.ns" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const SUPABASE_SERVICE_ROLE_KEY =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ?? "";

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: "Missing Supabase env vars." }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "Missing Authorization header." }, 401);

    const supabaseCaller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: callerUser, error: callerUserErr } = await supabaseCaller.auth.getUser();
    if (callerUserErr || !callerUser?.user) return json({ error: "Not authenticated." }, 401);

    const callerId = callerUser.user.id;

    const { data: callerProfile, error: callerProfileErr } = await supabaseCaller
      .from("user_profiles")
      .select("role, is_active")
      .eq("id", callerId)
      .single();

    if (callerProfileErr) return json({ error: callerProfileErr.message }, 403);
    if (!callerProfile?.is_active || callerProfile.role !== "admin") {
      return json({ error: "True admins only." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const target_user_id = (body?.target_user_id ?? "").toString();
    const new_role = (body?.new_role ?? "").toString();
    /**
     * Optional custom role (hr_roles.id). Its base level must match new_role —
     * the caller derives new_role from the role's base_role, and we re-check
     * here rather than trusting the client to have done so.
     */
    const hr_role_id = body?.hr_role_id ? String(body.hr_role_id) : null;
    const campus_id = body?.campus_id ? (body.campus_id as string).toString() : null;
    // "App Supervisor" = supervisor + this flag. Only meaningful for supervisors.
    const grant_learning = body?.can_manage_learning === true && new_role === "supervisor";

    if (!target_user_id) return json({ error: "Missing target_user_id" }, 400);
    if (new_role !== "teacher" && new_role !== "supervisor" && new_role !== "campus_admin") {
      return json({ error: "new_role must be 'teacher', 'supervisor', or 'campus_admin'" }, 400);
    }
    if (new_role === "campus_admin" && !campus_id) {
      return json({ error: "campus_id is required when promoting to campus_admin" }, 400);
    }
    if (target_user_id === callerId) {
      return json({ error: "You cannot change your own role." }, 400);
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Validate target
    const { data: targetProfile, error: targetErr } = await supabaseAdmin
      .from("user_profiles")
      .select("id, role, can_manage_learning, hr_role_id")
      .eq("id", target_user_id)
      .single();

    if (targetErr) return json({ error: targetErr.message }, 400);
    if (!targetProfile) return json({ error: "Target not found." }, 404);
    if (targetProfile.role === "admin") {
      return json({ error: "Cannot change role of a true admin." }, 400);
    }
    if (
      targetProfile.role !== "teacher" &&
      targetProfile.role !== "supervisor" &&
      targetProfile.role !== "campus_admin"
    ) {
      return json({ error: "Target role not eligible for role changes." }, 400);
    }
    // Reject only if nothing changes (same role AND same learning flag). This
    // allows Supervisor <-> App Supervisor, which keep new_role = "supervisor".
    const flagChanged = (targetProfile.can_manage_learning ?? false) !== grant_learning;
    const roleChanged = (targetProfile.hr_role_id ?? null) !== hr_role_id;
    if (targetProfile.role === new_role && !flagChanged && !roleChanged) {
      return json({ error: `User is already a ${new_role}.` }, 400);
    }

    // Validate campus_id if needed
    if (new_role === "campus_admin") {
      const { data: campusRow, error: campusErr } = await supabaseAdmin
        .from("hr_campuses")
        .select("id")
        .eq("id", campus_id)
        .maybeSingle();
      if (campusErr) return json({ error: campusErr.message }, 500);
      if (!campusRow) return json({ error: "Campus not found." }, 404);
    }

    if (hr_role_id) {
      const { data: roleRow, error: roleErr } = await supabaseAdmin
        .from("hr_roles")
        .select("id, base_role")
        .eq("id", hr_role_id)
        .maybeSingle();
      if (roleErr) return json({ error: roleErr.message }, 500);
      if (!roleRow) return json({ error: "Role not found." }, 404);
      if (roleRow.base_role !== new_role) {
        return json({ error: `That role is a ${roleRow.base_role}, not a ${new_role}.` }, 400);
      }
    }

    // Only clear supervisor-teacher assignments when actually LEAVING the
    // supervisor role (Supervisor -> App Supervisor stays supervisor, keeps them).
    if (targetProfile.role === "supervisor" && new_role !== "supervisor") {
      const { error: asnErr } = await supabaseAdmin
        .from("supervisor_teacher_assignments")
        .delete()
        .eq("supervisor_user_id", target_user_id);
      if (asnErr) return json({ error: "Failed to clear assignments: " + asnErr.message }, 500);
    }

    // Build the patch. campus_id is only meaningful for campus_admin; null it out
    // otherwise. The learning flag is only ever set for supervisors.
    const patch: Record<string, unknown> = {
      role: new_role,
      campus_id: new_role === "campus_admin" ? campus_id : null,
      can_manage_learning: grant_learning,
      // Null clears any custom role, putting them back on their level's defaults.
      hr_role_id,
      updated_at: new Date().toISOString(),
    };

    const { error: updErr } = await supabaseAdmin
      .from("user_profiles")
      .update(patch)
      .eq("id", target_user_id);

    if (updErr) return json({ error: updErr.message }, 500);

    return json({ ok: true, target_user_id, new_role });
  } catch (e: any) {
    return json({ error: e?.message ?? "Unknown error" }, 500);
  }
});
