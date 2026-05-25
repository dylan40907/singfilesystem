"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

/**
 * Small unread-count badge intended to render next to the "Chat" nav button.
 * - Fetches the total unread count via the `chat_unread_total` RPC.
 * - Subscribes to chat_messages INSERTs + chat_members UPDATEs (last_read_at)
 *   so the badge stays live without polling.
 * - While the user is on `/chat`, it forces the count to 0 (any messages get
 *   marked as read by the open thread).
 */
export default function ChatNavBadge({ size = 18 }: { size?: number }) {
  const pathname = usePathname();
  const [count, setCount] = useState(0);
  const [myId, setMyId] = useState<string | null>(null);

  // Resolve current user id
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      setMyId(data.session?.user?.id ?? null);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setMyId(session?.user?.id ?? null);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Fetch the current unread total
  const refetch = async () => {
    const { data, error } = await supabase.rpc("chat_unread_total");
    if (!error) setCount((data as number) ?? 0);
  };

  useEffect(() => {
    if (!myId) { setCount(0); return; }
    // Don't show a badge while the user is actively reading chats
    if (pathname === "/chat" || pathname?.startsWith("/chat/")) { setCount(0); return; }
    refetch();
  }, [myId, pathname]);

  // Subscribe to chat events so the badge updates in real time
  useEffect(() => {
    if (!myId) return;
    const channel = supabase
      .channel(`chat-nav-badge:${myId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        () => {
          if (pathname === "/chat" || pathname?.startsWith("/chat/")) return;
          refetch();
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "chat_members", filter: `user_id=eq.${myId}` },
        () => { refetch(); }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [myId, pathname]);

  if (count <= 0) return null;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: size,
        height: size,
        padding: "0 6px",
        borderRadius: size,
        background: "#e6178d",
        color: "white",
        fontSize: 11,
        fontWeight: 900,
        lineHeight: 1,
        boxShadow: "0 0 0 2px white",
      }}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
