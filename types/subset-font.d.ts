declare module "subset-font" {
  /** Subset a font down to the glyphs needed to render `text`. */
  export default function subsetFont(
    source: Buffer,
    text: string,
    options?: {
      targetFormat?: "sfnt" | "woff" | "woff2" | "truetype";
      /** Pin variable-font axes so the result is a plain static font. */
      variationAxes?: Record<string, number>;
    }
  ): Promise<Buffer>;
}
