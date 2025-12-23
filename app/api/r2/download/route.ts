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

export async function POST(req: Request) {
  try {
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

    const { fileId } = await req.json();
    if (!fileId) return NextResponse.json({ error: "fileId required" }, { status: 400 });

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) {
      return NextResponse.json({ error: "Invalid session" }, { status: 401 });
    }

    // Pull storage_key (primary) with fallback to object_key
    const { data: fileRow, error: fileErr } = await supabase
      .from("files")
      .select("id, name, original_name, storage_key, object_key, mime_type")
      .eq("id", fileId)
      .single();

    if (fileErr || !fileRow) {
      return NextResponse.json({ error: fileErr?.message ?? "File not accessible" }, { status: 403 });
    }

    const key = (fileRow as any).storage_key ?? (fileRow as any).object_key;
    if (!key) return NextResponse.json({ error: "File missing storage key" }, { status: 500 });

    const filename = (fileRow as any).original_name ?? (fileRow as any).name ?? "download";

    const cmd = new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
      ResponseContentType: (fileRow as any).mime_type ?? "application/octet-stream",
    });

    const url = await getSignedUrl(s3, cmd, { expiresIn: 60 });
    return NextResponse.json({ url });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "unknown" }, { status: 500 });
  }
}
