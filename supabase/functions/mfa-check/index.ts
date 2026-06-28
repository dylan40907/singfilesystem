// supabase/functions/mfa-check/index.ts
// Verifies the SMS code for a pending login. On success: records the phone (for
// first-time enrollment) and RELEASES the withheld Supabase session tokens.
// This is the gate that makes MFA server-enforced — no session reaches the
// client until the code is confirmed.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_ATTEMPTS = 6;

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

serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json(origin, 405, { error: "Method not allowed" });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SERVICE_ROLE =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ?? "";
    const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
    const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
    const TWILIO_VERIFY_SERVICE_SID = Deno.env.get("TWILIO_VERIFY_SERVICE_SID") ?? "";

    if (!SUPABASE_URL || !SERVICE_ROLE) return json(origin, 500, { error: "Server not configured" });
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
      return json(origin, 500, { error: "SMS provider not configured" });
    }

    const body = await req.json().catch(() => ({}));
    const ticket = String((body as any)?.ticket ?? "").trim();
    const code = String((body as any)?.code ?? "").trim();
    if (!ticket || !code) return json(origin, 400, { error: "Missing ticket or code" });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: pending } = await admin
      .from("mfa_pending")
      .select("ticket, user_id, access_token, refresh_token, phone_e164, setup, attempts, expires_at")
      .eq("ticket", ticket)
      .maybeSingle();

    if (!pending || new Date(pending.expires_at).getTime() < Date.now()) {
      return json(origin, 401, { error: "Your login session expired. Please sign in again." });
    }

    if ((pending.attempts ?? 0) >= MAX_ATTEMPTS) {
      await admin.from("mfa_pending").delete().eq("ticket", ticket);
      return json(origin, 429, { error: "Too many attempts. Please sign in again." });
    }

    const phone = (pending.phone_e164 ?? "").trim();
    if (!phone) return json(origin, 400, { error: "No phone number to verify. Please restart sign-in." });

    const res = await fetch(`https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: phone, Code: code }),
    });
    const data = await res.json().catch(() => ({}));
    const approved = res.ok && (data as any)?.status === "approved";

    if (!approved) {
      await admin
        .from("mfa_pending")
        .update({ attempts: (pending.attempts ?? 0) + 1 })
        .eq("ticket", ticket);
      return json(origin, 401, { error: "That code is incorrect or expired. Please try again." });
    }

    // Approved → persist enrollment and release the session.
    if (pending.setup) {
      await admin
        .from("user_profiles")
        .update({ phone_e164: phone, phone_verified: true, phone_verified_at: new Date().toISOString() })
        .eq("id", pending.user_id);
    }

    await admin.from("mfa_pending").delete().eq("ticket", ticket);

    return json(origin, 200, {
      access_token: pending.access_token,
      refresh_token: pending.refresh_token,
    });
  } catch (e: any) {
    return json(origin, 500, { error: e?.message ?? "unknown" });
  }
});
