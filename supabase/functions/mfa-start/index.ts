// supabase/functions/mfa-start/index.ts
// Sends an SMS verification code (Twilio Verify) for a pending login identified
// by `ticket`. For first-time enrollment (setup), the client also passes `phone`.
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
function isE164(s: string) {
  return /^\+[1-9]\d{6,14}$/.test(s.trim());
}
function maskPhone(s: string) {
  return "••••••" + s.replace(/\D/g, "").slice(-4);
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
    const phoneRaw = String((body as any)?.phone ?? "").trim();
    if (!ticket) return json(origin, 400, { error: "Missing ticket" });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    try { await admin.rpc("purge_expired_mfa_pending"); } catch (_) { /* best-effort */ }

    const { data: pending } = await admin
      .from("mfa_pending")
      .select("ticket, phone_e164, setup, expires_at")
      .eq("ticket", ticket)
      .maybeSingle();

    if (!pending || new Date(pending.expires_at).getTime() < Date.now()) {
      return json(origin, 401, { error: "Your login session expired. Please sign in again." });
    }

    let phone = (pending.phone_e164 ?? "").trim();

    if (pending.setup) {
      if (!phoneRaw) return json(origin, 400, { error: "Phone number required" });
      if (!isE164(phoneRaw)) {
        return json(origin, 400, { error: "Enter a valid number in international format, e.g. +15551234567" });
      }
      phone = phoneRaw;
      await admin.from("mfa_pending").update({ phone_e164: phone }).eq("ticket", ticket);
    }

    if (!phone) return json(origin, 400, { error: "No phone number on file" });

    const res = await fetch(`https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/Verifications`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: phone, Channel: "sms" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json(origin, 502, { error: (data as any)?.message ?? "Could not send code" });

    return json(origin, 200, { ok: true, masked_phone: maskPhone(phone) });
  } catch (e: any) {
    return json(origin, 500, { error: e?.message ?? "unknown" });
  }
});
