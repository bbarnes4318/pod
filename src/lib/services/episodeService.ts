import { db } from "../db";
import crypto from "crypto";
import { topicMatchesAnyVertical } from "../verticals";
import { scoreTopicTalkability } from "./talkabilityService";
import { isTtsProviderId } from "../providers/tts/providerIds";
import { TtsVoiceOverrides, validateTtsVoiceOverridesInput } from "../providers/tts/voiceResolution";
import { isProductionStyle, isSfxDensity } from "../audio/soundDesignShared";
import { resolveEpisodeHosts } from "./hostCasting";

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

export function evaluateTopicEligibility(
  topic: TopicWithBrief | null | undefined,
  idForMessage?: string
): TopicEligibility {
  if (!topic) {
    return {
      ok: false,
      category: "not_found",
      reason: `Topic candidate ${idForMessage ?? "(unknown id)"} not found in database.`,
    };
  }
  if (topic.status !== "approved") {
    return {
      ok: false,
      category: "not_approved",
      reason: `Topic candidate '${topic.title}' is not approved (status: ${topic.status}).`,
    };
  }
  const evidenceIds = Array.isArray(topic.evidenceIds) ? topic.evidenceIds : [];
  if (evidenceIds.length === 0) {
    return { ok: false, category: "weak_evidence", reason: `Topic candidate '${topic.title}' has empty evidenceIds.` };
  }
  const brief = topic.researchBrief;
  if (!brief) {
    return { ok: false, category: "missing_brief", reason: `Topic candidate '${topic.title}' is missing its ResearchBrief.` };
  }
  const facts = Array.isArray(brief.facts) ? brief.facts : [];
  if (facts.length === 0) {
    return { ok: false, category: "missing_brief", reason: `Topic candidate '${topic.title}' has empty facts in ResearchBrief.` };
  }
  const sourceIds = Array.isArray(brief.sourceIds) ? brief.sourceIds : [];
  if (sourceIds.length === 0) {
    return { ok: false, category: "weak_evidence", reason: `Topic candidate '${topic.title}' has empty sourceIds in ResearchBrief.` };
  }
  if (!brief.argumentForHostA?.trim() || !brief.argumentForHostB?.trim()) {
    return { ok: false, category: "missing_brief", reason: `Topic candidate '${topic.title}' has empty host arguments in ResearchBrief.` };
  }
  return { ok: true };
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
export async function selectAutoTopics(opts: AutoSelectOptions): Promise<AutoSelectResult> {
  const result: AutoSelectResult = {
    chosen: [],
    reasons: [],
    skippedTopicCount: 0,
    missingBriefCount: 0,
    weakEvidenceCount: 0,
  };
  const targetCount = Math.max(0, Math.floor(opts.targetCount));
  if (targetCount === 0) return result;

  const minScore = opts.minDebateScore !== undefined ? Number(opts.minDebateScore) : 70;
  const exclude = new Set(opts.excludeTopicIds || []);

  const rawCandidates = (await db.topicCandidate.findMany({
    where: { status: "approved" },
    include: { researchBrief: true },
    orderBy: { debateScore: "desc" },
  })) as unknown as TopicWithBrief[];

  const minTalkability = Number(process.env.TOPIC_MIN_TALKABILITY) || 35;
  const ranked = rawCandidates
    .filter((t) => !exclude.has(t.id))
    .map((t) => {
      const talkability = scoreTopicTalkability({
        title: t.title,
        summary: t.summary,
        createdAt: t.createdAt,
        brief: t.researchBrief as any,
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
  reasons: string[]
): Promise<string> {
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
  const existing = await db.episode.findUnique({ where: { slug } });
  if (existing) slug = `${slug}-${crypto.randomBytes(3).toString("hex")}`;

  const rssGuid = crypto.randomUUID();
  const soundDesign =
    settings.soundDesign && (settings.soundDesign.style || settings.soundDesign.sfxDensity)
      ? settings.soundDesign
      : undefined;

  const episode = await db.$transaction(async (tx) => {
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
        ttsVoiceOverrides: settings.ttsVoiceOverrides ? (settings.ttsVoiceOverrides as any) : undefined,
        soundDesign: soundDesign ? (soundDesign as any) : undefined,
        podcastId: settings.podcastId || undefined,
        ownerId: settings.ownerId || undefined,
        hostIds: chosenHostIds,
      },
    });

    for (let i = 0; i < orderedTopics.length; i++) {
      await tx.episodeTopic.create({
        data: { episodeId: ep.id, topicId: orderedTopics[i].id, orderIndex: i },
      });
    }
    for (const topic of orderedTopics) {
      await tx.topicCandidate.update({ where: { id: topic.id }, data: { status: "used" } });
    }
    return ep;
  });

  reasons.push(`Episode created successfully with ID ${episode.id}`);
  return episode.id;
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
export async function assertHostsCastable(hostIds: string[], ownerId?: string): Promise<void> {
  const ids = [...new Set(hostIds)];
  if (ids.length === 0) return;
  const where: any = { id: { in: ids }, isActive: true };
  if (ownerId) where.OR = [{ ownerId }, { ownerId: null }];
  const activeHosts = await db.aiHost.findMany({ where, select: { id: true } });
  if (activeHosts.length !== ids.length) {
    throw new Error("One or more selected hosts are missing, inactive, or not available to this account.");
  }
}

/**
 * LEGACY entry point — preserved for backwards compatibility. Binary mode:
 * explicit `topicIds` (validated, throws on the first invalid) or full
 * auto-selection. Now implemented on the shared primitives above so its
 * behavior stays in lockstep with `createEpisodeDraft`.
 */
export async function buildEpisodeFromTopics(input: EpisodeBuildInput): Promise<EpisodeBuildResult> {
  const result: EpisodeBuildResult = {
    insertedEpisodeCount: 0,
    selectedTopicCount: 0,
    skippedTopicCount: 0,
    invalidTopicCount: 0,
    missingBriefCount: 0,
    weakEvidenceCount: 0,
    statusUpdateCount: 0,
    selectedTopicIds: [],
    episodeId: null,
    reasons: [],
  };

  let settings;
  try {
    settings = normalizeEpisodeSettings(input);
  } catch (err: any) {
    result.reasons.push(err.message);
    throw err;
  }

  await assertHostsCastable(input.hostIds || [], input.ownerId);

  const targetCount = input.targetTopicCount !== undefined ? Number(input.targetTopicCount) : 3;
  let chosenTopics: TopicWithBrief[] = [];

  if (input.topicIds && input.topicIds.length > 0) {
    for (const tId of input.topicIds) {
      const topic = (await db.topicCandidate.findUnique({
        where: { id: tId },
        include: { researchBrief: true },
      })) as unknown as TopicWithBrief | null;
      const eligibility = evaluateTopicEligibility(topic, tId);
      if (!eligibility.ok) {
        tallyRejection(eligibility.category!, result);
        result.reasons.push(eligibility.reason!);
        throw new Error(eligibility.reason!);
      }
      chosenTopics.push(topic!);
    }
  } else {
    const auto = await selectAutoTopics({
      targetCount,
      minDebateScore: input.minDebateScore,
      leagueId: input.leagueId,
      leagueIds: input.leagueIds,
      sport: input.sport,
      verticals: input.verticals,
      teamNames: input.teamNames,
    });
    chosenTopics = auto.chosen;
    result.skippedTopicCount += auto.skippedTopicCount;
    result.missingBriefCount += auto.missingBriefCount;
    result.weakEvidenceCount += auto.weakEvidenceCount;
    result.reasons.push(...auto.reasons);
  }

  if (chosenTopics.length === 0) {
    const msg = "Fewer than 1 valid topic is available to build the episode.";
    result.reasons.push(msg);
    throw new Error(msg);
  }

  result.selectedTopicCount = chosenTopics.length;
  result.selectedTopicIds = chosenTopics.map((t) => t.id);

  const episodeId = await createEpisodeRecord(
    chosenTopics,
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
    },
    result.reasons
  );

  result.insertedEpisodeCount = 1;
  result.statusUpdateCount = chosenTopics.length;
  result.episodeId = episodeId;
  return result;
}
