import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const runtime = "nodejs";

// Presigned PUT for uploading course media directly to Cloudflare R2.
// Admin / campus-admin only. Returns { uploadUrl, publicUrl, key }.
// publicUrl points at the stable /api/course-media serve endpoint.

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error("Missing env var: " + name);
  return v;
}

// Stable portal origin baked into stored URLs so the mobile app resolves them.
const PORTAL = process.env.PORTAL_URL || "https://www.singlearning.com";

export async function POST(req: Request) {
  try {
    const SUPABASE_URL = env("SUPABASE_URL");
    const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
    const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

    const s3 = new S3Client({
      region: "auto",
      endpoint: env("R2_ENDPOINT"),
      credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") },
    });

    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
    }

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData.user) {
      return NextResponse.json({ error: "Invalid session" }, { status: 401 });
    }

    const { data: prof } = await adminClient
      .from("user_profiles")
      .select("role, is_active")
      .eq("id", userData.user.id)
      .single();

    if (!prof?.is_active || (prof.role !== "admin" && prof.role !== "campus_admin")) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const { name, contentType } = body ?? {};
    if (!name || !contentType) {
      return NextResponse.json({ error: "name and contentType required" }, { status: 400 });
    }

    const safe = String(name).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 200);
    const key = `course-media/${safe}`;

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: env("R2_BUCKET"), Key: key, ContentType: contentType }),
      { expiresIn: 3600 }
    );
    const publicUrl = `${PORTAL}/api/course-media/${encodeURIComponent(safe)}`;

    return NextResponse.json({ uploadUrl, publicUrl, key });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "unknown" }, { status: 500 });
  }
}
