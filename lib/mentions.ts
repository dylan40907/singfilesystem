/**
 * @-mentions in chat messages.
 *
 * Mentions are stored in the message body as `<@user-uuid>` tokens rather than
 * plain "@Name" text. That keeps them unambiguous when two people share a name,
 * survives someone changing their display name, and means a user can't fake a
 * mention just by typing it.
 */

export type MentionSegment =
  | { type: "text"; text: string }
  | { type: "mention"; userId: string };

const MENTION_RE = /<@([0-9a-fA-F-]{36})>/g;

export function mentionToken(userId: string): string {
  return `<@${userId}>`;
}

/** Split a message body into plain-text and mention segments, in order. */
export function parseMentions(content: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  const text = content ?? "";
  let last = 0;
  // Fresh regex state per call (MENTION_RE is global).
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    out.push({ type: "mention", userId: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

/** Every user id mentioned in a message. */
export function mentionedIds(content: string): string[] {
  return parseMentions(content)
    .filter((s): s is { type: "mention"; userId: string } => s.type === "mention")
    .map((s) => s.userId);
}

/** Render a body as plain text (tokens → "@Name"), for previews/notifications. */
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
  // Don't re-trigger inside an already-completed token.
  if (query.includes(">")) return null;
  return { query, start: at };
}

/** Replace the in-progress "@query" with a real mention token. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  userId: string
): { next: string; caret: number } {
  const token = mentionToken(userId) + " ";
  const next = text.slice(0, start) + token + text.slice(caret);
  return { next, caret: start + token.length };
}
