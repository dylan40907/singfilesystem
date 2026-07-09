"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useDialog } from "@/components/ui/useDialog";
import { Room, fetchRooms, ROOM_COLORS } from "@/lib/admissions";
import { Modal } from "@/components/hr/admissions/shared";

/**
 * Manage the per-campus set of rooms that roster students are slotted into and
 * that the Admit dialog offers. Add, rename, set capacity, reorder, delete.
 */
export default function RoomsModal({
  campusId, onClose, onChanged,
}: {
  campusId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { confirm, modal: dialog } = useDialog();
  const [list, setList] = useState<Room[]>([]);
  const [addName, setAddName] = useState("");
  const [addCap, setAddCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function refresh() {
    try { setList(await fetchRooms(campusId)); await onChanged(); }
    catch (e: any) { setErr(e?.message ?? "Load error"); }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [campusId]);

  async function add() {
    const name = addName.trim();
    if (!name) return;
    const capacity = addCap.trim() === "" ? null : Math.max(0, parseInt(addCap, 10) || 0);
    setBusy(true); setErr("");
    const { error } = await supabase.from("hr_admissions_rooms").insert({ campus_id: campusId, name, capacity, order_index: list.length });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setAddName(""); setAddCap("");
    await refresh();
  }

  async function patch(id: string, p: Partial<Room>) {
    setBusy(true); setErr("");
    const { error } = await supabase.from("hr_admissions_rooms").update(p).eq("id", id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await refresh();
  }

  async function remove(r: Room) {
    const ok = await confirm(
      `Delete room “${r.name}”? Students in it stay on the roster but become unassigned.`,
      { title: "Delete room", confirmLabel: "Delete", danger: true }
    );
    if (!ok) return;
    setBusy(true); setErr("");
    const { error } = await supabase.from("hr_admissions_rooms").delete().eq("id", r.id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await refresh();
  }

  async function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    const a = list[idx], b = list[j];
    setBusy(true);
    await supabase.from("hr_admissions_rooms").update({ order_index: b.order_index }).eq("id", a.id);
    await supabase.from("hr_admissions_rooms").update({ order_index: a.order_index }).eq("id", b.id);
    setBusy(false);
    await refresh();
  }

  return (
    <Modal title="Rooms" subtitle="Rooms for this campus (roster placements)" onClose={onClose} width={480}>
      {dialog}
      <div className="stack" style={{ gap: 10 }}>
        {list.length === 0 && <div className="subtle">No rooms yet — add one below.</div>}
        {list.map((r, i) => (
          <RoomRow key={r.id} room={r} disabled={busy}
            onRename={(name) => patch(r.id, { name })}
            onCapacity={(capacity) => patch(r.id, { capacity })}
            onColor={(color) => patch(r.id, { color })}
            onDelete={() => remove(r)}
            onUp={() => move(i, -1)} onDown={() => move(i, 1)}
            isFirst={i === 0} isLast={i === list.length - 1} />
        ))}
        <div className="row" style={{ gap: 8, borderTop: "1px solid #f3f4f6", paddingTop: 12, flexWrap: "wrap" }}>
          <input className="input" placeholder="New room name" value={addName}
            onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            style={{ flex: "1 1 160px" }} />
          <input className="input" placeholder="Cap" value={addCap} onChange={(e) => setAddCap(e.target.value)} inputMode="numeric" style={{ width: 70 }} />
          <button className="btn btn-primary" onClick={() => void add()} disabled={busy || !addName.trim()}>Add</button>
        </div>
        {err ? <div style={{ color: "#b91c1c", fontSize: 12, fontWeight: 600 }}>{err}</div> : null}
      </div>
    </Modal>
  );
}

function RoomRow({
  room, disabled, onRename, onCapacity, onColor, onDelete, onUp, onDown, isFirst, isLast,
}: {
  room: Room;
  disabled: boolean;
  onRename: (name: string) => void;
  onCapacity: (cap: number | null) => void;
  onColor: (color: string) => void;
  onDelete: () => void;
  onUp: () => void;
  onDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const [name, setName] = useState(room.name);
  const [cap, setCap] = useState(room.capacity == null ? "" : String(room.capacity));
  const [colorOpen, setColorOpen] = useState(false);
  const [custom, setCustom] = useState(room.color);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <div className="stack" style={{ gap: 0 }}>
          <button className="btn" style={{ padding: "0 6px", fontSize: 10, lineHeight: 1.4 }} disabled={disabled || isFirst} onClick={onUp} title="Move up">▲</button>
          <button className="btn" style={{ padding: "0 6px", fontSize: 10, lineHeight: 1.4 }} disabled={disabled || isLast} onClick={onDown} title="Move down">▼</button>
        </div>
        <button
          type="button"
          title="Room color"
          disabled={disabled}
          onClick={() => setColorOpen((o) => !o)}
          style={{ width: 26, height: 26, borderRadius: 999, background: room.color, border: "2px solid #e5e7eb", cursor: "pointer", flexShrink: 0 }}
        />
        <input className="input" value={name} onChange={(e) => setName(e.target.value)}
          onBlur={() => { if (name.trim() && name !== room.name) onRename(name.trim()); }}
          disabled={disabled} style={{ flex: 1 }} />
        <input className="input" value={cap} onChange={(e) => setCap(e.target.value)} inputMode="numeric"
          onBlur={() => {
            const next = cap.trim() === "" ? null : Math.max(0, parseInt(cap, 10) || 0);
            if (next !== room.capacity) onCapacity(next);
          }}
          placeholder="Cap" disabled={disabled} style={{ width: 64 }} title="Capacity (optional)" />
        <button className="btn" style={{ color: "#b91c1c" }} disabled={disabled} onClick={onDelete}>Delete</button>
      </div>

      {colorOpen && (
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", paddingLeft: 34 }}>
          {ROOM_COLORS.map((c) => (
            <button key={c} type="button" aria-label={c}
              onClick={() => { onColor(c); setCustom(c); setColorOpen(false); }}
              style={{ width: 24, height: 24, borderRadius: 999, background: c, cursor: "pointer",
                border: room.color.toLowerCase() === c.toLowerCase() ? "3px solid #111827" : "2px solid #e5e7eb" }} />
          ))}
          <label title="Custom color" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)}
              onBlur={() => { if (custom.toLowerCase() !== room.color.toLowerCase()) onColor(custom); }}
              style={{ width: 28, height: 28, padding: 0, border: "1px solid #e5e7eb", borderRadius: 8, background: "none", cursor: "pointer" }} />
            <span className="subtle" style={{ fontSize: 12 }}>Custom</span>
          </label>
        </div>
      )}
    </div>
  );
}
