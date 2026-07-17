"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { useEscapeKey } from "@/components/ui/useEscapeKey";

// Notification bell shared by both navbars. Reads the same public.hr_notifications
// table the mobile app uses, so the in-app and web notification logs are in sync.
// Chat notifications are collapsed to one entry per conversation (with an unread
// count); document notifications show individually.

type Notif = {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, any> | null;
  read_at: string | null;
  created_at: string;
};

type FeedItem =
  | { kind: "single"; id: string; notif: Notif }
  | { kind: "chat"; id: string; conversationId: string; title: string; body: string; time: string; unread: number };

const META: Record<string, { icon: string; tint: string }> = {
  document_approved: { icon: "✅", tint: "#16a34a" },
  document_rejected: { icon: "⚠️", tint: "#dc2626" },
  document_required: { icon: "📄", tint: "#d97706" },
  document_submitted: { icon: "📥", tint: "#2563eb" },
  document_expiring: { icon: "⏰", tint: "#d97706" },
  timesheet_request: { icon: "⏱️", tint: "#2563eb" },
  timesheet_approved: { icon: "✅", tint: "#16a34a" },
  timesheet_rejected: { icon: "⚠️", tint: "#dc2626" },
  leave_request: { icon: "🌴", tint: "#2563eb" },
  leave_approved: { icon: "✅", tint: "#16a34a" },
  leave_rejected: { icon: "⚠️", tint: "#dc2626" },
  waitlist_reminder: { icon: "⏳", tint: "#d97706" },
  chat: { icon: "💬", tint: "#2563eb" },
};

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default function NotificationsBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [myId, setMyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("hr_notifications")
      .select("id, type, title, body, data, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    setNotifs((data ?? []) as Notif[]);
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setMyId(data.user?.id ?? null));
    void load();
    const ch = supabase
      .channel(`hr_notif_bell_${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "hr_notifications" }, () => void load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const unread = useMemo(() => notifs.filter((n) => !n.read_at).length, [notifs]);
  useEscapeKey(() => setOpen(false), open);

  const feed = useMemo<FeedItem[]>(() => {
    const chatGroups = new Map<string, Notif[]>();
    const singles: Notif[] = [];
    for (const n of notifs) {
      const convId = n.type === "chat" ? n.data?.conversation_id : null;
      if (convId) {
        const arr = chatGroups.get(convId) ?? [];
        arr.push(n);
        chatGroups.set(convId, arr);
      } else {
        singles.push(n);
      }
    }
    const items: FeedItem[] = [];
    for (const [convId, group] of chatGroups) {
      const latest = group[0];
      items.push({
        kind: "chat",
        id: `chat:${convId}`,
        conversationId: convId,
        title: latest.title,
        body: latest.body,
        time: latest.created_at,
        unread: group.filter((g) => !g.read_at).length,
      });
    }
    for (const n of singles) items.push({ kind: "single", id: n.id, notif: n });
    items.sort((a, b) => {
      const ta = a.kind === "chat" ? a.time : a.notif.created_at;
      const tb = b.kind === "chat" ? b.time : b.notif.created_at;
      return new Date(tb).getTime() - new Date(ta).getTime();
    });
    return items;
  }, [notifs]);

  async function markAllRead() {
    await supabase.from("hr_notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
    void load();
  }

  async function onChat(conversationId: string) {
    await supabase
      .from("hr_notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("type", "chat")
      .is("read_at", null)
      .eq("data->>conversation_id", conversationId);
    setOpen(false);
    router.push("/chat");
  }

  async function onSingle(n: Notif) {
    if (!n.read_at) await supabase.from("hr_notifications").update({ read_at: new Date().toISOString() }).eq("id", n.id);
    setOpen(false);
    if (n.type === "document_submitted") router.push("/admin/hr/documents");
    else if (n.type.startsWith("document")) router.push("/hr");
    else if (n.type === "timesheet_request") router.push("/admin/hr/timesheets");
    else if (n.type.startsWith("timesheet")) router.push("/hr");
    else if (n.type === "leave_request") router.push("/admin/hr/leave");
    else if (n.type.startsWith("leave")) router.push("/hr");
    else if (n.type === "waitlist_reminder") router.push("/admin/hr/admissions");
    void load();
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        className="btn"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        style={{ position: "relative", padding: "8px 12px" }}
      >
        <span style={{ fontSize: 16 }}>🔔</span>
        {unread > 0 && (
          <span
            style={{
              position: "absolute", top: -4, right: -4, minWidth: 18, height: 18, borderRadius: 9,
              background: "#dc2626", color: "white", fontSize: 11, fontWeight: 800,
              display: "flex", alignItems: "center", justifyContent: "center", padding: "0 5px",
            }}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 60 }} onClick={() => setOpen(false)} />
          <div
            style={{
              position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 70, width: 360, maxWidth: "92vw",
              maxHeight: 460, overflowY: "auto", background: "white", border: "1px solid #e5e7eb",
              borderRadius: 14, boxShadow: "0 12px 32px rgba(0,0,0,0.16)",
            }}
          >
            <div className="row-between" style={{ padding: "12px 14px", borderBottom: "1px solid #f3f4f6", position: "sticky", top: 0, background: "white" }}>
              <div style={{ fontWeight: 900 }}>Notifications</div>
              {unread > 0 && (
                <button onClick={() => void markAllRead()} style={{ background: "none", border: "none", color: "#e6178d", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                  Mark all read
                </button>
              )}
            </div>

            {feed.length === 0 ? (
              <div className="subtle" style={{ padding: 24, textAlign: "center" }}>No notifications yet.</div>
            ) : (
              feed.map((item) => {
                if (item.kind === "chat") {
                  const m = META.chat;
                  return (
                    <button
                      key={item.id}
                      onClick={() => void onChat(item.conversationId)}
                      style={rowStyle(item.unread > 0)}
                    >
                      <span style={iconStyle(m.tint)}>{m.icon}</span>
                      <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                        <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                          <b style={ellipsis}>{item.title}</b>
                          <span className="subtle" style={{ fontSize: 11, flexShrink: 0 }}>{timeAgo(item.time)}</span>
                        </span>
                        <span style={{ fontSize: 13, color: "#6b7280", display: "block", ...ellipsis }}>{item.body}</span>
                      </span>
                      {item.unread > 0 && <span style={countStyle}>{item.unread}</span>}
                    </button>
                  );
                }
                const n = item.notif;
                const m = META[n.type] ?? { icon: "🔔", tint: "#6b7280" };
                return (
                  <button key={item.id} onClick={() => void onSingle(n)} style={rowStyle(!n.read_at)}>
                    <span style={iconStyle(m.tint)}>{m.icon}</span>
                    <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                      <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <b style={ellipsis}>{n.title}</b>
                        <span className="subtle" style={{ fontSize: 11, flexShrink: 0 }}>{timeAgo(n.created_at)}</span>
                      </span>
                      <span style={{ fontSize: 13, color: "#6b7280", display: "block", ...ellipsis }}>{n.body}</span>
                    </span>
                    {!n.read_at && <span style={{ width: 9, height: 9, borderRadius: 5, background: "#e6178d", flexShrink: 0 }} />}
                  </button>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function rowStyle(unread: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: 10, width: "100%",
    padding: "12px 14px", borderBottom: "1px solid #f3f4f6",
    background: unread ? "#fdf2f8" : "white", border: "none", cursor: "pointer",
  };
}
function iconStyle(tint: string): React.CSSProperties {
  return {
    width: 34, height: 34, borderRadius: 17, flexShrink: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: tint + "1a", fontSize: 16,
  };
}
const countStyle: React.CSSProperties = {
  minWidth: 20, height: 20, borderRadius: 10, background: "#e6178d", color: "white",
  fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 5px", flexShrink: 0,
};
