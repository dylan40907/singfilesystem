// Deno Edge Function
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization") ?? "";

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Identify caller (JWT)
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: caller, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller?.user) return new Response("Not authenticated", { status: 401 });

    // Admin client
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Check caller is admin
    const { data: prof, error: profErr } = await admin
      .from("user_profiles")
      .select("role, is_active")
      .eq("id", caller.user.id)
      .single();

    if (profErr || !prof || prof.role !== "admin" || !prof.is_active) {
      return new Response("Not authorized", { status: 403 });
    }

    const { email, full_name } = await req.json();
    if (!email || !full_name) return new Response("Missing email/full_name", { status: 400 });

    // Create Auth user WITHOUT password (teacher can set later via recovery/invite flow you’ll build)
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name },
    });
    if (createErr || !created?.user) throw createErr ?? new Error("Create user failed");

    // Ensure profile row exists (adjust columns if needed)
    await admin.from("user_profiles").upsert({
      id: created.user.id,
      email,
      full_name,
      role: "teacher",
      is_active: true,
    });

    return Response.json({ user_id: created.user.id });
  } catch (e: any) {
    return new Response(e?.message ?? "Unknown error", { status: 500 });
  }
});
