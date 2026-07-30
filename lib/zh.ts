/**
 * Traditional → Simplified Chinese conversion.
 *
 * This is script conversion, not translation: 歡迎 → 欢迎 is a deterministic
 * character mapping, so it needs no API, costs nothing, and gives the same
 * answer every time. OpenCC handles the cases a naive character table gets
 * wrong — 頭髮 → 头发 but 發財 → 发财, 乾淨 → 干净 but 乾坤 → 乾坤.
 *
 * Mode is `tw → cn` — Taiwan-standard Traditional to Mainland Simplified, which
 * is what these courses are actually written in. It resolves the 著/着 split the
 * way a Simplified reader expects (坐著 → 坐着, 睡著 → 睡着, 著急 → 着急) while
 * leaving 顯著 → 显著 and 著作權 → 著作权 alone; the plainer `t → cn` mode leaves
 * every one of those as 著. It does not swap regional vocabulary — 軟體 stays
 * 软体 rather than becoming 软件 — so nothing is silently reworded.
 */

type Convert = (s: string) => string;

let cached: Promise<Convert> | null = null;

/** The dictionaries are ~1 MB, so they're only fetched when a sync actually runs. */
async function converter(): Promise<Convert> {
  if (!cached) {
    cached = import("opencc-js").then((OpenCC) =>
      OpenCC.Converter({ from: "tw", to: "cn" })
    );
  }
  return cached;
}

/**
 * Their segments are named like "SCHOOL POLICIES (繁)" — the marker means
 * "Traditional". 繁 is the same character in both scripts, so a straight
 * conversion would leave the Simplified copy claiming to be Traditional.
 */
function retagScript(s: string): string {
  return s
    .replace(/（繁(體|体)?）/g, "（简）")
    .replace(/\((繁(體|体)?)\)/g, "(简)");
}

export async function toSimplified(text: string | null | undefined): Promise<string> {
  const raw = text ?? "";
  if (!raw) return "";
  const conv = await converter();
  return retagScript(conv(raw));
}

/**
 * Converts the visible text of an HTML fragment, leaving the markup alone.
 *
 * Parsing rather than running the converter over the raw string matters: the
 * string form would also rewrite characters inside href/src values, quietly
 * breaking every link and image in a course.
 */
export async function htmlToSimplified(html: string | null | undefined): Promise<string> {
  const raw = html ?? "";
  if (!raw.trim()) return raw ?? "";
  const conv = await converter();

  // No DOM (SSR, a worker, or the one-off first-pass script): convert every
  // run that isn't a tag. Attribute values only ever live inside a `<...>`
  // chunk, so they're still safe, and unlike a ">text<" match this also covers
  // content with no surrounding tags at all.
  if (typeof DOMParser === "undefined") {
    return raw.replace(/<[^>]*>|[^<]+/g, (chunk) =>
      chunk.startsWith("<") ? chunk : retagScript(conv(chunk))
    );
  }

  const doc = new DOMParser().parseFromString(`<div id="__root">${raw}</div>`, "text/html");
  const root = doc.getElementById("__root");
  if (!root) return raw;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const t of texts) {
    if (t.nodeValue) t.nodeValue = retagScript(conv(t.nodeValue));
  }
  return root.innerHTML;
}

/**
 * Keys inside a course object's `content` / `settings` JSON that hold text a
 * learner reads. Anything not listed here is copied across untouched, which is
 * what keeps `url`, `src` and generated ids intact.
 */
const TEXT_KEYS = new Set(["caption", "name", "prompt", "text", "label", "confirmLabel", "title"]);
const HTML_KEYS = new Set(["html"]);

/** Recursively converts the readable strings in a content/settings blob. */
export async function jsonToSimplified<T>(value: T): Promise<T> {
  if (Array.isArray(value)) {
    return (await Promise.all(value.map((v) => jsonToSimplified(v)))) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && HTML_KEYS.has(k)) out[k] = await htmlToSimplified(v);
      else if (typeof v === "string" && TEXT_KEYS.has(k)) out[k] = await toSimplified(v);
      else out[k] = await jsonToSimplified(v);
    }
    return out as unknown as T;
  }
  return value;
}
