// The Attendance Ledger — read model for the public /ledger page.
//
// Reads the SAME source of truth the continuity engine folds: each produced
// episode's stored claim. It does not read ShowContinuity's cached counters for
// the per-episode rows, because the cache is a fold of these and the page
// should show the underlying entries, not a summary that could have drifted
// from them.
//
// Every number here is real or absent. There is no placeholder data and no
// projection — an empty ledger renders as an honest empty state.

import { db } from "@/lib/db";
import { PRODUCED_OR_LATER } from "@/lib/episodeStatus";
import { continuityUpdateSchema } from "./showContinuityService";

export interface LedgerEntry {
  episodeId: string;
  episodeTitle: string;
  episodeSlug: string;
  publishedAt: Date | null;
  /** What he announced. */
  claimed: number;
  /** What she read back. */
  real: number;
  /** claimed - real, i.e. the fans he invented that night. */
  phantom: number;
}

export interface LedgerView {
  podcastId: string | null;
  podcastName: string | null;
  entries: LedgerEntry[];
  /** Sum of every phantom figure — the headline number. */
  phantomTotal: number;
  /** How many episodes contributed an attendance claim. */
  episodesWithClaim: number;
  /** The largest single invention. */
  biggest: LedgerEntry | null;
  /** True when nothing has been recorded yet — render the empty state. */
  isEmpty: boolean;
}

/** A produced episode plus whatever continuity claim it stored. */
export interface LedgerSourceRow {
  id: string;
  title: string;
  slug: string;
  publishedAt: Date | null;
  podcastId: string | null;
  continuityUpdate: unknown;
}

/**
 * PURE aggregation — the whole read model except the query. Extracted so the
 * rules that decide what counts as a ledger entry are testable without a
 * database, because those rules are the part that can be silently wrong.
 */
export function summarizeLedger(rows: LedgerSourceRow[]): Omit<LedgerView, "podcastName"> {
  const entries: LedgerEntry[] = [];
  const podcastByEpisode = new Map<string, string | null>();

  for (const ep of rows) {
    podcastByEpisode.set(ep.id, ep.podcastId);
    if (!ep.continuityUpdate) continue;
    const parsed = continuityUpdateSchema.safeParse(ep.continuityUpdate);
    if (!parsed.success) continue; // never guess at a claim that no longer validates
    const { attendanceClaimed, attendanceReal } = parsed.data;
    if (attendanceClaimed === null || attendanceReal === null) continue;
    const phantom = attendanceClaimed - attendanceReal;
    if (phantom <= 0) continue; // the bit is inflation; an honest figure is not an entry
    entries.push({
      episodeId: ep.id,
      episodeTitle: ep.title,
      episodeSlug: ep.slug,
      publishedAt: ep.publishedAt,
      claimed: attendanceClaimed,
      real: attendanceReal,
      phantom,
    });
  }

  // Multi-show deployments: scope to the podcast with the most entries.
  const counts = new Map<string, number>();
  for (const e of entries) {
    const pid = podcastByEpisode.get(e.episodeId);
    if (pid) counts.set(pid, (counts.get(pid) ?? 0) + 1);
  }
  const podcastId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const scoped = podcastId ? entries.filter((e) => podcastByEpisode.get(e.episodeId) === podcastId) : entries;

  const phantomTotal = scoped.reduce((sum, e) => sum + e.phantom, 0);
  const biggest = scoped.reduce<LedgerEntry | null>((best, e) => (!best || e.phantom > best.phantom ? e : best), null);

  return {
    podcastId,
    entries: scoped,
    phantomTotal,
    episodesWithClaim: scoped.length,
    biggest,
    isEmpty: scoped.length === 0,
  };
}

/**
 * Build the ledger for a podcast. Pass null to use the podcast with the most
 * ledger entries (the show, in a single-show deployment).
 */
export async function getLedgerView(podcastId?: string | null): Promise<LedgerView> {
  const episodes = await db.episode.findMany({
    where: {
      status: { in: [...PRODUCED_OR_LATER] },
      ...(podcastId ? { podcastId } : { podcastId: { not: null } }),
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      title: true,
      slug: true,
      publishedAt: true,
      podcastId: true,
      continuityUpdate: true,
      podcast: { select: { id: true, name: true } },
    },
  });

  const summary = summarizeLedger(episodes);
  const podcastName =
    episodes.find((e) => e.podcastId === summary.podcastId)?.podcast?.name ?? null;

  return { ...summary, podcastName };
}
