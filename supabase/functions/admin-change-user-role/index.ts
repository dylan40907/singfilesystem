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
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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
      return json({ error: "Admin-only." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const target_user_id = (body?.target_user_id ?? "").toString();
    const new_role = (body?.new_role ?? "").toString();

    if (!target_user_id) return json({ error: "Missing target_user_id" }, 400);
    if (new_role !== "teacher" && new_role !== "supervisor") {
      return json({ error: "new_role must be 'teacher' or 'supervisor'" }, 400);
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Ensure target exists and is teacher/supervisor (not admin)
    const { data: targetProfile, error: targetErr } = await supabaseAdmin
      .from("user_profiles")
      .select("id, role")
      .eq("id", target_user_id)
      .single();

    if (targetErr) return json({ error: targetErr.message }, 400);
    if (!targetProfile) return json({ error: "Target not found." }, 404);

    if (targetProfile.role !== "teacher" && targetProfile.role !== "supervisor") {
      return json({ error: "Can only change role for teacher/supervisor accounts." }, 400);
    }

    if (targetProfile.role === new_role) {
      return json({ error: `User is already a ${new_role}.` }, 400);
    }

    // If demoting supervisor to teacher, clear their supervisor-teacher assignments
    if (targetProfile.role === "supervisor" && new_role === "teacher") {
      await supabaseAdmin
        .from("supervisor_teacher_assignments")
        .delete()
        .eq("supervisor_id", target_user_id);
    }

    const { error: updErr } = await supabaseAdmin
      .from("user_profiles")
      .update({
        role: new_role,
        updated_at: new Date().toISOString(),
      })
      .eq("id", target_user_id);

    if (updErr) return json({ error: updErr.message }, 500);

    return json({ ok: true, target_user_id, new_role });
  } catch (e: any) {
    return json({ error: e?.message ?? "Unknown error" }, 500);
  }
});
