"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { generateEpisodesNow } from "@/app/app/podcasts/actions";

export default function GenerateShowEpisodeButton({ podcastId, primary = false }: { podcastId: string; primary?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  const generate = () => {
    setNote(null);
    startTransition(async () => {
      const result = await generateEpisodesNow(podcastId);
      if (result.success) {
        setNote("Episode queued — follow its production in Episodes.");
        router.refresh();
      } else {
        setNote(result.error || "Could not queue the episode.");
      }
    });
  };

  return (
    <span className="genBtnWrap">
      <button type="button" className={primary ? "btnPrimary" : "btnGhost"} disabled={pending} onClick={generate}>
        {pending ? "Queuing…" : "Generate episode"}
      </button>
      {note && <span role="status" className="genBtnNote">{note}</span>}
    </span>
  );
}
