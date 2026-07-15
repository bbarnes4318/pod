import { db } from "../db";
import { Prisma } from "@prisma/client";
import crypto from "crypto";
import { topicMatchesAnyVertical } from "../verticals";
import { scoreTopicTalkability } from "./talkabilityService";
import { isTtsProviderId } from "../providers/tts/providerIds";
import { TtsVoiceOverrides, validateTtsVoiceOverridesInput } from "../providers/tts/voiceResolution";
import { isProductionStyle, isSfxDensity } from "../audio/soundDesignShared";
import { resolveEpisodeHosts } from "./hostCasting";
import { buildTopicSnapshot } from "./topicSnapshot";
import { reserveRecentlyUsedTopics, supportsAdvisoryLocks } from "./topicReservation";
import { evaluateHardGates, type EligibilityTopic } from "./topicEligibility";
import { DEFAULT_MIN_DEBATE_SCORE, DEFAULT_MIN_TALKABILITY } from "../episodeLimits";

/** In-transaction concurrency guard for the exclude_podcast reuse policy. When
 *  present, `createEpisodeRecord` acquires advisory locks and re-validates
 *  recent use INSIDE the creation transaction, so two concurrent builds for the
 *  same podcast + topic can never both succeed. */
export interface EpisodeReuseReservation {
  podcastId: string;
  cooldownDays: number;
  /** Authorized override: keep a recently-used PINNED topic anyway. Never
   *  applies to auto-selected topics. */
  reuseOverride: boolean;
  /** Ids the user explicitly pinned (vs. auto-selected fill). */
  pinnedIds: Set<string>;
}

/** The AUTHORITATIVE outcome of writing an episode: which topics actually got
 *  EpisodeTopic rows (in written order) and which the in-transaction concurrency
 *  guard dropped. Callers MUST build their structured result from
 *  `writtenTopicIds` — never from the pre-transaction selection — so the result
 *  can never claim a topic that has no matching row. */
export interface CreatedEpisodeRecord {
  episodeId: string;
  /** Topic ids that received an EpisodeTopic row, in orderIndex order. */
  writtenTopicIds: string[];
  /** Auto-selected topic ids the concurrency guard dropped (used by another
   *  build for this podcast between selection and the locked write). */
  droppedTopicIds: string[];
}

export interface EpisodeBuildInput {
  title?: string;
  description?: string;
  topicIds?: string[];
  leagueId?: string;
  sport?: string;
  targetTopicCount?: number;
  minDebateScore?: number;
  /** Podcast this episode belongs to; persisted on the Episode row. */
  podcastId?: string;
  /** User.id of the creator; persisted as Episode.ownerId (null for
   *  scheduler/system-generated episodes). */
  ownerId?: string;
  /** Restrict auto-selection to these leagues (multi-vertical podcasts). */
  leagueIds?: string[];
  /** Restrict auto-selection to topics matching any of these verticals
   *  (sports verticals match on league; Gambling/Fantasy/Poker match on
   *  seeded league rows, betting score, or keywords). */
  verticals?: string[];
  /** Restrict selection to topics that mention any of these team names.
   *  Hard filter while matches exist; falls back to vertical-wide with a
   *  recorded reason when nothing matches, so a quiet news day never
   *  bricks a recurring show. */
  teamNames?: string[];
  /** AiHost ids to cast for this episode (persisted; script generation uses
   *  them, falling back to the default duo when empty). */
  hostIds?: string[];
  /** Voice engine chosen at build time; persisted on the Episode so every
   *  TTS run (and re-run) for it uses the same provider. Omit for the
   *  host-profile/env default. */
  ttsProvider?: string;
  /** Per-host voice picks keyed by host slug, each tagged with the provider
   *  it belongs to: { "max-voltage": { provider, voiceId, voiceName? } }.
   *  Persisted on the Episode so every TTS run uses the same voices. */
  ttsVoiceOverrides?: TtsVoiceOverrides;
  /** Post-production depth for this episode: "clean" | "light" | "full". */
  productionStyle?: string;
  /** Reaction-SFX density: "subtle" | "medium" | "hype". */
  sfxDensity?: string;
  /** AUTHORIZED override for the exclude_podcast reuse policy on pinned topics
   *  (admin/system callers only). */
  reuseOverride?: boolean;
}

export interface EpisodeBuildResult {
  insertedEpisodeCount: number;
  selectedTopicCount: number;
  skippedTopicCount: number;
  invalidTopicCount: number;
  missingBriefCount: number;
  weakEvidenceCount: number;
  statusUpdateCount: number;
  selectedTopicIds: string[];
  episodeId: string | null;
  reasons: string[];
}

/** A topic candidate joined with its research brief (the shape every
 *  eligibility + selection helper below operates on). */
export type TopicWithBrief = {
  id: string;
  title: string;
  status: string;
  sport: string;
  leagueId: string | null;
  summary: string | null;
  debateScore: number;
  bettingRelevanceScore: number;
  evidenceIds: unknown;
  createdAt: Date;
  researchBrief: {
    facts: unknown;
    sourceIds: unknown;
    argumentForHostA: string | null;
    argumentForHostB: string | null;
    mainAngle?: string | null;
    contrarianAngle?: string | null;
  } | null;
};

/** Why a topic candidate can't anchor an episode: an approved status plus a
 *  research brief carrying real evidence, facts, sources, and both host
 *  arguments. Returns null when the topic is eligible. This is the SINGLE
 *  source of truth for topic eligibility — the explicit-selection path, the
 *  auto-selection path, and the admin eligibility list all defer to it. */
export type TopicRejectionCategory =
  | "not_found"
  | "not_approved"
  | "weak_evidence"
  | "missing_brief";

export interface TopicEligibility {
  ok: boolean;
  category?: TopicRejectionCategory;
  reason?: string;
}

/** Fine-grained shared code -> this path's coarse rejection category. Keeping the
 *  mapping explicit is what lets one implementation serve both the creation path
 *  and the editorial pickers without drifting. */
const COARSE_CATEGORY: Record<string, TopicRejectionCategory> = {
  not_found: "not_found",
  pending_approval: "not_approved",
  rejected: "not_approved",
  archived: "not_approved",
  insufficient_evidence: "weak_evidence",
  missing_sources: "weak_evidence",
  missing_brief: "missing_brief",
  missing_facts: "missing_brief",
  missing_host_arguments: "missing_brief",
};

/**
 * DELEGATES to the shared hard gates in topicEligibility.ts — there is exactly
 * ONE implementation of "can this topic anchor an episode", shared with every
 * editorial surface. This wrapper preserves the legacy coarse category + message
 * that the creation path and its tests rely on.
 */
export function evaluateTopicEligibility(
  topic: TopicWithBrief | null | undefined,
  idForMessage?: string
): TopicEligibility {
  const reasons = evaluateHardGates(topic as EligibilityTopic | null | undefined, idForMessage);
  if (reasons.length === 0) return { ok: true };
  const first = reasons[0];
  return { ok: false, category: COARSE_CATEGORY[first.code] ?? "missing_brief", reason: first.message };
}

/** Fold an eligibility rejection into the shared counter shape. */
function tallyRejection(
  category: TopicRejectionCategory,
  counters: { invalidTopicCount: number; missingBriefCount: number; weakEvidenceCount: number }
): void {
  if (category === "not_found" || category === "not_approved") counters.invalidTopicCount++;
  else if (category === "missing_brief") counters.missingBriefCount++;
  else if (category === "weak_evidence") counters.weakEvidenceCount++;
}

function slugify(text: string): string {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]+/g, "")
    .replace(/\-\-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

export interface AutoSelectOptions {
  targetCount: number;
  minDebateScore?: number;
  leagueId?: string;
  leagueIds?: string[];
  sport?: string;
  verticals?: string[];
  teamNames?: string[];
  /** Topic ids to leave out of the ranked pool (hybrid pins them separately). */
  excludeTopicIds?: string[];
}

export interface AutoSelectResult {
  chosen: TopicWithBrief[];
  reasons: string[];
  skippedTopicCount: number;
  missingBriefCount: number;
  weakEvidenceCount: number;
}

/**
 * Rank the approved topic pool by TALKABILITY (measured research richness)
 * blended with the LLM debate score, apply the podcast filters
 * (vertical / team / league / sport / min-score), enforce topic eligibility,
 * and return the top `targetCount`. Shared by the legacy auto path and the
 * new hybrid fill — one ranking, one filter chain.
 */
export async function selectAutoTopics(opts: AutoSelectOptions, dbi: any = db): Promise<AutoSelectResult> {
  const result: AutoSelectResult = {
    chosen: [],
    reasons: [],
    skippedTopicCount: 0,
    missingBriefCount: 0,
    weakEvidenceCount: 0,
  };
  const targetCount = Math.max(0, Math.floor(opts.targetCount));
  if (targetCount === 0) return result;

  // AUTOMATIC-only floors — shared constants so the pickers and this ranking
  // can never drift apart (they must never gate MANUAL visibility).
  const minScore = opts.minDebateScore !== undefined ? Number(opts.minDebateScore) : DEFAULT_MIN_DEBATE_SCORE;
  const exclude = new Set(opts.excludeTopicIds || []);

  const rawCandidates = (await dbi.topicCandidate.findMany({
    where: { status: "approved" },
    include: { researchBrief: true },
    orderBy: { debateScore: "desc" },
  })) as unknown as TopicWithBrief[];

  const minTalkability = Number(process.env.TOPIC_MIN_TALKABILITY) || DEFAULT_MIN_TALKABILITY;
  const ranked = rawCandidates
    .filter((t) => !exclude.has(t.id))
    .map((t) => {
      const talkability = scoreTopicTalkability({
        title: t.title,
        summary: t.summary,
        createdAt: t.createdAt,
        brief: t.researchBrief,
      });
      const rank = talkability.total * 0.6 + Math.min(100, t.debateScore) * 0.4;
      return { t, talkability, rank };
    })
    .sort((a, b) => b.rank - a.rank);

  const candidates: TopicWithBrief[] = [];
  for (const r of ranked) {
    if (r.talkability.total < minTalkability) {
      result.skippedTopicCount++;
      result.reasons.push(`Skipped '${r.t.title}': talkability ${r.talkability.total}/100 below minimum ${minTalkability}.`);
      continue;
    }
    candidates.push(r.t);
  }

  // Vertical filter (podcast configs).
  if (opts.verticals && opts.verticals.length > 0) {
    const before = candidates.length;
    const matching = candidates.filter((t) =>
      topicMatchesAnyVertical(
        { leagueId: t.leagueId, sport: t.sport, title: t.title, summary: t.summary, bettingRelevanceScore: t.bettingRelevanceScore },
        opts.verticals!
      )
    );
    candidates.length = 0;
    candidates.push(...matching);
    result.skippedTopicCount += before - matching.length;
    result.reasons.push(`Vertical filter [${opts.verticals.join(", ")}]: ${matching.length}/${before} candidate(s) qualify.`);
  }

  // Team filter: hard while a match exists, explicit vertical-wide fallback.
  const teamNeedles = (opts.teamNames || [])
    .flatMap((n) => {
      const full = n.toLowerCase();
      const nickname = full.split(" ").slice(-1)[0];
      return nickname.length >= 4 ? [full, nickname] : [full];
    })
    .filter(Boolean);
  if (teamNeedles.length > 0) {
    const mentionsTeam = (t: TopicWithBrief) => {
      const text = `${t.title} ${t.summary || ""}`.toLowerCase();
      return teamNeedles.some((needle) => text.includes(needle));
    };
    const matching = candidates.filter(mentionsTeam);
    if (matching.length > 0) {
      candidates.length = 0;
      candidates.push(...matching);
      result.reasons.push(`Team filter active: restricted to ${matching.length} candidate(s) mentioning a followed team.`);
    } else {
      result.reasons.push("Team filter: no candidate mentions a followed team today — fell back to vertical-wide selection.");
    }
  }

  for (const t of candidates) {
    if (t.debateScore < minScore) {
      result.skippedTopicCount++;
      continue;
    }
    if (opts.leagueId && t.leagueId?.toUpperCase() !== opts.leagueId.toUpperCase()) {
      result.skippedTopicCount++;
      continue;
    }
    if (opts.leagueIds && opts.leagueIds.length > 0 && !opts.leagueIds.includes((t.leagueId || "").toUpperCase())) {
      result.skippedTopicCount++;
      continue;
    }
    if (opts.sport && t.sport.toLowerCase() !== opts.sport.toLowerCase()) {
      result.skippedTopicCount++;
      continue;
    }

    const eligibility = evaluateTopicEligibility(t, t.id);
    if (!eligibility.ok) {
      tallyRejection(eligibility.category!, result as any);
      continue;
    }

    result.chosen.push(t);
    if (result.chosen.length >= targetCount) break;
  }

  return result;
}

/** Normalized creation settings shared by every creation entry point. */
export interface EpisodeCreationSettings {
  title?: string;
  description?: string;
  podcastId?: string;
  ownerId?: string;
  hostIds?: string[];
  ttsProvider?: string | null;
  ttsVoiceOverrides?: TtsVoiceOverrides;
  soundDesign?: { style?: string; sfxDensity?: string };
  /** Used only to derive a default title when none is given. */
  leagueId?: string;
  sport?: string;
}

/**
 * Create the Episode row + ordered EpisodeTopic joins + mark topics used,
 * atomically. When no host cast was pinned, pick the two hosts that best fit
 * and most disagree on the primary topic. This is the ONE place an episode
 * record is written; every entry point routes through it.
 */
export async function createEpisodeRecord(
  orderedTopics: TopicWithBrief[],
  settings: EpisodeCreationSettings,
  reasons: string[],
  dbi: any = db,
  reservation?: EpisodeReuseReservation
): Promise<CreatedEpisodeRecord> {
  let chosenHostIds = [...new Set(settings.hostIds || [])];

  if (chosenHostIds.length === 0) {
    try {
      const primary = orderedTopics[0];
      const brief = primary?.researchBrief;
      const { hostA, hostB } = await resolveEpisodeHosts(
        { hostIds: [] },
        {
          topic: primary
            ? { sport: primary.sport, leagueId: primary.leagueId, title: primary.title, summary: primary.summary }
            : null,
          brief: brief ? { mainAngle: brief.mainAngle ?? null, contrarianAngle: brief.contrarianAngle ?? null } : null,
        }
      );
      chosenHostIds = [hostA.id, hostB.id];
      reasons.push(`Topic-aware casting: pinned ${hostA.name} + ${hostB.name} for '${primary?.title ?? "primary topic"}'.`);
    } catch (err) {
      reasons.push(`Topic-aware casting skipped (${(err as Error).message}); using roster fallback at each stage.`);
    }
  }

  let title = settings.title?.trim();
  if (!title) {
    const dateStr = new Date().toISOString().split("T")[0];
    let tag = "Sports";
    if (settings.leagueId) tag = settings.leagueId.toUpperCase();
    else if (settings.sport) tag = settings.sport.charAt(0).toUpperCase() + settings.sport.slice(1);
    title = `Take Machine — ${tag} Debate Briefing — ${dateStr}`;
  }
  const description = settings.description?.trim() || "Draft episode assembled from approved Take Machine topics and research briefs.";

  let slug = slugify(title);
  const existing = await dbi.episode.findUnique({ where: { slug } });
  if (existing) slug = `${slug}-${crypto.randomBytes(3).toString("hex")}`;

  const rssGuid = crypto.randomUUID();
  const soundDesign =
    settings.soundDesign && (settings.soundDesign.style || settings.soundDesign.sfxDensity)
      ? settings.soundDesign
      : undefined;

  const txResult = await dbi.$transaction(async (tx: any) => {
    // ---- Concurrency guard (exclude_podcast) ----
    // Acquire per-(podcast,topic) advisory locks and RE-VALIDATE recent use
    // inside this transaction, so a topic another build just consumed for the
    // same podcast is dropped (auto) or fails the build (pinned, no override) —
    // even under two simultaneous requests. Skipped for test doubles that can't
    // take advisory locks; different podcasts never block each other.
    let topicsToWrite = orderedTopics;
    let droppedTopicIds: string[] = [];
    if (reservation && supportsAdvisoryLocks(tx)) {
      const blocked = await reserveRecentlyUsedTopics(tx, {
        podcastId: reservation.podcastId,
        topicIds: orderedTopics.map((t) => t.id),
        cooldownDays: reservation.cooldownDays,
      });
      if (blocked.size > 0) {
        const pinnedBlocked = [...blocked].filter((id) => reservation.pinnedIds.has(id));
        if (pinnedBlocked.length > 0 && !reservation.reuseOverride) {
          // Atomic fail: a pinned topic was used by a concurrent build.
          throw new Error(
            `This podcast just used topic(s) ${pinnedBlocked.join(", ")} — reuse override required.`
          );
        }
        // Drop blocked AUTO-selected topics; keep pinned ones only under override.
        topicsToWrite = orderedTopics.filter(
          (t) => !blocked.has(t.id) || reservation.pinnedIds.has(t.id)
        );
        droppedTopicIds = orderedTopics
          .filter((t) => blocked.has(t.id) && !reservation.pinnedIds.has(t.id))
          .map((t) => t.id);
        if (topicsToWrite.length === 0) {
          throw new Error("Every candidate topic was just used by this podcast.");
        }
      }
    }

    const ep = await tx.episode.create({
      data: {
        title,
        slug,
        status: "draft",
        description,
        rssGuid,
        longShowNotes: null,
        durationSeconds: null,
        audioUrl: null,
        transcriptUrl: null,
        publishedAt: null,
        ttsProvider: settings.ttsProvider ?? null,
        ttsVoiceOverrides: settings.ttsVoiceOverrides ? (settings.ttsVoiceOverrides as unknown as Prisma.InputJsonValue) : undefined,
        soundDesign: soundDesign ? (soundDesign as unknown as Prisma.InputJsonValue) : undefined,
        podcastId: settings.podcastId || undefined,
        ownerId: settings.ownerId || undefined,
        hostIds: chosenHostIds,
      },
    });

    const selectedAt = new Date();
    for (let i = 0; i < topicsToWrite.length; i++) {
      const t = topicsToWrite[i];
      await tx.episodeTopic.create({
        data: {
          episodeId: ep.id,
          topicId: t.id,
          orderIndex: i,
          selectedAt,
          // Freeze the topic + brief so this episode stays reproducible even
          // if the source is later edited, re-researched, or archived.
          snapshot: buildTopicSnapshot(t, t.researchBrief ?? null, selectedAt) as unknown as Prisma.InputJsonValue,
        },
      });
    }
    // TopicCandidate.status is intentionally NOT mutated to "used": usage is
    // derived from EpisodeTopic, so a topic stays 'approved' and reusable by
    // other users, other podcasts, and (per policy) the same podcast.
    return { ep, writtenTopicIds: topicsToWrite.map((t) => t.id), droppedTopicIds };
  });

  reasons.push(`Episode created successfully with ID ${txResult.ep.id}`);
  return {
    episodeId: txResult.ep.id,
    writtenTopicIds: txResult.writtenTopicIds,
    droppedTopicIds: txResult.droppedTopicIds,
  };
}

/** Validate the TTS / production settings shared by both entry points.
 *  Throws with a clear message on the first invalid setting. */
export function normalizeEpisodeSettings(input: {
  ttsProvider?: string;
  ttsVoiceOverrides?: unknown;
  productionStyle?: string;
  sfxDensity?: string;
}): {
  ttsProvider: string | null;
  ttsVoiceOverrides?: TtsVoiceOverrides;
  soundDesign?: { style?: string; sfxDensity?: string };
} {
  const chosenTtsProvider = input.ttsProvider?.trim().toLowerCase() || null;
  if (chosenTtsProvider && !isTtsProviderId(chosenTtsProvider)) {
    throw new Error(`Unknown TTS provider '${chosenTtsProvider}'.`);
  }
  const ttsVoiceOverrides = validateTtsVoiceOverridesInput(input.ttsVoiceOverrides);

  const chosenStyle = input.productionStyle?.trim().toLowerCase();
  if (chosenStyle && !isProductionStyle(chosenStyle)) throw new Error(`Unknown production style '${chosenStyle}'.`);
  const chosenDensity = input.sfxDensity?.trim().toLowerCase();
  if (chosenDensity && !isSfxDensity(chosenDensity)) throw new Error(`Unknown SFX density '${chosenDensity}'.`);
  const soundDesign =
    chosenStyle || chosenDensity
      ? { ...(chosenStyle ? { style: chosenStyle } : {}), ...(chosenDensity ? { sfxDensity: chosenDensity } : {}) }
      : undefined;

  return { ttsProvider: chosenTtsProvider, ttsVoiceOverrides, soundDesign };
}

/** Verify every id is an active AiHost; throws when any is missing/inactive.
 *  When `ownerId` is given, hosts must also be owned by that user or shared
 *  (ownerId null) — never another user's private characters. */
export async function assertHostsCastable(hostIds: string[], ownerId?: string, dbi: any = db): Promise<void> {
  const ids = [...new Set(hostIds)];
  if (ids.length === 0) return;
  const where: any = { id: { in: ids }, isActive: true };
  if (ownerId) where.OR = [{ ownerId }, { ownerId: null }];
  const activeHosts = await dbi.aiHost.findMany({ where, select: { id: true } });
  if (activeHosts.length !== ids.length) {
    throw new Error("One or more selected hosts are missing, inactive, or not available to this account.");
  }
}

// NOTE: `buildEpisodeFromTopics` was moved to episodeCreation.ts as a DEPRECATED
// adapter that delegates to `createEpisodeDraft`, so there is exactly ONE
// selection-policy implementation (reuse policy, dedupe, snapshots, scoping).
// The shared primitives above are the single source of truth both entry points
// build on.
