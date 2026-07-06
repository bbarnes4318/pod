"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { generateEpisodesNow } from "./actions";

export default function GenerateNowButton({ podcastId, solid = false }: { podcastId: string; solid?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  const go = () => {
    setNote(null);
    startTransition(async () => {
      const res = await generateEpisodesNow(podcastId);
      if (res.success) {
        setNote("Episode queued — it shows up under My episodes as it produces.");
        router.refresh();
      } else {
        setNote(res.error || "That didn't work — try again in a moment.");
      }
    });
  };

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: "0.35rem", alignItems: "flex-start" }}>
      <button
        type="button"
        className={solid ? "uPlayLg" : "uRecordBtn"}
        style={solid ? { background: "var(--u-brand)", padding: "0.6rem 1.3rem", fontSize: "0.86rem" } : undefined}
        disabled={pending}
        onClick={go}
      >
        {pending ? "Queuing…" : "⚡ Generate episode now"}
      </button>
      {note && <span role="status" style={{ fontSize: "0.75rem", color: "var(--u-ink-2)", maxWidth: 260 }}>{note}</span>}
    </span>
  );
}
