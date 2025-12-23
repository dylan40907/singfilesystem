export const runtime = "nodejs";

import { NextResponse } from "next/server";
import archiver from "archiver";
import { PassThrough, Readable } from "stream";

type ZipBody = {
  zipName: string;
  files: { url: string; path: string }[];
};

export async function POST(req: Request) {
  try {
    // Basic auth presence check (you can strengthen later)
    const auth = req.headers.get("authorization") || "";
    if (!auth.toLowerCase().startsWith("bearer ")) {
      return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });
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
      const path = (f.path || "file").replace(/^\/+/, "");
      if (!url || !path) continue;

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
