export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import archiver from "archiver";
import { PassThrough, Readable } from "stream";

type ZipBody = {
  zipName: string;
  files: { url: string; path: string }[];
};

/**
 * Only our own storage is fetchable.
 *
 * This route fetches every URL the caller supplies and streams the result back,
 * which without a restriction is a server-side request forgery primitive: it
 * would happily fetch cloud metadata endpoints, anything on the private
 * network, or act as an open proxy. Callers legitimately pass signed Supabase
 * Storage or R2 links, so allow exactly those hosts.
 */
function isAllowedSource(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;

  const allowed = [
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_URL,
    process.env.R2_ENDPOINT,
    process.env.R2_PUBLIC_BASE_URL,
  ]
    .filter(Boolean)
    .map((v) => {
      try { return new URL(v as string).host; } catch { return null; }
    })
    .filter(Boolean) as string[];

  return allowed.includes(u.host);
}

export async function POST(req: Request) {
  try {
    // The old check only asserted the header *started with* "bearer", so
    // `Authorization: Bearer x` sailed through. Verify the token for real.
    const auth = req.headers.get("authorization") || "";
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!token) {
      return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      return NextResponse.json({ error: "Server not configured" }, { status: 500 });
    }
    const { data: userData, error: userErr } = await createClient(supabaseUrl, anonKey).auth.getUser(token);
    if (userErr || !userData?.user) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const body = (await req.json()) as ZipBody;
    const zipName = (body?.zipName || "folder").replaceAll(/[\\/:*?"<>|]+/g, "_");
    const files = Array.isArray(body?.files) ? body.files : [];

    if (files.length === 0) {
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    const archive = archiver("zip", { zlib: { level: 9 } });
    const passthrough = new PassThrough();
    archive.pipe(passthrough);

    // Pull each signed URL and append into zip
    for (const f of files) {
      const url = f.url;
      // Strip any leading slashes and any ../ so a crafted name can't write
      // outside the archive root when the zip is extracted.
      const path = (f.path || "file").replace(/^\/+/, "").replace(/\.\.[\\/]/g, "");
      if (!url || !path) continue;

      if (!isAllowedSource(url)) {
        archive.append(`Refused: not an allowed source\n`, { name: `${path}.error.txt` });
        continue;
      }

      const res = await fetch(url);
      if (!res.ok || !res.body) {
        // Put a marker file in the zip instead of failing the whole zip
        archive.append(`Failed to fetch (${res.status})\n${url}\n`, { name: `${path}.error.txt` });
        continue;
      }

      // Convert Web stream -> Node stream for archiver
      const nodeStream = Readable.fromWeb(res.body as any);
      archive.append(nodeStream, { name: path });
    }

    archive.finalize();

    const webStream = Readable.toWeb(passthrough as any);

    return new Response(webStream as any, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipName}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "zip failed" }, { status: 500 });
  }
}
