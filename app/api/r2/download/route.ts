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

function safeFilename(name: string) {
  return String(name || "file")
    .replaceAll('"', "")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ")
    .slice(0, 180);
}

function contentTypeFallback(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "application/octet-stream";
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

    const body = await req.json().catch(() => null);
    const fileId = body?.fileId;
    const mode: "inline" | "attachment" = body?.mode === "inline" ? "inline" : "attachment";

    if (!fileId) return NextResponse.json({ error: "fileId required" }, { status: 400 });

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) {
      return NextResponse.json({ error: "Invalid session" }, { status: 401 });
    }

    // ✅ enforce "teachers cannot download"
    const { data: prof, error: profErr } = await supabase
      .from("user_profiles")
      .select("role, is_active")
      .eq("id", userData.user.id)
      .single();

    if (profErr || !prof?.is_active) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    const isAdminOrSupervisor = prof.role === "admin" || prof.role === "supervisor";
    if (!isAdminOrSupervisor && mode === "attachment") {
      return NextResponse.json(
        { error: "Downloads are disabled for teacher accounts. Ask a supervisor." },
        { status: 403 }
      );
    }

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

    const filename = safeFilename((fileRow as any).original_name ?? (fileRow as any).name ?? "file");
    const contentType = (fileRow as any).mime_type ?? contentTypeFallback(filename);

    const cmd = new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ResponseContentDisposition: `${mode}; filename="${filename}"`,
      ResponseContentType: contentType,
    });

    const url = await getSignedUrl(s3, cmd, { expiresIn: 60 * 5 });
    return NextResponse.json({ url });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "unknown" }, { status: 500 });
  }
}
