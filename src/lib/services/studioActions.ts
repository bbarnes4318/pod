// Studio server-action LOGIC, extracted behind an authenticated-user seam so it
// is testable without bypassing the actions. The thin "use server" wrappers in
// app/app/create/actions.ts supply the real ctx (session user + db); tests
// supply a fake user + in-memory db. ownerId ALWAYS comes from ctx.user — never
// the client. reuseOverride is NEVER sent (Admin-only).

import type { PrismaClient } from "@prisma/client";
import { createEpisodeDraft, type CreateEpisodeDraftResult } from "./episodeCreation";
import { getTopicUsage, resolveTopicReusePolicy, type UsageDb } from "./topicUsageService";
import { buildStudioTopicVMs, type RawPoolTopic, type StudioTopicVM } from "./studioTopicPool";
import { loadStudioDraft, saveStudioDraft, clearStudioDraft, type RundownDraftState, type StudioDraftDb } from "./studioDraft";
import { assertCanCreateEpisode as realAssertCanCreateEpisode, assertPremiumVoiceAllowed as realAssertPremiumVoiceAllowed } from "./entitlementService";
import { leadFirst } from "../studio/rundownRules";

/** The authenticated context every Studio action runs under. */
export interface StudioCtx {
  user: { id: string; role: string };
  db: PrismaClient;
}

type EntitlementResult = { ok: true } | { ok: false; error: string; upgrade?: true };
export interface StudioDeps {
  assertCanCreateEpisode?: (userId: string) => Promise<EntitlementResult>;
  assertPremiumVoiceAllowed?: (userId: string, provider?: string) => Promise<EntitlementResult>;
}

export interface StudioEpisodeInput {
  mode: "manual" | "automatic" | "hybrid";
  selectedTopicIds: string[];
  targetTopicCount?: number;
  leadTopicId?: string | null;
  podcastId?: string | null;
  hostIds?: string[];
  ttsProvider?: string;
  ttsVoiceOverrides?: unknown;
  productionStyle?: string;
  sfxDensity?: string;
  title?: string;
  description?: string;
  // Automatic/Hybrid backend selection PREFERENCES (not board display filters).
  verticals?: string[];
  leagueIds?: string[];
  teams?: string[];
  sport?: string;
  minDebateScore?: number;
}

/**
 * OWNERSHIP RULE: a Studio user may only use podcasts they OWN. A null-owner
 * (legacy/system) podcast is NOT implicitly shared to every customer, so it is
 * never listed, scoped to, or usable here.
 */
function ownsPodcast(pod: { ownerId: string | null } | null, user: { id: string; role: string }): boolean {
  if (!pod) return false;
  return pod.ownerId === user.id || user.role === "ADMIN";
}

async function resolveOwnedPodcast(ctx: StudioCtx, podcastId: string) {
  const pod = await ctx.db.podcast.findUnique({
    where: { id: podcastId },
    select: { id: true, ownerId: true, name: true, verticals: true, teams: true, segmentCount: true, hostIds: true },
  });
  if (!pod) return { ok: false as const, error: "That show no longer exists." };
  if (!ownsPodcast(pod, ctx.user)) return { ok: false as const, error: "That show belongs to another account." };
  return { ok: true as const, podcast: pod };
}

/** The topic pool, owner-scoped and (optionally) podcast-scoped. Verifies the
 *  caller owns the podcast before showing its usage. */
export async function getStudioTopicsFor(
  ctx: StudioCtx,
  podcastId?: string | null
): Promise<{ success: true; topics: StudioTopicVM[] } | { success: false; error: string }> {
  let scopedPodcastId: string | undefined;
  if (podcastId) {
    const owned = await resolveOwnedPodcast(ctx, podcastId);
    if (!owned.ok) return { success: false, error: owned.error };
    scopedPodcastId = podcastId;
  }
  const topics = (await ctx.db.topicCandidate.findMany({
    where: { status: { in: ["pending", "approved"] } },
    include: { researchBrief: true },
    orderBy: { createdAt: "desc" },
    take: 60,
  })) as unknown as RawPoolTopic[];

  const usage = await getTopicUsage(topics.map((t) => t.id), { ownerId: ctx.user.id, podcastId: scopedPodcastId }, ctx.db as unknown as UsageDb);
  const policy = resolveTopicReusePolicy();
  const vms = buildStudioTopicVMs(topics, { usage, policy, podcastId: scopedPodcastId }).sort((a, b) => b.talkability - a.talkability);
  return { success: true, topics: vms };
}

/** Studio's podcast view-model. `Podcast.teams` holds Team IDs, but the
 *  auto-selection service matches on team NAMES — so we resolve them here and
 *  expose both. The UI must never show raw ids as if they were names. */
export interface StudioPodcast {
  id: string;
  name: string;
  verticals: string[];
  teamIds: string[];
  teamNames: string[];
  segmentCount: number;
  hostIds: string[];
}

/** The signed-in user's OWN saved shows only (never legacy null-owner podcasts),
 *  with Team IDs resolved to display/selection names. */
export async function getStudioPodcastsFor(ctx: StudioCtx): Promise<{ success: true; podcasts: StudioPodcast[] }> {
  const rows = await ctx.db.podcast.findMany({
    where: { ownerId: ctx.user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, verticals: true, teams: true, segmentCount: true, hostIds: true },
  });
  const allTeamIds = [...new Set(rows.flatMap((p) => p.teams))];
  const teamRows = allTeamIds.length
    ? await ctx.db.team.findMany({ where: { id: { in: allTeamIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(teamRows.map((t) => [t.id, t.name]));
  return {
    success: true,
    podcasts: rows.map((p) => ({
      id: p.id, name: p.name, verticals: p.verticals, segmentCount: p.segmentCount, hostIds: p.hostIds,
      teamIds: p.teams,
      // Unresolved ids are dropped rather than shown as fake names.
      teamNames: p.teams.map((id) => nameById.get(id)).filter((n): n is string => !!n),
    })),
  };
}

export type CreateStudioEpisodeResult =
  | {
      success: true;
      episodeId: string;
      mode: CreateEpisodeDraftResult["mode"];
      selectedTopics: CreateEpisodeDraftResult["selectedTopics"];
      rejectedTopics: CreateEpisodeDraftResult["rejectedTopics"];
      autoSelectedTopicIds: string[];
      finalOrder: string[];
      reasons: string[];
      requestedCount: number;
      concurrentlyDroppedIds: string[];
      draftCleanupWarning?: string;
    }
  | { success: false; error: string; upgrade?: true; rejectedTopics?: CreateEpisodeDraftResult["rejectedTopics"]; reasons?: string[] };

/**
 * Create a draft episode from a Studio rundown, through the SHARED
 * createEpisodeDraft. ownerId is ctx.user.id (session). Podcast ownership is
 * verified; podcast settings are inherited for values the client omits; the
 * automatic/hybrid selection preferences are forwarded; reuseOverride is never
 * sent. Returns the backend finalOrder as the source of truth.
 */
export async function createStudioEpisodeFor(
  ctx: StudioCtx,
  input: StudioEpisodeInput,
  deps: StudioDeps = {}
): Promise<CreateStudioEpisodeResult> {
  const assertCanCreateEpisode = deps.assertCanCreateEpisode ?? realAssertCanCreateEpisode;
  const assertPremiumVoiceAllowed = deps.assertPremiumVoiceAllowed ?? realAssertPremiumVoiceAllowed;

  const quota = await assertCanCreateEpisode(ctx.user.id);
  if (!quota.ok) return { success: false, error: quota.error, upgrade: true };
  const voiceGate = await assertPremiumVoiceAllowed(ctx.user.id, input.ttsProvider);
  if (!voiceGate.ok) return { success: false, error: voiceGate.error, upgrade: true };

  // Podcast ownership + safe inheritance for omitted values.
  let verticals = input.verticals;
  let teams = input.teams;
  let hostIds = input.hostIds?.length ? input.hostIds : undefined;
  let targetTopicCount = input.targetTopicCount;
  if (input.podcastId) {
    const owned = await resolveOwnedPodcast(ctx, input.podcastId);
    if (!owned.ok) return { success: false, error: owned.error };
    if (verticals === undefined && owned.podcast.verticals.length > 0) verticals = owned.podcast.verticals;
    if (teams === undefined && owned.podcast.teams.length > 0) {
      const teamRows = await ctx.db.team.findMany({ where: { id: { in: owned.podcast.teams } }, select: { name: true } });
      teams = teamRows.map((t) => t.name);
    }
    if (!hostIds && owned.podcast.hostIds.length > 0) hostIds = owned.podcast.hostIds.slice(0, 2);
    if (targetTopicCount === undefined && owned.podcast.segmentCount) targetTopicCount = owned.podcast.segmentCount;
  }

  const orderedIds = leadFirst([...input.selectedTopicIds], input.leadTopicId);

  const res = await createEpisodeDraft(
    {
      mode: input.mode,
      selectedTopicIds: input.mode === "automatic" ? [] : orderedIds,
      targetTopicCount,
      ownerId: ctx.user.id, // SESSION user — never the client
      podcastId: input.podcastId ?? undefined,
      hostIds,
      ttsProvider: input.ttsProvider,
      ttsVoiceOverrides: input.ttsVoiceOverrides,
      productionStyle: input.productionStyle,
      sfxDensity: input.sfxDensity,
      // Selection preferences actually reach the backend (auto/hybrid).
      verticals,
      teams,
      leagueIds: input.leagueIds,
      sport: input.sport,
      minDebateScore: input.minDebateScore,
      title: input.title,
      description: input.description,
      strictSelection: input.mode === "manual",
      // reuseOverride intentionally omitted — Admin-only.
    },
    { db: ctx.db }
  );

  if (!res.ok || !res.episodeId) {
    // Failed creation: the resume draft is RETAINED so the producer keeps their work.
    return { success: false, error: res.error || "Couldn't create the episode.", rejectedTopics: res.rejectedTopics, reasons: res.reasons };
  }

  // Success → clear the resume draft. A cleanup failure is NON-fatal but SURFACED
  // (logged + warned) so a stale draft can't silently cause a duplicate.
  let draftCleanupWarning: string | undefined;
  try {
    await clearStudioDraft(ctx.user.id, ctx.db as unknown as StudioDraftDb);
  } catch (err) {
    draftCleanupWarning = "Your episode was created, but the saved draft couldn't be cleared automatically — discard it manually to avoid a duplicate.";
    console.error(`[studio] draft cleanup failed for user=${ctx.user.id} episode=${res.episodeId}:`, (err as Error).message);
  }

  const requestedCount = input.mode === "manual" ? orderedIds.length : targetTopicCount ?? 3;
  const concurrentlyDropped = res.rejectedTopics.filter((r) => r.category === "recently_used_concurrently");
  return {
    success: true,
    episodeId: res.episodeId,
    mode: res.mode,
    selectedTopics: res.selectedTopics,
    rejectedTopics: res.rejectedTopics,
    autoSelectedTopicIds: res.autoSelectedTopicIds,
    finalOrder: res.finalOrder,
    reasons: res.reasons,
    requestedCount,
    concurrentlyDroppedIds: concurrentlyDropped.map((r) => r.id),
    draftCleanupWarning,
  };
}

export async function loadStudioDraftFor(ctx: StudioCtx): Promise<{ success: true; draft: RundownDraftState | null }> {
  const draft = await loadStudioDraft(ctx.user.id, ctx.db as unknown as StudioDraftDb);
  return { success: true, draft };
}

export async function saveStudioDraftFor(ctx: StudioCtx, state: unknown): Promise<{ success: true } | { success: false; error: string }> {
  // Verify a referenced podcast is owned before persisting (defense in depth).
  const podcastId = (state as { podcastId?: string | null } | null)?.podcastId;
  if (podcastId) {
    const owned = await resolveOwnedPodcast(ctx, podcastId);
    if (!owned.ok) return { success: false, error: owned.error };
  }
  const res = await saveStudioDraft(ctx.user.id, state, ctx.db as unknown as StudioDraftDb);
  return res.ok ? { success: true } : { success: false, error: res.error };
}

export async function discardStudioDraftFor(ctx: StudioCtx): Promise<{ success: true }> {
  await clearStudioDraft(ctx.user.id, ctx.db as unknown as StudioDraftDb);
  return { success: true };
}
