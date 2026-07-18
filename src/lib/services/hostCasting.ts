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

// Re-export the client-safe matchers so server callers have one import site.
export { makeSpeakerMatchers, makeCastMatchers } from "./hostCastingShared";
export type { CastHost } from "./hostCastingShared";
import { getShowFormat, roleForSeat, DEFAULT_FORMAT_ID } from "@/lib/formats/showFormatRegistry";

export interface DebateHosts {
  hostA: AiHost;
  hostB: AiHost;
}

/** A resolved seat: which host, in which chair, playing which format role. */
export interface EpisodeCastMemberResolved {
  host: AiHost;
  role: string; // ShowFormatRole.id
  orderIndex: number;
}

export interface EpisodeCast {
  formatId: string;
  formatVersion: number;
  members: EpisodeCastMemberResolved[];
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

/**
 * FORMAT-DRIVEN cast resolution (Prompt 7): resolve 1-4 active hosts for an
 * episode according to its show format. Precedence: the pinned `hostIds`
 * (seat order preserved) -> topic-aware pairing (two-seat formats only) ->
 * intensity-ordered fill from the active roster, until the format's REQUIRED
 * seats are filled. Optional seats stay empty when the roster runs out.
 *
 * two_host_debate resolves byte-identically to resolveEpisodeHosts — the
 * legacy wrapper delegates to the same fill logic, so nothing changes for the
 * existing pipeline.
 */
export async function resolveEpisodeCast(
  source: HostCastingSource & { formatId?: string | null },
  context?: EpisodeCastingContext
): Promise<EpisodeCast> {
  const formatId = source.formatId || DEFAULT_FORMAT_ID;
  const format = getShowFormat(formatId);
  if (!format) throw new Error(`Unknown show format '${formatId}'.`);

  // two_host_debate: delegate to the EXISTING resolver so behavior (including
  // the topic-aware pair fallback) is byte-identical to today.
  if (format.id === DEFAULT_FORMAT_ID) {
    const { hostA, hostB } = await resolveEpisodeHosts(source, context);
    return {
      formatId: format.id,
      formatVersion: format.version,
      members: [
        { host: hostA, role: roleForSeat(format, 0).id, orderIndex: 0 },
        { host: hostB, role: roleForSeat(format, 1).id, orderIndex: 1 },
      ],
    };
  }

  const ids = Array.isArray(source.hostIds) ? source.hostIds.filter(Boolean) : [];
  const seated: AiHost[] = [];

  if (ids.length > 0) {
    const selected = await db.aiHost.findMany({ where: { id: { in: ids }, isActive: true } });
    for (const id of ids.slice(0, format.speakerMax)) {
      const h = selected.find((x) => x.id === id);
      if (h && !seated.some((s) => s.id === h.id)) seated.push(h);
    }
  }

  const requiredSeats = format.roles.filter((r) => r.required).length;
  if (seated.length < requiredSeats) {
    const active = await db.aiHost.findMany({
      where: { isActive: true, isArchived: false },
      orderBy: [{ intensityLevel: "desc" }, { name: "asc" }],
    });
    for (const h of active) {
      if (seated.length >= requiredSeats) break;
      if (!seated.some((s) => s.id === h.id)) seated.push(h);
    }
  }

  if (seated.length < format.speakerMin) {
    throw new Error(
      `The '${format.displayName}' format needs at least ${format.speakerMin} active host(s); only ${seated.length} available. Activate more on /admin/personalities.`
    );
  }

  return {
    formatId: format.id,
    formatVersion: format.version,
    members: seated.map((host, i) => ({ host, role: roleForSeat(format, i).id, orderIndex: i })),
  };
}
