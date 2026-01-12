export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !service) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, service, { auth: { persistSession: false } });
}

function getSupabaseAnonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  if (!url || !anon) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return createClient(url, anon, { auth: { persistSession: false } });
}

function getR2Client() {
  const endpoint = process.env.R2_ENDPOINT!;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID!;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY!;
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error("Missing R2 env vars");
  return new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function assertAdminFromBearer(token: string) {
  const supabaseAnon = getSupabaseAnonClient();
  const supabaseAdmin = getSupabaseAdminClient();

  const { data: userRes, error: userErr } = await supabaseAnon.auth.getUser(token);
  if (userErr || !userRes?.user?.id) throw new Error("Invalid session token");

  const userId = userRes.user.id;

  const { data: profile, error: profErr } = await supabaseAdmin
    .from("user_profiles")
    .select("id, role, is_active")
    .eq("id", userId)
    .maybeSingle();

  if (profErr || !profile) throw new Error("Profile not found");
  if (!profile.is_active || profile.role !== "admin") throw new Error("Admin access required");

  return { userId };
}

export async function POST(req: Request) {
  try {
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    if (!token) return jsonError("Missing Bearer token", 401);

    await assertAdminFromBearer(token);

    const body = await req.json().catch(() => null);
    const documentId = (body?.documentId || "").toString().trim();
    if (!documentId) return jsonError("documentId is required");

    const supabaseAdmin = getSupabaseAdminClient();
    const { data: doc, error } = await supabaseAdmin
      .from("hr_meeting_documents")
      .select("id, object_key")
      .eq("id", documentId)
      .maybeSingle();

    if (error || !doc) return jsonError("Document not found", 404);

    const bucket = process.env.R2_BUCKET!;
    if (!bucket) return jsonError("Missing R2_BUCKET env", 500);

    const r2 = getR2Client();
    await r2.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: doc.object_key,
      })
    );

    const { error: delErr } = await supabaseAdmin.from("hr_meeting_documents").delete().eq("id", documentId);
    if (delErr) throw delErr;

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: any) {
    return jsonError(e?.message ?? "delete-meeting failed", 400);
  }
}
