import { NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { authenticate, isAllowedKey, mediaBucket, r2Client } from "@/lib/r2Media";

export const runtime = "nodejs";

/** An album grid asks for every key at once, so this is deliberately batched. */
const MAX_KEYS = 500;

/**
 * Presigned GETs for media keys.
 *
 * Body: { keys: string[], expiresIn? }
 * Returns: { urls: { [key]: string } } — keys that can't be signed are simply
 * absent, which is what the clients already expect.
 */
export async function POST(req: Request) {
  try {
    const caller = await authenticate(req);
    if (!caller) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const body = await req.json().catch(() => null);
    const raw = Array.isArray(body?.keys) ? body.keys : [];
    const keys = raw
      .filter((k: unknown): k is string => typeof k === "string" && isAllowedKey(k))
      .slice(0, MAX_KEYS);

    if (keys.length === 0) return NextResponse.json({ urls: {} });

    // Signing is local (an HMAC), so this makes no network calls per key.
    const expiresIn = Math.min(Math.max(Number(body?.expiresIn) || 3600, 60), 24 * 3600);
    const s3 = r2Client();
    const bucket = mediaBucket();

    const entries = await Promise.all(
      keys.map(async (key: string) => {
        try {
          const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
          return [key, url] as const;
        } catch {
          return null;
        }
      })
    );

    const urls: Record<string, string> = {};
    for (const e of entries) if (e) urls[e[0]] = e[1];
    return NextResponse.json({ urls });
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? "unknown" }, { status: 500 });
  }
}
