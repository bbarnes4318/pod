// Unified episode-creation domain service — ONE source of truth for turning a
// topic selection into a draft Episode, across /admin, /app, /studio, saved
// podcasts, and the recurring scheduler.
//
// Business rules live here; AUTHORIZATION (who may call) stays in the surface
// server actions. The service never trusts the caller for eligibility: it
// re-validates topics, hosts, TTS/production settings, and owner/podcast access
// against the database and returns a STRUCTURED result — selected, rejected
// (with per-topic reasons), auto-selected, and final order — so no
// user-selected topic is ever silently discarded.

import { z } from "zod";
import { db } from "../db";
import { PLATFORM_MAX_TOPICS, DEFAULT_TARGET_TOPIC_COUNT } from "../episodeLimits";
import {
  TopicWithBrief,
  EpisodeBuildInput,
  EpisodeBuildResult,
  evaluateTopicEligibility,
  selectAutoTopics,
  createEpisodeRecord,
  normalizeEpisodeSettings,
  assertHostsCastable,
} from "./episodeService";
import {
  resolveTopicReusePolicy,
  getReuseExcludedTopicIds,
  getTopicUsage,
  reuseWarnings,
  scopedRecentUseCount,
} from "./topicUsageService";
import { loadPodcastConfiguration, resolveEpisodeConfiguration } from "./podcastConfiguration";
import { buildEpisodeConfigurationSnapshot, type EpisodeSnapshotColumns } from "./episodeConfigurationSnapshot";

/**
 * Fallback configuration snapshot for creation paths that did not pre-resolve
 * one at the surface (the queue / recurring / legacy adapters). A podcast
 * episode resolves ENTIRELY from the show — those paths derive every field from
 * the podcast, so "podcast" provenance is accurate. A standalone episode
 * resolves from the settings actually applied. Studio/Admin pass their own
 * precise snapshot via deps and never reach here.
 */
async function computeCreationSnapshot(
  dbi: Parameters<typeof loadPodcastConfiguration>[0],
  input: { podcastId?: string; verticals?: string[]; hostIds?: string[]; targetTopicCount?: number; minDebateScore?: number },
  settings: { ttsProvider: string | null; ttsVoiceOverrides?: unknown; soundDesign?: { style?: string; sfxDensity?: string } }
): Promise<EpisodeSnapshotColumns | undefined> {
  const podcast = input.podcastId ? await loadPodcastConfiguration(dbi, input.podcastId) : null;
  const resolved = resolveEpisodeConfiguration({
    podcast,
    // A podcast episode inherits from the show (no episode overrides here).
    // A standalone episode captures the settings that were actually applied.
    overrides: podcast
      ? {}
      : {
          verticals: input.verticals,
          hostIds: input.hostIds,
          segmentCount: input.targetTopicCount,
          minDebateScore: input.minDebateScore ?? undefined,
          ttsProvider: settings.ttsProvider ?? undefined,
          ttsVoiceOverrides: settings.ttsVoiceOverrides,
          productionStyle: settings.soundDesign?.style,
          sfxDensity: settings.soundDesign?.sfxDensity,
        },
  });
  if (!resolved.ok) return undefined;
  return buildEpisodeConfigurationSnapshot(resolved.resolved, new Date());
}

/** Configurable cap on topics per episode. Env-tunable DOWN, but never above
 *  the client-safe PLATFORM_MAX_TOPICS — one shared limit, no conflicts. */
export const MAX_TOPICS_PER_EPISODE = (() => {
  const n = Number(process.env.MAX_TOPICS_PER_EPISODE);
  if (Number.isFinite(n) && n >= 1) return Math.min(Math.floor(n), PLATFORM_MAX_TOPICS);
  return PLATFORM_MAX_TOPICS;
})();

export type EpisodeCreationMode = "manual" | "automatic" | "hybrid";

const nonEmptyId = z.string().trim().min(1, "Topic ids must be non-empty strings.");

export const CreateEpisodeDraftInputSchema = z
  .object({
    mode: z.enum(["manual", "automatic", "hybrid"]),
    selectedTopicIds: z.array(nonEmptyId).default([]),
    targetTopicCount: z
      .number()
      .int("targetTopicCount must be a whole number.")
      .positive("targetTopicCount must be positive.")
      .max(MAX_TOPICS_PER_EPISODE, `No more than ${MAX_TOPICS_PER_EPISODE} topics per episode.`)
      .optional(),
    ownerId: z.string().trim().min(1).optional(),
    podcastId: z.string().trim().min(1).optional(),
    title: z.string().trim().max(200).optional(),
    description: z.string().trim().max(4000).optional(),
    verticals: z.array(z.string().trim().min(1)).optional(),
    leagueIds: z.array(z.string().trim().min(1)).optional(),
    teams: z.array(z.string().trim().min(1)).optional(),
    hostIds: z.array(nonEmptyId).optional(),
    ttsProvider: z.string().trim().min(1).optional(),
    ttsVoiceOverrides: z.unknown().optional(),
    productionStyle: z.string().trim().min(1).optional(),
    sfxDensity: z.string().trim().min(1).optional(),
    // Auto-selection narrowing (also honored in hybrid fill).
    minDebateScore: z.number().optional(),
    leagueId: z.string().trim().min(1).optional(),
    sport: z.string().trim().min(1).optional(),
    /** When true, a single ineligible PINNED topic fails the whole request
     *  before any episode is created (all-or-nothing) — the semantics
     *  interactive "I picked exactly these" surfaces want. When false (default),
     *  ineligible pins are reported in rejectedTopics and the build proceeds
     *  from the valid ones. Rejections are surfaced either way — never silent. */
    strictSelection: z.boolean().optional(),
    /** AUTHORIZED override: permit a manually-pinned topic that the
     *  exclude_podcast policy would otherwise block for recent use. The SERVICE
     *  honors it; the SURFACE decides who may pass it (admins yes, ordinary
     *  producers no). Never affects auto-selected topics. */
    reuseOverride: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    const deduped = [...new Set(val.selectedTopicIds.map((s) => s.trim()))];
    const target = val.targetTopicCount ?? DEFAULT_TARGET_TOPIC_COUNT;

    if (val.mode === "manual" && deduped.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedTopicIds"], message: "Manual mode requires at least one selected topic." });
    }
    if (val.mode === "automatic" && deduped.length > 0) {
      // Not fatal, but flag it so the caller knows the picks are ignored.
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedTopicIds"], message: "Automatic mode ignores selectedTopicIds; use manual or hybrid to pin topics." });
    }
    if (val.mode === "hybrid" && deduped.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedTopicIds"], message: "Hybrid mode requires at least one pinned topic (use automatic for none)." });
    }
    if (val.mode === "hybrid" && deduped.length > target) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedTopicIds"], message: `Hybrid mode: pinned topics (${deduped.length}) cannot exceed targetTopicCount (${target}).` });
    }
    if (deduped.length > MAX_TOPICS_PER_EPISODE) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedTopicIds"], message: `No more than ${MAX_TOPICS_PER_EPISODE} topics per episode (got ${deduped.length}).` });
    }
  });

export type CreateEpisodeDraftInput = z.input<typeof CreateEpisodeDraftInputSchema>;

export interface RejectedTopic {
  id: string;
  reason: string;
  category?: string;
}

export interface SelectedTopicRef {
  id: string;
  title: string;
  /** true = the user pinned it; false = system auto-selected. */
  pinned: boolean;
}

export interface CreateEpisodeDraftResult {
  ok: boolean;
  mode: EpisodeCreationMode;
  episodeId: string | null;
  selectedTopics: SelectedTopicRef[];
  rejectedTopics: RejectedTopic[];
  autoSelectedTopicIds: string[];
  finalOrder: string[];
  reasons: string[];
  error?: string;
}

function fail(
  mode: EpisodeCreationMode,
  error: string,
  extra?: Partial<CreateEpisodeDraftResult>
): CreateEpisodeDraftResult {
  return {
    ok: false,
    mode,
    episodeId: null,
    selectedTopics: [],
    rejectedTopics: [],
    autoSelectedTopicIds: [],
    finalOrder: [],
    reasons: [],
    error,
    ...extra,
  };
}

/** Dedupe while preserving first-seen order. Exported for unit testing. */
export function dedupePreserveOrder(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Create a draft episode from a topic selection. Pure business logic — the
 * caller must have already authorized the request and should pass the real
 * `ownerId`. Returns a structured result; only throws on unexpected
 * infrastructure errors.
 */
export async function createEpisodeDraft(
  rawInput: CreateEpisodeDraftInput,
  deps?: { db?: any; configuration?: EpisodeSnapshotColumns }
): Promise<CreateEpisodeDraftResult> {
  const dbi = deps?.db ?? db;
  const parsed = CreateEpisodeDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const mode = (rawInput as { mode?: EpisodeCreationMode })?.mode ?? "manual";
    return fail(mode, first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input.", {
      reasons: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`),
    });
  }
  const input = parsed.data;
  const mode = input.mode;
  const target = input.targetTopicCount ?? DEFAULT_TARGET_TOPIC_COUNT;
  const pinnedIds = dedupePreserveOrder(input.selectedTopicIds);
  const reasons: string[] = [];

  // ---- Settings validation (TTS / production) ----
  let settings;
  try {
    settings = normalizeEpisodeSettings(input);
  } catch (err: any) {
    return fail(mode, err.message);
  }

  // ---- Owner / podcast access ----
  if (input.podcastId) {
    const podcast = await dbi.podcast.findUnique({ where: { id: input.podcastId }, select: { id: true, ownerId: true } });
    if (!podcast) return fail(mode, "That podcast no longer exists.");
    if (podcast.ownerId && input.ownerId && podcast.ownerId !== input.ownerId) {
      return fail(mode, "That podcast belongs to another account.");
    }
  }

  // ---- Host casting (scoped to the owner + shared hosts) ----
  try {
    await assertHostsCastable(input.hostIds || [], input.ownerId, dbi);
  } catch (err: any) {
    return fail(mode, err.message);
  }

  // Reuse policy (default: allow). Resolved up-front so it governs BOTH
  // manually-pinned topics and the auto-fill pool — one policy, applied
  // consistently.
  const policy = resolveTopicReusePolicy();

  // ---- Resolve PINNED topics (manual / hybrid) ----
  const rejectedTopics: RejectedTopic[] = [];
  const pinnedTopics: TopicWithBrief[] = [];
  let autoTopics: TopicWithBrief[] = [];

  if (mode === "manual" || mode === "hybrid") {
    for (const id of pinnedIds) {
      const topic = (await dbi.topicCandidate.findUnique({
        where: { id },
        include: { researchBrief: true },
      })) as unknown as TopicWithBrief | null;
      const eligibility = evaluateTopicEligibility(topic, id);
      if (!eligibility.ok) {
        // Surface the rejection — never silently drop a user pick.
        rejectedTopics.push({ id, reason: eligibility.reason!, category: eligibility.category });
        continue;
      }
      pinnedTopics.push(topic!);
    }

    // exclude_podcast applies to MANUAL/HYBRID pins too: a pin the SELECTED
    // podcast used within the cooldown is BLOCKED (category "recently_used")
    // unless an authorized caller passed reuseOverride. Scoped strictly to this
    // podcast; another customer's use never blocks. Never silently dropped.
    if (policy.mode === "exclude_podcast" && input.podcastId && !input.reuseOverride && pinnedTopics.length > 0) {
      const pinUsage = await getTopicUsage(
        pinnedTopics.map((t) => t.id),
        { podcastId: input.podcastId, cooldownDays: policy.cooldownDays },
        dbi
      );
      const stillPinned: TopicWithBrief[] = [];
      for (const t of pinnedTopics) {
        const n = scopedRecentUseCount(pinUsage.get(t.id), { podcastId: input.podcastId });
        if (n > 0) {
          rejectedTopics.push({
            id: t.id,
            category: "recently_used",
            reason: `Topic '${t.title}' was used ${n} time(s) by this podcast in the last ${policy.cooldownDays} days (reuseOverride required).`,
          });
        } else {
          stillPinned.push(t);
        }
      }
      pinnedTopics.length = 0;
      pinnedTopics.push(...stillPinned);
    }

    // Strict surfaces fail atomically before any record is written when ANY pin
    // is rejected (ineligible OR policy-blocked) — rejections always surfaced.
    if (input.strictSelection && rejectedTopics.length > 0) {
      return fail(mode, `Some selected topics can't be used: ${rejectedTopics.map((r) => r.reason).join(" ")}`, {
        rejectedTopics,
        reasons,
      });
    }
  }

  // ---- Auto-fill (automatic / hybrid) ----
  if (mode === "automatic" || mode === "hybrid") {
    const need = mode === "automatic" ? target : Math.max(0, target - pinnedTopics.length);
    if (need > 0) {
      const policyExcluded = await getReuseExcludedTopicIds(policy, { podcastId: input.podcastId }, dbi);
      const auto = await selectAutoTopics(
        {
          targetCount: need,
          minDebateScore: input.minDebateScore,
          leagueId: input.leagueId,
          leagueIds: input.leagueIds,
          sport: input.sport,
          verticals: input.verticals,
          teamNames: input.teams,
          // Never re-pick a pinned topic (exclude_episode is implicit), and honor
          // the podcast-cooldown policy for auto-selected topics.
          excludeTopicIds: [...pinnedTopics.map((t) => t.id), ...policyExcluded],
        },
        dbi
      );
      autoTopics = auto.chosen;
      reasons.push(...auto.reasons);
    }
  }

  const orderedTopics: TopicWithBrief[] = [...pinnedTopics, ...autoTopics];

  if (orderedTopics.length === 0) {
    return fail(mode, "No valid topic is available to build the episode.", {
      rejectedTopics,
      reasons,
    });
  }

  if (orderedTopics.length > MAX_TOPICS_PER_EPISODE) {
    orderedTopics.length = MAX_TOPICS_PER_EPISODE;
  }

  // ---- Reuse warnings computed from PRIOR usage (BEFORE creating the record) ----
  // The episode does not exist yet, so a first use can NEVER count itself.
  // Scoped to the selected podcast (if any), else the owner — never global. With
  // neither scope (an owner-less system build) there is nothing to warn about.
  if (policy.mode === "warn" && (input.ownerId || input.podcastId)) {
    const priorUsage = await getTopicUsage(
      orderedTopics.map((t) => t.id),
      { ownerId: input.ownerId, podcastId: input.podcastId, cooldownDays: policy.cooldownDays },
      dbi
    );
    reasons.push(...reuseWarnings(policy, priorUsage, orderedTopics.map((t) => t.id), { podcastId: input.podcastId }));
  }

  // ---- Create the record via the single shared primitive ----
  // Under exclude_podcast, hand the creation primitive a reservation so it can
  // re-validate recent use under an advisory lock INSIDE the write transaction
  // (closes the check-then-create race two simultaneous builds would slip
  // through). Only exclude_podcast needs this exclusivity; allow/warn don't.
  const reservation =
    policy.mode === "exclude_podcast" && input.podcastId
      ? {
          podcastId: input.podcastId,
          cooldownDays: policy.cooldownDays,
          reuseOverride: !!input.reuseOverride,
          pinnedIds: new Set(pinnedTopics.map((t) => t.id)),
        }
      : undefined;

  // ---- Freeze the configuration snapshot (Prompt 5) ----
  // Prefer a snapshot the canonical resolver already computed at the surface
  // (Studio/Admin know exactly what the actor overrode vs inherited, so their
  // provenance is precise). Absent that — the queue / recurring / legacy-adapter
  // paths — compute one here: a podcast episode resolves entirely from the show
  // (all values carry "podcast" provenance, which is accurate for those paths),
  // a standalone episode resolves from the applied settings.
  let configuration = deps?.configuration;
  if (!configuration) {
    try {
      configuration = await computeCreationSnapshot(dbi, input, settings);
    } catch {
      // A snapshot must never break creation; the column default keeps it honest.
      configuration = undefined;
    }
  }

  let created;
  try {
    created = await createEpisodeRecord(
      orderedTopics,
      {
        title: input.title,
        description: input.description,
        podcastId: input.podcastId,
        ownerId: input.ownerId,
        hostIds: input.hostIds,
        ttsProvider: settings.ttsProvider,
        ttsVoiceOverrides: settings.ttsVoiceOverrides,
        soundDesign: settings.soundDesign,
        leagueId: input.leagueId,
        sport: input.sport,
        configuration,
      },
      reasons,
      dbi,
      reservation
    );
  } catch (err: any) {
    return fail(mode, err.message || "Failed to create the episode.", { rejectedTopics, reasons });
  }

  // Build the structured result from the ACTUAL written EpisodeTopic rows — never
  // the pre-transaction selection — so the result can never list a topic that has
  // no matching row. The in-transaction concurrency guard may have dropped
  // recently-used auto-selected topics (a pinned drop fails the build above).
  const episodeId = created.episodeId;
  const topicById = new Map(orderedTopics.map((t) => [t.id, t]));
  const writtenSet = new Set(created.writtenTopicIds);
  const pinnedIdSet = new Set(pinnedTopics.map((t) => t.id));

  // Surface every concurrency-dropped topic with a structured rejection so the
  // caller can never mistake the reduced episode for the full requested one.
  for (const droppedId of created.droppedTopicIds) {
    const t = topicById.get(droppedId);
    rejectedTopics.push({
      id: droppedId,
      category: "recently_used_concurrently",
      reason: `Topic '${t?.title ?? droppedId}' was used by this podcast by a concurrent build during creation and was dropped.`,
    });
  }
  if (created.droppedTopicIds.length > 0) {
    // Documented behavior: we CREATE THE SHORTER EPISODE and report the reduced
    // count (rather than failing + retrying). Never silently report the
    // originally requested count as successful.
    reasons.push(
      `Concurrency: ${created.droppedTopicIds.length} topic(s) were used by this podcast during creation and dropped; ` +
        `episode built with ${created.writtenTopicIds.length} topic(s) (requested ${target}).`
    );
  }

  return {
    ok: true,
    mode,
    episodeId,
    selectedTopics: created.writtenTopicIds.map((id) => ({
      id,
      title: topicById.get(id)?.title ?? id,
      pinned: pinnedIdSet.has(id),
    })),
    rejectedTopics,
    autoSelectedTopicIds: autoTopics.map((t) => t.id).filter((id) => writtenSet.has(id)),
    finalOrder: [...created.writtenTopicIds],
    reasons,
  };
}

/**
 * @deprecated Use `createEpisodeDraft` directly. Kept as a thin, queue-safe
 * adapter so the legacy `EpisodeBuildInput`/`EpisodeBuildResult` shape (BullMQ
 * job data, JobLog output) keeps working — it now DELEGATES to
 * `createEpisodeDraft`, so there is exactly ONE selection-policy implementation
 * (reuse policy, ordered dedupe, snapshots, owner/podcast scoping). It maps
 * binary `topicIds` presence to manual/automatic mode and throws on failure to
 * preserve the old error contract.
 *
 * `statusUpdateCount` is always 0: creating an episode no longer mutates any
 * TopicCandidate status (usage is derived from EpisodeTopic).
 */
export async function buildEpisodeFromTopics(
  input: EpisodeBuildInput & { reuseOverride?: boolean },
  deps?: { db?: any }
): Promise<EpisodeBuildResult> {
  const hasExplicit = !!(input.topicIds && input.topicIds.length > 0);
  const draft = await createEpisodeDraft(
    {
      mode: hasExplicit ? "manual" : "automatic",
      selectedTopicIds: input.topicIds ?? [],
      // Queue/legacy builds are lenient: surface rejects, build from the valid
      // ones rather than failing the whole job on a single bad topic.
      strictSelection: false,
      reuseOverride: input.reuseOverride,
      targetTopicCount: input.targetTopicCount,
      ownerId: input.ownerId,
      podcastId: input.podcastId,
      title: input.title,
      description: input.description,
      verticals: input.verticals,
      leagueId: input.leagueId,
      leagueIds: input.leagueIds,
      teams: input.teamNames,
      hostIds: input.hostIds,
      ttsProvider: input.ttsProvider,
      ttsVoiceOverrides: input.ttsVoiceOverrides,
      productionStyle: input.productionStyle,
      sfxDensity: input.sfxDensity,
      minDebateScore: input.minDebateScore,
      sport: input.sport,
    },
    deps
  );

  if (!draft.ok || !draft.episodeId) {
    throw new Error(draft.error || "Fewer than 1 valid topic is available to build the episode.");
  }

  return {
    insertedEpisodeCount: 1,
    selectedTopicCount: draft.finalOrder.length,
    skippedTopicCount: 0,
    invalidTopicCount: draft.rejectedTopics.length,
    missingBriefCount: 0,
    weakEvidenceCount: 0,
    statusUpdateCount: 0, // deprecated: no topic status is ever updated
    selectedTopicIds: draft.finalOrder,
    episodeId: draft.episodeId,
    reasons: draft.reasons,
  };
}
