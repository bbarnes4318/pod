// The SHARED rundown → episode creation core, used by BOTH /studio and /admin.
//
// This exists so the two surfaces cannot implement the business rules twice.
// Everything that decides WHAT gets made — podcast inheritance, lead-story
// ordering, the call into createEpisodeDraft, and the result mapping — lives
// here exactly once. The surfaces keep only what genuinely differs:
//
//   Studio  → entitlement/plan gates, owner-scoped podcast access, StudioDraft
//   Admin   → audit logging, global podcast access, AdminDraft
//
// AUTHORITY, NOT RULES. The one capability difference is `reuseOverride`
// (permit a manually-pinned topic the exclude_podcast policy would block for
// recent use). It is stripped here for non-admin actors, so a direct call —
// or a client that hand-crafts the field — can never self-authorize. The rule
// itself (what the override does) is identical for both surfaces.

import type { PrismaClient } from "@prisma/client";
import { createEpisodeDraft, type CreateEpisodeDraftResult } from "./episodeCreation";
import { leadFirst } from "../studio/rundownRules";
import { DEFAULT_TARGET_TOPIC_COUNT } from "../episodeLimits";

/** WHO is creating, and with what authority. Never derived from client input. */
export interface RundownAuthority {
  kind: "owner" | "admin";
  /**
   * The Episode.ownerId to stamp. Studio passes the SESSION user id.
   * Admin passes null: /admin authenticates via HTTP Basic Auth against env
   * vars and has no User row, while Episode.ownerId is a real (nullable) FK to
   * User(id) — so an admin-created episode is ownerless, exactly as the
   * pre-existing admin creation path already behaved.
   */
  ownerId: string | null;
  /** Audit identity (adminIdentity()); admin only. */
  adminId?: string;
}

/** The rundown a surface wants turned into an episode. Mirrors what Studio
 *  already sends; `reuseOverride` is the single admin-gated addition. */
export interface RundownEpisodeInput {
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
  verticals?: string[];
  leagueIds?: string[];
  teams?: string[];
  sport?: string;
  minDebateScore?: number;
  /** ADMIN-ONLY. Ignored (stripped) for owner actors — see the header note. */
  reuseOverride?: boolean;
}

export interface RundownCreationCtx {
  db: PrismaClient;
  authority: RundownAuthority;
  /**
   * Whether this actor may use the referenced podcast. Studio passes an
   * ownership check; Admin passes the authorized global catalog. Access scope
   * is a legitimate authority difference — the inheritance rules applied after
   * it are identical.
   */
  canUsePodcast: (pod: { id: string; ownerId: string | null }) => boolean;
}

export type RundownCreationOutcome =
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
      /** True when the admin override was both requested AND authorized. */
      reuseOverrideApplied: boolean;
    }
  | {
      success: false;
      error: string;
      rejectedTopics?: CreateEpisodeDraftResult["rejectedTopics"];
      reasons?: string[];
    };

/**
 * Resolve a podcast the actor is allowed to use, and inherit the show settings
 * the caller omitted. IDENTICAL for Studio and Admin — only `canUsePodcast`
 * (the access scope) differs.
 */
async function resolveAndInherit(
  ctx: RundownCreationCtx,
  input: RundownEpisodeInput,
  draft: { verticals?: string[]; teams?: string[]; hostIds?: string[]; targetTopicCount?: number }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.podcastId) return { ok: true };

  const pod = await ctx.db.podcast.findUnique({
    where: { id: input.podcastId },
    select: { id: true, ownerId: true, name: true, verticals: true, teams: true, segmentCount: true, hostIds: true },
  });
  if (!pod) return { ok: false, error: "That show no longer exists." };
  if (!ctx.canUsePodcast(pod)) return { ok: false, error: "That show belongs to another account." };

  if (draft.verticals === undefined && pod.verticals.length > 0) draft.verticals = pod.verticals;
  if (draft.teams === undefined && pod.teams.length > 0) {
    // Podcast.teams holds Team IDs, but auto-selection matches on team NAMES.
    const teamRows = await ctx.db.team.findMany({ where: { id: { in: pod.teams } }, select: { name: true } });
    draft.teams = teamRows.map((t: { name: string }) => t.name);
  }
  if (!draft.hostIds && pod.hostIds.length > 0) draft.hostIds = pod.hostIds.slice(0, 2);
  if (draft.targetTopicCount === undefined && pod.segmentCount) draft.targetTopicCount = pod.segmentCount;
  return { ok: true };
}

/**
 * Turn a rundown into a draft episode through the SHARED createEpisodeDraft.
 * The backend's finalOrder is returned as the source of truth — a surface must
 * never present its own optimistic order as the result.
 */
export async function createRundownEpisode(
  ctx: RundownCreationCtx,
  input: RundownEpisodeInput
): Promise<RundownCreationOutcome> {
  const draft = {
    verticals: input.verticals,
    teams: input.teams,
    hostIds: input.hostIds?.length ? input.hostIds : undefined,
    targetTopicCount: input.targetTopicCount,
  };

  const resolved = await resolveAndInherit(ctx, input, draft);
  if (!resolved.ok) return { success: false, error: resolved.error };

  // AUTHORIZATION, enforced server-side at the single choke point: only an
  // admin actor may carry the override. An owner surface cannot pass it, and a
  // direct call with `reuseOverride: true` is NOT self-authorizing.
  const reuseOverrideApplied = ctx.authority.kind === "admin" && input.reuseOverride === true;

  const orderedIds = leadFirst([...input.selectedTopicIds], input.leadTopicId);

  const res = await createEpisodeDraft(
    {
      mode: input.mode,
      selectedTopicIds: input.mode === "automatic" ? [] : orderedIds,
      targetTopicCount: draft.targetTopicCount,
      // Never the client. Studio → session user; Admin → null (no User row).
      ownerId: ctx.authority.ownerId ?? undefined,
      podcastId: input.podcastId ?? undefined,
      hostIds: draft.hostIds,
      ttsProvider: input.ttsProvider,
      ttsVoiceOverrides: input.ttsVoiceOverrides,
      productionStyle: input.productionStyle,
      sfxDensity: input.sfxDensity,
      // Selection preferences actually reach the backend (auto/hybrid).
      verticals: draft.verticals,
      teams: draft.teams,
      leagueIds: input.leagueIds,
      sport: input.sport,
      minDebateScore: input.minDebateScore,
      title: input.title,
      description: input.description,
      strictSelection: input.mode === "manual",
      reuseOverride: reuseOverrideApplied || undefined,
    },
    { db: ctx.db }
  );

  if (!res.ok || !res.episodeId) {
    return { success: false, error: res.error || "Couldn't create the episode.", rejectedTopics: res.rejectedTopics, reasons: res.reasons };
  }

  const requestedCount = input.mode === "manual" ? orderedIds.length : draft.targetTopicCount ?? DEFAULT_TARGET_TOPIC_COUNT;
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
    reuseOverrideApplied,
  };
}
