// DB-backed cooldown store for the production planner: which sound assets
// the last N rendered episodes consumed. Read at plan time, written after a
// successful planner-driven render. Failures here must never sink a render —
// callers treat both operations as best-effort.
//
// Prompt 6: cooldown is SCOPED, never global. The default scope is the
// Podcast (only THIS show's prior usage rotates its sound); "owner" widens to
// all of one owner's shows. Another customer's usage must never influence a
// show's rotation, and shared system assets never become globally "used up".
// Ownerless internal episodes require an EXPLICIT system flag — a missing
// scope is an error, not silently global.

import { db } from "@/lib/db";
import type { CooldownSnapshot } from "@/lib/audio/productionPlanner";
import type { ProductionPlan } from "@/lib/audio/productionPlan";
import { planAssetUsage } from "@/lib/audio/productionPlanner";

export type CooldownScopeFilter =
  | { kind: "podcast"; podcastId: string }
  | { kind: "owner"; ownerId: string }
  /** Ownerless, podcast-less internal episodes only. Deliberately explicit so
   *  a missing scope can never silently mean "global". */
  | { kind: "system" };

function scopeWhere(scope: CooldownScopeFilter) {
  switch (scope.kind) {
    case "podcast":
      return { podcastId: scope.podcastId };
    case "owner":
      return { ownerId: scope.ownerId };
    case "system":
      // Internal episodes: only usage that itself has no owner and no podcast.
      return { ownerId: null, podcastId: null };
  }
}

/**
 * Build the planner's cooldown snapshot: the most recent `episodeCount`
 * distinct episodes WITHIN THE SCOPE (newest first) and the asset IDs each
 * consumed. The episode currently being rendered is excluded so a re-render
 * doesn't cool itself down.
 */
export async function readCooldownSnapshot(opts: {
  episodeCount: number;
  scope: CooldownScopeFilter;
  excludeEpisodeId?: string;
}): Promise<CooldownSnapshot> {
  if (opts.episodeCount <= 0) return { episodes: [] };
  const rows = await db.soundCueUsage.findMany({
    where: {
      ...scopeWhere(opts.scope),
      ...(opts.excludeEpisodeId ? { episodeId: { not: opts.excludeEpisodeId } } : {}),
    },
    orderBy: { usedAt: "desc" },
    take: 500,
  });

  const episodes: Array<{ episodeId: string; assetIds: string[] }> = [];
  const byEpisode = new Map<string, Set<string>>();
  for (const row of rows) {
    let set = byEpisode.get(row.episodeId);
    if (!set) {
      if (byEpisode.size >= opts.episodeCount) continue; // beyond the window
      set = new Set<string>();
      byEpisode.set(row.episodeId, set);
      episodes.push({ episodeId: row.episodeId, assetIds: [] });
    }
    set.add(row.assetId);
  }
  for (const ep of episodes) {
    ep.assetIds = [...(byEpisode.get(ep.episodeId) ?? [])];
  }
  return { episodes };
}

/** Facts frozen onto each usage row so later asset edits cannot rewrite what
 *  a render actually consumed. */
export interface UsageContext {
  renderId?: string | null;
  ownerId?: string | null;
  podcastId?: string | null;
  selectionSource: "podcast_assignment" | "system_default" | "production_planner" | "episode_highlight" | "historical_reproduction";
  /** assetId -> frozen facts (from the episode's frozen sound profile). */
  assetFacts?: Map<string, { kind: string; scope: string; contentHash: string | null; gainDb: number | null; fadeInMs: number | null; fadeOutMs: number | null }>;
}

/**
 * Record what a rendered plan consumed, with owner/podcast scoping and
 * per-asset provenance. Replaces any prior rows for the episode (a re-render
 * supersedes, never double-counts).
 */
export async function recordPlanUsage(plan: ProductionPlan, ctx?: UsageContext): Promise<void> {
  const usage = planAssetUsage(plan);
  await db.$transaction([
    // Supersede semantics: when this render is version-tracked, only
    // UN-versioned (pre-Prompt-6) rows for the episode are replaced — each
    // versioned render KEEPS its exact usage history forever. Without a render
    // id (legacy path) the old replace-per-episode behavior applies.
    db.soundCueUsage.deleteMany({
      where: ctx?.renderId ? { episodeId: plan.episodeId, renderId: null } : { episodeId: plan.episodeId },
    }),
    ...(usage.length > 0
      ? [
          db.soundCueUsage.createMany({
            data: usage.map((u, i) => {
              const facts = ctx?.assetFacts?.get(u.assetId);
              return {
                episodeId: plan.episodeId,
                scriptId: plan.scriptId,
                assetId: u.assetId,
                assetName: u.assetName,
                cueType: u.cueType,
                renderId: ctx?.renderId ?? null,
                ownerId: ctx?.ownerId ?? null,
                podcastId: ctx?.podcastId ?? null,
                orderIndex: i,
                selectionSource: ctx?.selectionSource ?? "production_planner",
                assetKind: facts?.kind ?? null,
                assetScope: facts?.scope ?? null,
                assetContentHash: facts?.contentHash ?? null,
                gainDb: facts?.gainDb ?? null,
                fadeInMs: facts?.fadeInMs ?? null,
                fadeOutMs: facts?.fadeOutMs ?? null,
              };
            }),
          }),
        ]
      : []),
  ]);
}
