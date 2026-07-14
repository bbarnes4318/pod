// Derived topic usage + reuse policies.
//
// Usage is NEVER stored on TopicCandidate — it is derived from EpisodeTopic
// (a topic can be consumed by many users, podcasts, and episodes). Reuse is
// allowed by default; optional policies can warn or exclude on recent use.

import { db } from "../db";

export interface TopicUsage {
  topicId: string;
  /** How many episodes have consumed this topic (all owners/podcasts). */
  totalUseCount: number;
  /** Most recent selection timestamp, or null if never used. */
  lastUsedAt: Date | null;
  /** Has the querying user used it in any of their episodes? */
  usedByCurrentUser: boolean;
  /** Has the selected podcast used it? */
  usedByPodcast: boolean;
  /** Uses within the cooldown window (all owners/podcasts). */
  recentUseCount: number;
}

export interface TopicUsageQuery {
  ownerId?: string;
  podcastId?: string;
  /** Cooldown window for recentUseCount (days). Default 7. */
  cooldownDays?: number;
}

/**
 * Compute derived usage for a set of topics from EpisodeTopic joins. One query;
 * empty input short-circuits. Topics never used are returned with zeroed usage.
 */
export async function getTopicUsage(
  topicIds: string[],
  query: TopicUsageQuery = {},
  dbi: any = db
): Promise<Map<string, TopicUsage>> {
  const ids = [...new Set(topicIds)];
  const out = new Map<string, TopicUsage>();
  for (const id of ids) {
    out.set(id, { topicId: id, totalUseCount: 0, lastUsedAt: null, usedByCurrentUser: false, usedByPodcast: false, recentUseCount: 0 });
  }
  if (ids.length === 0) return out;

  const cooldownDays = query.cooldownDays ?? 7;
  const cooldownCutoff = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);

  const joins = await dbi.episodeTopic.findMany({
    where: { topicId: { in: ids } },
    select: {
      topicId: true,
      selectedAt: true,
      episode: { select: { ownerId: true, podcastId: true } },
    },
  });

  for (const j of joins as any[]) {
    const u = out.get(j.topicId);
    if (!u) continue;
    u.totalUseCount++;
    const when: Date | null = j.selectedAt ? new Date(j.selectedAt) : null;
    if (when && (!u.lastUsedAt || when > u.lastUsedAt)) u.lastUsedAt = when;
    if (query.ownerId && j.episode?.ownerId === query.ownerId) u.usedByCurrentUser = true;
    if (query.podcastId && j.episode?.podcastId === query.podcastId) u.usedByPodcast = true;
    if (when && when >= cooldownCutoff) u.recentUseCount++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reuse policy
// ---------------------------------------------------------------------------

export type TopicReuseMode = "allow" | "warn" | "exclude_podcast" | "exclude_episode";

export interface TopicReusePolicy {
  mode: TopicReuseMode;
  cooldownDays: number;
}

/** Read the reuse policy from env. Default: allow (never block reuse). */
export function resolveTopicReusePolicy(env: Record<string, string | undefined> = process.env): TopicReusePolicy {
  const raw = (env.TOPIC_REUSE_MODE || "allow").trim().toLowerCase();
  const mode: TopicReuseMode =
    raw === "warn" || raw === "exclude_podcast" || raw === "exclude_episode" ? (raw as TopicReuseMode) : "allow";
  const days = Number(env.TOPIC_REUSE_COOLDOWN_DAYS);
  return { mode, cooldownDays: Number.isFinite(days) && days > 0 ? Math.floor(days) : 7 };
}

/**
 * Topic ids to EXCLUDE from auto-selection under the current policy. Only the
 * exclude_podcast policy removes anything (topics this podcast used within the
 * cooldown window); allow/warn/exclude_episode never exclude here (same-episode
 * dedupe is handled by the selection itself).
 */
export async function getReuseExcludedTopicIds(
  policy: TopicReusePolicy,
  ctx: { podcastId?: string },
  dbi: any = db
): Promise<string[]> {
  if (policy.mode !== "exclude_podcast" || !ctx.podcastId) return [];
  const cutoff = new Date(Date.now() - policy.cooldownDays * 24 * 60 * 60 * 1000);
  const rows = await dbi.episodeTopic.findMany({
    where: { selectedAt: { gte: cutoff }, episode: { podcastId: ctx.podcastId } },
    select: { topicId: true },
  });
  return [...new Set((rows as any[]).map((r) => r.topicId))];
}

/** Non-blocking warnings for a resolved selection under the policy. */
export function reuseWarnings(policy: TopicReusePolicy, usage: Map<string, TopicUsage>, topicIds: string[]): string[] {
  if (policy.mode !== "warn") return [];
  const warnings: string[] = [];
  for (const id of topicIds) {
    const u = usage.get(id);
    if (u && u.recentUseCount > 0) {
      warnings.push(`Topic ${id} was used ${u.recentUseCount} time(s) in the last ${policy.cooldownDays} days.`);
    }
  }
  return warnings;
}
