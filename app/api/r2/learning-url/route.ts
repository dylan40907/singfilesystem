import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const runtime = "nodejs";

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Returns a presigned GET URL for an object in sing-learning-media.
// Admin-only.
// Body: { objectKey, expiresIn? }
// expiresIn defaults to 3600 (1 hour). Use 604800 for 7-day thumbnail URLs.
export async function POST(req: Request) {
  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SUPABASE_ANON_KEY = requireEnv("SUPABASE_ANON_KEY");
    const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const R2_ENDPOINT = requireEnv("R2_ENDPOINT");
    const R2_ACCESS_KEY_ID = requireEnv("R2_ACCESS_KEY_ID");
    const R2_SECRET_ACCESS_KEY = requireEnv("R2_SECRET_ACCESS_KEY");
    const R2_BUCKET = requireEnv("SING_LEARNING_R2_BUCKET");

    const s3 = new S3Client({
      region: "auto",
      endpoint: R2_ENDPOINT,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });

    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
    }

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData.user) {
      return NextResponse.json({ error: "Invalid session" }, { status: 401 });
    }

    const { data: prof } = await adminClient
      .from("user_profiles")
      .select("role, is_active, can_manage_learning")
      .eq("id", userData.user.id)
      .single();

    if (!prof?.is_active || (prof.role !== "admin" && prof.role !== "campus_admin" && !prof.can_manage_learning)) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const { objectKey, expiresIn = 3600 } = body ?? {};

    if (!objectKey) {
      return NextResponse.json({ error: "objectKey required" }, { status: 400 });
    }

    const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: objectKey });
    const url = await getSignedUrl(s3, cmd, { expiresIn: Math.min(expiresIn, 604800) });

    return NextResponse.json({ url });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "unknown" }, { status: 500 });
  }
}
