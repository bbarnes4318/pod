// Derived topic usage + reuse policies.
//
// Usage is NEVER stored on TopicCandidate — it is derived from EpisodeTopic.
// PRIVACY: producer-facing usage is SCOPED to the caller's own podcast (when a
// podcastId is given) and/or their own account. NO platform-wide total or
// latest-use date is ever returned here — one customer must never be warned or
// shown usage because a DIFFERENT customer used the same topic. Platform-wide
// aggregates live ONLY in `getGlobalTopicUsageStatsAdmin`, which callers must
// admin-authorize.

import { db } from "../db";

/**
 * The minimal DB surface these helpers touch. Both the real PrismaClient and
 * the in-memory test doubles satisfy it, so we never need `any` at call sites.
 */
export interface UsageDb {
  episodeTopic: {
    findMany: (args: unknown) => Promise<
      Array<{
        topicId: string;
        selectedAt: Date | string | null;
        episode?: { ownerId: string | null; podcastId: string | null } | null;
      }>
    >;
  };
}

/** Producer-facing usage — SCOPED ONLY. Deliberately carries no platform-wide
 *  total or global last-used date, so no surface can accidentally leak another
 *  customer's aggregate usage. */
export interface ScopedTopicUsage {
  topicId: string;
  /** Scoped to the querying OWNER (all podcasts they own). */
  currentOwnerUseCount: number;
  currentOwnerLastUsedAt: Date | null;
  currentOwnerRecentUseCount: number;
  /** Scoped to the selected PODCAST. */
  currentPodcastUseCount: number;
  currentPodcastLastUsedAt: Date | null;
  currentPodcastRecentUseCount: number;
}

export interface TopicUsageQuery {
  ownerId?: string;
  podcastId?: string;
  /** Cooldown window for the *RecentUseCount fields (days). Default 7. */
  cooldownDays?: number;
  /** Exclude a specific episode's joins (e.g. the one being created) so a
   *  first use never counts itself. */
  excludeEpisodeId?: string;
  /** EXPLICIT, documented system scope: an internal/background caller that has
   *  no owner or podcast context (e.g. a maintenance job). Required to call
   *  without an ownerId/podcastId so a producer surface can never silently ask
   *  for unscoped data — the result is still scoped (all-zero unless matched). */
  system?: boolean;
}

function emptyUsage(id: string): ScopedTopicUsage {
  return {
    topicId: id,
    currentOwnerUseCount: 0,
    currentOwnerLastUsedAt: null,
    currentOwnerRecentUseCount: 0,
    currentPodcastUseCount: 0,
    currentPodcastLastUsedAt: null,
    currentPodcastRecentUseCount: 0,
  };
}

const maxDate = (a: Date | null, b: Date | null): Date | null =>
  !a ? b : !b ? a : a > b ? a : b;

/**
 * Compute derived usage for a set of topics, scoped to the querying owner
 * and/or selected podcast. NEVER returns platform-wide figures. A scope is
 * REQUIRED (ownerId, podcastId, or an explicit `system: true`); calling with no
 * scope throws, so a producer surface can't accidentally request global usage.
 */
export async function getTopicUsage(
  topicIds: string[],
  query: TopicUsageQuery,
  dbi: UsageDb = db as unknown as UsageDb
): Promise<Map<string, ScopedTopicUsage>> {
  if (!query || (!query.ownerId && !query.podcastId && !query.system)) {
    throw new Error(
      "getTopicUsage requires a scope: pass ownerId, podcastId, or an explicit { system: true }."
    );
  }
  const ids = [...new Set(topicIds)];
  const out = new Map<string, ScopedTopicUsage>();
  for (const id of ids) out.set(id, emptyUsage(id));
  if (ids.length === 0) return out;

  const cooldownDays = query.cooldownDays ?? 7;
  const cutoff = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);

  const where: Record<string, unknown> = { topicId: { in: ids } };
  if (query.excludeEpisodeId) where.episodeId = { not: query.excludeEpisodeId };

  const joins = await dbi.episodeTopic.findMany({
    where,
    select: { topicId: true, selectedAt: true, episode: { select: { ownerId: true, podcastId: true } } },
  });

  for (const j of joins) {
    const u = out.get(j.topicId);
    if (!u) continue;
    const when: Date | null = j.selectedAt ? new Date(j.selectedAt) : null;
    const recent = !!when && when >= cutoff;

    if (query.ownerId && j.episode?.ownerId === query.ownerId) {
      u.currentOwnerUseCount++;
      u.currentOwnerLastUsedAt = maxDate(u.currentOwnerLastUsedAt, when);
      if (recent) u.currentOwnerRecentUseCount++;
    }
    if (query.podcastId && j.episode?.podcastId === query.podcastId) {
      u.currentPodcastUseCount++;
      u.currentPodcastLastUsedAt = maxDate(u.currentPodcastLastUsedAt, when);
      if (recent) u.currentPodcastRecentUseCount++;
    }
  }
  return out;
}

/** Platform-wide aggregate for a single topic (all owners/podcasts). */
export interface GlobalTopicUsageStat {
  topicId: string;
  totalUseCount: number;
  lastUsedAt: Date | null;
  recentUseCount: number;
  distinctOwners: number;
  distinctPodcasts: number;
}

/** ADMIN-ONLY platform-wide usage stats (all owners/podcasts). Callers MUST be
 *  admin-authorized; never expose this to a producer surface. */
export async function getGlobalTopicUsageStatsAdmin(
  topicIds: string[],
  opts: { cooldownDays?: number } = {},
  dbi: UsageDb = db as unknown as UsageDb
): Promise<Map<string, GlobalTopicUsageStat>> {
  const ids = [...new Set(topicIds)];
  const acc = new Map<string, GlobalTopicUsageStat & { _owners: Set<string>; _podcasts: Set<string> }>();
  for (const id of ids) {
    acc.set(id, { topicId: id, totalUseCount: 0, lastUsedAt: null, recentUseCount: 0, distinctOwners: 0, distinctPodcasts: 0, _owners: new Set(), _podcasts: new Set() });
  }
  const out = new Map<string, GlobalTopicUsageStat>();
  if (ids.length === 0) return out;

  const cutoff = new Date(Date.now() - (opts.cooldownDays ?? 7) * 24 * 60 * 60 * 1000);
  const joins = await dbi.episodeTopic.findMany({
    where: { topicId: { in: ids } },
    select: { topicId: true, selectedAt: true, episode: { select: { ownerId: true, podcastId: true } } },
  });
  for (const j of joins) {
    const u = acc.get(j.topicId);
    if (!u) continue;
    const when = j.selectedAt ? new Date(j.selectedAt) : null;
    u.totalUseCount++;
    u.lastUsedAt = maxDate(u.lastUsedAt, when);
    if (when && when >= cutoff) u.recentUseCount++;
    if (j.episode?.ownerId) u._owners.add(j.episode.ownerId);
    if (j.episode?.podcastId) u._podcasts.add(j.episode.podcastId);
  }
  for (const u of acc.values()) {
    const { _owners, _podcasts, ...rest } = u;
    out.set(u.topicId, { ...rest, distinctOwners: _owners.size, distinctPodcasts: _podcasts.size });
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
 * Topic ids to EXCLUDE from AUTO-selection under exclude_podcast — topics this
 * podcast used within the cooldown window. Scoped strictly to the selected
 * podcast; another podcast's usage never excludes here.
 */
export async function getReuseExcludedTopicIds(
  policy: TopicReusePolicy,
  ctx: { podcastId?: string },
  dbi: UsageDb = db as unknown as UsageDb
): Promise<string[]> {
  if (policy.mode !== "exclude_podcast" || !ctx.podcastId) return [];
  const cutoff = new Date(Date.now() - policy.cooldownDays * 24 * 60 * 60 * 1000);
  const rows = await dbi.episodeTopic.findMany({
    where: { selectedAt: { gte: cutoff }, episode: { podcastId: ctx.podcastId } },
    select: { topicId: true },
  });
  return [...new Set(rows.map((r) => r.topicId))];
}

/** The scoped recent-use count producer warnings/exclusions must use: the
 *  selected podcast's count when a podcastId exists, else the owner's. Never
 *  the platform-wide total. */
export function scopedRecentUseCount(u: ScopedTopicUsage | undefined, ctx: { podcastId?: string }): number {
  if (!u) return 0;
  return ctx.podcastId ? u.currentPodcastRecentUseCount : u.currentOwnerRecentUseCount;
}

/** Non-blocking warnings for a resolved selection under the warn policy —
 *  scoped to the caller (podcast or owner), never global. */
export function reuseWarnings(
  policy: TopicReusePolicy,
  usage: Map<string, ScopedTopicUsage>,
  topicIds: string[],
  ctx: { podcastId?: string }
): string[] {
  if (policy.mode !== "warn") return [];
  const scope = ctx.podcastId ? "this podcast" : "your account";
  const warnings: string[] = [];
  for (const id of topicIds) {
    const n = scopedRecentUseCount(usage.get(id), ctx);
    if (n > 0) warnings.push(`Topic ${id} was used ${n} time(s) by ${scope} in the last ${policy.cooldownDays} days.`);
  }
  return warnings;
}
