import { NextRequest, NextResponse } from "next/server";
import subsetFont from "subset-font";

/**
 * Serves a *subsetted* CJK font for the schedule PDF.
 *
 * jsPDF can only embed TrueType, and its built-in Helvetica is WinAnsi-only, so
 * Chinese comes out as mojibake. Noto Sans SC is a 17 MB variable font — far too
 * big to embed — but subsetting it to just the characters a given schedule uses
 * yields ~20-40 KB, which is fine to inline in the PDF.
 *
 * The variable weight axis is pinned so the result is a plain static TTF, which
 * is what jsPDF's parser expects.
 */

const FONT_URL =
  "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf";

// Cache the (large) source font in module memory so only the first request on a
// warm server pays the download cost.
let sourcePromise: Promise<Buffer> | null = null;
function loadSource(): Promise<Buffer> {
  if (!sourcePromise) {
    sourcePromise = fetch(FONT_URL)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Font fetch failed (${res.status})`);
        return Buffer.from(await res.arrayBuffer());
      })
      .catch((e) => {
        sourcePromise = null; // let the next request retry
        throw e;
      });
  }
  return sourcePromise;
}

export async function POST(req: NextRequest) {
  try {
    const { text } = (await req.json()) as { text?: string };
    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "text required" }, { status: 400 });
    }

    // Deduplicate to keep the subset (and the harfbuzz work) minimal.
    const chars = Array.from(new Set(text.split(""))).join("");
    const source = await loadSource();

    const [regular, bold] = await Promise.all([
      subsetFont(source, chars, { targetFormat: "truetype", variationAxes: { wght: 400 } }),
      subsetFont(source, chars, { targetFormat: "truetype", variationAxes: { wght: 700 } }),
    ]);

    return NextResponse.json({
      regular: regular.toString("base64"),
      bold: bold.toString("base64"),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Font subset failed" }, { status: 500 });
  }
}
