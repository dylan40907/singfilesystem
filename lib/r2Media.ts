import { createClient } from "@supabase/supabase-js";
import { S3Client } from "@aws-sdk/client-s3";

/**
 * Shared plumbing for the media R2 routes (albums, chat attachments, sales
 * email assets).
 *
 * These three used to live in Supabase Storage, which meant a second storage
 * system with its own upload cap, its own RLS and its own egress bill. R2 is
 * where everything else in the product already lives, so they were moved to
 * match — see app/api/r2/media-*.
 *
 * Server-only: this reads secrets and must never be imported by a client
 * component.
 */

export type MediaScope = "album" | "chat" | "email";

/** Key prefix per scope, so one bucket stays legible and easy to sweep. */
const PREFIX: Record<MediaScope, string> = {
  album: "albums",
  chat: "chat",
  email: "sales-email",
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export function r2Client() {
  return new S3Client({
    region: "auto",
    endpoint: requireEnv("R2_ENDPOINT"),
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
}

export function mediaBucket(): string {
  return requireEnv("R2_BUCKET");
}

/**
 * Build the object key for a scope.
 *
 * `group` is the album id / conversation id, so the key still says who owns the
 * file. It's validated rather than interpolated blindly — a caller-supplied
 * value containing ".." or a leading slash could otherwise reach outside its
 * own prefix.
 */
export function mediaKey(scope: MediaScope, group: string | null, filename: string): string {
  const safeGroup = (group ?? "").replace(/[^a-zA-Z0-9._-]+/g, "");
  const safeName = filename.replace(/[^\w.\-()+\s]/g, "_").slice(-120) || "file";
  const id = crypto.randomUUID();
  const parts = [PREFIX[scope], safeGroup, `${id}-${safeName}`].filter(Boolean);
  return parts.join("/");
}

/** Keys must stay inside a known prefix — no traversal, no other buckets' data. */
export function isAllowedKey(key: string): boolean {
  if (!key || key.includes("..") || key.startsWith("/")) return false;
  return Object.values(PREFIX).some((p) => key.startsWith(`${p}/`));
}

export type Caller = { id: string; role: string | null; isActive: boolean };

/**
 * Verify the caller's Supabase session. Used by every media route — the phone
 * and the browser both send the same bearer token.
 */
export async function authenticate(req: Request): Promise<Caller | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const authClient = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error } = await authClient.auth.getUser();
  if (error || !userData.user) return null;

  const admin = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const { data: prof } = await admin
    .from("user_profiles")
    .select("role, is_active")
    .eq("id", userData.user.id)
    .maybeSingle();

  // Guest sessions (signInAnonymously) have no profile row and must not reach
  // any of this.
  if (!prof?.is_active) return null;
  return { id: userData.user.id, role: prof.role ?? null, isActive: true };
}

/** Deleting is for supervisors and up, matching can_manage_albums() in the database. */
export function canDeleteMedia(caller: Caller): boolean {
  return ["admin", "campus_admin", "supervisor"].includes(caller.role ?? "");
}
