"use client";

import { useEffect, useMemo, useState } from "react";
import { ChatConversationView, MessageHit, searchMessages, userDisplayName } from "@/lib/chat";
import { mentionsToPlainText } from "@/lib/mentions";

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
}

export default function ChatSidebar({
  conversations,
  selectedId,
  onSelect,
  onNewChat,
  onHide,
  onMarkUnread,
  onSelectMessage,
  myId,
}: {
  conversations: ChatConversationView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  /** Hide the chat from my list (it returns on new activity). */
  onHide: (id: string) => void;
  onMarkUnread: (id: string) => void;
  /** Open a chat scrolled to one specific message (a search hit). */
  onSelectMessage: (conversationId: string, messageId: string) => void;
  myId: string;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MessageHit[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTerm = query.trim();
  const searching2 = searchTerm.length >= 2;

  /** Name lookup shared by the chat and message result lists. */
  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of conversations) for (const m of c.members) map.set(m.id, userDisplayName(m));
    return (id: string) => map.get(id) ?? "Someone";
  }, [conversations]);

  // Chats whose name — or any member's name — matches. Answered from the list
  // already in memory, so it is instant and needs no query.
  const chatHits = useMemo(() => {
    if (!searching2) return [];
    const q = searchTerm.toLowerCase();
    return conversations.filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        c.members.some((m) => userDisplayName(m).toLowerCase().includes(q))
    );
  }, [conversations, searchTerm, searching2]);

  // Messages come from the server. Debounced so typing doesn't fire a query per
  // keystroke, and guarded against out-of-order responses.
  useEffect(() => {
    if (!searching2) { setHits([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      searchMessages(searchTerm)
        .then((r) => { if (!cancelled) setHits(r); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [searchTerm, searching2]);

  const convById = useMemo(
    () => new Map(conversations.map((c) => [c.id, c])),
    [conversations]
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        // As a grid item this defaults to min-height:auto, which lets a long
        // chat list stretch past the container so the list below never
        // scrolls. Pin it so the overflow lands on the list instead.
        minHeight: 0,
        overflow: "hidden",
        background: "white",
        borderRight: "1px solid #e5e7eb",
      }}
    >
      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 16, color: "#111827" }}>Chats</div>
        <button
          onClick={onNewChat}
          style={{
            padding: "6px 12px",
            borderRadius: 10,
            border: "1.5px solid #e6178d",
            background: "#e6178d",
            color: "white",
            fontSize: 13,
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          + New
        </button>
      </div>

      <div style={{ padding: "10px 12px", borderBottom: "1px solid #e5e7eb" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search messages, chats and people"
          style={{
            width: "100%", padding: "8px 11px", fontSize: 13, borderRadius: 10,
            border: "1.5px solid #e5e7eb", outline: "none", boxSizing: "border-box",
          }}
        />
      </div>

      {searching2 ? (
        <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
          {chatHits.length === 0 && hits.length === 0 && !searching && (
            <div style={{ padding: 20, color: "#9ca3af", fontSize: 14, textAlign: "center" }}>
              Nothing found for “{searchTerm}”.
            </div>
          )}

          {chatHits.length > 0 && (
            <SearchHeading>Chats &amp; people</SearchHeading>
          )}
          {chatHits.map((c) => (
            <button
              key={c.id}
              onClick={() => { onSelect(c.id); setQuery(""); }}
              style={resultRow}
            >
              <span style={{ fontWeight: 800, fontSize: 14, color: "#111827" }}>{c.displayName}</span>
              <span style={{ fontSize: 12, color: "#6b7280" }}>
                {c.is_group ? `${c.members.length} members` : "Direct message"}
              </span>
            </button>
          ))}

          {hits.length > 0 && <SearchHeading>Messages</SearchHeading>}
          {hits.map((h) => {
            const conv = convById.get(h.conversation_id);
            const text = mentionsToPlainText(h.content, (id) => nameOf(id));
            return (
              <button
                key={h.id}
                onClick={() => { onSelectMessage(h.conversation_id, h.id); setQuery(""); }}
                style={resultRow}
              >
                <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontWeight: 800, fontSize: 13, color: "#111827" }}>
                    {conv?.displayName ?? "Chat"}
                  </span>
                  <span style={{ fontSize: 11, color: "#9ca3af", flexShrink: 0 }}>
                    {formatRelative(h.created_at)}
                  </span>
                </span>
                <span style={{ fontSize: 12, color: "#6b7280" }}>
                  <strong style={{ color: "#374151" }}>{nameOf(h.sender_id)}:</strong>{" "}
                  {text.length > 90 ? text.slice(0, 90) + "…" : text}
                </span>
              </button>
            );
          })}

          {searching && (
            <div style={{ padding: 14, color: "#9ca3af", fontSize: 13, textAlign: "center" }}>Searching…</div>
          )}
        </div>
      ) : (
      <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
        {conversations.length === 0 ? (
          <div style={{ padding: 20, color: "#9ca3af", fontSize: 14, textAlign: "center" }}>
            No chats yet. Tap <strong style={{ color: "#e6178d" }}>+ New</strong> to start one.
          </div>
        ) : (
          conversations.map((c) => {
            const isSelected = selectedId === c.id;
            // Render mention tokens as "@Name" so previews stay readable.
            const rawPreview = c.lastMessage?.content
              ? mentionsToPlainText(c.lastMessage.content, (id) => {
                  const u = c.members.find((m) => m.id === id);
                  return u ? userDisplayName(u) : null;
                })
              : null;
            const preview = rawPreview?.replace(/\s+/g, " ").slice(0, 60) ?? "No messages yet";
            const senderLabel = (() => {
              if (!c.lastMessage) return "";
              if (c.lastMessage.sender_id === myId) return "You: ";
              if (!c.is_group) return "";
              const sender = c.members.find((m) => m.id === c.lastMessage!.sender_id);
              const name = sender ? userDisplayName(sender).split(" ")[0] : "";
              return name ? `${name}: ` : "";
            })();
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(c.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(c.id); } }}
                style={{
                  display: "flex",
                  width: "100%",
                  boxSizing: "border-box",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "12px 14px",
                  borderBottom: "1px solid #f3f4f6",
                  background: isSelected ? "rgba(230,23,141,0.08)" : "transparent",
                  border: "none",
                  borderLeft: isSelected ? "3px solid #e6178d" : "3px solid transparent",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <div
                  style={{
                    flexShrink: 0,
                    width: 38,
                    height: 38,
                    borderRadius: "50%",
                    background: c.is_group ? "#fdf2f8" : "#eef2ff",
                    color: c.is_group ? "#e6178d" : "#4338ca",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 800,
                    fontSize: 14,
                  }}
                >
                  {c.displayName.slice(0, 2).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <div
                      style={{
                        fontWeight: c.unreadCount > 0 ? 900 : 700,
                        color: "#111827",
                        fontSize: 14,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.displayName}
                    </div>
                    <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                      <div style={{ fontSize: 11, color: "#9ca3af" }}>
                        {formatRelative(c.last_message_at)}
                      </div>
                      <div style={{ display: "flex", gap: 2 }}>
                      {/* Only offered where it means something: a chat you've
                          already read, with something of someone else's to
                          leave unread. */}
                      {c.unreadCount === 0 && (
                        <button
                          title="Mark as unread"
                          onClick={(e) => { e.stopPropagation(); onMarkUnread(c.id); }}
                          style={{
                            border: "none", background: "transparent", cursor: "pointer",
                            color: "#2563eb", fontSize: 13, fontWeight: 900, lineHeight: 1,
                            padding: "1px 4px", borderRadius: 6,
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "#dbeafe")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          ●
                        </button>
                      )}
                      <button
                        title="Close chat — it comes back on new activity"
                        onClick={(e) => { e.stopPropagation(); onHide(c.id); }}
                        style={{
                          border: "none", background: "transparent", cursor: "pointer",
                          color: "#dc2626", fontSize: 13, fontWeight: 900, lineHeight: 1,
                          padding: "1px 4px", borderRadius: 6,
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "#fee2e2")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        ✕
                      </button>
                      </div>
                    </div>
                  </div>
                  <div
                    style={{
                      marginTop: 2,
                      fontSize: 13,
                      color: c.unreadCount > 0 ? "#374151" : "#6b7280",
                      fontWeight: c.unreadCount > 0 ? 700 : 400,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {senderLabel}{preview}
                  </div>
                </div>
                {c.unreadCount > 0 && (
                  <div
                    style={{
                      flexShrink: 0,
                      minWidth: 20,
                      height: 20,
                      borderRadius: 10,
                      background: "#e6178d",
                      color: "white",
                      fontSize: 11,
                      fontWeight: 900,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "0 6px",
                    }}
                  >
                    {c.unreadCount > 99 ? "99+" : c.unreadCount}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      )}
    </div>
  );
}

function SearchHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "10px 14px 4px",
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color: "#9ca3af",
      }}
    >
      {children}
    </div>
  );
}

const resultRow: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  width: "100%",
  textAlign: "left",
  padding: "9px 14px",
  border: "none",
  borderBottom: "1px solid #f3f4f6",
  background: "transparent",
  cursor: "pointer",
};
