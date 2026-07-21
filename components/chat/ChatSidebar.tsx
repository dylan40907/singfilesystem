"use client";

import { ChatConversationView, userDisplayName } from "@/lib/chat";
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
  myId,
}: {
  conversations: ChatConversationView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  /** Hide the chat from my list (it returns on new activity). */
  onHide: (id: string) => void;
  myId: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
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

      <div style={{ overflowY: "auto", flex: 1 }}>
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
    </div>
  );
}
