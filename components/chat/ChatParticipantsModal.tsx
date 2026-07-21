"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChatUserLite,
  addMembers,
  fetchPickableUsers,
  postSystemMessage,
  removeMember,
  userDisplayName,
} from "@/lib/chat";
import { useEscapeKey } from "@/components/ui/useEscapeKey";

/**
 * Group participants. Managers (any role above teacher) can add/remove people;
 * everyone else gets a read-only roster. Each change posts a system note into
 * the thread so there's a visible, timestamped record.
 */
export default function ChatParticipantsModal({
  conversationId,
  members,
  myId,
  canManage,
  onClose,
  onChanged,
}: {
  conversationId: string;
  members: ChatUserLite[];
  myId: string;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  useEscapeKey(onClose);

  const [pickable, setPickable] = useState<ChatUserLite[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const myName = useMemo(() => {
    const me = members.find((m) => m.id === myId);
    return me ? userDisplayName(me) : "Someone";
  }, [members, myId]);

  useEffect(() => {
    if (!canManage) return;
    (async () => {
      try { setPickable(await fetchPickableUsers(myId)); } catch { /* ignore */ }
    })();
  }, [canManage, myId]);

  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    const pool = pickable.filter((u) => !memberIds.has(u.id));
    if (!q) return pool.slice(0, 8);
    return pool.filter((u) => userDisplayName(u).toLowerCase().includes(q)).slice(0, 20);
  }, [pickable, memberIds, search]);

  async function add(u: ChatUserLite) {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      await addMembers(conversationId, [u.id]);
      await postSystemMessage(conversationId, myId, `${myName} added ${userDisplayName(u)}`);
      onChanged();
    } catch (e: any) { setErr(e?.message ?? "Could not add"); }
    finally { setBusy(false); }
  }

  async function remove(u: ChatUserLite) {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      await removeMember(conversationId, u.id);
      await postSystemMessage(conversationId, myId, `${myName} removed ${userDisplayName(u)}`);
      onChanged();
    } catch (e: any) { setErr(e?.message ?? "Could not remove"); }
    finally { setBusy(false); }
  }

  return (
    <div
      onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 300,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div className="card" style={{ width: "min(460px, 100%)", maxHeight: "82vh", display: "flex", flexDirection: "column" }}>
        <div className="row-between" style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Participants</div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        {err ? <div style={{ color: "#b91c1c", fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{err}</div> : null}

        <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 12, color: "#6b7280", margin: "4px 0 6px" }}>
            IN THIS CHAT ({members.length})
          </div>
          {members.map((u) => (
            <div key={u.id} className="row-between" style={{ padding: "7px 2px", gap: 10 }}>
              <span style={{ fontWeight: 600 }}>
                {userDisplayName(u)}{u.id === myId ? <span className="subtle" style={{ fontWeight: 400 }}> (you)</span> : null}
              </span>
              {canManage && u.id !== myId ? (
                <button className="btn" style={{ padding: "3px 10px", fontSize: 12, color: "#b91c1c" }}
                  disabled={busy} onClick={() => void remove(u)}>
                  Remove
                </button>
              ) : null}
            </div>
          ))}

          {canManage ? (
            <>
              <div style={{ fontWeight: 800, fontSize: 12, color: "#6b7280", margin: "14px 0 6px" }}>ADD PEOPLE</div>
              <input
                className="input"
                placeholder="Search people…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ width: "100%", marginBottom: 6 }}
              />
              {candidates.length === 0 ? (
                <div className="subtle" style={{ fontSize: 13, padding: "6px 2px" }}>
                  {search.trim() ? "No matching people." : "Everyone is already in this chat."}
                </div>
              ) : (
                candidates.map((u) => (
                  <div key={u.id} className="row-between" style={{ padding: "7px 2px", gap: 10 }}>
                    <span>{userDisplayName(u)}</span>
                    <button className="btn btn-primary" style={{ padding: "3px 12px", fontSize: 12 }}
                      disabled={busy} onClick={() => void add(u)}>
                      Add
                    </button>
                  </div>
                ))
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
