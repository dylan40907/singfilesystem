// supabase/functions/sales-mailchimp-sync/index.ts
//
// Pushes Sales leads into a Mailchimp audience as contacts.
//
// Config split: the audience id / server prefix / enabled flag live in
// public.sales_settings (readable by admins in the browser), while the API key
// is an edge-function secret. A Mailchimp key grants full account access, so it
// must never sit in a table the client can read.
//
// Set the secret before use:
//   supabase secrets set MAILCHIMP_API_KEY=...
//
// POST { mode: "test" }            → verify credentials only
// POST { mode: "sync" }            → sync every lead in the configured statuses
// POST { mode: "sync", lead_id }   → sync one lead

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Settings = {
  mailchimp_enabled: boolean;
  mailchimp_server_prefix: string | null;
  mailchimp_audience_id: string | null;
  mailchimp_sync_statuses: string[];
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
    },
  });
}

// Minimal MD5 (public-domain algorithm) — Mailchimp addresses a subscriber by
// the MD5 of their lowercased email, and Deno's WebCrypto has no MD5.
function md5(input: Uint8Array): string {
  const s = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
    4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  const ml = input.length * 8;
  const withPad = new Uint8Array((((input.length + 8) >> 6) + 1) * 64);
  withPad.set(input);
  withPad[input.length] = 0x80;
  new DataView(withPad.buffer).setUint32(withPad.length - 8, ml >>> 0, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const view = new DataView(withPad.buffer);

  for (let off = 0; off < withPad.length; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + (((F << s[i]) | (F >>> (32 - s[i]))) >>> 0)) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }

  const hex = (n: number) =>
    [...new Uint8Array(new Uint32Array([n]).buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

function subscriberHash(email: string): string {
  return md5(new TextEncoder().encode(email.trim().toLowerCase()));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(204, {});
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const API_KEY = Deno.env.get("MAILCHIMP_API_KEY") ?? "";

  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: "Server not configured" });

  // Caller must be an active full admin.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json(401, { error: "Missing Authorization header." });
  const caller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json(401, { error: "Not authenticated." });
  const { data: prof } = await caller
    .from("user_profiles").select("role, is_active").eq("id", userData.user.id).single();
  if (!prof?.is_active || prof.role !== "admin") return json(403, { error: "Admin-only." });

  if (!API_KEY) {
    return json(400, {
      error: "MAILCHIMP_API_KEY is not set on this function yet.",
      hint: "supabase secrets set MAILCHIMP_API_KEY=...",
    });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: settingsRow } = await admin.from("sales_settings").select("*").eq("id", true).single();
  const settings = (settingsRow ?? {}) as Settings;

  const prefix = (settings.mailchimp_server_prefix ?? "").trim() || API_KEY.split("-")[1] || "";
  if (!prefix) return json(400, { error: "No Mailchimp server prefix (e.g. us14) configured." });

  const base = `https://${prefix}.api.mailchimp.com/3.0`;
  const mcHeaders = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

  const body = await req.json().catch(() => ({}));
  const mode = String(body?.mode ?? "test");

  // ── test ──────────────────────────────────────────────────────────────────
  if (mode === "test") {
    const res = await fetch(`${base}/ping`, { headers: mcHeaders });
    const text = await res.text();
    if (!res.ok) return json(400, { ok: false, error: `Mailchimp ${res.status}: ${text.slice(0, 300)}` });
    return json(200, { ok: true, server_prefix: prefix, ping: text.slice(0, 200) });
  }

  // ── sync ──────────────────────────────────────────────────────────────────
  const audience = (settings.mailchimp_audience_id ?? "").trim();
  if (!audience) return json(400, { error: "No Mailchimp audience id configured." });
  if (!settings.mailchimp_enabled) return json(400, { error: "Mailchimp sync is turned off in Sales settings." });

  const statuses = settings.mailchimp_sync_statuses?.length
    ? settings.mailchimp_sync_statuses
    : ["active", "enrolled"];

  let q = admin
    .from("sales_leads")
    .select("id, parent_first_name, parent_last_name, email, status, city, campus_id")
    .not("email", "is", null);
  if (body?.lead_id) q = q.eq("id", String(body.lead_id));
  else q = q.in("status", statuses);

  const { data: leads, error } = await q;
  if (error) return json(500, { error: error.message });

  let synced = 0;
  const failures: string[] = [];

  for (const l of leads ?? []) {
    const email = (l.email ?? "").trim();
    if (!email || !email.includes("@")) continue;

    const hash = subscriberHash(email);
    const res = await fetch(`${base}/lists/${audience}/members/${hash}`, {
      method: "PUT", // upsert
      headers: mcHeaders,
      body: JSON.stringify({
        email_address: email,
        // Never flip an existing contact to subscribed — that is the caller's
        // consent decision, not ours. New contacts land as transactional.
        status_if_new: "transactional",
        merge_fields: {
          FNAME: l.parent_first_name ?? "",
          LNAME: l.parent_last_name ?? "",
        },
        tags: [`sing-${l.status}`],
      }),
    });

    if (res.ok) synced += 1;
    else failures.push(`${email}: ${res.status} ${(await res.text()).slice(0, 140)}`);
  }

  await admin.from("sales_settings").update({
    mailchimp_last_sync_at: new Date().toISOString(),
    mailchimp_last_result: `${synced} synced, ${failures.length} failed`,
  }).eq("id", true);

  return json(200, { ok: true, synced, failed: failures.length, failures: failures.slice(0, 10) });
});
