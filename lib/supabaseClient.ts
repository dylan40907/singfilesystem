// lib/supabaseClient.ts
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Turn Postgres' RLS refusal into something a person can act on.
 *
 * Every page surfaces `error.message` straight to the user, and a role without
 * edit rights would see 'new row violates row-level security policy for table
 * "clock_entries"'. That reads as a broken portal rather than as "your role
 * can't do this", so it gets rewritten once here instead of at ~200 call sites.
 *
 * Only the message changes — `code` (42501) and the rest of the body are left
 * alone so anything matching on them still works.
 */
const RLS_MESSAGE =
  "Your role doesn't have permission to change this. Ask an admin if you need edit access to this page.";

function friendlier(body: string): string | null {
  if (!body.includes("row-level security policy")) return null;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.message !== "string") return null;
    return JSON.stringify({ ...parsed, message: RLS_MESSAGE, hint: parsed.message });
  } catch {
    return null;
  }
}

const fetchWithFriendlyRlsErrors: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  // 403 is the RLS refusal; 400 covers the check-constraint shaped variants.
  if (res.ok || (res.status !== 403 && res.status !== 400)) return res;

  const clone = res.clone();
  const body = await clone.text().catch(() => "");
  const rewritten = friendlier(body);
  if (!rewritten) return res;

  // The rewritten body is a different length, so the original header would lie.
  const headers = new Headers(res.headers);
  headers.delete("content-length");

  return new Response(rewritten, { status: res.status, statusText: res.statusText, headers });
};

export const supabase = createClient(url, anon, {
  global: { fetch: fetchWithFriendlyRlsErrors },
});
