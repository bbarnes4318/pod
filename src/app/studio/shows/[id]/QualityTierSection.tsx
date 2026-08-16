"use client";

// Binds the quality-tier picker to its server action.
//
// The picker itself is presentational and knows nothing about persistence; this
// wrapper is the only place that talks to the server, so the rules that matter
// (ownership, tier validation) stay in one server action rather than being
// re-implemented per surface.
//
// It keeps local state so the selection updates immediately on click rather than
// waiting for a round trip and a revalidate — but ONLY after the action reports
// success. An optimistic update that survives a rejected save would show a user
// a tier their show is not actually using, which is worse than a moment's lag on
// a setting they change once.

import React, { useState } from "react";
import QualityTierPicker from "../../QualityTierPicker";
import { setPodcastQualityTier } from "@/app/app/create/actions";
import { toQualityTier, type QualityTier } from "@/lib/providers/llm/qualityTiers";

export default function QualityTierSection({
  podcastId,
  initialTier,
}: {
  podcastId: string;
  /** Raw column value: a tier string, or null when never chosen. */
  initialTier: string | null;
}) {
  const [tier, setTier] = useState<QualityTier | null>(
    initialTier ? toQualityTier(initialTier) : null
  );

  async function save(next: QualityTier) {
    const res = await setPodcastQualityTier(podcastId, next);
    if (!res.ok) {
      // Thrown so the picker renders it inline; it owns the error surface.
      throw new Error(res.error);
    }
    setTier(next);
  }

  return <QualityTierPicker value={tier} onChange={save} />;
}
