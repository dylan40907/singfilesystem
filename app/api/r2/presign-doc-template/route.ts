import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

function safeFilename(name: string) {
  return (name || "form").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 140);
}
function jsonError(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export const runtime = "nodejs";

// Presigns an upload for a document TYPE's blank/template form. Full HR admins
// only (templates are global, not per-employee). Object lives under
// hr/doc-templates/{docTypeId}/… ("new" before the type exists).
export async function POST(req: Request) {
  try {
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return jsonError("Missing bearer token", 401);

    const body = await req.json();
    const docTypeId = String(body?.docTypeId || "new");
    const filename = String(body?.filename || "");
    const contentType = String(body?.contentType || "application/octet-stream");
    const sizeBytes = Number(body?.sizeBytes || 0);
    if (!filename) return jsonError("Missing filename");

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return jsonError("Invalid session", 401);

    const { data: isAdmin, error: adminErr } = await supabase.rpc("is_hr_admin");
    if (adminErr) return jsonError(adminErr.message, 403);
    if (isAdmin !== true) return jsonError("Forbidden", 403);

    const r2 = new S3Client({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT!,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });

    const key = `hr/doc-templates/${docTypeId}/${randomUUID()}-${safeFilename(filename)}`;
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
