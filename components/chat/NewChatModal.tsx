"use client";

import { useEffect, useMemo, useState } from "react";
import { ChatUserLite, createConversation, fetchPickableUsers, userDisplayName } from "@/lib/chat";
import { fetchMyProfile } from "@/lib/teachers";

export default function NewChatModal({
  myId,
  onClose,
  onCreated,
}: {
  myId: string;
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}) {
  const [users, setUsers] = useState<ChatUserLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only supervisors / app-supervisors / admins can create group chats.
  const [canCreateGroups, setCanCreateGroups] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [list, profile] = await Promise.all([fetchPickableUsers(myId), fetchMyProfile()]);
        setUsers(list);
        setCanCreateGroups(!!profile && profile.role !== "teacher");
      } catch (e: any) {
        setError(e?.message ?? "Failed to load users");
      } finally {
        setLoading(false);
      }
    })();
  }, [myId]);

  const isGroup = selected.size > 1;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      userDisplayName(u).toLowerCase().includes(q) ||
      (u.username ?? "").toLowerCase().includes(q) ||
      (u.email ?? "").toLowerCase().includes(q)
    );
  }, [users, search]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      // Standard accounts: single-select (DM only).
      if (!canCreateGroups) return new Set([id]);
      next.add(id);
      return next;
    });
  }

  async function handleCreate() {
    if (selected.size === 0) return;
    if (isGroup && !groupName.trim()) {
      setError("Pick a name for the group chat.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const convId = await createConversation({
        myId,
        recipientUserIds: [...selected],
        name: isGroup ? groupName.trim() : null,
      });
      onCreated(convId);
    } catch (e: any) {
      setError(e?.message ?? "Failed to create chat");
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 400 }}
        onClick={() => !creating && onClose()}
      />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          top: "50%", left: "50%",
          transform: "translate(-50%,-50%)",
          zIndex: 401,
          background: "white",
          borderRadius: 16,
          width: "min(540px, 95vw)",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid #e5e7eb",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 16, color: "#111827" }}>
            New chat
          </div>
          <button
            onClick={() => !creating && onClose()}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#9ca3af" }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "12px 20px", display: "flex", flexDirection: "column", gap: 10, flex: 1, overflow: "hidden" }}>
          <input
            type="text"
            placeholder="Search people…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={creating}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1.5px solid #e5e7eb",
              fontSize: 14,
              outline: "none",
            }}
          />

          {isGroup && (
            <input
              type="text"
              placeholder="Group chat name (required)"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              disabled={creating}
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1.5px solid #c7d2fe",
                background: "#eef2ff",
                fontSize: 14,
                fontWeight: 600,
                outline: "none",
              }}
            />
          )}

          <div style={{ fontSize: 12, color: "#6b7280" }}>
            {selected.size === 0
              ? canCreateGroups
                ? "Pick one person for a direct message, or 2+ for a group chat."
                : "Pick a person to start a direct message."
              : isGroup
                ? `${selected.size} people selected — group chat`
                : "1 person selected — direct message"}
          </div>

          <div
            style={{
              flex: 1,
              overflowY: "auto",
              border: "1px solid #f3f4f6",
              borderRadius: 10,
              minHeight: 200,
            }}
          >
            {loading ? (
              <div style={{ padding: 16, color: "#9ca3af", fontSize: 13 }}>Loading…</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 16, color: "#9ca3af", fontSize: 13 }}>No matches.</div>
            ) : (
              filtered.map((u) => {
                const sel = selected.has(u.id);
                return (
                  <button
                    key={u.id}
                    onClick={() => toggle(u.id)}
                    disabled={creating}
                    style={{
                      display: "flex",
                      width: "100%",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 14px",
                      borderBottom: "1px solid #f9fafb",
                      background: sel ? "rgba(230,23,141,0.08)" : "transparent",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <div
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        border: "1.5px solid",
                        borderColor: sel ? "#e6178d" : "#d1d5db",
                        background: sel ? "#e6178d" : "white",
                        color: "white",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 12,
                        fontWeight: 900,
                      }}
                    >
                      {sel ? "✓" : ""}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: "#111827" }}>
                        {userDisplayName(u)}
                      </div>
                      {u.username && (
                        <div style={{ fontSize: 12, color: "#9ca3af" }}>@{u.username}</div>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {error && (
            <div style={{ fontSize: 12, color: "#991b1b", fontWeight: 600 }}>{error}</div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid #e5e7eb",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => onClose()}
            disabled={creating}
            style={{
              padding: "9px 16px",
              borderRadius: 10,
              border: "1.5px solid #e5e7eb",
              background: "white",
              color: "#374151",
              fontWeight: 700,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || selected.size === 0}
            style={{
              padding: "9px 20px",
              borderRadius: 10,
              border: "none",
              background: creating || selected.size === 0 ? "#f9a8d4" : "#e6178d",
              color: "white",
              fontWeight: 800,
              fontSize: 14,
              cursor: creating || selected.size === 0 ? "default" : "pointer",
            }}
          >
            {creating ? "Creating…" : isGroup ? "Create group" : selected.size === 1 ? "Start chat" : "Start"}
          </button>
        </div>
      </div>
    </>
  );
}
