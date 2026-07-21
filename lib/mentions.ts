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
  | { type: "mention"; userId: string };

/** A mention the user picked while composing: the visible label + who it is. */
export type DraftMention = { text: string; userId: string };

const MENTION_RE = /<@([0-9a-fA-F-]{36})>/g;

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
    out.push({ type: "mention", userId: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
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
    .map((s) => (s.type === "text" ? s.text : `@${nameFor(s.userId) ?? "someone"}`))
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
      const label = mentionLabel(nameFor(s.userId) ?? "someone");
      mentions.push({ text: label, userId: s.userId });
      return label;
    })
    .join("");
  return { draft, mentions };
}
