import { supabase } from "./supabaseClient";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ChatConversation = {
  id: string;
  name: string | null;
  is_group: boolean;
  created_by: string | null;
  created_at: string;
  last_message_at: string;
};

export type ChatMember = {
  conversation_id: string;
  user_id: string;
  joined_at: string;
  last_read_at: string;
  hidden_at: string | null;
};

export type ChatMessage = {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: string;
  attachment_path?: string | null;
  attachment_name?: string | null;
  attachment_type?: string | null;
  attachment_size?: number | null;
  attachment_kind?: "image" | "file" | "video" | null;
  edited_at?: string | null;
  deleted_at?: string | null;
  message_type?: "user" | "system";
};

export type ChatAttachment = {
  attachment_path: string;
  attachment_name: string;
  attachment_type: string | null;
  attachment_size: number | null;
  attachment_kind: "image" | "file";
};

const MSG_COLS =
  "id, conversation_id, sender_id, content, created_at, attachment_path, attachment_name, attachment_type, attachment_size, attachment_kind, edited_at, deleted_at, message_type";

export type ChatUserLite = {
  id: string;
  full_name: string | null;
  username: string | null;
  email: string | null;
};

// Conversation enriched with members + last message preview for the sidebar list.
export type ChatConversationView = ChatConversation & {
  members: ChatUserLite[];
  myLastReadAt: string;
  lastMessage: ChatMessage | null;
  unreadCount: number;
  /** Display name: group name OR the other 1-on-1 member's name */
  displayName: string;
};

// ─── Display helpers ─────────────────────────────────────────────────────────

export function userDisplayName(u: { full_name?: string | null; username?: string | null; email?: string | null; id?: string }): string {
  const name = (u.full_name ?? "").trim();
  if (name) return name;
  const un = (u.username ?? "").trim();
  if (un) return un;
  return u.email ?? u.id ?? "Unknown";
}

export function conversationDisplayName(
  c: ChatConversation,
  members: ChatUserLite[],
  myId: string
): string {
  if (c.is_group) {
    if (c.name && c.name.trim()) return c.name.trim();
    // Fallback for unnamed group: concat names of other members
    const others = members.filter((m) => m.id !== myId).slice(0, 3);
    const names = others.map(userDisplayName);
    return names.length === 0 ? "Group chat" : names.join(", ");
  }
  // 1-on-1: name is the other person
  const other = members.find((m) => m.id !== myId);
  return other ? userDisplayName(other) : "Direct message";
}

// ─── API ─────────────────────────────────────────────────────────────────────

/** Fetch all conversations the current user is in, enriched for sidebar. */
export async function fetchMyConversations(myId: string): Promise<ChatConversationView[]> {
  // Get conversation IDs I'm a member of (with my last_read_at + hidden_at)
  const { data: myMembership, error: memErr } = await supabase
    .from("chat_members")
    .select("conversation_id, last_read_at, hidden_at")
    .eq("user_id", myId);
  if (memErr) throw memErr;
  const ids = (myMembership ?? []).map((m) => m.conversation_id);
  if (ids.length === 0) return [];

  const hiddenAtByConv = new Map<string, string | null>();
  for (const m of myMembership ?? []) {
    hiddenAtByConv.set(m.conversation_id, (m as { hidden_at: string | null }).hidden_at ?? null);
  }

  // Fetch the conversation rows
  const { data: convs, error: convErr } = await supabase
    .from("chat_conversations")
    .select("id, name, is_group, created_by, created_at, last_message_at")
    .in("id", ids)
    .order("last_message_at", { ascending: false });
  if (convErr) throw convErr;

  // Filter out conversations I've hidden, unless new activity arrived after hidden_at
  const visibleConvs = (convs ?? []).filter((c) => {
    const hidden = hiddenAtByConv.get(c.id);
    if (!hidden) return true;
    return new Date(c.last_message_at) > new Date(hidden);
  });

  const visibleIds = visibleConvs.map((c) => c.id);
  if (visibleIds.length === 0) return [];

  // Fetch all members for those conversations (RLS allows because we're a member)
  const { data: allMembers, error: allMemErr } = await supabase
    .from("chat_members")
    .select("conversation_id, user_id")
    .in("conversation_id", visibleIds);
  if (allMemErr) throw allMemErr;

  const memberIds = [...new Set((allMembers ?? []).map((m) => m.user_id))];

  // Fetch user profiles for display
  const { data: profs, error: profErr } = await supabase
    .from("user_profiles")
    .select("id, full_name, username, email")
    .in("id", memberIds);
  if (profErr) throw profErr;
  const profileMap = new Map<string, ChatUserLite>(
    (profs ?? []).map((p) => [p.id as string, p as ChatUserLite])
  );

  // Group members by conversation
  const membersByConv = new Map<string, ChatUserLite[]>();
  for (const m of allMembers ?? []) {
    const arr = membersByConv.get(m.conversation_id) ?? [];
    const p = profileMap.get(m.user_id);
    if (p) arr.push(p);
    membersByConv.set(m.conversation_id, arr);
  }

  // Build my last_read_at lookup
  const myLastReadMap = new Map<string, string>();
  for (const m of myMembership ?? []) {
    myLastReadMap.set(m.conversation_id, m.last_read_at);
  }

  // Fetch the latest message per conversation (one query, then group)
  const { data: recentMsgs, error: msgErr } = await supabase
    .from("chat_messages")
    .select("id, conversation_id, sender_id, content, created_at")
    .in("conversation_id", visibleIds)
    .order("created_at", { ascending: false })
    .limit(500);
  if (msgErr) throw msgErr;

  const lastByConv = new Map<string, ChatMessage>();
  const messagesByConv = new Map<string, ChatMessage[]>();
  for (const m of (recentMsgs ?? []) as ChatMessage[]) {
    if (!lastByConv.has(m.conversation_id)) lastByConv.set(m.conversation_id, m);
    const arr = messagesByConv.get(m.conversation_id) ?? [];
    arr.push(m);
    messagesByConv.set(m.conversation_id, arr);
  }

  return visibleConvs.map((c) => {
    const members = membersByConv.get(c.id) ?? [];
    const myLastRead = myLastReadMap.get(c.id) ?? c.created_at;
    const allMsgs = messagesByConv.get(c.id) ?? [];
    const unread = allMsgs.filter(
      (m) => m.sender_id !== myId && new Date(m.created_at) > new Date(myLastRead)
    ).length;
    return {
      ...(c as ChatConversation),
      members,
      myLastReadAt: myLastRead,
      lastMessage: lastByConv.get(c.id) ?? null,
      unreadCount: unread,
      displayName: conversationDisplayName(c as ChatConversation, members, myId),
    };
  });
}

/** Fetch the full message history for a conversation (newest at the bottom). */
export async function fetchMessages(conversationId: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select(MSG_COLS)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ChatMessage[];
}

/** Send a message (text and/or one attachment). */
export async function sendMessage(
  conversationId: string,
  senderId: string,
  content: string,
  attachment?: ChatAttachment | null
): Promise<ChatMessage> {
  const trimmed = content.trim();
  if (!trimmed && !attachment) throw new Error("Message cannot be empty");
  const { data, error } = await supabase
    .from("chat_messages")
    .insert({
      conversation_id: conversationId,
      sender_id: senderId,
      content: trimmed,
      ...(attachment ?? {}),
    })
    .select(MSG_COLS)
    .single();
  if (error) throw error;
  return data as ChatMessage;
}

/** Upload a browser File to the chat-attachments bucket; returns attachment meta. */
export async function uploadChatAttachment(
  conversationId: string,
  file: File
): Promise<ChatAttachment> {
  const safeName = (file.name || "file").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  const path = `${conversationId}/${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`;
  const { error } = await supabase.storage
    .from("chat-attachments")
    .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
  if (error) throw error;
  return {
    attachment_path: path,
    attachment_name: file.name || safeName,
    attachment_type: file.type || "application/octet-stream",
    attachment_size: file.size ?? null,
    attachment_kind: (file.type || "").startsWith("image/") ? "image" : "file",
  };
}

/** Short-lived signed URL for an attachment. */
export async function getAttachmentUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from("chat-attachments").createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

// ─── Attachment previews ─────────────────────────────────────────────────────

/** What kind of in-app preview an attachment supports. 'none' → download only. */
export type PreviewKind = "image" | "video" | "audio" | "pdf" | "office" | "text" | "none";

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif"];
const VIDEO_EXT = ["mp4", "mov", "m4v", "webm", "avi", "mkv", "3gp"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "aac", "ogg", "oga", "flac"];
const OFFICE_EXT = ["doc", "docx", "xls", "xlsx", "ppt", "pptx"];
const TEXT_EXT = [
  "txt", "md", "markdown", "csv", "tsv", "log", "json", "xml", "yml", "yaml",
  "ts", "tsx", "js", "jsx", "html", "htm", "css", "sql", "sh", "rtf", "ini", "env",
];

function extOf(name: string | null | undefined): string {
  const n = (name ?? "").toLowerCase();
  const dot = n.lastIndexOf(".");
  return dot >= 0 ? n.slice(dot + 1) : "";
}

/** Classify an attachment into a preview kind from its mime type + filename. */
export function previewKindFor(
  attachmentType: string | null | undefined,
  attachmentName: string | null | undefined,
  attachmentKind?: string | null
): PreviewKind {
  if (attachmentKind === "image") return "image";
  if (attachmentKind === "video") return "video";

  const mime = (attachmentType ?? "").toLowerCase();
  const ext = extOf(attachmentName);

  if (mime.startsWith("image/") || IMAGE_EXT.includes(ext)) return "image";
  if (mime.startsWith("video/") || VIDEO_EXT.includes(ext)) return "video";
  if (mime.startsWith("audio/") || AUDIO_EXT.includes(ext)) return "audio";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (
    OFFICE_EXT.includes(ext) ||
    mime.includes("officedocument") ||
    mime.includes("msword") ||
    mime.includes("ms-excel") ||
    mime.includes("ms-powerpoint")
  )
    return "office";
  if (mime.startsWith("text/") || mime === "application/json" || TEXT_EXT.includes(ext))
    return "text";
  return "none";
}

/** Emoji icon for a file chip, by preview kind. */
export function fileTypeIcon(kind: PreviewKind, name: string | null | undefined): string {
  const ext = extOf(name);
  switch (kind) {
    case "pdf":
      return "📕";
    case "office":
      if (["xls", "xlsx"].includes(ext)) return "📊";
      if (["ppt", "pptx"].includes(ext)) return "📈";
      return "📘";
    case "audio":
      return "🎵";
    case "text":
      return "📃";
    default:
      return "📎";
  }
}

/** Microsoft Office Online embed URL for a publicly-reachable file URL. */
export function officeViewerUrl(fileUrl: string): string {
  return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(fileUrl)}`;
}

/** Edit my own message. Sets edited_at so clients can show an "edited" hint. */
export async function editMessage(messageId: string, newContent: string): Promise<void> {
  const text = newContent.trim();
  if (!text) throw new Error("Message cannot be empty");
  const { error } = await supabase
    .from("chat_messages")
    .update({ content: text, edited_at: new Date().toISOString() })
    .eq("id", messageId);
  if (error) throw error;
}

/** Unsend (soft-delete) my own message — clears the body for everyone. */
export async function unsendMessage(messageId: string): Promise<void> {
  const { error } = await supabase
    .from("chat_messages")
    .update({
      deleted_at: new Date().toISOString(),
      content: "",
      attachment_path: null,
      attachment_name: null,
      attachment_type: null,
      attachment_size: null,
      attachment_kind: null,
    })
    .eq("id", messageId);
  if (error) throw error;
}

/** Post a system note (e.g. "Dana added Sam") — a normal row flagged system. */
export async function postSystemMessage(
  conversationId: string,
  actorId: string,
  text: string
): Promise<void> {
  const { error } = await supabase.from("chat_messages").insert({
    conversation_id: conversationId,
    sender_id: actorId,
    content: text,
    message_type: "system",
  });
  if (error) throw error;
  await supabase
    .from("chat_conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);
}

/** Add members to a group. RLS allows any member; the app gates by role. */
export async function addMembers(conversationId: string, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  const { error } = await supabase
    .from("chat_members")
    .insert(ids.map((uid) => ({ conversation_id: conversationId, user_id: uid })));
  if (error) throw error;
}

/** Remove a member from a group. RLS allows managers (role ≠ teacher). */
export async function removeMember(conversationId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from("chat_members")
    .delete()
    .eq("conversation_id", conversationId)
    .eq("user_id", userId);
  if (error) throw error;
}

/** Update my last_read_at to "now" for a conversation. */
export async function markRead(conversationId: string, myId: string): Promise<void> {
  const { error } = await supabase
    .from("chat_members")
    .update({ last_read_at: new Date().toISOString() })
    .eq("conversation_id", conversationId)
    .eq("user_id", myId);
  if (error) throw error;
}

/**
 * "Delete" a chat for the current user only — soft-hides it from their sidebar.
 * The conversation will re-appear automatically when a new message arrives
 * (last_message_at > hidden_at), or when the user explicitly re-opens it.
 */
export async function hideConversation(conversationId: string, myId: string): Promise<void> {
  const { error } = await supabase
    .from("chat_members")
    .update({ hidden_at: new Date().toISOString() })
    .eq("conversation_id", conversationId)
    .eq("user_id", myId);
  if (error) throw error;
}

/** Clear my hidden_at flag for a conversation — used when re-engaging with a previously hidden chat. */
export async function unhideConversation(conversationId: string, myId: string): Promise<void> {
  const { error } = await supabase
    .from("chat_members")
    .update({ hidden_at: null })
    .eq("conversation_id", conversationId)
    .eq("user_id", myId);
  if (error) throw error;
}

/**
 * Find an existing 1-on-1 conversation between me and `otherUserId`.
 * Returns the conversation id, or null if none exists.
 */
export async function findExistingDirectConversation(
  myId: string,
  otherUserId: string
): Promise<string | null> {
  // All 1-on-1 conversations I'm in
  const { data: mine, error: mineErr } = await supabase
    .from("chat_members")
    .select("conversation_id")
    .eq("user_id", myId);
  if (mineErr) throw mineErr;
  const myConvIds = (mine ?? []).map((r) => r.conversation_id);
  if (myConvIds.length === 0) return null;

  const { data: convs, error: cErr } = await supabase
    .from("chat_conversations")
    .select("id")
    .in("id", myConvIds)
    .eq("is_group", false);
  if (cErr) throw cErr;
  const oneOnOneIds = (convs ?? []).map((c) => c.id as string);
  if (oneOnOneIds.length === 0) return null;

  // Find one where the other user is also a member
  const { data: matches, error: matchErr } = await supabase
    .from("chat_members")
    .select("conversation_id")
    .eq("user_id", otherUserId)
    .in("conversation_id", oneOnOneIds);
  if (matchErr) throw matchErr;
  return matches && matches.length > 0 ? (matches[0].conversation_id as string) : null;
}

/**
 * Create a new conversation. For 1-on-1 (single recipient), de-dupes against
 * any existing direct conversation between the two users.
 *
 * Returns the conversation id.
 */
export async function createConversation(opts: {
  myId: string;
  recipientUserIds: string[];
  name?: string | null;
}): Promise<string> {
  const recipients = [...new Set(opts.recipientUserIds.filter((id) => id && id !== opts.myId))];
  if (recipients.length === 0) throw new Error("Pick at least one user");

  const isGroup = recipients.length > 1;

  // De-dup direct chats — also un-hide it for me if I'd previously hidden it
  if (!isGroup) {
    const existing = await findExistingDirectConversation(opts.myId, recipients[0]);
    if (existing) {
      await unhideConversation(existing, opts.myId).catch(() => {});
      return existing;
    }
  }

  const { data: convRow, error: convErr } = await supabase
    .from("chat_conversations")
    .insert({
      name: isGroup ? (opts.name?.trim() || null) : null,
      is_group: isGroup,
      created_by: opts.myId,
    })
    .select("id")
    .single();
  if (convErr) throw convErr;
  const convId = (convRow as { id: string }).id;

  // Insert membership rows: me first (RLS requires user_id = auth.uid() for the bootstrap row)
  const { error: meErr } = await supabase
    .from("chat_members")
    .insert({ conversation_id: convId, user_id: opts.myId });
  if (meErr) throw meErr;

  if (recipients.length > 0) {
    const { error: othersErr } = await supabase
      .from("chat_members")
      .insert(recipients.map((uid) => ({ conversation_id: convId, user_id: uid })));
    if (othersErr) throw othersErr;
  }

  return convId;
}

/**
 * Profile ids of employees deactivated in HR. `user_profiles.is_active` tracks
 * portal login and is left alone when someone is deactivated in HR, so this is
 * the flag that actually says "no longer staff".
 */
export async function fetchInactiveStaffIds(): Promise<Set<string>> {
  const { data } = await supabase.rpc("inactive_staff_profile_ids");
  return new Set(((data ?? []) as (string | { inactive_staff_profile_ids: string })[]).map(
    (r) => (typeof r === "string" ? r : r.inactive_staff_profile_ids)
  ));
}

/**
 * Fetch all active users (for the new-chat picker), excluding the current user
 * and anyone deactivated in HR.
 */
export async function fetchPickableUsers(myId: string): Promise<ChatUserLite[]> {
  const [{ data, error }, inactive] = await Promise.all([
    supabase
      .from("user_profiles")
      .select("id, full_name, username, email, is_active")
      .eq("is_active", true)
      .neq("id", myId)
      .order("full_name", { ascending: true }),
    fetchInactiveStaffIds(),
  ]);
  if (error) throw error;
  return ((data ?? []) as (ChatUserLite & { is_active: boolean })[])
    .filter((u) => !inactive.has(u.id))
    .map((u) => ({
      id: u.id, full_name: u.full_name, username: u.username, email: u.email,
    }));
}
