"use client";

import { ScheduleRoom } from "@/lib/scheduleUtils";

interface RoomHeaderProps {
  room: ScheduleRoom;
  onUpdate: (roomId: string, updates: { name?: string; columns?: number }) => void;
  onDelete: (roomId: string) => void;
  readOnly?: boolean;
}

export default function RoomHeader({ room, onUpdate, readOnly }: RoomHeaderProps) {
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
          ({room.columns})
        </span>
      </div>
    );
  }

  return (
    <div
      onClick={() => onUpdate(room.id, {})}
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
        ({room.columns})
      </span>
    </div>
  );
}
