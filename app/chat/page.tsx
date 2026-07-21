"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { ChatConversationView, fetchMyConversations, hideConversation } from "@/lib/chat";
import ChatSidebar from "@/components/chat/ChatSidebar";
import ChatThread from "@/components/chat/ChatThread";
import NewChatModal from "@/components/chat/NewChatModal";

export default function ChatPage() {
  const router = useRouter();
  const [myId, setMyId] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [conversations, setConversations] = useState<ChatConversationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);

  // Auth guard + capture user id
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user?.id ?? null;
      if (!uid) {
        router.replace("/");
        return;
      }
      setMyId(uid);
      setAuthChecked(true);
    })();
  }, [router]);

  const reload = useCallback(async () => {
    if (!myId) return;
    setError(null);
    try {
      const list = await fetchMyConversations(myId);
      setConversations(list);
      // Auto-select first conversation if none selected
      setSelectedId((cur) => {
        if (cur && list.some((c) => c.id === cur)) return cur;
        return list[0]?.id ?? null;
      });
    } catch (e: any) {
      setError(e?.message ?? "Failed to load conversations");
    } finally {
      setLoading(false);
    }
  }, [myId]);

  useEffect(() => {
    if (!myId) return;
    reload();
  }, [myId, reload]);

  // Realtime: refresh sidebar when any message is inserted into one of my conversations
  // and when a new conversation is added (or a member is added to one)
  useEffect(() => {
    if (!myId) return;
    const channel = supabase
      .channel(`chat-sidebar:${myId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        () => { reload(); }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_members", filter: `user_id=eq.${myId}` },
        () => { reload(); }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [myId, reload]);

  const selectedConversation = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId]
  );

  if (!authChecked) return null;

  return (
    <div
      style={{
        // Fit within the page wrapper; cap so we don't exceed viewport
        display: "grid",
        gridTemplateColumns: "minmax(260px, 320px) 1fr",
        height: "calc(100vh - 120px)",
        minHeight: 480,
        background: "white",
        border: "1px solid #e5e7eb",
        borderRadius: 16,
        overflow: "hidden",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      <ChatSidebar
        conversations={conversations}
        selectedId={selectedId}
        onSelect={(id) => setSelectedId(id)}
        onNewChat={() => setNewChatOpen(true)}
        onHide={async (id) => {
          if (!myId) return;
          try {
            await hideConversation(id, myId);
          } catch (e: any) {
            setError(e?.message ?? "Failed to close chat");
            return;
          }
          setSelectedId((cur) => (cur === id ? null : cur));
          reload();
        }}
        myId={myId ?? ""}
      />

      <div style={{ minWidth: 0, minHeight: 0, height: "100%" }}>
        {loading && !selectedConversation ? (
          <div style={{ padding: 24, color: "#9ca3af", fontSize: 14 }}>Loading…</div>
        ) : error ? (
          <div style={{ padding: 24, color: "#991b1b", fontSize: 14 }}>{error}</div>
        ) : selectedConversation && myId ? (
          <ChatThread
            key={selectedConversation.id}
            conversation={selectedConversation}
            myId={myId}
            onMessageSent={() => reload()}
            onMembersChanged={() => reload()}
          />
        ) : (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: 32,
              textAlign: "center",
              color: "#6b7280",
            }}
          >
            <div style={{ fontSize: 48 }}>💬</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#111827" }}>
              No conversation selected
            </div>
            <div style={{ fontSize: 14 }}>
              Start a new chat to talk with anyone in the portal.
            </div>
            <button
              onClick={() => setNewChatOpen(true)}
              style={{
                marginTop: 4,
                padding: "10px 18px",
                borderRadius: 10,
                border: "none",
                background: "#e6178d",
                color: "white",
                fontWeight: 800,
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              + New chat
            </button>
          </div>
        )}
      </div>

      {newChatOpen && myId && (
        <NewChatModal
          myId={myId}
          onClose={() => setNewChatOpen(false)}
          onCreated={(id) => {
            setNewChatOpen(false);
            setSelectedId(id);
            reload();
          }}
        />
      )}
    </div>
  );
}
