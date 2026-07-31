/**
 * Glyph plumbing shared by the PDF exports.
 *
 * jsPDF can only embed TrueType and its built-in fonts are WinAnsi-only, so
 * both Chinese and emoji need help:
 *
 * - Chinese: fetch a Noto subset containing only the characters this document
 *   uses (~20-40 KB instead of a 17 MB font) and embed that.
 * - Emoji: no CJK font carries colour emoji, so each cluster is rasterised to a
 *   PNG through the system emoji font and placed as a tiny inline image.
 *
 * (lib/schedulePdf.ts predates this module and still has its own copies; it
 * works, so it's been left alone rather than refactored blind.)
 */

export const EMOJI_CHAR_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE00}-\u{FE0F}\u{20E3}]/u;

const CJK_RE = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;

export type RichSeg = { emoji: boolean; text: string };

let segmenter: Intl.Segmenter | null | undefined;
function graphemeSegmenter(): Intl.Segmenter | undefined {
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
    } catch { segmenter = null; }
  }
  return segmenter ?? undefined;
}

/** Grapheme clusters, so ZWJ sequences and skin tones stay whole. */
export function toClusters(text: string): string[] {
  const seg = graphemeSegmenter();
  if (seg) return Array.from(seg.segment(text), (s) => s.segment);
  return Array.from(text);
}

const segmentCache = new Map<string, RichSeg[]>();

/** Emoji clusters stay separate (one image each); plain text runs coalesce. */
export function segmentRich(text: string): RichSeg[] {
  const key = text ?? "";
  const hit = segmentCache.get(key);
  if (hit) return hit;
  const out: RichSeg[] = [];
  for (const c of toClusters(key)) {
    const emoji = EMOJI_CHAR_RE.test(c);
    const last = out[out.length - 1];
    if (!emoji && last && !last.emoji) last.text += c;
    else out.push({ emoji, text: c });
  }
  segmentCache.set(key, out);
  return out;
}

const emojiPngCache = new Map<string, string | null>();

/** Rasterise one emoji cluster, or null when this machine can't draw it. */
export function emojiPng(cluster: string): string | null {
  if (emojiPngCache.has(cluster)) return emojiPngCache.get(cluster)!;
  let url: string | null = null;
  try {
    if (typeof document !== "undefined") {
      const S = 128; // well above on-page size so it stays crisp when zoomed
      const canvas = document.createElement("canvas");
      canvas.width = S;
      canvas.height = S;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.font = `${Math.round(S * 0.78)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif`;
        ctx.fillText(cluster, S / 2, S * 0.82);
        const { data } = ctx.getImageData(0, 0, S, S);
        let painted = false;
        for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) { painted = true; break; }
        if (painted) url = canvas.toDataURL("image/png");
      }
    }
  } catch { url = null; }
  emojiPngCache.set(cluster, url);
  return url;
}

/** Stable ASCII key for a cluster, e.g. "emoji-1f469-200d-1f373". */
export function emojiAlias(cluster: string): string {
  return "emoji-" + Array.from(cluster).map((c) => c.codePointAt(0)!.toString(16)).join("-");
}

/**
 * Embed a Chinese-capable font covering `text`, returning the family name to
 * use (or null to stay on Helvetica when there's no CJK in the document).
 *
 * `script` picks the source face: Traditional courses need Noto Sans TC, since
 * the SC face is missing a number of Traditional-only glyphs and they'd come
 * out blank.
 */
export async function ensureCjkFont(
  doc: { addFileToVFS: (n: string, d: string) => void; addFont: (f: string, n: string, s: string) => void },
  text: string,
  script: "sc" | "tc" = "sc"
): Promise<string | null> {
  if (!CJK_RE.test(text)) return null;
  try {
    const res = await fetch("/api/schedule-font", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, script }),
    });
    if (!res.ok) return null;
    const { regular, bold } = (await res.json()) as { regular: string; bold: string };
    const fam = `NotoCJK${script.toUpperCase()}`;
    doc.addFileToVFS(`${fam}-Regular.ttf`, regular);
    doc.addFont(`${fam}-Regular.ttf`, fam, "normal");
    doc.addFileToVFS(`${fam}-Bold.ttf`, bold);
    doc.addFont(`${fam}-Bold.ttf`, fam, "bold");
    return fam;
  } catch {
    return null; // fall back rather than failing the whole export
  }
}
