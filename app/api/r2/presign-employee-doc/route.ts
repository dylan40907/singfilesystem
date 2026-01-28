import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

function safeFilename(name: string) {
  // keep it simple + predictable
  return (name || "file").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 140);
}

function jsonError(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return jsonError("Missing bearer token", 401);

    const body = await req.json();
    const employeeId = String(body?.employeeId || "");
    const filename = String(body?.filename || "");
    const contentType = String(body?.contentType || "application/octet-stream");
    const sizeBytes = Number(body?.sizeBytes || 0);

    if (!employeeId) return jsonError("Missing employeeId");
    if (!filename) return jsonError("Missing filename");

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return jsonError("Invalid session", 401);

    // enforce admin/is_active (same predicate as RLS)
    const { data: prof, error: profErr } = await supabase
      .from("user_profiles")
      .select("role,is_active")
      .eq("id", userData.user.id)
      .maybeSingle();

    if (profErr) return jsonError(profErr.message, 403);
    if (!prof || prof.role !== "admin" || prof.is_active !== true) return jsonError("Forbidden", 403);

    const r2 = new S3Client({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT!,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });

    const key = `hr/employees/${employeeId}/${randomUUID()}-${safeFilename(filename)}`;

    const cmd = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: key,
      ContentType: contentType,
      ContentLength: Number.isFinite(sizeBytes) ? sizeBytes : undefined,
    });

    const uploadUrl = await getSignedUrl(r2, cmd, { expiresIn: 60 });

    return NextResponse.json({ uploadUrl, objectKey: key });
  } catch (e: any) {
    return jsonError(e?.message ?? "Presign failed", 500);
  }
}
