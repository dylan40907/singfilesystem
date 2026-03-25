"use client";

import { useState } from "react";
import { ScheduleRoom } from "@/lib/scheduleUtils";

interface RoomHeaderProps {
  room: ScheduleRoom;
  onUpdate: (roomId: string, updates: { name?: string; capacity?: number }) => void;
  onDelete: (roomId: string) => void;
  readOnly?: boolean;
}

export default function RoomHeader({ room, onUpdate, onDelete, readOnly }: RoomHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(room.name);
  const [capacity, setCapacity] = useState(room.capacity);

  function handleSave() {
    onUpdate(room.id, { name: name.trim() || room.name, capacity });
    setEditing(false);
  }

  if (readOnly) {
    return (
      <div
        style={{
          padding: "6px 10px",
          fontWeight: 800,
          fontSize: 13,
          textAlign: "center",
          borderBottom: "1.5px solid #e5e7eb",
          background: "#f9fafb",
        }}
      >
        {room.name}
        <span style={{ color: "#9ca3af", fontWeight: 600, marginLeft: 6, fontSize: 11 }}>
          ({room.capacity})
        </span>
      </div>
    );
  }

  if (editing) {
    return (
      <div
        style={{
          padding: "6px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          borderBottom: "1.5px solid #e5e7eb",
          background: "#fdf2f8",
        }}
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Room name"
          style={{
            padding: "4px 6px",
            borderRadius: 6,
            border: "1px solid #e5e7eb",
            fontSize: 12,
            fontWeight: 700,
          }}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <label style={{ fontSize: 11, color: "#6b7280" }}>Cap:</label>
          <input
            type="number"
            min={1}
            max={10}
            value={capacity}
            onChange={(e) => setCapacity(Math.max(1, parseInt(e.target.value) || 1))}
            style={{
              width: 40,
              padding: "2px 4px",
              borderRadius: 6,
              border: "1px solid #e5e7eb",
              fontSize: 12,
              textAlign: "center",
            }}
          />
        </div>
        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
          <button
            onClick={handleSave}
            style={{
              padding: "2px 8px",
              borderRadius: 6,
              border: "none",
              background: "#e6178d",
              color: "white",
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Save
          </button>
          <button
            onClick={() => {
              onDelete(room.id);
            }}
            style={{
              padding: "2px 8px",
              borderRadius: 6,
              border: "1px solid #fca5a5",
              background: "white",
              color: "#dc2626",
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Delete
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={() => setEditing(true)}
      style={{
        padding: "6px 10px",
        fontWeight: 800,
        fontSize: 13,
        textAlign: "center",
        borderBottom: "1.5px solid #e5e7eb",
        background: "#f9fafb",
        cursor: "pointer",
      }}
      title="Click to edit room"
    >
      {room.name}
      <span style={{ color: "#9ca3af", fontWeight: 600, marginLeft: 6, fontSize: 11 }}>
        ({room.capacity})
      </span>
    </div>
  );
}
