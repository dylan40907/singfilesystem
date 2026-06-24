"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  ChatConversationView, ChatMessage, fetchMessages, markRead, sendMessage, userDisplayName,
} from "@/lib/chat";
import { useDialog } from "@/components/ui/useDialog";

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

export default function ChatThread({
  conversation,
  myId,
  onMessageSent,
  onDelete,
}: {
  conversation: ChatConversationView;
  myId: string;
  onMessageSent: () => void;
  onDelete: () => void;
}) {
  const { confirm, modal: dialogModal } = useDialog();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const memberMap = useMemo(
    () => new Map(conversation.members.map((m) => [m.id, m] as const)),
    [conversation.members]
  );

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
    try {
      const msg = await sendMessage(conversation.id, myId, draft);
      // Optimistically add (the realtime sub may also add it; we dedupe)
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      setDraft("");
      onMessageSent();
    } catch (e: any) {
      setError(e?.message ?? "Failed to send");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "white" }}>
      {dialogModal}
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
        <button
          onClick={async () => {
            const msg = conversation.is_group
              ? `Hide "${conversation.displayName}" from your chat list?\n\nThe other members will still see it. New messages will bring it back automatically.`
              : `Hide this chat with ${conversation.displayName}?\n\n${conversation.displayName} will still see the chat. New messages will bring it back automatically.`;
            const ok = await confirm(msg, { title: "Delete chat", confirmLabel: "Delete", danger: true });
            if (ok) onDelete();
          }}
          title="Delete chat (hide from your list)"
          style={{
            flexShrink: 0,
            padding: "6px 12px",
            borderRadius: 8,
            border: "1.5px solid #fca5a5",
            background: "#fee2e2",
            color: "#991b1b",
            fontWeight: 700,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Delete
        </button>
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
                      {m.content}
                    </div>
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
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message — Enter to send, Shift+Enter for newline"
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
