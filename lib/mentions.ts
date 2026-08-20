/**
 * @-mentions in chat messages.
 *
 * STORAGE  — a mention is persisted as a `<@user-uuid>` token in the body. That
 *            keeps it unambiguous when two people share a name, survives someone
 *            changing their display name, and can't be faked by typing text.
 *
 * COMPOSING — the composer never shows tokens. While typing you see the plain
 *            "@Brooke Huang" label; the picked mentions are tracked alongside
 *            the draft and swapped back to tokens on send (`draftToStored`).
 *            Editing an existing message does the reverse (`storedToDraft`).
 */

export type MentionSegment =
  | { type: "text"; text: string }
  | { type: "mention"; userId: string }
  | { type: "everyone" };

/**
 * What a message bubble renders: mentions plus clickable links. Kept separate
 * from MentionSegment so existing callers that narrow on "not text" and read
 * .userId keep compiling — only the bubble renderers deal with links.
 */
export type RichSegment = MentionSegment | { type: "link"; text: string; url: string };

/** A mention the user picked while composing: the visible label + who it is. */
export type DraftMention = { text: string; userId: string };

/**
 * "@everyone" is stored as `<@everyone>` — deliberately not a uuid, so it can
 * never collide with a person. It doesn't change who is notified (every member
 * already gets a notification for every message); it marks the message as
 * addressed to the whole group so it reads that way.
 */
export const EVERYONE_ID = "everyone";
export const EVERYONE_LABEL = "@everyone";

const MENTION_RE = /<@(everyone|[0-9a-fA-F-]{36})>/g;

export function mentionToken(userId: string): string {
  return `<@${userId}>`;
}

/** Split a stored message body into plain-text and mention segments, in order. */
export function parseMentions(content: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  const text = content ?? "";
  let last = 0;
  MENTION_RE.lastIndex = 0; // global regex — reset per call
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    out.push(m[1] === EVERYONE_ID ? { type: "everyone" } : { type: "mention", userId: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

/** True when the message is addressed to the whole group. */
export function mentionsEveryone(content: string): boolean {
  return parseMentions(content).some((s) => s.type === "everyone");
}

/** Every user id mentioned in a stored message. */
export function mentionedIds(content: string): string[] {
  return parseMentions(content)
    .filter((s): s is { type: "mention"; userId: string } => s.type === "mention")
    .map((s) => s.userId);
}

/** Render a stored body as plain text (tokens → "@Name"), for previews. */
export function mentionsToPlainText(content: string, nameFor: (id: string) => string | null): string {
  return parseMentions(content)
    .map((s) =>
      s.type === "text" ? s.text
        : s.type === "everyone" ? EVERYONE_LABEL
        : `@${nameFor(s.userId) ?? "someone"}`
    )
    .join("");
}

/**
 * If the caret sits inside an in-progress "@query", return it so the composer
 * can show the autocomplete. Returns null when there's no active mention.
 */
export function activeMentionQuery(
  text: string,
  caret: number
): { query: string; start: number } | null {
  const upto = (text ?? "").slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  // Must start a word — otherwise "email@host" would trigger it.
  if (at > 0 && !/\s/.test(upto[at - 1])) return null;
  const query = upto.slice(at + 1);
  // A mention query is a single run of characters; whitespace ends it.
  if (/\s/.test(query)) return null;
  return { query, start: at };
}

/**
 * Replace the in-progress "@query" with the readable label (e.g. "@Brooke
 * Huang"). The label — not a token — is what the user sees while typing.
 */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  label: string
): { next: string; caret: number } {
  const piece = `${label} `;
  const next = text.slice(0, start) + piece + text.slice(caret);
  return { next, caret: start + piece.length };
}

/** Label shown in the composer for a mention of `name`. */
export function mentionLabel(name: string): string {
  return `@${name}`;
}

/**
 * Convert a composed draft into the stored form, swapping each picked label
 * back to its `<@uuid>` token. Longest labels first so "@Ann" can't clobber
 * part of "@Anna Lee". A label the user has since edited simply stays as plain
 * text, which is the behaviour you'd expect.
 */
export function draftToStored(draft: string, mentions: DraftMention[]): string {
  let out = draft ?? "";
  const sorted = [...mentions].sort((a, b) => b.text.length - a.text.length);
  for (const m of sorted) {
    if (!m.text) continue;
    out = out.split(m.text).join(mentionToken(m.userId));
  }
  return out;
}

/** Inverse of `draftToStored`, for loading a message back into the composer. */
export function storedToDraft(
  content: string,
  nameFor: (id: string) => string | null
): { draft: string; mentions: DraftMention[] } {
  const mentions: DraftMention[] = [];
  const draft = parseMentions(content)
    .map((s) => {
      if (s.type === "text") return s.text;
      if (s.type === "everyone") {
        mentions.push({ text: EVERYONE_LABEL, userId: EVERYONE_ID });
        return EVERYONE_LABEL;
      }
      const label = mentionLabel(nameFor(s.userId) ?? "someone");
      mentions.push({ text: label, userId: s.userId });
      return label;
    })
    .join("");
  return { draft, mentions };
}

// ─── Links ───────────────────────────────────────────────────────────────────

/**
 * URLs typed into a message. Deliberately conservative: it stops at whitespace
 * and angle brackets, and drops trailing punctuation so "see example.com/a."
 * doesn't capture the full stop as part of the address. Bare "www." is matched
 * too, since that is how people usually type one.
 */
const URL_RE = /((?:https?:\/\/|www\.)[^\s<>]+)/gi;

/** Trailing characters that are almost always sentence punctuation, not URL. */
function trimUrlTail(raw: string): string {
  let url = raw;
  while (url.length > 1 && /[.,!?;:'"]$/.test(url)) url = url.slice(0, -1);
  // Balance a closing bracket only when it was opened inside the URL.
  while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1);
  }
  return url;
}

/**
 * Mentions *and* links, in order — what a message bubble should render.
 *
 * Built on top of parseMentions so a URL can never swallow a mention token and
 * the two can't disagree about where a segment starts.
 */
export function parseRichBody(content: string): RichSegment[] {
  const out: RichSegment[] = [];
  for (const seg of parseMentions(content)) {
    if (seg.type !== "text") { out.push(seg); continue; }
    let last = 0;
    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(seg.text)) !== null) {
      const shown = trimUrlTail(m[1]);
      if (!shown) continue;
      if (m.index > last) out.push({ type: "text", text: seg.text.slice(last, m.index) });
      out.push({
        type: "link",
        text: shown,
        // Without a scheme the OS and the browser both treat it as relative.
        url: /^https?:\/\//i.test(shown) ? shown : `https://${shown}`,
      });
      last = m.index + shown.length;
    }
    if (last < seg.text.length) out.push({ type: "text", text: seg.text.slice(last) });
  }
  return out;
}
