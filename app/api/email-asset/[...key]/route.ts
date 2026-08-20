import { GetObjectCommand } from "@aws-sdk/client-s3";
import { mediaBucket, r2Client } from "@/lib/r2Media";

export const runtime = "nodejs";

/**
 * Public, permanent URLs for images embedded in sales emails.
 *
 * Everything else in R2 is served through short-lived presigned links, but that
 * doesn't work here: an email sits in someone's inbox for months, and a
 * presigned URL would expire and leave broken images in a message we already
 * sent. So these are proxied through a stable path instead.
 *
 * Deliberately unauthenticated — the recipient is a parent with no account, and
 * their mail client fetches the image with no session. These are marketing
 * assets (logos, brochures, tuition sheets) that are meant to be public.
 *
 * Scope is the point of the guard below: only the sales-email prefix is
 * reachable. Without it this route would serve any object in the bucket,
 * including every album photo and chat attachment.
 */
const ALLOWED_PREFIX = "sales-email/";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ key: string[] }> }
) {
  const { key: segments } = await ctx.params;
  const key = (segments ?? []).join("/");

  if (!key || key.includes("..") || !key.startsWith(ALLOWED_PREFIX)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const obj = await r2Client().send(
      new GetObjectCommand({ Bucket: mediaBucket(), Key: key })
    );
    if (!obj.Body) return new Response("Not found", { status: 404 });

    return new Response(obj.Body.transformToWebStream(), {
      headers: {
        "Content-Type": obj.ContentType ?? "application/octet-stream",
        ...(obj.ContentLength ? { "Content-Length": String(obj.ContentLength) } : {}),
        // The key contains a uuid and content never changes under it, so this
        // can be cached hard — mail clients and their proxies refetch often.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
