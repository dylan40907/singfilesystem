import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";

export const runtime = "nodejs";

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function safeFilename(name: string) {
  return name.replace(/[^\w.\-()+\s]/g, "_").slice(0, 180);
}

export async function POST(req: Request) {
  try {
    // Read env INSIDE handler so the route can still load in dev without crashing
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SUPABASE_ANON_KEY = requireEnv("SUPABASE_ANON_KEY");

    const R2_BUCKET = requireEnv("R2_BUCKET");
    const R2_ENDPOINT = requireEnv("R2_ENDPOINT");
    const R2_ACCESS_KEY_ID = requireEnv("R2_ACCESS_KEY_ID");
    const R2_SECRET_ACCESS_KEY = requireEnv("R2_SECRET_ACCESS_KEY");

    const s3 = new S3Client({
      region: "auto",
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });

    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const folderId = body?.folderId;
    const filename = body?.filename;
    const contentType = body?.contentType;
    const sizeBytes = body?.sizeBytes;

    if (!folderId || !filename || !contentType) {
      return NextResponse.json(
        { error: "folderId, filename, contentType required" },
        { status: 400 }
      );
    }

    // Supabase client that applies RLS using the user's JWT
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) {
      return NextResponse.json({ error: "Invalid session" }, { status: 401 });
    }

    const { data: canManage, error: canErr } = await supabase.rpc("can_manage_folder", {
      folder_uuid: folderId,
    });

    if (canErr) return NextResponse.json({ error: canErr.message }, { status: 403 });
    if (!canManage)
      return NextResponse.json({ error: "No permission to upload to this folder" }, { status: 403 });

    const id = crypto.randomUUID();
    const clean = safeFilename(filename);
    const objectKey = `folders/${folderId}/${id}-${clean}`;

    const cmd = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: objectKey,
      ContentType: contentType,
      Metadata: sizeBytes ? { sizeBytes: String(sizeBytes) } : undefined,
    });

    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 60 });

    return NextResponse.json({ uploadUrl, objectKey });
  } catch (e: any) {
    // IMPORTANT: always return JSON (so client never sees HTML doctype)
    return NextResponse.json({ error: e?.message ?? "unknown" }, { status: 500 });
  }
}
