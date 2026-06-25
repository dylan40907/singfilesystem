import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function jsonError(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export const runtime = "nodejs";

// Signs a short-lived GET URL for a document TYPE's blank/template file (the
// form employees download to fill out). Any active staff member can read type
// definitions (RLS), so we just confirm the caller's session, then sign.
export async function POST(req: Request) {
  try {
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return jsonError("Missing bearer token", 401);

    const body = await req.json();
    const docTypeId = String(body?.docTypeId || "");
    const mode = (body?.mode === "attachment" ? "attachment" : "inline") as "inline" | "attachment";
    if (!docTypeId) return jsonError("Missing docTypeId");

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return jsonError("Invalid session", 401);

    const { data: type, error: typeErr } = await supabase
      .from("hr_document_types")
      .select("id, template_object_key, template_file_name, template_mime_type")
      .eq("id", docTypeId)
      .maybeSingle();

    if (typeErr) return jsonError(typeErr.message, 403);
    if (!type || !type.template_object_key) return jsonError("No template on file", 404);

    const r2 = new S3Client({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT!,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });

    const cmd = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: type.template_object_key,
      ResponseContentType: type.template_mime_type || "application/octet-stream",
      ResponseContentDisposition: `${mode}; filename="${String(type.template_file_name || "form").replace(/"/g, "")}"`,
    });

    const url = await getSignedUrl(r2, cmd, { expiresIn: 120 });
    return NextResponse.json({ url });
  } catch (e: any) {
    return jsonError(e?.message ?? "Template download failed", 500);
  }
}
