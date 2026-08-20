import { NextResponse } from "next/server";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { authenticate, canDeleteMedia, isAllowedKey, mediaBucket, r2Client } from "@/lib/r2Media";

export const runtime = "nodejs";

/**
 * Delete media objects.
 *
 * Restricted to supervisors and up, matching can_manage_albums() in the
 * database — the row is removed under RLS, and this removes the file, so both
 * halves must agree on who is allowed.
 *
 * Body: { keys: string[] }
 */
export async function POST(req: Request) {
  try {
    const caller = await authenticate(req);
    if (!caller) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    if (!canDeleteMedia(caller)) {
      return NextResponse.json({ error: "Not allowed to delete files" }, { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const keys = (Array.isArray(body?.keys) ? body.keys : [])
      .filter((k: unknown): k is string => typeof k === "string" && isAllowedKey(k))
      .slice(0, 1000);

    if (keys.length === 0) return NextResponse.json({ deleted: 0 });

    await r2Client().send(
      new DeleteObjectsCommand({
        Bucket: mediaBucket(),
        Delete: { Objects: keys.map((Key: string) => ({ Key })), Quiet: true },
      })
    );

    return NextResponse.json({ deleted: keys.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? "unknown" }, { status: 500 });
  }
}
