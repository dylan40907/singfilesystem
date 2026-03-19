import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const runtime = "nodejs";

type PermissionAccess = "view" | "download" | "manage";

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

function accessRank(access: PermissionAccess) {
  if (access === "manage") return 3;
  if (access === "download") return 2;
  return 1;
}

function accessAllowsDownload(access: PermissionAccess | null | undefined) {
  return !!access && accessRank(access) >= accessRank("download");
}

async function hasDirectFileDownloadAccess(supabase: any, userId: string, fileId: string) {
  const { data, error } = await supabase
    .from("permissions")
    .select("access")
    .eq("principal_user_id", userId)
    .eq("resource_type", "file")
    .eq("resource_id", fileId);

  if (error) throw error;
  return (data ?? []).some((row: any) => accessAllowsDownload((row?.access ?? "view") as PermissionAccess));
}

async function hasFolderDownloadAccess(
  supabase: any,
  userId: string,
  startingFolderId: string | null | undefined
) {
  let cursorId = startingFolderId ?? null;
  let isDirectFolder = true;

  while (cursorId) {
    const { data: permRows, error: permErr } = await supabase
      .from("permissions")
      .select("access, inherit")
      .eq("principal_user_id", userId)
      .eq("resource_type", "folder")
      .eq("resource_id", cursorId);

    if (permErr) throw permErr;

    const allowsHere = (permRows ?? []).some((row: any) => {
      const access = (row?.access ?? "view") as PermissionAccess;
      const inherit = !!row?.inherit;
      if (!accessAllowsDownload(access)) return false;
      return isDirectFolder ? true : inherit;
    });

    if (allowsHere) return true;

    const { data: folderRow, error: folderErr } = await supabase
      .from("folders")
      .select("parent_id")
      .eq("id", cursorId)
      .single();

    if (folderErr) throw folderErr;

    cursorId = (folderRow as any)?.parent_id ?? null;
    isDirectFolder = false;
  }

  return false;
}

export async function POST(req: Request) {
  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SUPABASE_ANON_KEY = requireEnv("SUPABASE_ANON_KEY");
    const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

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

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData.user) {
      return NextResponse.json({ error: "Invalid session" }, { status: 401 });
    }

    const { data: prof, error: profErr } = await adminClient
      .from("user_profiles")
      .select("role, is_active")
      .eq("id", userData.user.id)
      .single();

    if (profErr || !prof?.is_active) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    const isAdminOrSupervisor = prof.role === "admin" || prof.role === "supervisor";

    const { data: fileRow, error: fileErr } = await adminClient
      .from("files")
      .select("id, folder_id, name, original_name, storage_key, object_key, mime_type")
      .eq("id", fileId)
      .maybeSingle();

    if (fileErr || !fileRow) {
      return NextResponse.json({ error: fileErr?.message ?? "File not found" }, { status: 404 });
    }

    if (!isAdminOrSupervisor && mode === "attachment") {
      const [hasDirectFileGrant, hasFolderGrant] = await Promise.all([
        hasDirectFileDownloadAccess(adminClient, userData.user.id, fileId),
        hasFolderDownloadAccess(adminClient, userData.user.id, (fileRow as any).folder_id ?? null),
      ]);

      if (!hasDirectFileGrant && !hasFolderGrant) {
        return NextResponse.json(
          { error: "Downloads are not enabled for this file." },
          { status: 403 }
        );
      }
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
