export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function safeFilename(name: string) {
  const base = (name || "file").trim();
  // replace path-ish and other risky chars
  return base.replaceAll(/[\\/:*?"<>|]+/g, "_").slice(0, 180) || "file";
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
    const meetingId = (body?.meetingId || "").toString().trim();
    const filename = (body?.filename || "").toString().trim();
    const contentType = (body?.contentType || "application/octet-stream").toString();
    const sizeBytes = Number(body?.sizeBytes || 0);

    if (!meetingId) return jsonError("meetingId is required");
    if (!filename) return jsonError("filename is required");

    const bucket = process.env.R2_BUCKET!;
    if (!bucket) return jsonError("Missing R2_BUCKET env", 500);

    const r2 = getR2Client();
    const uuid = crypto.randomUUID();
    const key = `meetings/${meetingId}/${uuid}-${safeFilename(filename)}`;

    // 5 minutes
    const uploadUrl = await getSignedUrl(
      r2,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType || "application/octet-stream",
        // You can add Metadata if you want.
      }),
      { expiresIn: 60 * 5 }
    );

    return NextResponse.json({ uploadUrl, objectKey: key, sizeBytes }, { status: 200 });
  } catch (e: any) {
    return jsonError(e?.message ?? "presign-meeting failed", 400);
  }
}
