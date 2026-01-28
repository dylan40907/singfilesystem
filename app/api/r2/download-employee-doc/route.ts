import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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
    const documentId = String(body?.documentId || "");
    const mode = (body?.mode === "inline" ? "inline" : "attachment") as "inline" | "attachment";
    if (!documentId) return jsonError("Missing documentId");

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return jsonError("Invalid session", 401);

    const { data: prof, error: profErr } = await supabase
      .from("user_profiles")
      .select("role,is_active")
      .eq("id", userData.user.id)
      .maybeSingle();

    if (profErr) return jsonError(profErr.message, 403);
    if (!prof || prof.role !== "admin" || prof.is_active !== true) return jsonError("Forbidden", 403);

    const { data: doc, error: docErr } = await supabase
      .from("hr_employee_documents")
      .select("id,name,object_key,mime_type")
      .eq("id", documentId)
      .single();

    if (docErr) return jsonError(docErr.message, 404);

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
      Key: doc.object_key,
      ResponseContentType: doc.mime_type || "application/octet-stream",
      ResponseContentDisposition: `${mode}; filename="${String(doc.name || "download").replace(/"/g, "")}"`,
    });

    const url = await getSignedUrl(r2, cmd, { expiresIn: 300 });
    return NextResponse.json({ url });
  } catch (e: any) {
    return jsonError(e?.message ?? "Download failed", 500);
  }
}
