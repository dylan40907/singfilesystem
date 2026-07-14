import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Public serving endpoint for course media stored in Cloudflare R2.
// The R2 bucket is private, so we mint a short-lived signed GET URL and 302 to
// it. This keeps a stable, permanent app URL in course_objects.content.url
// (works for <video>/<img>/pdf and follows range requests for streaming), while
// the actual bytes are served straight from R2 (free egress).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error("Missing env var: " + name);
  return v;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ seg: string[] }> }) {
  try {
    const { seg } = await params;
    const key = "course-media/" + seg.map((s) => decodeURIComponent(s)).join("/");
    const s3 = new S3Client({
      region: "auto",
      endpoint: env("R2_ENDPOINT"),
      credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") },
    });
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: env("R2_BUCKET"), Key: key }), { expiresIn: 60 * 60 * 24 });
    return new NextResponse(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "unknown" }, { status: 500 });
  }
}
