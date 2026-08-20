import { NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MediaScope, authenticate, mediaBucket, mediaKey, r2Client } from "@/lib/r2Media";

export const runtime = "nodejs";

/**
 * Presigned PUT for album photos, chat attachments and sales email assets.
 *
 * Any active staff member may upload — that's deliberate: teachers add to
 * albums and send attachments. Deleting is the restricted action, handled in
 * media-delete.
 *
 * Body: { scope, group?, filename, contentType }
 * Returns: { uploadUrl, objectKey }
 */
export async function POST(req: Request) {
  try {
    const caller = await authenticate(req);
    if (!caller) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const body = await req.json().catch(() => null);
    const scope = body?.scope as MediaScope | undefined;
    const filename = typeof body?.filename === "string" ? body.filename : "";
    const contentType = typeof body?.contentType === "string" ? body.contentType : "";
    const group = typeof body?.group === "string" ? body.group : null;

    if (!scope || !["album", "chat", "email"].includes(scope)) {
      return NextResponse.json({ error: "Unknown scope" }, { status: 400 });
    }
    if (!filename || !contentType) {
      return NextResponse.json({ error: "filename and contentType are required" }, { status: 400 });
    }

    const objectKey = mediaKey(scope, group, filename);
    const uploadUrl = await getSignedUrl(
      r2Client(),
      new PutObjectCommand({ Bucket: mediaBucket(), Key: objectKey, ContentType: contentType }),
      // Long enough for a big video over a slow connection, short enough that a
      // leaked URL isn't useful for long.
      { expiresIn: 900 }
    );

    return NextResponse.json({ uploadUrl, objectKey });
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? "unknown" }, { status: 500 });
  }
}
