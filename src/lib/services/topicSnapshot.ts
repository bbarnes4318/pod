// Immutable episode-topic snapshots.
//
// An episode records the topic + research brief AS SELECTED so it stays
// reproducible even if the source TopicCandidate/ResearchBrief is later edited,
// re-researched, or archived. Script generation and fact-checking read the
// snapshot when present and fall back to live data only for legacy rows.

import crypto from "crypto";

export const EPISODE_TOPIC_SNAPSHOT_VERSION = 1 as const;

/** The frozen content of one topic at the moment it was selected. */
export interface EpisodeTopicSnapshot {
  version: number;
  source: "creation" | "backfill";
  title: string;
  summary: string | null;
  sport: string | null;
  leagueId: string | null;
  evidenceIds: unknown;
  facts: unknown;
  sourceIds: unknown;
  stats?: unknown;
  mainAngle: string | null;
  contrarianAngle: string | null;
  argumentForHostA: string | null;
  argumentForHostB: string | null;
  counterArguments?: unknown;
  unsafeClaims?: unknown;
  onAirTalkingPoints?: unknown;
  whyMattersNow?: string | null;
  keyFactsContext?: unknown;
  debateScore?: number | null;
  strongestDebateQuestion?: string | null;
  suggestedHostTake?: string | null;
  injuryContext?: string | null;
  oddsContext?: string | null;
  /** Stable hash of the evidence/facts/sources — lets a reader detect drift
   *  from the current live topic and version the snapshot. */
  evidenceFingerprint: string;
  /** When the topic was selected into the episode (ISO 8601). */
  selectionTimestamp: string;
}

type LiveTopic = {
  title: string;
  summary?: string | null;
  sport?: string | null;
  leagueId?: string | null;
  evidenceIds?: unknown;
  debateScore?: number | null;
  researchBrief?: LiveBrief | null;
};

type LiveBrief = {
  facts?: unknown;
  sourceIds?: unknown;
  stats?: unknown;
  mainAngle?: string | null;
  contrarianAngle?: string | null;
  argumentForHostA?: string | null;
  argumentForHostB?: string | null;
  counterArguments?: unknown;
  unsafeClaims?: unknown;
  onAirTalkingPoints?: unknown;
  whyMattersNow?: string | null;
  keyFactsContext?: unknown;
  strongestDebateQuestion?: string | null;
  suggestedHostTake?: string | null;
  injuryContext?: string | null;
  oddsContext?: string | null;
} | null;

export function evidenceFingerprint(facts: unknown, sourceIds: unknown, evidenceIds: unknown): string {
  const material = `${JSON.stringify(facts ?? null)}|${JSON.stringify(sourceIds ?? null)}|${JSON.stringify(evidenceIds ?? null)}`;
  return crypto.createHash("md5").update(material).digest("hex");
}

/** Freeze a topic + its brief into a snapshot at selection time. */
export function buildTopicSnapshot(
  topic: LiveTopic,
  brief: LiveBrief,
  selectionTimestamp: Date = new Date()
): EpisodeTopicSnapshot {
  return {
    version: EPISODE_TOPIC_SNAPSHOT_VERSION,
    source: "creation",
    title: topic.title,
    summary: topic.summary ?? null,
    sport: topic.sport ?? null,
    leagueId: topic.leagueId ?? null,
    evidenceIds: topic.evidenceIds ?? [],
    facts: brief?.facts ?? [],
    sourceIds: brief?.sourceIds ?? [],
    stats: brief?.stats,
    mainAngle: brief?.mainAngle ?? null,
    contrarianAngle: brief?.contrarianAngle ?? null,
    argumentForHostA: brief?.argumentForHostA ?? null,
    argumentForHostB: brief?.argumentForHostB ?? null,
    counterArguments: brief?.counterArguments,
    unsafeClaims: brief?.unsafeClaims,
    onAirTalkingPoints: brief?.onAirTalkingPoints,
    whyMattersNow: brief?.whyMattersNow ?? null,
    keyFactsContext: brief?.keyFactsContext,
    debateScore: topic.debateScore ?? null,
    strongestDebateQuestion: brief?.strongestDebateQuestion ?? null,
    suggestedHostTake: brief?.suggestedHostTake ?? null,
    injuryContext: brief?.injuryContext ?? null,
    oddsContext: brief?.oddsContext ?? null,
    evidenceFingerprint: evidenceFingerprint(brief?.facts, brief?.sourceIds, topic.evidenceIds),
    selectionTimestamp: (selectionTimestamp instanceof Date ? selectionTimestamp : new Date()).toISOString(),
  };
}

/** The normalized content script-gen + fact-check consume, regardless of
 *  whether it came from a snapshot or live topic data. */
export interface ResolvedTopicContent {
  fromSnapshot: boolean;
  title: string;
  summary: string | null;
  sport: string | null;
  leagueId: string | null;
  evidenceIds: unknown;
  facts: unknown;
  sourceIds: unknown;
  stats?: unknown;
  mainAngle: string | null;
  contrarianAngle: string | null;
  argumentForHostA: string | null;
  argumentForHostB: string | null;
  counterArguments?: unknown;
  unsafeClaims?: unknown;
  onAirTalkingPoints?: unknown;
  whyMattersNow?: string | null;
  keyFactsContext?: unknown;
  debateScore: number | null;
  strongestDebateQuestion?: string | null;
  suggestedHostTake?: string | null;
  injuryContext?: string | null;
  oddsContext?: string | null;
}

/** Shape resolved content back into a ResearchBrief-like object so existing
 *  brief consumers (prompt builder, collectReviewerEvidence) work unchanged. */
export function briefLikeFromContent(c: ResolvedTopicContent) {
  return {
    facts: c.facts,
    stats: c.stats,
    sourceIds: c.sourceIds,
    keyFactsContext: c.keyFactsContext,
    argumentForHostA: c.argumentForHostA,
    argumentForHostB: c.argumentForHostB,
    mainAngle: c.mainAngle,
    contrarianAngle: c.contrarianAngle,
    whyMattersNow: c.whyMattersNow,
    onAirTalkingPoints: c.onAirTalkingPoints,
    counterArguments: c.counterArguments,
    unsafeClaims: c.unsafeClaims,
    injuryContext: c.injuryContext ?? null,
    oddsContext: c.oddsContext ?? null,
    strongestDebateQuestion: c.strongestDebateQuestion ?? null,
    suggestedHostTake: c.suggestedHostTake ?? null,
  };
}

function isSnapshot(v: unknown): v is EpisodeTopicSnapshot {
  return !!v && typeof v === "object" && typeof (v as any).title === "string" && "evidenceFingerprint" in (v as any);
}

/**
 * Resolve one EpisodeTopic to its content, preferring the immutable snapshot.
 * Falls back to the live TopicCandidate + ResearchBrief only when no snapshot
 * exists (legacy rows the backfill hasn't reached), so a later edit of the
 * source topic can never rewrite an already-produced episode.
 */
export function resolveEpisodeTopicContent(et: {
  snapshot?: unknown;
  topic?: LiveTopic | null;
}): ResolvedTopicContent {
  const snap = et.snapshot;
  if (isSnapshot(snap)) {
    return {
      fromSnapshot: true,
      title: snap.title,
      summary: snap.summary ?? null,
      sport: snap.sport ?? null,
      leagueId: snap.leagueId ?? null,
      evidenceIds: snap.evidenceIds ?? [],
      facts: snap.facts ?? [],
      sourceIds: snap.sourceIds ?? [],
      stats: snap.stats,
      mainAngle: snap.mainAngle ?? null,
      contrarianAngle: snap.contrarianAngle ?? null,
      argumentForHostA: snap.argumentForHostA ?? null,
      argumentForHostB: snap.argumentForHostB ?? null,
      counterArguments: snap.counterArguments,
      unsafeClaims: snap.unsafeClaims,
      onAirTalkingPoints: snap.onAirTalkingPoints,
      whyMattersNow: snap.whyMattersNow ?? null,
      keyFactsContext: snap.keyFactsContext,
      debateScore: snap.debateScore ?? null,
      strongestDebateQuestion: snap.strongestDebateQuestion ?? null,
      suggestedHostTake: snap.suggestedHostTake ?? null,
      injuryContext: snap.injuryContext ?? null,
      oddsContext: snap.oddsContext ?? null,
    };
  }
  const t = et.topic || ({} as LiveTopic);
  const b = t.researchBrief || null;
  return {
    fromSnapshot: false,
    title: t.title,
    summary: t.summary ?? null,
    sport: t.sport ?? null,
    leagueId: t.leagueId ?? null,
    evidenceIds: t.evidenceIds ?? [],
    facts: b?.facts ?? [],
    sourceIds: b?.sourceIds ?? [],
    stats: b?.stats,
    mainAngle: b?.mainAngle ?? null,
    contrarianAngle: b?.contrarianAngle ?? null,
    argumentForHostA: b?.argumentForHostA ?? null,
    argumentForHostB: b?.argumentForHostB ?? null,
    counterArguments: b?.counterArguments,
    unsafeClaims: b?.unsafeClaims,
    onAirTalkingPoints: b?.onAirTalkingPoints,
    whyMattersNow: b?.whyMattersNow ?? null,
    keyFactsContext: b?.keyFactsContext,
    debateScore: t.debateScore ?? null,
    strongestDebateQuestion: b?.strongestDebateQuestion ?? null,
    suggestedHostTake: b?.suggestedHostTake ?? null,
    injuryContext: b?.injuryContext ?? null,
    oddsContext: b?.oddsContext ?? null,
  };
}
