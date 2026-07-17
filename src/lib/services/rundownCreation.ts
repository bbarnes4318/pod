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
import {
  loadPodcastConfiguration,
  resolveEpisodeConfiguration,
  type LoadedPodcastConfiguration,
  type PodcastConfigurationError,
} from "./podcastConfiguration";
import { buildEpisodeConfigurationSnapshot, type EpisodeSnapshotColumns } from "./episodeConfigurationSnapshot";
import { resolvePodcastSoundProfile, resolveStandaloneSoundProfile } from "./podcastSoundProfile";

/** Turn a structured resolver error into the user-facing message the surfaces
 *  already expect. Kept here so both surfaces render identical copy. */
function resolverErrorMessage(err: PodcastConfigurationError): string {
  switch (err.code) {
    case "podcast_not_found": return "That show no longer exists.";
    case "podcast_forbidden": return "That show belongs to another account.";
    case "unsupported_format": return `The "${err.format}" format is not supported yet.`;
    case "unknown_tts_provider": return `Unknown TTS provider '${err.provider}'.`;
    case "invalid_production_style": return `Unknown production style '${err.style}'.`;
    case "invalid_sfx_density": return `Unknown SFX density '${err.density}'.`;
    case "too_many_hosts": return `A show supports at most two hosts (got ${err.count}).`;
    case "invalid_tts_voice_overrides": return err.message;
    default: return "That show's configuration could not be resolved.";
  }
}

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

/** The fully-resolved inputs to a creation call: the selection/casting draft
 *  (behaviour-identical to the legacy inheritance), the Episode.ownerId to
 *  stamp (owner-corrected for admin-created podcast episodes), the resolved
 *  production settings, and the immutable snapshot to freeze. */
interface ResolvedRundownConfiguration {
  draft: { verticals?: string[]; teams?: string[]; hostIds?: string[]; targetTopicCount?: number };
  ownerId: string | null;
  production: { ttsProvider?: string; ttsVoiceOverrides?: unknown; productionStyle?: string; sfxDensity?: string; minDebateScore?: number };
  configuration: EpisodeSnapshotColumns;
}

/**
 * Resolve a podcast the actor may use through the ONE canonical resolver, then
 * derive: (a) the selection draft — inheriting the settings the caller omitted
 * with EXACTLY the legacy precedence so the created episode is byte-identical;
 * (b) the corrected owner; (c) the immutable configuration snapshot with
 * accurate provenance. IDENTICAL rules for Studio and Admin — only
 * `canUsePodcast` (the access scope) differs.
 */
async function resolveRundownConfiguration(
  ctx: RundownCreationCtx,
  input: RundownEpisodeInput
): Promise<{ ok: true; resolved: ResolvedRundownConfiguration } | { ok: false; error: string }> {
  let podcast: LoadedPodcastConfiguration | null = null;
  if (input.podcastId) {
    podcast = await loadPodcastConfiguration(ctx.db, input.podcastId);
    if (!podcast) return { ok: false, error: "That show no longer exists." };
    if (!ctx.canUsePodcast({ id: podcast.id, ownerId: podcast.ownerId })) {
      return { ok: false, error: "That show belongs to another account." };
    }
  }

  // Resolve with the RAW actor overrides so provenance is accurate.
  const resolvedCfg = resolveEpisodeConfiguration({
    podcast,
    overrides: {
      verticals: input.verticals,
      teams: input.teams,
      hostIds: input.hostIds?.length ? input.hostIds : undefined,
      segmentCount: input.targetTopicCount,
      minDebateScore: input.minDebateScore,
      ttsProvider: input.ttsProvider,
      ttsVoiceOverrides: input.ttsVoiceOverrides,
      productionStyle: input.productionStyle,
      sfxDensity: input.sfxDensity,
    },
  });
  if (!resolvedCfg.ok) return { ok: false, error: resolverErrorMessage(resolvedCfg.error) };

  // ---- Selection draft: replicate the legacy inheritance EXACTLY ----
  // (Only apply a show value when the caller omitted the field AND the show has
  //  a non-empty one — the precise guards the previous code used, so no existing
  //  episode changes shape.)
  const draft: ResolvedRundownConfiguration["draft"] = {
    verticals: input.verticals,
    teams: input.teams,
    hostIds: input.hostIds?.length ? input.hostIds : undefined,
    targetTopicCount: input.targetTopicCount,
  };
  if (podcast) {
    if (draft.verticals === undefined && podcast.editorial.verticals.length > 0) {
      draft.verticals = podcast.editorial.verticals;
    }
    if (draft.teams === undefined && podcast.editorial.teams.length > 0) {
      // Podcast teams are Team IDs, but auto-selection matches on team NAMES.
      const teamRows = await ctx.db.team.findMany({ where: { id: { in: podcast.editorial.teams } }, select: { name: true } });
      draft.teams = teamRows.map((t: { name: string }) => t.name);
    }
    if (!draft.hostIds && podcast.production.hostIds.length > 0) {
      draft.hostIds = podcast.production.hostIds.slice(0, 2);
    }
    if (draft.targetTopicCount === undefined && podcast.editorial.segmentCount) {
      draft.targetTopicCount = podcast.editorial.segmentCount;
    }
  }

  // ---- Owner correction ----
  // Admin creates episodes with no session user (ownerId = null). For a PODCAST
  // episode that would orphan it from its show's owner, so an admin-created
  // podcast episode is stamped with the SHOW's owner. Standalone admin episodes
  // stay ownerless, exactly as before. Owner surfaces already pass their own id.
  let ownerId = ctx.authority.ownerId;
  if (ownerId == null && podcast?.ownerId) ownerId = podcast.ownerId;

  const r = resolvedCfg.resolved;
  // Freeze the sound profile (Prompt 6): podcast episodes freeze the show's
  // profile; standalone episodes freeze the shared system default and never
  // inherit any Podcast's private assets. Same rule as the snapshot itself:
  // a profile-freeze failure must never break creation — the snapshot simply
  // omits the profile and the render uses the legacy compatibility path.
  let soundProfile;
  try {
    soundProfile = podcast
      ? await resolvePodcastSoundProfile(ctx.db, { id: podcast.id, ownerId: podcast.ownerId }, podcast.production)
      : await resolveStandaloneSoundProfile(ctx.db);
  } catch {
    soundProfile = undefined;
  }
  return {
    ok: true,
    resolved: {
      draft,
      ownerId,
      production: {
        ttsProvider: r.production.ttsProvider.value ?? undefined,
        ttsVoiceOverrides: r.production.ttsVoiceOverrides.value ?? undefined,
        productionStyle: r.production.productionStyle.value ?? undefined,
        sfxDensity: r.production.sfxDensity.value ?? undefined,
        minDebateScore: r.editorial.minDebateScore.value ?? undefined,
      },
      configuration: buildEpisodeConfigurationSnapshot(r, new Date(), soundProfile),
    },
  };
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
  const resolution = await resolveRundownConfiguration(ctx, input);
  if (!resolution.ok) return { success: false, error: resolution.error };
  const { draft, ownerId, production, configuration } = resolution.resolved;

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
      // Never the client. Studio → session user; Admin → null, except an
      // admin-created PODCAST episode inherits the show's owner (owner
      // correction) so it is not orphaned from its show.
      ownerId: ownerId ?? undefined,
      podcastId: input.podcastId ?? undefined,
      hostIds: draft.hostIds,
      // Resolved production values (episode override > show > default). For
      // today's data these equal the raw episode inputs, so nothing changes.
      ttsProvider: production.ttsProvider,
      ttsVoiceOverrides: production.ttsVoiceOverrides,
      productionStyle: production.productionStyle,
      sfxDensity: production.sfxDensity,
      // Selection preferences actually reach the backend (auto/hybrid).
      verticals: draft.verticals,
      teams: draft.teams,
      leagueIds: input.leagueIds,
      sport: input.sport,
      minDebateScore: production.minDebateScore,
      title: input.title,
      description: input.description,
      strictSelection: input.mode === "manual",
      reuseOverride: reuseOverrideApplied || undefined,
    },
    // Pass the precise, provenance-accurate snapshot so createEpisodeDraft
    // persists it rather than recomputing a coarser one.
    { db: ctx.db, configuration },
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
