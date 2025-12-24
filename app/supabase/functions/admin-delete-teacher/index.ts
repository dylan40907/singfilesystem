import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization") ?? "";

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: caller, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller?.user) return new Response("Not authenticated", { status: 401 });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: prof } = await admin
      .from("user_profiles")
      .select("role, is_active")
      .eq("id", caller.user.id)
      .single();

    if (!prof || prof.role !== "admin" || !prof.is_active) return new Response("Not authorized", { status: 403 });

    const { user_id } = await req.json();
    if (!user_id) return new Response("Missing user_id", { status: 400 });

    // Delete profile row (optional; depends on your schema/triggers)
    await admin.from("user_profiles").delete().eq("id", user_id);

    // Delete auth user
    const { error: delErr } = await admin.auth.admin.deleteUser(user_id);
    if (delErr) throw delErr;

    return new Response(null, { status: 204 });
  } catch (e: any) {
    return new Response(e?.message ?? "Unknown error", { status: 500 });
  }
});
