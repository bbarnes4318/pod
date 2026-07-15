// Topic-pool view-model for the multi-topic rundown picker (Studio now, Admin
// later). Turns raw TopicCandidate rows + SCOPED usage into everything a
// producer needs to make an editorial decision — talkability, readiness,
// evidence/source counts, owner- and podcast-scoped usage, a clear
// unavailability reason, and a research-brief preview. It NEVER exposes
// platform-wide usage, and it labels (not raw-dumps) moderated/unsafe claims.

import {
  evaluateTopicEligibility,
  type TopicWithBrief,
} from "./episodeService";
import { scoreTopicTalkability } from "./talkabilityService";
import {
  type ScopedTopicUsage,
  type TopicReusePolicy,
  scopedRecentUseCount,
} from "./topicUsageService";

export type TopicReadiness = "ready" | "needs_research" | "not_approved" | "weak_evidence";

/** Research-brief fields safe to preview. Unsafe/moderated claims are surfaced
 *  as a COUNT only (labeled), never raw text. */
export interface TopicBriefPreview {
  mainAngle: string | null;
  contrarianAngle: string | null;
  whyMattersNow: string | null;
  argumentForHostA: string | null;
  argumentForHostB: string | null;
  strongestDebateQuestion: string | null;
  suggestedHostTake: string | null;
  injuryContext: string | null;
  oddsContext: string | null;
  keyFacts: string[];
  stats: string[];
  talkingPoints: string[];
  sourceRefs: string[];
  /** Count of moderated/flagged claims — shown with a warning label, not raw. */
  flaggedClaimCount: number;
}

export interface StudioTopicVM {
  id: string;
  title: string;
  sport: string;
  leagueId: string | null;
  summary: string | null;
  talkability: number;
  status: string;
  hasBrief: boolean;
  readiness: TopicReadiness;
  evidenceCount: number;
  sourceCount: number;
  debateScore: number;
  /** Owner-scoped usage (never platform-wide). */
  usedByYouCount: number;
  /** Podcast-scoped usage; null when no podcast is selected. */
  usedByShowCount: number | null;
  usedByShowRecent: boolean;
  lastUsedByShow: string | null;
  /** Eligible to ADD to the final rundown (approved + real evidence + not
   *  blocked by the reuse policy for the selected podcast). */
  eligible: boolean;
  /** Why it can't be added — shown, never hidden. Null when eligible. */
  unavailableReason: string | null;
  brief: TopicBriefPreview | null;
}

/** The minimal raw topic shape this builder reads (Prisma rows satisfy it). */
export interface RawPoolTopic extends TopicWithBrief {
  researchBrief:
    | (TopicWithBrief["researchBrief"] & {
        whyMattersNow?: string | null;
        keyFactsContext?: unknown;
        onAirTalkingPoints?: unknown;
        stats?: unknown;
        strongestDebateQuestion?: string | null;
        suggestedHostTake?: string | null;
        injuryContext?: string | null;
        oddsContext?: string | null;
        unsafeClaims?: unknown;
      })
    | null;
}

function textList(v: unknown, max = 8): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? String((x as Record<string, unknown>).text || (x as Record<string, unknown>).claim || (x as Record<string, unknown>).point || "") : ""))
    .filter(Boolean)
    .slice(0, max);
}

function sourceRefList(v: unknown, max = 12): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      if (typeof x === "string") return x;
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        if (o.type && o.id) return `${o.type}:${o.id}`;
        return String(o.url || o.id || "");
      }
      return "";
    })
    .filter(Boolean)
    .slice(0, max);
}

function readinessFor(topic: RawPoolTopic, eligibleCategory: string | undefined): TopicReadiness {
  if (topic.status !== "approved") return "not_approved";
  if (!topic.researchBrief) return "needs_research";
  if (eligibleCategory === "missing_brief") return "needs_research";
  if (eligibleCategory === "weak_evidence") return "weak_evidence";
  return "ready";
}

function briefPreview(topic: RawPoolTopic): TopicBriefPreview | null {
  const b = topic.researchBrief;
  if (!b) return null;
  const flagged = Array.isArray(b.unsafeClaims) ? b.unsafeClaims.length : 0;
  const keyFacts = textList(b.keyFactsContext).length ? textList(b.keyFactsContext) : textList(b.facts);
  return {
    mainAngle: b.mainAngle ?? null,
    contrarianAngle: b.contrarianAngle ?? null,
    whyMattersNow: b.whyMattersNow ?? null,
    argumentForHostA: b.argumentForHostA ?? null,
    argumentForHostB: b.argumentForHostB ?? null,
    strongestDebateQuestion: b.strongestDebateQuestion ?? null,
    suggestedHostTake: b.suggestedHostTake ?? null,
    injuryContext: b.injuryContext ?? null,
    oddsContext: b.oddsContext ?? null,
    keyFacts,
    stats: textList(b.stats),
    talkingPoints: textList(b.onAirTalkingPoints),
    sourceRefs: sourceRefList(b.sourceIds),
    flaggedClaimCount: flagged,
  };
}

export interface BuildPoolContext {
  usage: Map<string, ScopedTopicUsage>;
  policy: TopicReusePolicy;
  /** Present only when a podcast is selected — enables podcast-scoped usage +
   *  the exclude_podcast block. */
  podcastId?: string;
}

/** PURE view-model build (no DB) — the unit-testable core. */
export function buildStudioTopicVMs(topics: RawPoolTopic[], ctx: BuildPoolContext): StudioTopicVM[] {
  return topics.map((topic) => {
    const elig = evaluateTopicEligibility(topic, topic.id);
    const talk = scoreTopicTalkability({
      title: topic.title,
      summary: topic.summary,
      createdAt: topic.createdAt,
      brief: topic.researchBrief,
    });
    const u = ctx.usage.get(topic.id);
    const recentByShow = ctx.podcastId ? scopedRecentUseCount(u, { podcastId: ctx.podcastId }) > 0 : false;
    // Only exclude_podcast actually BLOCKS a recently-used topic; warn/allow show
    // the usage but keep it selectable.
    const blockedByReuse = ctx.policy.mode === "exclude_podcast" && recentByShow;
    const eligible = elig.ok && !blockedByReuse;
    const unavailableReason = !elig.ok
      ? elig.reason ?? "This topic can't be used yet."
      : blockedByReuse
        ? "Recently used by this show — pick another or wait for the cooldown."
        : null;

    const evidenceCount = Array.isArray(topic.evidenceIds) ? topic.evidenceIds.length : 0;
    const sourceCount = Array.isArray(topic.researchBrief?.sourceIds) ? (topic.researchBrief!.sourceIds as unknown[]).length : 0;

    return {
      id: topic.id,
      title: topic.title,
      sport: topic.sport,
      leagueId: topic.leagueId,
      summary: topic.summary,
      talkability: talk.total,
      status: topic.status,
      hasBrief: !!topic.researchBrief,
      readiness: readinessFor(topic, elig.category),
      evidenceCount,
      sourceCount,
      debateScore: topic.debateScore,
      usedByYouCount: u?.currentOwnerUseCount ?? 0,
      usedByShowCount: ctx.podcastId ? u?.currentPodcastUseCount ?? 0 : null,
      usedByShowRecent: recentByShow,
      lastUsedByShow: ctx.podcastId && u?.currentPodcastLastUsedAt ? new Date(u.currentPodcastLastUsedAt).toISOString() : null,
      eligible,
      unavailableReason,
      brief: briefPreview(topic),
    };
  });
}
