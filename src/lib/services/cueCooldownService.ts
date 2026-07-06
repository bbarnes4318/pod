// DB-backed cooldown store for the production planner: which sound assets
// the last N rendered episodes consumed. Read at plan time, written after a
// successful planner-driven render. Failures here must never sink a render —
// callers treat both operations as best-effort.

import { db } from "@/lib/db";
import type { CooldownSnapshot } from "@/lib/audio/productionPlanner";
import type { ProductionPlan } from "@/lib/audio/productionPlan";
import { planAssetUsage } from "@/lib/audio/productionPlanner";

/**
 * Build the planner's cooldown snapshot: the most recent `episodeCount`
 * distinct episodes (by latest usage time, newest first) and the asset IDs
 * each consumed. The episode currently being rendered is excluded so a
 * re-render doesn't cool itself down.
 */
export async function readCooldownSnapshot(opts: {
  episodeCount: number;
  excludeEpisodeId?: string;
}): Promise<CooldownSnapshot> {
  if (opts.episodeCount <= 0) return { episodes: [] };
  // Recent rows are plenty: even a hype episode uses a couple dozen cues.
  const rows = await db.soundCueUsage.findMany({
    where: opts.excludeEpisodeId ? { episodeId: { not: opts.excludeEpisodeId } } : undefined,
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

/**
 * Record what a rendered plan consumed. Replaces any prior rows for the
 * episode (a re-render supersedes, never double-counts).
 */
export async function recordPlanUsage(plan: ProductionPlan): Promise<void> {
  const usage = planAssetUsage(plan);
  await db.$transaction([
    db.soundCueUsage.deleteMany({ where: { episodeId: plan.episodeId } }),
    ...(usage.length > 0
      ? [
          db.soundCueUsage.createMany({
            data: usage.map((u) => ({
              episodeId: plan.episodeId,
              scriptId: plan.scriptId,
              assetId: u.assetId,
              assetName: u.assetName,
              cueType: u.cueType,
            })),
          }),
        ]
      : []),
  ]);
}
