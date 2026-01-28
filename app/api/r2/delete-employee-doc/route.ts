import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

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
    if (!documentId) return jsonError("Missing documentId");

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return jsonError("Invalid session", 401);

    const { data: prof, error: profErr } = await supabase
      .from("user_profiles")
      .select("role,is_active")
      .eq("id", userData.user.id)
      .maybeSingle();

    if (profErr) return jsonError(profErr.message, 403);
    if (!prof || prof.role !== "admin" || prof.is_active !== true) return jsonError("Forbidden", 403);

    // fetch doc row (RLS will enforce access too)
    const { data: doc, error: docErr } = await supabase
      .from("hr_employee_documents")
      .select("id,object_key")
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

    // delete object first (best effort), then delete db row
    await r2.send(
      new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET!,
        Key: doc.object_key,
      })
    );

    const { error: delErr } = await supabase.from("hr_employee_documents").delete().eq("id", documentId);
    if (delErr) return jsonError(delErr.message, 500);

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return jsonError(e?.message ?? "Delete failed", 500);
  }
}
