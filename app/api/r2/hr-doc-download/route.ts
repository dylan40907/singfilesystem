import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function jsonError(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export const runtime = "nodejs";

// Signs a short-lived GET URL for a single hr_document_records file. Access is
// enforced by RLS: the user-token client only returns the record if the caller
// is allowed to see that employee's documents (admin or matching campus admin).
export async function POST(req: Request) {
  try {
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return jsonError("Missing bearer token", 401);

    const body = await req.json();
    const recordId = String(body?.recordId || "");
    const mode = (body?.mode === "inline" ? "inline" : "attachment") as "inline" | "attachment";
    if (!recordId) return jsonError("Missing recordId");

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return jsonError("Invalid session", 401);

    const { data: rec, error: recErr } = await supabase
      .from("hr_document_records")
      .select("id, object_key, file_name, mime_type, employee_id, doc_type_id")
      .eq("id", recordId)
      .maybeSingle();

    if (recErr) return jsonError(recErr.message, 403);
    if (!rec || !rec.object_key) return jsonError("Not found", 404);

    // Append-only audit trail (who downloaded which employee's sensitive doc).
    try {
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
      const ua = req.headers.get("user-agent") || null;
      await supabase.rpc("log_document_audit", {
        p_action: "download",
        p_record_id: rec.id,
        p_employee_id: (rec as any).employee_id,
        p_doc_type_id: (rec as any).doc_type_id,
        p_file_name: rec.file_name,
        p_detail: { ip, user_agent: ua, mode },
      });
    } catch { /* logging must never block a legitimate download */ }

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
      Key: rec.object_key,
      ResponseContentType: rec.mime_type || "application/octet-stream",
      ResponseContentDisposition: `${mode}; filename="${String(rec.file_name || "download").replace(/"/g, "")}"`,
    });

    const url = await getSignedUrl(r2, cmd, { expiresIn: 120 });
    return NextResponse.json({ url });
  } catch (e: any) {
    return jsonError(e?.message ?? "Download failed", 500);
  }
}
