// Single source of truth for "which two hosts front this episode."
//
// The show is a two-voice debate, but WHICH two voices is a per-episode
// choice, not a hardcoded pair. Episodes pin their cast in `Episode.hostIds`
// (chosen at build time from the active roster). Every pipeline stage —
// script generation, validation, fact-check, TTS, stitching, content assets —
// resolves its hosts through here so nothing is coupled to specific host
// names. Deactivating a host and activating another is all it takes to change
// who's on the show.
//
// Ordering convention: hostA is the higher-intensity / "emotional" chair,
// hostB the lower-intensity / "analytical" chair. For a pinned cast the
// operator's chosen order wins; for the fallback we sort by intensityLevel so
// the classic duo (Max Voltage 9 vs Dr. Linebreak 3) keeps its historical
// A/B roles and existing episodes render identically.

import { db } from "@/lib/db";
import type { AiHost } from "@prisma/client";

// Re-export the client-safe matcher so server callers have one import site.
export { makeSpeakerMatchers } from "./hostCastingShared";
export type { CastHost } from "./hostCastingShared";

export interface DebateHosts {
  hostA: AiHost;
  hostB: AiHost;
}

/** Minimal shape needed to resolve — accepts a full Episode or just its ids. */
export interface HostCastingSource {
  hostIds?: string[] | null;
}

/**
 * Resolve the two active hosts cast for an episode.
 * Precedence: the episode's pinned `hostIds` (in the operator's order) →
 * the two most-intense active hosts. Throws a clear, actionable error when
 * two active hosts can't be found.
 */
export async function resolveEpisodeHosts(source: HostCastingSource): Promise<DebateHosts> {
  const ids = Array.isArray(source.hostIds) ? source.hostIds.filter(Boolean) : [];

  let hostA: AiHost | null = null;
  let hostB: AiHost | null = null;

  if (ids.length > 0) {
    const selected = await db.aiHost.findMany({ where: { id: { in: ids }, isActive: true } });
    const ordered = ids
      .map((id) => selected.find((h) => h.id === id))
      .filter((h): h is AiHost => !!h);
    hostA = ordered[0] ?? null;
    hostB = ordered[1] ?? null;
  }

  // Fill any unresolved chair from the active roster (most intense first), so a
  // single pinned host still gets a sparring partner and an empty pin falls
  // back to the strongest available pair.
  if (!hostA || !hostB) {
    const active = await db.aiHost.findMany({
      where: { isActive: true },
      orderBy: [{ intensityLevel: "desc" }, { name: "asc" }],
    });
    for (const h of active) {
      if (h.id === hostA?.id || h.id === hostB?.id) continue;
      if (!hostA) hostA = h;
      else if (!hostB) hostB = h;
      else break;
    }
  }

  if (!hostA || !hostB) {
    throw new Error(
      "Two active AI hosts are required to cast a debate. Activate at least two on /admin/personalities."
    );
  }

  return { hostA, hostB };
}
