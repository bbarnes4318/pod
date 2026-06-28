"use client";

import React, { useState, useTransition } from "react";
import { toggleHostStatus } from "./actions";

interface ToggleProps {
  hostId: string;
  initialStatus: boolean;
}

export default function HostStatusToggle({ hostId, initialStatus }: ToggleProps) {
  const [isActive, setIsActive] = useState(initialStatus);
  const [isPending, startTransition] = useTransition();

  const handleToggle = async () => {
    const nextStatus = !isActive;
    setIsActive(nextStatus);

    startTransition(async () => {
      const res = await toggleHostStatus(hostId, nextStatus);
      if (!res.success) {
        // Rollback on failure
        setIsActive(isActive);
        alert(res.error || "Failed to update status");
      }
    });
  };

  return (
    <label className="switchContainer" style={{ opacity: isPending ? 0.7 : 1 }}>
      <input
        type="checkbox"
        checked={isActive}
        onChange={handleToggle}
        disabled={isPending}
        style={{
          width: "36px",
          height: "18px",
          accentColor: "#38bdf8",
          cursor: "pointer",
        }}
      />
      <span className="switchLabel">
        {isActive ? (
          <span style={{ color: "#10b981", fontWeight: 700 }}>ACTIVE</span>
        ) : (
          <span style={{ color: "#f59e0b", fontWeight: 700 }}>INACTIVE</span>
        )}
      </span>
    </label>
  );
}
