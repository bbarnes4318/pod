// The Language Ledger — read model for the public /ledger page.
//
// WHAT THIS PAGE IS FOR
//
// It used to be a scoreboard for a running gag: every crowd figure the previous
// seat-B host invented, totalled. That made the show's public artifact a joke
// counter. This one is evidence of a character changing — every institutional
// phrase Cal Mercer reached for, what he was covering when he said it, and
// whether he later took it back.
//
// Reads the SAME source of truth the continuity engine folds: each produced
// episode's stored claim. It does not read ShowContinuity's cached ledger,
// because the cache is a fold of these and the page should show the underlying
// entries, not a summary that could have drifted from them.
//
// Every entry here is real or absent. There is no placeholder data and no
// projection — an empty ledger renders as an honest empty state.

import { db } from "@/lib/db";
import { PRODUCED_OR_LATER } from "@/lib/episodeStatus";
import { continuityUpdateSchema } from "./showContinuityService";

export type LedgerStatus = "used" | "rejected" | "revised";

export interface LedgerEntryView {
  episodeId: string;
  episodeTitle: string;
  episodeSlug: string;
  publishedAt: Date | null;
  /** The phrase, verbatim. */
  phrase: string;
  /** What he was covering when he said it. May be empty. */
  context: string;
  /** "used" until a later episode shows him taking it back. */
  status: LedgerStatus;
}

export interface LedgerView {
  podcastId: string | null;
  podcastName: string | null;
  entries: LedgerEntryView[];
  /** How many phrases are on record. */
  phraseCount: number;
  /** How many he has since rejected or revised — the arc, as a number. */
  takenBackCount: number;
  /** How many episodes contributed at least one phrase. */
  episodesWithEntry: number;
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
 *
 * Resolutions are applied ACROSS episodes: a phrase Cal used in episode 3 and
 * rejected in episode 9 shows as rejected on its episode-3 row. Showing it as
 * still "used" would tell the reader the opposite of what the season did.
 */
export function summarizeLedger(rows: LedgerSourceRow[]): Omit<LedgerView, "podcastName"> {
  const entries: LedgerEntryView[] = [];
  const podcastByEpisode = new Map<string, string | null>();
  /** phrase (lowercased) -> the resolution a later episode applied to it. */
  const resolutions = new Map<string, LedgerStatus>();

  for (const ep of rows) {
    podcastByEpisode.set(ep.id, ep.podcastId);
    if (!ep.continuityUpdate) continue;
    const parsed = continuityUpdateSchema.safeParse(ep.continuityUpdate);
    if (!parsed.success) continue; // never guess at a claim that no longer validates

    for (const used of parsed.data.languageUsed) {
      const phrase = used.phrase.trim();
      if (!phrase) continue;
      entries.push({
        episodeId: ep.id,
        episodeTitle: ep.title,
        episodeSlug: ep.slug,
        publishedAt: ep.publishedAt,
        phrase,
        context: used.context.trim(),
        status: "used",
      });
    }
    for (const res of parsed.data.languageResolved) {
      resolutions.set(res.phrase.trim().toLowerCase(), res.resolution);
    }
  }

  for (const e of entries) {
    const resolved = resolutions.get(e.phrase.toLowerCase());
    if (resolved) e.status = resolved;
  }

  // Multi-show deployments: scope to the podcast with the most entries.
  const counts = new Map<string, number>();
  for (const e of entries) {
    const pid = podcastByEpisode.get(e.episodeId);
    if (pid) counts.set(pid, (counts.get(pid) ?? 0) + 1);
  }
  const podcastId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const scoped = podcastId ? entries.filter((e) => podcastByEpisode.get(e.episodeId) === podcastId) : entries;

  return {
    podcastId,
    entries: scoped,
    phraseCount: scoped.length,
    takenBackCount: scoped.filter((e) => e.status !== "used").length,
    episodesWithEntry: new Set(scoped.map((e) => e.episodeId)).size,
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
