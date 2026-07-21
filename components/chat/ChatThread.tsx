"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  ChatConversationView, ChatMessage, ChatUserLite, PreviewKind, editMessage, fetchMessages,
  fileTypeIcon, getAttachmentUrl, markRead, officeViewerUrl, previewKindFor, sendMessage,
  unsendMessage, uploadChatAttachment, userDisplayName,
} from "@/lib/chat";
import { fetchMyProfile } from "@/lib/teachers";
import {
  DraftMention, activeMentionQuery, draftToStored, insertMention, mentionLabel,
  parseMentions, storedToDraft,
} from "@/lib/mentions";
import ChatParticipantsModal from "@/components/chat/ChatParticipantsModal";
import { useDialog } from "@/components/ui/useDialog";

type PreviewTarget = { url: string; kind: PreviewKind; name: string; type: string | null };

// Renders a message attachment inline; clicking opens the full-screen lightbox.
function ChatAttachment({
  message,
  mine,
  onOpen,
}: {
  message: ChatMessage;
  mine: boolean;
  onOpen: (t: PreviewTarget) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (message.attachment_path) getAttachmentUrl(message.attachment_path).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [message.attachment_path]);

  const hasText = !!message.content?.trim();
  const kind = previewKindFor(message.attachment_type, message.attachment_name, message.attachment_kind);
  const name = message.attachment_name ?? "Attachment";
  const open = () => { if (url) onOpen({ url, kind, name, type: message.attachment_type ?? null }); };

  if (kind === "image") {
    return (
      <button onClick={open} style={{ display: "block", border: "none", padding: 0, background: "none", cursor: url ? "pointer" : "default", marginBottom: hasText ? 6 : 0 }}>
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={name} style={{ maxWidth: 240, maxHeight: 240, borderRadius: 12, display: "block", background: "#e5e7eb" }} />
        ) : (
          <div style={{ width: 200, height: 160, borderRadius: 12, background: "#e5e7eb" }} />
        )}
      </button>
    );
  }

  if (kind === "video") {
    return (
      <button onClick={open} style={{ display: "block", border: "none", padding: 0, background: "none", cursor: url ? "pointer" : "default", marginBottom: hasText ? 6 : 0 }}>
        <div style={{ width: 220, height: 130, borderRadius: 12, background: "#1f2937", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <span style={{ fontSize: 34, color: "white" }}>▶</span>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
        </div>
      </button>
    );
  }

  return (
    <button
      onClick={open}
      style={{
        display: "inline-flex", alignItems: "center", gap: 10, marginBottom: hasText ? 6 : 0,
        padding: "10px 12px", borderRadius: 12, border: "none", textAlign: "left", maxWidth: 280,
        cursor: url ? "pointer" : "default",
        background: mine ? "rgba(255,255,255,0.2)" : "#e5e7eb", color: mine ? "white" : "#111827",
      }}
    >
      <span style={{ fontSize: 22 }}>{fileTypeIcon(kind, message.attachment_name)}</span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600, fontSize: 13 }}>{name}</span>
        <span style={{ display: "block", fontSize: 11, opacity: 0.7 }}>{kind === "none" ? "Click to download" : "Click to preview"}</span>
      </span>
    </button>
  );
}

// ─── Full-screen lightbox ─────────────────────────────────────────────────────

function TextLightbox({ url }: { url: string }) {
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => r.text())
      .then((t) => { if (!cancelled) setBody(t.length > 200000 ? t.slice(0, 200000) + "\n\n…(truncated)" : t); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [url]);

  if (failed) return <div style={{ color: "white", fontSize: 15 }}>Couldn’t load this file’s contents.</div>;
  if (body === null) return <div style={{ color: "white", fontSize: 15 }}>Loading…</div>;
  return (
    <pre style={{
      maxWidth: 900, width: "92vw", maxHeight: "82vh", overflow: "auto", margin: 0,
      background: "#1e1e1e", color: "#e5e7eb", padding: 20, borderRadius: 12,
      fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
    }}>{body}</pre>
  );
}

function PreviewLightbox({ target, onClose }: { target: PreviewTarget; onClose: () => void }) {
  const { url, kind, name } = target;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  let body: React.ReactNode;
  if (kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    body = <img src={url} alt={name} style={{ maxWidth: "92vw", maxHeight: "86vh", borderRadius: 8, display: "block" }} />;
  } else if (kind === "video") {
    body = <video src={url} controls autoPlay style={{ maxWidth: "92vw", maxHeight: "86vh", borderRadius: 8, background: "#000" }} />;
  } else if (kind === "audio") {
    body = (
      <div style={{ textAlign: "center" }}>
        <div style={{ color: "white", fontSize: 16, fontWeight: 700, marginBottom: 18 }}>🎵 {name}</div>
        <audio src={url} controls autoPlay style={{ width: "min(80vw, 480px)" }} />
      </div>
    );
  } else if (kind === "pdf") {
    body = <iframe src={url} title={name} style={{ width: "92vw", height: "86vh", border: "none", borderRadius: 8, background: "white" }} />;
  } else if (kind === "office") {
    body = <iframe src={officeViewerUrl(url)} title={name} style={{ width: "92vw", height: "86vh", border: "none", borderRadius: 8, background: "white" }} />;
  } else if (kind === "text") {
    body = <TextLightbox url={url} />;
  } else {
    body = (
      <div style={{ textAlign: "center", maxWidth: 360 }}>
        <div style={{ fontSize: 64, marginBottom: 12 }}>{fileTypeIcon(kind, name)}</div>
        <div style={{ color: "white", fontSize: 17, fontWeight: 700, marginBottom: 6, wordBreak: "break-word" }}>{name}</div>
        <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 14, marginBottom: 22 }}>No preview available for this file type.</div>
        <a href={url} download={name} target="_blank" rel="noopener noreferrer"
          style={{ display: "inline-block", padding: "12px 30px", borderRadius: 24, background: "#e6178d", color: "white", fontWeight: 800, fontSize: 15, textDecoration: "none" }}>
          Download
        </a>
      </div>
    );
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.92)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      }}
    >
      <div style={{ position: "absolute", top: 16, right: 16, display: "flex", gap: 10, zIndex: 1 }}>
        <a href={url} download={name} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
          title="Download"
          style={{ width: 40, height: 40, borderRadius: 20, background: "rgba(255,255,255,0.15)", color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, textDecoration: "none" }}>
          ⤓
        </a>
        <button onClick={onClose} title="Close"
          style={{ width: 40, height: 40, borderRadius: 20, background: "rgba(255,255,255,0.15)", color: "white", border: "none", cursor: "pointer", fontSize: 18, fontWeight: 700 }}>
          ✕
        </button>
      </div>
      <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        {body}
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (isSameDay(d, today)) return "Today";
  if (isSameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

const msgActionBtn: React.CSSProperties = {
  marginLeft: 6,
  border: "none",
  background: "transparent",
  color: "#6b7280",
  fontSize: 10,
  fontWeight: 800,
  cursor: "pointer",
  padding: 0,
  textDecoration: "underline",
};

const attachMenuItem: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "10px 12px",
  borderRadius: 8,
  border: "none",
  background: "transparent",
  fontSize: 14,
  fontWeight: 700,
  color: "#111827",
  cursor: "pointer",
};

export default function ChatThread({
  conversation,
  myId,
  onMessageSent,
  onMembersChanged,
}: {
  conversation: ChatConversationView;
  myId: string;
  onMessageSent: () => void;
  onMembersChanged: () => void;
}) {
  const { confirm, modal: dialogModal } = useDialog();
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  // Editing an existing message (null = composing a new one)
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [viewerRole, setViewerRole] = useState<string | null>(null);
  // @-mention autocomplete
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  // Mentions picked for the current draft — the composer shows labels, these
  // map them back to user ids when the message is sent.
  const [draftMentions, setDraftMentions] = useState<DraftMention[]>([]);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const memberMap = useMemo(
    () => new Map(conversation.members.map((m) => [m.id, m] as const)),
    [conversation.members]
  );

  // Same rule as the app: every role above the lowest (teacher) may edit a
  // group's participants; everyone else gets a read-only roster.
  const canManageMembers = conversation.is_group && !!viewerRole && viewerRole !== "teacher";

  const nameFor = (id: string) => {
    const m = memberMap.get(id);
    return m ? userDisplayName(m) : "someone";
  };

  /** Members matching the in-progress @query, for the composer dropdown. */
  const mentionMatches = useMemo(() => {
    if (!mention) return [] as ChatUserLite[];
    const q = mention.query.toLowerCase();
    return conversation.members
      .filter((m) => m.id !== myId)
      .filter((m) => !q || userDisplayName(m).toLowerCase().includes(q))
      .slice(0, 6);
  }, [mention, conversation.members, myId]);

  useEffect(() => {
    (async () => {
      try { setViewerRole((await fetchMyProfile())?.role ?? null); } catch { setViewerRole(null); }
    })();
  }, []);

  // Load messages whenever the selected conversation changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const list = await fetchMessages(conversation.id);
        if (cancelled) return;
        setMessages(list);
        // Mark read; don't bubble errors here
        markRead(conversation.id, myId).catch(() => {});
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to load messages");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [conversation.id, myId]);

  // Subscribe to new messages via Realtime
  useEffect(() => {
    const channel = supabase
      .channel(`chat:${conversation.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
          filter: `conversation_id=eq.${conversation.id}`,
        },
        (payload) => {
          const newMsg = payload.new as ChatMessage;
          setMessages((prev) => {
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            return [...prev, newMsg];
          });
          // Whenever a new message arrives, mark read (we're looking at the thread)
          markRead(conversation.id, myId).catch(() => {});
        }
      )
      .on(
        // Edits + unsends arrive as UPDATEs — reflect them in place.
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "chat_messages",
          filter: `conversation_id=eq.${conversation.id}`,
        },
        (payload) => {
          const upd = payload.new as ChatMessage;
          setMessages((prev) => prev.map((m) => (m.id === upd.id ? upd : m)));
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversation.id, myId]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  async function handleSend() {
    if (!draft.trim() || sending) return;
    setSending(true);
    setError(null);

    // Saving an edit rather than sending a new message.
    if (editing) {
      try {
        const stored = draftToStored(draft, draftMentions).trim();
        await editMessage(editing.id, stored);
        const saved = stored;
        setMessages((prev) =>
          prev.map((x) => (x.id === editing.id ? { ...x, content: saved, edited_at: new Date().toISOString() } : x))
        );
        setEditing(null);
        setDraft("");
        setDraftMentions([]);
      } catch (e: any) {
        setError(e?.message ?? "Failed to edit");
      } finally {
        setSending(false);
      }
      return;
    }

    try {
      const msg = await sendMessage(conversation.id, myId, draftToStored(draft, draftMentions));
      // Optimistically add (the realtime sub may also add it; we dedupe)
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      setDraft("");
      setDraftMentions([]);
      onMessageSent();
    } catch (e: any) {
      setError(e?.message ?? "Failed to send");
    } finally {
      setSending(false);
    }
  }

  async function handleAttachmentChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    setAttachOpen(false);
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const att = await uploadChatAttachment(conversation.id, file);
      const msg = await sendMessage(conversation.id, myId, draftToStored(draft, draftMentions), att);
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      setDraft("");
      setDraftMentions([]);
      onMessageSent();
    } catch (e2: any) {
      setError(e2?.message ?? "Failed to upload");
    } finally {
      setUploading(false);
    }
  }

  function applyMention(u: ChatUserLite) {
    if (!mention) return;
    const el = draftRef.current;
    const caret = el?.selectionStart ?? draft.length;
    const label = mentionLabel(userDisplayName(u));
    const { next, caret: nextCaret } = insertMention(draft, mention.start, caret, label);
    setDraft(next);
    setDraftMentions((prev) =>
      prev.some((m) => m.text === label && m.userId === u.id) ? prev : [...prev, { text: label, userId: u.id }]
    );
    setMention(null);
    setMentionIdx(0);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(nextCaret, nextCaret);
    });
  }

  /** Recompute the @-autocomplete from the caret position. */
  function syncMention(value: string, caret: number) {
    const found = activeMentionQuery(value, caret);
    setMention(found);
    setMentionIdx(0);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // The mention list owns the arrow keys / Enter while it's open.
    if (mention && mentionMatches.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionMatches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyMention(mentionMatches[mentionIdx]); return; }
      if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
    }
    if (e.key === "Escape" && editing) { e.preventDefault(); setEditing(null); setDraft(""); setDraftMentions([]); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "white" }}>
      {dialogModal}
      {preview && <PreviewLightbox target={preview} onClose={() => setPreview(null)} />}
      {participantsOpen && (
        <ChatParticipantsModal
          conversationId={conversation.id}
          members={conversation.members}
          myId={myId}
          canManage={canManageMembers}
          onClose={() => setParticipantsOpen(false)}
          onChanged={onMembersChanged}
        />
      )}
      {/* Header */}
      <div
        style={{
          padding: "14px 18px",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          alignItems: "center",
          gap: 12,
          background: "white",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: conversation.is_group ? "#fdf2f8" : "#eef2ff",
            color: conversation.is_group ? "#e6178d" : "#4338ca",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 800,
            fontSize: 13,
            flexShrink: 0,
          }}
        >
          {conversation.displayName.slice(0, 2).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 900, fontSize: 15, color: "#111827" }}>
            {conversation.displayName}
          </div>
          <div style={{ fontSize: 12, color: "#9ca3af" }}>
            {conversation.is_group
              ? `${conversation.members.length} members`
              : "Direct message"}
          </div>
        </div>
        {conversation.is_group ? (
          <button
            onClick={() => setParticipantsOpen(true)}
            title={canManageMembers ? "Edit participants" : "View participants"}
            style={{
              flexShrink: 0, padding: "6px 12px", borderRadius: 8,
              border: "1.5px solid #e5e7eb", background: "white",
              color: "#374151", fontWeight: 700, fontSize: 13, cursor: "pointer",
            }}
          >
            {canManageMembers ? "✎ Participants" : "👥 Participants"}
          </button>
        ) : null}
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          // min-height:0 lets this flex child actually scroll instead of growing
          // to fit all messages (which would push the composer out of the card).
          minHeight: 0,
          overflowY: "auto",
          padding: "16px 18px",
          background: "linear-gradient(180deg, #fdfbff 0%, white 100%)",
        }}
      >
        {loading ? (
          <div style={{ color: "#9ca3af", fontSize: 14 }}>Loading…</div>
        ) : messages.length === 0 ? (
          <div style={{ color: "#9ca3af", fontSize: 14, textAlign: "center", paddingTop: 32 }}>
            No messages yet. Say hi 👋
          </div>
        ) : (
          messages.map((m, idx) => {
            const prev = messages[idx - 1];
            const showDay = !prev || formatDay(prev.created_at) !== formatDay(m.created_at);
            const isMine = m.sender_id === myId;
            const sender = memberMap.get(m.sender_id);
            const showSenderName =
              conversation.is_group && !isMine && (!prev || prev.sender_id !== m.sender_id);

            // System note (participant added/removed) — centered, with time.
            if (m.message_type === "system") {
              return (
                <div key={m.id}>
                  {showDay && (
                    <div style={{ textAlign: "center", margin: "16px 0 12px", fontSize: 11, color: "#9ca3af", fontWeight: 700 }}>
                      {formatDay(m.created_at)}
                    </div>
                  )}
                  <div style={{ textAlign: "center", margin: "8px 0" }}>
                    <span style={{ display: "inline-block", fontSize: 12, color: "#6b7280", background: "#f3f4f6", padding: "4px 12px", borderRadius: 999 }}>
                      {m.content}
                    </span>
                    <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 3 }}>{formatTime(m.created_at)}</div>
                  </div>
                </div>
              );
            }

            return (
              <div key={m.id}>
                {showDay && (
                  <div
                    style={{
                      textAlign: "center",
                      margin: "16px 0 12px",
                      fontSize: 11,
                      color: "#9ca3af",
                      fontWeight: 700,
                    }}
                  >
                    {formatDay(m.created_at)}
                  </div>
                )}
                <div
                  style={{
                    display: "flex",
                    justifyContent: isMine ? "flex-end" : "flex-start",
                    marginBottom: 4,
                  }}
                  onMouseEnter={() => setHoverId(m.id)}
                  onMouseLeave={() => setHoverId((cur) => (cur === m.id ? null : cur))}
                >
                  <div style={{ maxWidth: "70%" }}>
                    {showSenderName && (
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: "#6b7280",
                          marginBottom: 3,
                          paddingLeft: 4,
                        }}
                      >
                        {sender ? userDisplayName(sender) : "Someone"}
                      </div>
                    )}
                    {m.deleted_at ? (
                      <div
                        style={{
                          padding: "8px 12px",
                          borderRadius: 14,
                          border: "1px dashed #e5e7eb",
                          background: "#f9fafb",
                          color: "#9ca3af",
                          fontSize: 13.5,
                          fontStyle: "italic",
                        }}
                      >
                        🚫 Message unsent
                      </div>
                    ) : (
                      <div
                        style={{
                          padding: "8px 12px",
                          borderRadius: 14,
                          background: isMine ? "#e6178d" : "#f3f4f6",
                          color: isMine ? "white" : "#111827",
                          fontSize: 14,
                          lineHeight: 1.4,
                          wordBreak: "break-word",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {m.attachment_path && <ChatAttachment message={m} mine={isMine} onOpen={setPreview} />}
                        {m.content?.trim()
                          ? parseMentions(m.content).map((seg, si) =>
                              seg.type === "text" ? (
                                <span key={si}>{seg.text}</span>
                              ) : (
                                <span
                                  key={si}
                                  style={{
                                    fontWeight: 800,
                                    borderRadius: 4,
                                    padding: "0 3px",
                                    color: isMine ? "#ffffff" : "#4338ca",
                                    background: isMine ? "rgba(255,255,255,0.22)" : "#e0e7ff",
                                  }}
                                >
                                  @{nameFor(seg.userId)}
                                </span>
                              )
                            )
                          : null}
                      </div>
                    )}
                    <div
                      style={{
                        fontSize: 10,
                        color: "#9ca3af",
                        marginTop: 2,
                        textAlign: isMine ? "right" : "left",
                        paddingLeft: isMine ? 0 : 4,
                        paddingRight: isMine ? 4 : 0,
                      }}
                    >
                      {formatTime(m.created_at)}
                      {m.edited_at && !m.deleted_at ? " · edited" : ""}
                      {isMine && !m.deleted_at && hoverId === m.id ? (
                        <>
                          {m.content?.trim() ? (
                            <button
                              onClick={() => {
                                const { draft: d, mentions } = storedToDraft(m.content, nameFor);
                                setEditing(m); setDraft(d); setDraftMentions(mentions); draftRef.current?.focus();
                              }}
                              style={msgActionBtn}
                            >
                              Edit
                            </button>
                          ) : null}
                          <button
                            onClick={async () => {
                              const ok = await confirm("Unsend this message? It will be removed for everyone.", {
                                title: "Unsend message", confirmLabel: "Unsend", danger: true,
                              });
                              if (!ok) return;
                              try {
                                await unsendMessage(m.id);
                                setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, deleted_at: new Date().toISOString(), content: "", attachment_path: null } : x)));
                                if (editing?.id === m.id) { setEditing(null); setDraft(""); setDraftMentions([]); }
                              } catch (e: any) { setError(e?.message ?? "Failed to unsend"); }
                            }}
                            style={{ ...msgActionBtn, color: "#b91c1c" }}
                          >
                            Unsend
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Composer */}
      <div
        style={{
          borderTop: "1px solid #e5e7eb",
          padding: "12px 16px",
          background: "white",
          flexShrink: 0,
        }}
      >
        {error && (
          <div style={{ marginBottom: 8, fontSize: 12, color: "#991b1b", fontWeight: 600 }}>{error}</div>
        )}

        {editing && (
          <div className="row-between" style={{
            marginBottom: 8, padding: "6px 10px", borderRadius: 8,
            background: "#fdf2f8", border: "1px solid #f9d9ec",
          }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: "#e6178d" }}>✎ Editing message</span>
            <button
              onClick={() => { setEditing(null); setDraft(""); setDraftMentions([]); }}
              style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 12, fontWeight: 700, color: "#6b7280" }}
            >
              Cancel
            </button>
          </div>
        )}

        {mention && mentionMatches.length > 0 && (
          <div style={{
            position: "relative", marginBottom: 6,
          }}>
            <div style={{
              border: "1px solid #e5e7eb", borderRadius: 10, background: "white",
              boxShadow: "0 8px 24px rgba(0,0,0,0.10)", overflow: "hidden",
            }}>
              <div style={{ padding: "6px 10px", fontSize: 11, fontWeight: 800, color: "#9ca3af" }}>
                MEMBERS MATCHING @{mention.query.toUpperCase()}
              </div>
              {mentionMatches.map((u, i) => (
                <button
                  key={u.id}
                  onMouseDown={(e) => { e.preventDefault(); applyMention(u); }}
                  onMouseEnter={() => setMentionIdx(i)}
                  style={{
                    display: "flex", width: "100%", alignItems: "center", gap: 8,
                    padding: "8px 10px", border: "none", cursor: "pointer", textAlign: "left",
                    background: i === mentionIdx ? "rgba(230,23,141,0.08)" : "transparent",
                    fontSize: 13, fontWeight: 700, color: "#111827",
                  }}
                >
                  <span style={{
                    width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
                    background: "#eef2ff", color: "#4338ca", fontSize: 10, fontWeight: 800,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {userDisplayName(u).slice(0, 2).toUpperCase()}
                  </span>
                  {userDisplayName(u)}
                </button>
              ))}
            </div>
          </div>
        )}

        <input ref={imageInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleAttachmentChosen} />
        <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleAttachmentChosen} />

        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          {/* Attach (+) menu — image or file, iMessage-style */}
          <div style={{ position: "relative", flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setAttachOpen((v) => !v)}
              disabled={uploading}
              title="Add attachment"
              style={{
                width: 40, height: 40, borderRadius: 12, border: "1.5px solid #e5e7eb",
                background: "white", color: "#e6178d", fontSize: 22, lineHeight: 1,
                cursor: uploading ? "default" : "pointer",
                transform: attachOpen ? "rotate(45deg)" : "none", transition: "transform 0.15s",
              }}
            >
              {uploading ? "…" : "+"}
            </button>
            {attachOpen && (
              <>
                <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setAttachOpen(false)} />
                <div
                  style={{
                    position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 50,
                    background: "white", border: "1px solid #e5e7eb", borderRadius: 12,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.12)", padding: 6, width: 160,
                  }}
                >
                  <button type="button" onClick={() => { setAttachOpen(false); imageInputRef.current?.click(); }} style={attachMenuItem}>
                    🖼️ Photo
                  </button>
                  <button type="button" onClick={() => { setAttachOpen(false); fileInputRef.current?.click(); }} style={attachMenuItem}>
                    📄 File
                  </button>
                </div>
              </>
            )}
          </div>
          <textarea
            ref={draftRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); syncMention(e.target.value, e.target.selectionStart ?? 0); }}
            onClick={(e) => syncMention(draft, (e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyUp={(e) => syncMention(draft, (e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyDown={handleKeyDown}
            placeholder={editing ? "Edit your message — Enter to save, Esc to cancel" : "Type a message — @ to mention, Enter to send"}
            rows={1}
            disabled={sending}
            style={{
              flex: 1,
              padding: "10px 14px",
              borderRadius: 12,
              border: "1.5px solid #e5e7eb",
              fontSize: 14,
              fontFamily: "inherit",
              resize: "none",
              maxHeight: 140,
              outline: "none",
            }}
          />
          <button
            onClick={handleSend}
            disabled={sending || !draft.trim()}
            style={{
              padding: "10px 18px",
              borderRadius: 12,
              border: "none",
              background: sending || !draft.trim() ? "#f9a8d4" : "#e6178d",
              color: "white",
              fontWeight: 800,
              fontSize: 14,
              cursor: sending || !draft.trim() ? "default" : "pointer",
              flexShrink: 0,
            }}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
