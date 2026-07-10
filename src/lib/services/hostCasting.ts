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
// a higher-intensity host keeps the A chair and existing episodes render
// identically. No host name is ever special-cased.

import { db } from "@/lib/db";
import type { AiHost } from "@prisma/client";
import {
  selectBestPair,
  type CastingTopicInput,
  type CastingBriefInput,
} from "./hostCastingShared";

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
 * Optional topic/brief context. When supplied AND no cast is pinned, the
 * fallback picks the best-fit oppositional pair instead of the two most
 * intense. Absent (today's callers) → identical to previous behavior.
 */
export interface EpisodeCastingContext {
  topic?: CastingTopicInput | null;
  brief?: CastingBriefInput | null;
}

/**
 * Resolve the two active hosts cast for an episode.
 * Precedence: the episode's pinned `hostIds` (in the operator's order) →
 * the two most-intense active hosts. Throws a clear, actionable error when
 * two active hosts can't be found.
 */
export async function resolveEpisodeHosts(
  source: HostCastingSource,
  context?: EpisodeCastingContext
): Promise<DebateHosts> {
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

  // Fill any unresolved chair from the active roster. Pinned hostIds above are
  // an absolute override; this only runs for empty/partial pins.
  if (!hostA || !hostB) {
    const active = await db.aiHost.findMany({
      where: { isActive: true, isArchived: false },
      orderBy: [{ intensityLevel: "desc" }, { name: "asc" }],
    });

    // Topic-aware fallback: with no cast pinned and a topic in hand, choose the
    // two hosts who both have a stake AND will disagree — not just the two most
    // intense (which is how a betting persona landed on a nostalgia debate).
    // selectBestPair returns null on a sparse topic / no brief, in which case we
    // drop through to the intensity-sorted fill below (today's behavior).
    if (!hostA && !hostB && context?.topic) {
      const best = selectBestPair(active, context.topic, context.brief ?? undefined);
      if (best) {
        hostA = active[best.aIndex] ?? null;
        hostB = active[best.bIndex] ?? null;
      }
    }

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
